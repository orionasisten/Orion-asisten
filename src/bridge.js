'use strict';
/**
 * Jembatan main-process untuk ORION Desktop.
 * Prinsip: renderer tidak punya akses Node. Semua aksi berisiko (tulis berkas, jalankan perintah,
 * jalankan coding agent) wajib lewat dialog persetujuan native yang tidak bisa dipalsukan halaman web.
 * Kompatibel Node 16+ (Electron 22) sampai Node terbaru.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, spawn } = require('child_process');
const { createMcp, validateSpec: validateMcpSpec, REMOTE_OFF } = require('./mcp');
const { createConnectorHub } = require('./connectors');
const { createWebTools, PROVIDERS: SEARCH_PROVIDERS } = require('./webtools');
const { MemoryService } = require('./memory/service');
const { MemoryStore } = require('./memory/store');
const { SkillRegistry } = require('./skills/registry');
const { SkillStore } = require('./skills/store');
const { Outbox } = require('./central/outbox');
const { CentralClient } = require('./central/client');
const { CentralDesktop } = require('./central/desktop-sync');
const migrator = require('./central/migrate/migrate-local');

const MAX_READ = 1024 * 1024;
const MAX_WRITE = 2 * 1024 * 1024;
const MAX_OUT = 200 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const SECRET_DENY = [/^\.env/i, /\.(pem|key|p12|pfx|keystore)$/i, /^id_(rsa|dsa|ecdsa|ed25519)/i, /^\.npmrc$/i, /^credentials/i];

/* ───────── util murni (diuji di scripts/selftest.js) ───────── */
function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  m[1].split(/\r?\n/).forEach(line => {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  });
  return { meta, body: m[2] };
}

function makeSafePath(root, rel) {
  if (!root) throw new Error('Workspace belum dipilih.');
  const realRoot = fs.realpathSync(root);
  const target = path.resolve(realRoot, rel || '.');
  let probe = target;
  while (!fs.existsSync(probe)) {
    const up = path.dirname(probe);
    if (up === probe) break;
    probe = up;
  }
  const real = fs.realpathSync(probe);
  if (!(real === realRoot || real.startsWith(realRoot + path.sep))) throw new Error('Path berada di luar workspace.');
  if (!(target === realRoot || target.startsWith(realRoot + path.sep))) throw new Error('Path berada di luar workspace.');
  return target;
}

function isSecretName(name) { return SECRET_DENY.some(re => re.test(name)); }

function validatePluginManifest(m, folderName) {
  if (!m || typeof m !== 'object') throw new Error('plugin.json tidak valid.');
  if (!ID_RE.test(String(m.id || ''))) throw new Error('id plugin harus huruf kecil/angka/-/_/. (maks 64).');
  if (typeof m.name !== 'string' || !m.name.trim()) throw new Error('name wajib diisi.');
  const cmds = Array.isArray(m.commands) ? m.commands : [];
  const commands = cmds.slice(0, 40).map(c => {
    if (!c || !ID_RE.test(String(c.id || '')) || typeof c.title !== 'string' || typeof c.prompt !== 'string') {
      throw new Error('Command plugin tidak valid (butuh id, title, prompt).');
    }
    if (c.prompt.length > 8000) throw new Error('Prompt command terlalu panjang (maks 8000).');
    return { id: c.id, title: c.title.slice(0, 80), prompt: c.prompt, input: typeof c.input === 'string' ? c.input.slice(0, 120) : '' };
  });
  return {
    id: m.id,
    name: m.name.slice(0, 80),
    version: String(m.version || '0.0.0').slice(0, 20),
    description: String(m.description || '').slice(0, 300),
    author: String(m.author || '').slice(0, 80),
    permissions: (Array.isArray(m.permissions) ? m.permissions : []).map(String).slice(0, 10),
    commands,
    folder: folderName
  };
}

/* ───────── register ───────── */
function register(ctx) {
  const { ipcMain, app, dialog, shell, safeStorage, getWindow, updater } = ctx;
  const userData = app.getPath('userData');
  const cfgPath = path.join(userData, 'orion-desktop.json');
  const resRoot = app.isPackaged ? path.join(process.resourcesPath, 'resources') : path.join(__dirname, '..', 'resources');
  const userDirs = { skills: path.join(userData, 'skills'), plugins: path.join(userData, 'plugins') };
  Object.keys(userDirs).forEach(k => fs.mkdirSync(userDirs[k], { recursive: true }));

  let cfg = { workspace: null, secrets: {}, mcpServers: [], mcpTokens: {}, connectorSecrets: {}, experimental: { remoteMcp: false }, search: { provider: 'wikipedia-id', searxngBase: '', googleCx: '' } };
  try { cfg = Object.assign(cfg, JSON.parse(fs.readFileSync(cfgPath, 'utf8'))); } catch (e) { /* baru */ }
  const saveCfg = () => fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  if (cfg.workspace && !fs.existsSync(cfg.workspace)) cfg.workspace = null;

  /* PATH: aplikasi GUI di macOS tidak mewarisi PATH shell (Homebrew, nvm, dll). */
  let envPromise = null;
  function getEnv() {
    if (envPromise) return envPromise;
    envPromise = new Promise(resolve => {
      const base = Object.assign({}, process.env, { GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' });
      if (process.platform === 'win32') return resolve(base);
      const home = os.homedir();
      const extra = ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', path.join(home, '.local/bin'),
        path.join(home, '.npm-global/bin'), path.join(home, '.claude/local'), path.join(home, '.volta/bin'), path.join(home, '.bun/bin')];
      const fallback = () => { base.PATH = [base.PATH || '/usr/bin:/bin:/usr/sbin:/sbin'].concat(extra).join(':'); resolve(base); };
      execFile(process.env.SHELL || '/bin/zsh', ['-ilc', 'printf "__ORION_PATH__%s" "$PATH"'], { timeout: 5000 }, (err, stdout) => {
        const m = !err && /__ORION_PATH__(.*)$/m.exec(String(stdout));
        if (m && m[1]) base.PATH = m[1] + ':' + extra.join(':'); else return fallback();
        resolve(base);
      });
    });
    return envPromise;
  }

  const procs = new Set(); // proses anak aktif (terminal/agent/diagnostik) — dihentikan oleh emergency stop

  function killTree(child) {
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
      else process.kill(-child.pid, 'SIGKILL');
    } catch (e) { try { child.kill('SIGKILL'); } catch (e2) { /* selesai */ } }
  }

  function runProc(command, args, opts) {
    return getEnv().then(env => new Promise(resolve => {
      const child = spawn(command, args, {
        cwd: opts.cwd, env, shell: !!opts.shell, windowsHide: true, detached: process.platform !== 'win32'
      });
      procs.add(child);
      let out = '', err = '', timedOut = false, truncated = false;
      const add = (cur, d) => {
        if (cur.length >= MAX_OUT) { truncated = true; return cur; }
        return cur + d.toString('utf8');
      };
      child.stdout.on('data', d => { out = add(out, d); });
      child.stderr.on('data', d => { err = add(err, d); });
      const timer = setTimeout(() => { timedOut = true; killTree(child); }, opts.timeout || 120000);
      child.on('error', e => { clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: err + String(e.message), timedOut, truncated }); });
      child.on('close', code => { procs.delete(child); clearTimeout(timer); resolve({ code, stdout: out.slice(0, MAX_OUT), stderr: err.slice(0, MAX_OUT), timedOut, truncated }); });
      if (opts.input != null) child.stdin.write(opts.input);
      child.stdin.end();
    }));
  }

  async function approve(title, message, detail) {
    const w = getWindow();
    const r = await dialog.showMessageBox(w || undefined, {
      type: 'warning', buttons: ['Batal', 'Izinkan'], defaultId: 0, cancelId: 0, noLink: true,
      title: 'ORION — ' + title, message, detail: String(detail || '').slice(0, 1500)
    });
    return r.response === 1;
  }

  function handle(channel, fn) {
    ipcMain.handle('orion:' + channel, async (e, ...args) => {
      const w = getWindow();
      let url = '';
      try { url = e.senderFrame ? e.senderFrame.url : ''; } catch (x) { /* abaikan */ }
      if (!w || e.sender !== w.webContents || (url && !url.startsWith('file://'))) return { ok: false, error: 'Pemanggil tidak dipercaya.' };
      try { return Object.assign({ ok: true }, await fn(...args)); } catch (err) { return { ok: false, error: String((err && err.message) || err) }; }
    });
  }

  const ws = () => { if (!cfg.workspace) throw new Error('Pilih workspace dulu (Desktop Hub → Workspace).'); return cfg.workspace; };

  /* app */
  handle('app:info', () => ({
    version: app.getVersion(), platform: process.platform, arch: process.arch, electron: process.versions.electron,
    chrome: process.versions.chrome, experimental: { remoteMcp: !!(cfg.experimental && cfg.experimental.remoteMcp) }, updates: { enabled: !!(updater && updater.enabled), repo: updater ? updater.repo : '' }, userData, packaged: app.isPackaged, secureStore: secOk()
  }));
  handle('app:checkUpdate', () => { if (updater) updater.check(true); return { enabled: !!(updater && updater.enabled), repo: updater ? updater.repo : '' }; });
  handle('app:openFolder', async kind => {
    const dir = kind === 'data' ? userData : userDirs[kind];
    if (!dir) throw new Error('Folder tidak dikenal.');
    await shell.openPath(dir);
    return {};
  });

  /* workspace & fs */
  handle('ws:get', () => ({ workspace: cfg.workspace }));
  handle('ws:choose', async () => {
    const r = await dialog.showOpenDialog(getWindow() || undefined, { title: 'Pilih folder workspace ORION', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { workspace: cfg.workspace };
    cfg.workspace = r.filePaths[0]; saveCfg();
    return { workspace: cfg.workspace };
  });
  handle('ws:clear', () => { cfg.workspace = null; saveCfg(); return { workspace: null }; });

  handle('fs:list', rel => {
    const dir = makeSafePath(ws(), rel || '.');
    const items = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 500).map(d => {
      let size = 0; try { if (d.isFile()) size = fs.statSync(path.join(dir, d.name)).size; } catch (x) { /* abaikan */ }
      return { name: d.name, dir: d.isDirectory(), size };
    }).sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    return { items };
  });
  handle('fs:read', rel => {
    const file = makeSafePath(ws(), rel);
    if (isSecretName(path.basename(file))) throw new Error('Berkas sensitif (.env/kunci) tidak boleh dibaca lewat ORION.');
    const st = fs.statSync(file);
    if (!st.isFile()) throw new Error('Bukan berkas.');
    if (st.size > MAX_READ) throw new Error('Berkas > 1 MB.');
    return { content: fs.readFileSync(file, 'utf8') };
  });
  handle('fs:write', async (rel, content) => {
    const file = makeSafePath(ws(), rel);
    const data = String(content == null ? '' : content);
    if (Buffer.byteLength(data) > MAX_WRITE) throw new Error('Konten > 2 MB.');
    if (isSecretName(path.basename(file))) throw new Error('Menulis berkas sensitif diblokir.');
    if (!(await approve('Tulis berkas', 'Izinkan ORION menulis berkas ini?', file + '\n' + Buffer.byteLength(data) + ' byte'))) throw new Error('Ditolak oleh pengguna.');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, data);
    return {};
  });

  /* terminal (selalu minta izin) */
  handle('term:run', async command => {
    const cwd = ws();
    const cmd = String(command || '').trim();
    if (!cmd || cmd.length > 2000) throw new Error('Perintah kosong atau terlalu panjang.');
    if (!(await approve('Jalankan perintah', 'Izinkan menjalankan perintah ini di workspace?', cmd + '\n\nFolder: ' + cwd))) throw new Error('Ditolak oleh pengguna.');
    return runProc(cmd, [], { cwd, shell: true, timeout: 120000 });
  });

  /* git (read-only, argumen tetap) */
  const GIT = {
    status: ['status', '--short', '--branch'],
    log: ['log', '--oneline', '--no-decorate', '-n', '30'],
    diffstat: ['diff', '--stat', '--no-ext-diff', '--no-textconv'],
    diff: ['diff', '--no-color', '--no-ext-diff', '--no-textconv'],
    branch: ['branch', '--show-current']
  };
  handle('git:run', async sub => {
    const args = GIT[sub];
    if (!args) throw new Error('Sub-perintah git tidak diizinkan.');
    const r = await runProc('git', ['-c', 'core.fsmonitor=false', '-c', 'core.pager=cat'].concat(args), { cwd: ws(), timeout: 15000 });
    if (r.code === -1 && /ENOENT/.test(r.stderr)) throw new Error('Git belum terpasang atau tidak ada di PATH.');
    return r;
  });

  /* deteksi tool */
  const PROBES = {
    claude: ['claude', ['--version']], codex: ['codex', ['--version']], git: ['git', ['--version']], node: ['node', ['--version']],
    playwright: ['npx', ['--no-install', 'playwright', '--version']], sqlite3: ['sqlite3', ['--version']], psql: ['psql', ['--version']],
    docker: ['docker', ['--version']], gh: ['gh', ['--version']], vercel: ['vercel', ['--version']], netlify: ['netlify', ['--version']]
  };
  handle('tools:detect', async () => {
    const env = await getEnv();
    const tools = {};
    await Promise.all(Object.keys(PROBES).map(k => new Promise(res => {
      const [cmd, args] = PROBES[k];
      execFile(cmd, args, { timeout: 8000, env, windowsHide: true, shell: process.platform === 'win32' }, (err, so, se) => {
        tools[k] = err ? { found: false } : { found: true, version: String(so || se).trim().split(/\r?\n/)[0].slice(0, 80) };
        res();
      });
    })));
    return { tools };
  });

  /* connectors & agent CLI */
  const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8'));
  function presets() {
    const p = readJson(path.join(resRoot, 'connectors', 'presets.json'));
    try { Object.assign(p.agents, readJson(path.join(userData, 'agents.override.json'))); } catch (e) { /* tanpa override */ }
    return p;
  }
  handle('connectors:presets', () => ({ presets: presets() }));

  /* Phase 2 — durable local mission runtime (state machine + atomic JSON store + recovery). */
  const MR = () => ctx.missionRuntime;
  const needMR = () => { if (!MR()) throw new Error('MISSION_RUNTIME_UNAVAILABLE'); };
  handle('mission:list', () => { needMR(); return { missions: MR().listMissions() }; });
  handle('mission:get', id => { needMR(); return { mission: MR().getMission(String(id||'')) }; });
  handle('mission:create', spec => { needMR(); return { mission: MR().createMission(spec && typeof spec==='object' ? spec : {}) }; });
  handle('mission:transition', (id, to, reason) => { needMR(); return { mission: MR().transitionMission(String(id||''), String(to||''), reason) }; });
  handle('mission:pause', id => { needMR(); return { mission: MR().pauseMission(String(id||'')) }; });
  handle('mission:resume', id => { needMR(); return { mission: MR().resumeMission(String(id||'')) }; });
  handle('mission:cancel', id => { needMR(); return { mission: MR().cancelMission(String(id||'')) }; });
  handle('mission:addTask', (id, task) => { needMR(); return { mission: MR().addTask(String(id||''), task && typeof task==='object' ? task : {}) }; });
  handle('mission:addDependency', (id, taskId, depId) => { needMR(); return { mission: MR().addDependency(String(id||''), String(taskId||''), String(depId||'')) }; });
  handle('mission:startTask', (id, taskId) => { needMR(); return { mission: MR().startTask(String(id||''), String(taskId||'')) }; });
  handle('mission:succeedTask', (id, taskId, result, key) => { needMR(); return { mission: MR().succeedTask(String(id||''), String(taskId||''), result, key) }; });
  handle('mission:failTask', (id, taskId, error, retryable) => { needMR(); return { mission: MR().failTask(String(id||''), String(taskId||''), error, !!retryable) }; });
  handle('mission:outcomeUnknown', (id, taskId, reason) => { needMR(); return { mission: MR().outcomeUnknown(String(id||''), String(taskId||''), reason) }; });
  handle('mission:requestApproval', (id, taskId, action, resource, params, scope, ttlMs) => { needMR(); return MR().requestApproval(String(id||''), taskId?String(taskId):null, String(action||''), String(resource||''), params, String(scope||'mission'), Number(ttlMs)||600000); });
  handle('mission:resolveApproval', (id, approvalId, approved) => { needMR(); return MR().resolveApproval(String(id||''), String(approvalId||''), !!approved, 'user'); });
  handle('mission:retryTask', (id, taskId) => { needMR(); return { mission: MR().retryTask(String(id||''), String(taskId||'')) }; });
  handle('mission:validateApproval', (id, approvalId, action, resource, params, scope) => { needMR(); return { ok: MR().validateApproval(String(id||''), String(approvalId||''), String(action||''), String(resource||''), params, String(scope||'mission')) }; });

  function readAiKey(){ try { const v = cfg.secrets && cfg.secrets[secName('aikey')]; if(!v || !secOk()) return null; return safeStorage.decryptString(Buffer.from(v,'base64')); } catch(e){ return null; } }
  handle('mission:executeTask', async (missionId, taskId, adapterConfig, taskPayload) => {
    needMR();
    const configs = Array.isArray(adapterConfig) ? adapterConfig : (adapterConfig ? [adapterConfig] : []);
    const apiKey = readAiKey();
    return await MR().executeTask(String(missionId||''), String(taskId||''), configs, taskPayload && typeof taskPayload==='object' ? taskPayload : {}, apiKey);
  });
  handle('mission:executeNext', async (missionId, adapterConfig, opts) => {
    needMR();
    const configs = Array.isArray(adapterConfig) ? adapterConfig : (adapterConfig ? [adapterConfig] : []);
    const apiKey = readAiKey();
    return await MR().executeNext(String(missionId||''), configs, apiKey, opts && typeof opts==='object' ? opts : {});
  });

  handle('agent:run', async (id, prompt) => {
    const a = presets().agents[id];
    if (!a || !/^[\w.-]+$/.test(a.cmd) || !Array.isArray(a.args)) throw new Error('Agent tidak dikenal.');
    const text = String(prompt || '').trim();
    if (!text || text.length > 20000) throw new Error('Prompt kosong atau terlalu panjang.');
    const cwd = ws();
    const ok = await approve('Jalankan coding agent', `Izinkan ${a.label || id} bekerja di workspace? Agent dapat mengubah berkas dan menjalankan perintah sesuai konfigurasinya.`,
      'Folder: ' + cwd + '\nPerintah: ' + a.cmd + ' ' + a.args.join(' ') + '\n\nPrompt:\n' + text.slice(0, 700));
    if (!ok) throw new Error('Ditolak oleh pengguna.');
    // Prompt dikirim lewat stdin (bukan argumen) sehingga tidak ada risiko injeksi shell.
    return runProc(a.cmd, a.args, { cwd, shell: process.platform === 'win32', input: text, timeout: 10 * 60 * 1000 });
  });

  /* secrets (Keychain macOS / DPAPI Windows lewat safeStorage) */
  const secName = n => { if (!/^[a-z0-9_.-]{1,64}$/.test(String(n))) throw new Error('Nama secret tidak valid.'); return String(n); };
  // Penyimpanan secret yang layak: backend 'basic_text' (Linux tanpa keyring) memakai kunci tetap → ditolak.
  const secOk = () => {
    if (!(safeStorage && safeStorage.isEncryptionAvailable())) return false;
    try { const b = safeStorage.getSelectedStorageBackend && safeStorage.getSelectedStorageBackend(); return b !== 'basic_text'; } catch (e) { return true; }
  };
  handle('secret:available', () => ({ available: secOk() }));
  handle('secret:set', (name, value) => {
    if (!secOk()) throw new Error('Penyimpanan aman OS tidak tersedia.');
    cfg.secrets[secName(name)] = safeStorage.encryptString(String(value)).toString('base64'); saveCfg(); return {};
  });
  handle('secret:get', name => {
    const v = cfg.secrets[secName(name)];
    if (!v || !secOk()) return { value: null };
    try { return { value: safeStorage.decryptString(Buffer.from(v, 'base64')) }; } catch (e) { return { value: null }; }
  });
  handle('secret:del', name => { delete cfg.secrets[secName(name)]; saveCfg(); return {}; });

  /* API Connector Hub (policy broker lokal; lihat docs/api-connector-hub.md) */
  const storageOk = secOk;
  async function approveApi(info) {
    const detail = [
      `Connector: ${info.connector.name} (${info.connector.id})`, `Risiko: ${info.connector.riskLevel} · Autentikasi: ${info.connector.authType}`,
      `Permintaan: ${info.method} ${info.url}`, info.body ? `Body: ${info.body.bytes} byte, kunci: ${info.body.keys.join(', ')}` : '',
      info.mission ? `Mission: ${info.mission.name}` : 'Tanpa mission (uji manual)', `Alasan: ${info.reason}`, `ID operasi: ${info.fingerprint.slice(0, 12)}`
    ].filter(Boolean).join('\n');
    const r = await dialog.showMessageBox(getWindow() || undefined, { type: 'warning', buttons: ['Tolak', 'Izinkan'], defaultId: 0, cancelId: 0, noLink: true, title: 'ORION — Izinkan panggilan API', message: info.kind === 'test' ? 'Uji koneksi connector API?' : 'Izinkan panggilan API ini?', detail });
    return r.response === 1;
  }
  const hubDir = path.join(userData, 'connectors');
  fs.mkdirSync(hubDir, { recursive: true });
  const hub = createConnectorHub({
    dir: hubDir, version: app.getVersion(), approve: approveApi,
    secretsBacking: {
      load: () => cfg.connectorSecrets, save: d => { cfg.connectorSecrets = d; saveCfg(); },
      crypto: { available: storageOk, encrypt: v => safeStorage.encryptString(v).toString('base64'), decrypt: b => safeStorage.decryptString(Buffer.from(b, 'base64')) }
    }
  });
  const askUser = async (title, message, detail, ok) => (await dialog.showMessageBox(getWindow() || undefined, { type: 'warning', buttons: ['Batal', ok || 'Lanjutkan'], defaultId: 0, cancelId: 0, noLink: true, title: 'ORION — ' + title, message, detail: String(detail || '').slice(0, 1500) })).response === 1;
  const wrapApi = fn => async (...a) => { try { return await fn(...a); } catch (e) { return { ok: false, code: e.code || 'ERROR', error: String((e && e.message) || e), retryAfterMs: e.retryAfterMs || null }; } };

  /* ── Phase 5: Orion Central (klien desktop) ──
   * Token disimpan di main process (tidak pernah di renderer), dan hanya di-memory per sesi.
   * Outbox event lokal tahan restart. Status sinkronisasi ditampilkan di UI. */
  const centralOutbox = new Outbox(path.join(userData, 'central-outbox'));
  const centralClient = new CentralClient({ baseUrl: (cfg.central && cfg.central.url) || process.env.ORION_CENTRAL_URL || '' });
  const centralState = { connected: false, lastSyncAt: null, lastError: null, pending: 0 };

  handle('central:status', () => {
    centralState.pending = centralOutbox.count();
    return { status: { connected: centralState.connected, lastSyncAt: centralState.lastSyncAt, lastError: centralState.lastError, pending: centralState.pending, configured: !!centralClient.baseUrl, hasToken: centralClient.hasToken } };
  });
  handle('central:setToken', (token) => {
    const t = String(token || '').trim();
    if (!t || t.length < 20) throw new Error('TOKEN_TIDAK_VALID');
    centralClient.setToken(t);
    return { ok: true };
  });
  handle('central:clearToken', () => { centralClient.setToken(null); return { ok: true }; });
  handle('central:enqueue', (type, payload) => {
    const t = String(type || '');
    if (!/^[a-z0-9_.]{3,40}$/.test(t)) throw new Error('EVENT_TYPE_INVALID');
    const ev = centralOutbox.enqueue(t, payload && typeof payload === 'object' ? payload : {});
    return { ok: true, eventId: ev.eventId, pending: centralOutbox.count() };
  });
  handle('central:sync', async () => {
    if (!centralClient.baseUrl || !centralClient.hasToken) throw new Error('CENTRAL_NOT_CONFIGURED');
    const pending = centralOutbox.pending(200);
    let accepted = 0, duplicates = 0, rejected = 0;
    if (pending.length){
      const res = await centralClient.pushEvents(pending);
      accepted = res.accepted || 0; duplicates = res.duplicates || 0; rejected = res.rejected || 0;
      // tandai synced HANYA setelah server mengonfirmasi commit
      const done = pending.filter(e => res.accepted > 0 || res.duplicates > 0).map(e => e.eventId);
      centralOutbox.markSynced(done);
    }
    centralState.connected = true;
    centralState.lastSyncAt = new Date().toISOString();
    centralState.lastError = null;
    return { ok: true, accepted, duplicates, rejected, pending: centralOutbox.count(), cursor: res && res.cursor };
  });
  handle('central:pull', async (after) => {
    if (!centralClient.baseUrl || !centralClient.hasToken) throw new Error('CENTRAL_NOT_CONFIGURED');
    const res = await centralClient.pullEvents(parseInt(after, 10) || 0, 100);
    return { events: res.events || [], cursor: res.cursor || 0 };
  });
  handle('central:migrateLocal', async (opts2) => {
    const dryRun = !!(opts2 && opts2.dryRun);
    const memDir = path.join(userData, 'memory');
    const skDir = path.join(userData, 'skill-versions');
    const memRecs = new MemoryStore(memDir).loadAll();
    const skRecs = new SkillStore(skDir).loadAll();
    const memPlan = migrator.planMemory(memRecs, { ownerId: 'local' });
    const skPlan = migrator.planSkills(skRecs, { ownerId: 'local' });
    const report = {
      dryRun,
      memory: memPlan.counts,
      skills: skPlan.counts,
      checksum: migrator.reportChecksum({ memory: memPlan.counts, skills: skPlan.counts })
    };
    // Dry-run = analisis lokal murni; boleh dijalankan tanpa server (offline).
    if (dryRun) return { report };
    if (!centralClient.baseUrl || !centralClient.hasToken) throw new Error('CENTRAL_NOT_CONFIGURED');
    // Unggah metadata ke tabel server (provenance dipertahankan; endpoint server
    // yang memvalidasi & menerapkan — renderer tidak menulis langsung ke DB).
    const memRes = await centralClient.importMemory(memRecs);
    const skRes = await centralClient.importSkillVersions(skRecs);
    report.imported = { memory: memRes, skills: skRes };
    return { report };
  });

  /* ── Phase C: integrasi Desktop ↔ Orion Central ──
   * Token perangkat disimpan terenkripsi di main process (safeStorage) — renderer tidak pernah
   * melihat token. Outbox pesan persisten; SSE + delta feed untuk sinkronisasi. */
  const centralDesktop = new CentralDesktop({
    userData,
    getWindow: () => (typeof getWindow === 'function' ? getWindow() : null),
    readToken: (name) => {
      const v = cfg.secrets && cfg.secrets[secName(name)];
      if (!v || !secOk()) return null;
      try { return safeStorage.decryptString(Buffer.from(v, 'base64')); } catch (e) { return null; }
    },
    writeToken: (name, value) => {
      if (value == null) delete cfg.secrets[secName(name)];
      else cfg.secrets[secName(name)] = safeStorage.encryptString(String(value)).toString('base64');
      saveCfg();
    },
    readState: () => cfg.central || {},
    writeState: (patch) => { cfg.central = Object.assign({}, cfg.central || {}, patch); saveCfg(); },
    baseUrl: (cfg.central && cfg.central.url) || process.env.ORION_CENTRAL_URL || '',
    log: (m) => logLine('central', m)
  });
  if (centralDesktop.baseUrl) centralDesktop.start();

  handle('central:desktopStatus', () => ({ status: centralDesktop.getStatus() }));
  handle('central:desktopLogin', async (token) => {
    const s = await centralDesktop.login(token);
    return { ok: true, session: s };
  });
  handle('central:desktopLogout', async () => { await centralDesktop.logout(); return { ok: true }; });
  handle('central:desktopSetUrl', async (url) => {
    const u = String(url || '').trim();
    if (u && !/^https?:\/\//i.test(u)) throw new Error('URL_TIDAK_VALID');
    cfg.central = Object.assign({}, cfg.central || {}, { url: u });
    saveCfg();
    centralDesktop.baseUrl = u;
    centralDesktop.start();
    return { ok: true };
  });
  handle('central:desktopList', async () => await centralDesktop.listConversations());
  handle('central:desktopGet', async (id) => await centralDesktop.getConversation(String(id || '')));
  handle('central:desktopCreate', async (title, clientKey) => await centralDesktop.createConversation(String(title || 'Percakapan baru'), String(clientKey || '')));
  handle('central:desktopUpdate', async (id, patch) => await centralDesktop.updateConversation(String(id || ''), patch && typeof patch === 'object' ? patch : {}));
  handle('central:desktopRemove', async (id) => await centralDesktop.removeConversation(String(id || '')));
  handle('central:desktopSend', async (conversationId, msg) => await centralDesktop.sendMessage(String(conversationId || ''), msg && typeof msg === 'object' ? msg : {}));
  handle('central:desktopSync', async () => { const changes = await centralDesktop.catchUp(); await centralDesktop.flushOutbox(); return { ok: true, changes: changes.length, status: centralDesktop.getStatus() }; });
  handle('central:desktopImport', async (convos) => {
    const list = convos && Array.isArray(convos.conversations) ? convos.conversations : (Array.isArray(convos) ? convos : []);
    const rep = await centralDesktop.importConversations(list);
    return { report: rep };
  });

  /* ── Phase 4: memory provenance + versioned skills (trusted main-process services) ── */
  const memoryDir = path.join(userData, 'memory');
  const skillDir = path.join(userData, 'skill-versions');
  const memorySvc = new MemoryService(new MemoryStore(memoryDir), { owner: 'owner' });
  const skillReg = new SkillRegistry(new SkillStore(skillDir), { owner: 'owner' });
  // Caller scope untuk akses memori: renderer TIDAK boleh menentukan sendiri; scope hanya enum
  // yang divalidasi, dan nilai tak dikenal jatuh ke scope paling ketat.
  const SCOPES = new Set(['global', 'project', 'mission', 'session', 'skill']);
  const scopeOf = v => (SCOPES.has(String(v)) ? String(v) : 'global');
  // Skill tidak boleh memberi dirinya sendiri hak akses memori/secret.
  const skillPolicyChecker = (req) => {
    const p = String((req && req.permission) || '');
    if (['secret:read', 'secret:read-all', 'filesystem:unrestricted', 'policy:override', 'approval:bypass', 'system:admin'].includes(p)) {
      return { effect: 'deny', reason: 'Izin skill tidak diizinkan: ' + p };
    }
    return { effect: 'allow', reason: 'Izin skill diterima: ' + p };
  };

  handle('memory:create', (rec, scope) => {
    const out = memorySvc.create(rec && typeof rec === 'object' ? rec : {}, scopeOf(scope));
    return { record: out };
  });
  handle('memory:get', (id, scope) => ({ record: memorySvc.get(String(id || ''), scopeOf(scope)) }));
  handle('memory:list', (filters) => {
    const f = filters && typeof filters === 'object' ? filters : {};
    return { records: memorySvc.list({ scope: f.scope, type: f.type, status: f.status, missionId: f.missionId, callerScope: scopeOf(f.callerScope) }) };
  });
  handle('memory:search', (query, filters) => {
    const f = filters && typeof filters === 'object' ? filters : {};
    const r = memorySvc.search(String(query || ''), { scope: f.scope, type: f.type, status: f.status, missionId: f.missionId, callerScope: scopeOf(f.callerScope) });
    return { results: r.results, insufficientEvidence: r.insufficientEvidence, reason: r.reason || '' };
  });
  handle('memory:update', (id, patch, scope) => ({ record: memorySvc.update(String(id || ''), patch && typeof patch === 'object' ? patch : {}, scopeOf(scope)) }));
  handle('memory:supersede', (id, reason, scope) => ({ record: memorySvc.supersede(String(id || ''), reason, scopeOf(scope)) }));
  handle('memory:delete', (id, scope) => ({ record: memorySvc.delete(String(id || ''), scopeOf(scope)) }));
  handle('memory:conflicts', (rec, scope) => ({ records: memorySvc.detectConflict(rec && typeof rec === 'object' ? rec : {}, scopeOf(scope)) }));

  handle('skillversion:register', (manifest, body) => ({ version: skillReg.registerVersion(manifest && typeof manifest === 'object' ? manifest : {}, String(body || ''), { owner: 'owner' }) }));
  handle('skillversion:list', (filter) => {
    const f = filter && typeof filter === 'object' ? filter : {};
    return { versions: skillReg.list({ skillId: f.skillId, state: f.state }) };
  });
  handle('skillversion:get', (versionId) => ({ version: skillReg.get(String(versionId || '')) }));
  handle('skillversion:evaluate', (versionId) => {
    const res = skillReg.evaluate(String(versionId || ''), { owner: 'owner', policyChecker: skillPolicyChecker });
    return { reportId: res.reportId, report: res.report, version: res.version };
  });
  handle('skillversion:activate', (versionId) => {
    const res = skillReg.activate(String(versionId || ''), { owner: 'owner' });
    return { versionId: res.versionId, previous: res.previous, version: res.version };
  });
  handle('skillversion:deactivate', (versionId) => ({ version: skillReg.deactivate(String(versionId || ''), { owner: 'owner' }) }));
  handle('skillversion:quarantine', (versionId, reason) => ({ version: skillReg.quarantine(String(versionId || ''), String(reason || ''), { owner: 'owner' }) }));
  handle('skillversion:rollback', (versionId) => {
    const res = skillReg.rollback(String(versionId || ''), { owner: 'owner' });
    return { versionId: res.versionId, previous: res.previous, version: res.version };
  });
  handle('skillversion:active', (skillId) => ({ version: skillReg.getActive(String(skillId || '')) }));
  handle('skillversion:backup', () => {
    const dest = path.join(userData, 'backups', 'skills');
    fs.mkdirSync(dest, { recursive: true });
    return { files: new SkillStore(skillDir).backup(dest) };
  });



  /* Alat web: pencarian realtime, pembaca halaman, discovery (semua lewat gateway yang sama) */
  const web = createWebTools({
    gateway: hub.gateway, guard: hub.guard, secrets: hub.secrets, audit: hub.audit, getConfig: () => cfg.search,
    approveHost: async i => {
      const r = await dialog.showMessageBox(getWindow() || undefined, {
        type: 'warning', buttons: ['Tolak', 'Izinkan'], defaultId: 0, cancelId: 0, noLink: true, title: 'ORION — Izinkan membuka halaman web',
        message: `Izinkan Orion membuka halaman dari ${i.host}?`,
        detail: `URL: ${i.url}\nTujuan: ${i.purpose}\nIsi halaman dibaca dan sebagian diteruskan ke model AI sebagai DATA tidak tepercaya. Hanya permintaan GET; IP privat/internal diblokir.`,
        checkboxLabel: i.noRemember ? undefined : 'Izinkan host ini selama sesi', checkboxChecked: false
      });
      return { ok: r.response === 1, remember: r.response === 1 && !!r.checkboxChecked };
    }
  });
  let discoverOk = false;
  handle('web:overview', () => ({ providers: web.providers(), config: cfg.search, sessions: web.sessions(), secureStore: storageOk() }));
  handle('web:config:set', wrapApi(async patch => {
    const p = patch || {}; const next = Object.assign({}, cfg.search);
    if (p.provider !== undefined) { if (!SEARCH_PROVIDERS[p.provider]) throw new Error('Penyedia tidak dikenal.'); next.provider = p.provider; }
    if (p.searxngBase !== undefined) {
      if (p.searxngBase === '') next.searxngBase = '';
      else { const u = hub.guard.validateUrl(String(p.searxngBase), { anyPublic: true }); next.searxngBase = (u.origin + u.pathname).replace(/\/+$/, '').slice(0, 200); }
    }
    if (p.googleCx !== undefined) { if (p.googleCx !== '' && !/^[A-Za-z0-9:_-]{3,100}$/.test(String(p.googleCx))) throw new Error('Nilai cx tidak valid.'); next.googleCx = String(p.googleCx); }
    cfg.search = next; saveCfg(); hub.audit.record({ kind: 'web.config', provider: next.provider }); return { ok: true, config: next };
  }));
  handle('web:key:set', wrapApi(async (provider, value) => {
    if (!SEARCH_PROVIDERS[provider] || !SEARCH_PROVIDERS[provider].secret) throw new Error('Penyedia ini tidak memakai API key.');
    hub.secrets.set('search-' + provider, 'apiKey', value); hub.audit.record({ kind: 'secret.set', connectorId: 'search-' + provider, name: 'apiKey' }); return { ok: true };
  }));
  handle('web:key:del', wrapApi(async provider => { if (SEARCH_PROVIDERS[provider]) hub.secrets.delete('search-' + provider, 'apiKey'); return { ok: true }; }));
  handle('web:session:start', wrapApi(async spec => {
    const sp = spec || {}; const provider = String(sp.provider || cfg.search.provider); const P = SEARCH_PROVIDERS[provider];
    if (!P) throw new Error('Penyedia tidak dikenal.');
    const research = sp.mode === 'research';
    const detail = `Penyedia: ${P.label}\nMode: ${research ? 'riset mendalam (maks 25 pencarian, 20 halaman)' : 'pencarian (maks 10 pencarian, 8 halaman)'}\nKueri pencarian dikirim ke penyedia tersebut; hasil dianggap data tidak tepercaya.\nHalaman web: ${sp.allowAllHosts ? 'SEMUA host publik diizinkan tanpa tanya (model dapat membuka halaman mana pun — ada risiko kebocoran data lewat URL)' : 'Anda akan ditanya per host'}.`;
    if (!(await askUser(research ? 'Mulai riset web' : 'Mulai pencarian web', 'Izinkan sesi chat ini mencari di web?', detail, 'Izinkan'))) throw Object.assign(new Error('Ditolak oleh pengguna.'), { code: 'USER_REJECTED' });
    return { ok: true, session: web.startSession({ provider, mode: research ? 'research' : 'search', allowAllHosts: sp.allowAllHosts === true }) };
  }));
  handle('web:session:end', wrapApi(async id => { web.endSession(String(id)); return { ok: true }; }));
  handle('web:search', wrapApi(async (sid, req) => Object.assign({ ok: true }, await web.search(String(sid), req && req.query, req && req.max))));
  handle('web:fetch', wrapApi(async (sid, req) => Object.assign({ ok: true }, await web.fetchPage(String(sid), req && req.url))));
  handle('data:fetchUrl', wrapApi(async req => Object.assign({ ok: true }, await web.fetchUserPage(req && req.url))));
  handle('discover:search', wrapApi(async req => {
    if (!discoverOk) {
      const r = await dialog.showMessageBox(getWindow() || undefined, { type: 'question', buttons: ['Batal', 'Cari'], defaultId: 0, cancelId: 0, noLink: true, title: 'ORION — Temukan kemampuan', message: 'Cari skill/plugin/MCP di GitHub?', detail: 'Kata kunci dikirim ke api.github.com (tanpa login). Hasil hanya untuk penemuan: tidak ada yang dipasang otomatis dan belum diperiksa keamanannya.', checkboxLabel: 'Jangan tanya lagi sampai aplikasi ditutup', checkboxChecked: false });
      if (r.response !== 1) throw Object.assign(new Error('Dibatalkan.'), { code: 'USER_REJECTED' });
      discoverOk = !!r.checkboxChecked;
    }
    return Object.assign({ ok: true }, await web.discover(String(req && req.kind), req && req.q));
  }));
  handle('discover:open', wrapApi(async url => {
    if (!/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/.test(String(url))) throw new Error('Hanya repositori GitHub yang dapat dibuka.');
    await shell.openExternal(String(url)); return { ok: true };
  }));
  handle('skills:install', wrapApi(async mode => {
    const file = mode === 'file';
    const r = await dialog.showOpenDialog(getWindow() || undefined, file ? { title: 'Pilih berkas SKILL.md', properties: ['openFile'], filters: [{ name: 'Markdown', extensions: ['md'] }] } : { title: 'Pilih folder skill (berisi SKILL.md)', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { ok: true, installed: null };
    const src = r.filePaths[0]; const skillFile = file ? src : path.join(src, 'SKILL.md');
    let st; try { st = fs.statSync(skillFile); } catch (e) { throw new Error('SKILL.md tidak ditemukan.'); }
    if (!st.isFile() || st.size > 64 * 1024) throw new Error('SKILL.md harus berkas ≤ 64 KB.');
    const meta = parseFrontmatter(fs.readFileSync(skillFile, 'utf8')).meta;
    if (!meta.name || !meta.description) throw new Error('SKILL.md harus punya frontmatter name dan description.');
    const slug = String(meta.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
    if (!slug) throw new Error('Nama skill tidak valid.');
    const extra = []; let total = 0;
    if (!file) {
      (function walk(dir, rel) {
        fs.readdirSync(dir, { withFileTypes: true }).forEach(d => {
          if (d.name.startsWith('.') || d.name === 'node_modules' || d.isSymbolicLink()) return;
          const full = path.join(dir, d.name), rp = rel ? rel + '/' + d.name : d.name;
          if (d.isDirectory()) { if (rp.split('/').length < 4) walk(full, rp); return; }
          if (rp === 'SKILL.md' || !/\.(md|txt|json|ya?ml)$/i.test(d.name) || extra.length >= 39) return;
          const sz = fs.statSync(full).size; if (total + sz > 1024 * 1024) return;
          total += sz; extra.push({ full, rp });
        });
      })(src, '');
    }
    if (!(await approve('Pasang skill', `Pasang skill "${meta.name}"?`, `${meta.description}\nBerkas: ${1 + extra.length}\nSkill adalah teks instruksi untuk model (tidak menjalankan kode) tetapi memengaruhi perilaku model. Pasang hanya dari sumber tepercaya.`))) throw Object.assign(new Error('Ditolak oleh pengguna.'), { code: 'USER_REJECTED' });
    const dest = path.join(userDirs.skills, slug);
    fs.rmSync(dest, { recursive: true, force: true }); fs.mkdirSync(dest, { recursive: true });
    fs.copyFileSync(skillFile, path.join(dest, 'SKILL.md'));
    extra.forEach(x => { const to = path.join(dest, x.rp); if (!path.resolve(to).startsWith(path.resolve(dest) + path.sep)) return; fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(x.full, to); });
    hub.audit.record({ kind: 'skill.install', name: slug, files: 1 + extra.length });
    return { ok: true, installed: slug };
  }));

  handle('api:overview', () => ({
    stats: hub.registry.stats(), connectors: hub.registry.list().map(hub.view), missions: hub.gateway.missions(), stopped: hub.gateway.isStopped(),
    secureStore: storageOk(), audit: hub.audit.verify()
  }));
  handle('api:catalog:list', f => hub.registry.listCatalog({ q: String((f && f.q) || '').slice(0, 80), category: f && f.category ? String(f.category).slice(0, 40) : '', auth: f && f.auth ? String(f.auth) : '', offset: Math.max(0, +((f && f.offset) || 0)), limit: 20 }));
  handle('api:catalog:sync', wrapApi(async () => {
    if (!(await askUser('Sinkron katalog API', 'Unduh daftar API publik dari GitHub?', 'Sumber: github.com/public-apis/public-apis (lisensi MIT)\nHanya mengunduh satu berkas README (maks 3 MB). Tidak ada API di katalog yang dipanggil.', 'Unduh'))) throw Object.assign(new Error('Dibatalkan.'), { code: 'USER_REJECTED' });
    return Object.assign({ ok: true }, await hub.syncCatalog());
  }));
  handle('api:catalog:importFile', wrapApi(async () => {
    const r = await dialog.showOpenDialog(getWindow() || undefined, { title: 'Pilih README.md public-apis', properties: ['openFile'], filters: [{ name: 'Markdown', extensions: ['md', 'txt'] }] });
    if (r.canceled || !r.filePaths[0]) return { ok: true, canceled: true };
    const st = fs.statSync(r.filePaths[0]); if (st.size > 3 * 1024 * 1024) throw new Error('Berkas > 3 MB.');
    const buf = fs.readFileSync(r.filePaths[0]);
    return Object.assign({ ok: true }, hub.importText(buf.toString('utf8'), { syncedAt: new Date().toISOString(), sha256: require('crypto').createHash('sha256').update(buf).digest('hex') }));
  }));
  handle('api:connector:review', wrapApi(async (input, catalogId) => { const c = hub.registry.review(input, { catalogId: catalogId || null }); hub.audit.record({ kind: 'connector.review', connectorId: c.id, risk: c.riskLevel }); return { ok: true, connector: hub.view(c) }; }));
  handle('api:connector:update', wrapApi(async (id, patch) => { const c = hub.registry.update(String(id), patch || {}); hub.audit.record({ kind: 'connector.update', connectorId: c.id, status: c.status }); return { ok: true, connector: hub.view(c) }; }));
  handle('api:connector:test', wrapApi(async id => Object.assign({}, await hub.gateway.test(String(id)), { connector: undefined })));
  handle('api:connector:enable', wrapApi(async id => {
    const c = hub.registry.get(String(id)); if (!c) throw new Error('Connector tidak ditemukan.');
    const ok = await askUser('Aktifkan connector API', `Aktifkan "${c.name}"? Aktif berarti mission yang Anda izinkan dapat memanggilnya sesuai kebijakan risiko.`,
      `Base URL: ${c.baseUrl}\nHost diizinkan: ${c.allowedHosts.join(', ')}\nMetode: ${c.allowedMethods.join(', ')}\nRisiko: ${c.riskLevel} · Data: ${c.dataClassification}\nAutentikasi: ${c.authType}\nBatas laju: ${c.rateLimit.perMinute}/menit · Biaya: ${c.usageCost.model}\nLisensi/ketentuan: ${c.license}\nUji terakhir: ${c.lastTest ? c.lastTest.at : '-'}`, 'Aktifkan');
    if (!ok) throw Object.assign(new Error('Dibatalkan.'), { code: 'USER_REJECTED' });
    const r = hub.registry.enable(c.id, 'user-dialog'); hub.audit.record({ kind: 'connector.enable', connectorId: c.id }); return { ok: true, connector: hub.view(r) };
  }));
  handle('api:connector:disable', wrapApi(async id => { const c = hub.registry.disable(String(id)); hub.audit.record({ kind: 'connector.disable', connectorId: c.id }); return { ok: true, connector: hub.view(c) }; }));
  handle('api:connector:revoke', wrapApi(async id => {
    if (!(await askUser('Cabut akses connector', 'Cabut akses connector ini secara permanen?', 'Secret-nya akan dihapus dan panggilan baru diblokir. Connector tidak bisa diaktifkan lagi.', 'Cabut'))) throw Object.assign(new Error('Dibatalkan.'), { code: 'USER_REJECTED' });
    return { ok: true, connector: hub.view(hub.revoke(String(id))) };
  }));
  handle('api:connector:remove', wrapApi(async id => { hub.registry.remove(String(id)); hub.secrets.deleteAll(String(id)); hub.audit.record({ kind: 'connector.remove', connectorId: String(id) }); return { ok: true }; }));
  handle('api:secret:set', wrapApi(async (id, name, value) => { hub.secrets.set(String(id), String(name), value); hub.audit.record({ kind: 'secret.set', connectorId: String(id), name: String(name) }); return { ok: true }; }));
  handle('api:secret:has', wrapApi(async (id, name) => ({ ok: true, has: hub.secrets.has(String(id), String(name)) })));
  handle('api:secret:del', wrapApi(async (id, name) => { hub.secrets.delete(String(id), String(name)); hub.audit.record({ kind: 'secret.delete', connectorId: String(id), name: String(name) }); return { ok: true }; }));
  handle('api:mission:start', wrapApi(async spec => {
    const sp = spec || {};
    const list = (sp.connectors || []).map(id => hub.registry.get(String(id))).filter(Boolean);
    const detail = list.map(c => `• ${c.name} — ${c.riskLevel}, ${c.allowedMethods.join('/')}, ${c.allowedHosts[0]}`).join('\n') + `\n\nMaks panggilan: ${sp.maxCalls || 25}\nOperasi tulis: ${sp.allowWrites ? 'DIIZINKAN (tetap minta persetujuan tiap panggilan)' : 'tidak'}`;
    if (!(await askUser('Mulai mission dengan API connector', 'Izinkan sesi chat ini memanggil connector berikut?', detail, 'Izinkan'))) throw Object.assign(new Error('Ditolak oleh pengguna.'), { code: 'USER_REJECTED' });
    return { ok: true, mission: hub.gateway.startMission({ name: String(sp.name || 'Chat').slice(0, 80), connectors: sp.connectors, maxCalls: sp.maxCalls, allowWrites: sp.allowWrites === true }) };
  }));
  handle('api:mission:end', wrapApi(async id => { hub.gateway.endMission(String(id)); return { ok: true }; }));
  handle('api:call', wrapApi(async (missionId, req) => {
    const r = await hub.gateway.call({ source: 'model', missionId: String(missionId) }, String(req && req.connector), { method: req && req.method, path: req && req.path, query: req && req.query, body: req && req.body });
    return { ok: true, text: hub.gateway.toModelText(r, 12000), provenance: r.provenance };
  }));
  handle('api:stop', wrapApi(async () => { // emergency stop menyeluruh: API gateway + server MCP + proses anak
    const r = hub.gateway.stopAll('manual');
    const killed = procs.size; procs.forEach(killTree); procs.clear(); mcp.stopAll(); web.endAll();
    hub.audit.record({ kind: 'emergency.scope', killedProcesses: killed, mcpStopped: true });
    return Object.assign({ ok: true, killedProcesses: killed }, r);
  }));
  handle('api:resume', wrapApi(async () => {
    if (!(await askUser('Lanjutkan setelah emergency stop', 'Izinkan panggilan API baru lagi?', 'Mission lama tidak diaktifkan kembali; mulai mission baru bila perlu.', 'Lanjutkan'))) throw Object.assign(new Error('Dibatalkan.'), { code: 'USER_REJECTED' });
    hub.gateway.resume(); return { ok: true };
  }));
  handle('api:audit:tail', n => ({ records: hub.audit.tail(Math.min(100, +n || 20)) }));
  handle('api:audit:verify', () => hub.audit.verify());

  /* fitur eksperimental (default MATI) */
  handle('app:setExperimental', wrapApi(async (name, on) => {
    if (name !== 'remoteMcp') throw new Error('Fitur tidak dikenal.');
    if (on && !(await askUser('Aktifkan MCP jarak jauh (eksperimental)', 'Izinkan koneksi ke server MCP lewat internet?', 'Blueprint menempatkan fitur ini setelah validasi aplikasi native. Argumen tool dan hasilnya melewati server pihak ketiga. Tetap minta izin tiap panggilan; host privat/metadata diblokir.', 'Aktifkan'))) throw Object.assign(new Error('Dibatalkan.'), { code: 'USER_REJECTED' });
    cfg.experimental = Object.assign({}, cfg.experimental, { remoteMcp: !!on }); saveCfg(); return { ok: true, remoteMcp: !!on };
  }));

  /* MCP */
  async function approveMcp(title, message, detail, allowSession) {
    const buttons = allowSession ? ['Batal', 'Izinkan', 'Izinkan semua dari server ini (sesi)'] : ['Batal', 'Izinkan'];
    const r = await dialog.showMessageBox(getWindow() || undefined, { type: 'warning', buttons, defaultId: 0, cancelId: 0, noLink: true, title: 'ORION — ' + title, message, detail: String(detail || '').slice(0, 1500) });
    return r.response === 0 ? 'deny' : r.response === 1 ? 'once' : 'session';
  }
  const mcp = createMcp({
    getEnv, version: app.getVersion(), cwd: () => cfg.workspace, approve: approveMcp, lookup: hub.guard.lookup,
    allowRemote: () => !!(cfg.experimental && cfg.experimental.remoteMcp),
    getToken: id => { // token server MCP jarak jauh: terenkripsi, dan TIDAK dapat dibaca renderer
      try { const v = (cfg.mcpTokens || {})[id]; return v && secOk() ? safeStorage.decryptString(Buffer.from(v, 'base64')) : ''; } catch (e) { return ''; }
    },
    load: () => cfg.mcpServers || [], save: list => { cfg.mcpServers = list; saveCfg(); }
  });
  app.on('before-quit', () => mcp.stopAll());
  handle('mcp:list', () => ({ servers: mcp.list() }));
  handle('mcp:add', (spec, token) => {
    const sp = validateMcpSpec(spec);
    if (sp.url && !(cfg.experimental && cfg.experimental.remoteMcp)) throw new Error(REMOTE_OFF);
    const tok = typeof token === 'string' ? token.trim() : '';
    if (sp.url && tok && !secOk()) throw new Error('Penyimpanan aman OS tidak tersedia — token tidak bisa disimpan.');
    mcp.add(sp);
    cfg.mcpTokens = cfg.mcpTokens || {};
    if (sp.url && tok) cfg.mcpTokens[sp.id] = safeStorage.encryptString(tok).toString('base64'); else delete cfg.mcpTokens[sp.id];
    saveCfg(); return {};
  });
  handle('mcp:remove', id => { mcp.remove(String(id)); if (cfg.mcpTokens) { delete cfg.mcpTokens[String(id)]; saveCfg(); } return {}; });
  handle('mcp:start', async id => ({ tools: (await mcp.start(String(id))).tools }));
  handle('mcp:stop', id => { mcp.stop(String(id)); return {}; });
  handle('mcp:call', async (id, tool, args) => mcp.call(String(id), String(tool), args && typeof args === 'object' ? args : {}));

  /* REA (reverse engineering MCP): diagnostik hanya-baca dengan versi terpin */
  handle('rea:doctor', async version => {
    const v = String(version || '');
    if (!/^(latest|\d+\.\d+\.\d+)$/.test(v)) throw new Error('Versi tidak valid (contoh: 6.4.0).');
    const args = ['-y', 'rea-agents@' + v, 'doctor', '--json'];
    if (!(await approve('Jalankan REA Doctor', 'Izinkan diagnostik REA (hanya-baca)? npx dapat mengunduh paket rea-agents dari npm.', 'npx ' + args.join(' ')))) throw new Error('Ditolak oleh pengguna.');
    return runProc('npx', args, { cwd: userData, shell: process.platform === 'win32', timeout: 180000 });
  });

  /* skills & plugins */
  const skillFiles = new Map();
  function scanSkills(dir, source, plugin) {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch (e) { return []; }
    const out = [];
    names.forEach(n => {
      const file = path.join(dir, n, 'SKILL.md');
      try {
        const st = fs.statSync(file);
        if (!st.isFile() || st.size > 64 * 1024) return;
        const { meta } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
        const name = /^[\w .-]{1,64}$/.test(meta.name || '') ? meta.name : n;
        const id = [source, plugin || '', n].join('/');
        skillFiles.set(id, file);
        out.push({ id, name, description: (meta.description || '').slice(0, 300), agent: meta.agent || '', source, plugin: plugin || '' });
      } catch (e) { /* lewati skill rusak */ }
    });
    return out;
  }
  function scanPlugins() {
    const list = [];
    [[path.join(resRoot, 'plugins'), 'bundled'], [userDirs.plugins, 'user']].forEach(([root, source]) => {
      let names = [];
      try { names = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name); } catch (e) { return; }
      names.forEach(n => {
        try {
          const m = validatePluginManifest(readJson(path.join(root, n, 'plugin.json')), n);
          m.source = source; m.dir = path.join(root, n);
          list.push(m);
        } catch (e) { list.push({ id: 'invalid:' + n, name: n, invalid: String(e.message), source, commands: [], permissions: [] }); }
      });
    });
    return list;
  }
  handle('skills:list', () => {
    skillFiles.clear();
    let skills = scanSkills(path.join(resRoot, 'skills'), 'bundled', '').concat(scanSkills(userDirs.skills, 'user', ''));
    scanPlugins().filter(p => !p.invalid).forEach(p => { skills = skills.concat(scanSkills(path.join(p.dir, 'skills'), p.source, p.id)); });
    return { skills };
  });
  handle('skills:read', id => {
    const file = skillFiles.get(String(id));
    if (!file) throw new Error('Skill tidak ditemukan (muat ulang daftar).');
    const { meta, body } = parseFrontmatter(fs.readFileSync(file, 'utf8'));
    return { name: meta.name || path.basename(path.dirname(file)), body: body.trim().slice(0, 24000) };
  });
  handle('plugins:list', () => ({ plugins: scanPlugins().map(p => { const q = Object.assign({}, p); delete q.dir; return q; }) }));
  handle('plugins:install', async () => {
    const r = await dialog.showOpenDialog(getWindow() || undefined, { title: 'Pilih folder plugin (berisi plugin.json)', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return { installed: null };
    const src = r.filePaths[0];
    const m = validatePluginManifest(readJson(path.join(src, 'plugin.json')), path.basename(src));
    const dest = path.join(userDirs.plugins, m.id);
    const ok = await approve('Pasang plugin', `Pasang plugin "${m.name}" v${m.version}?`,
      'Plugin bersifat deklaratif (prompt + skill), tidak menjalankan kode.\nIzin dinyatakan: ' + (m.permissions.join(', ') || '-') + '\nSumber: ' + src);
    if (!ok) throw new Error('Ditolak oleh pengguna.');
    fs.rmSync(dest, { recursive: true, force: true });
    fs.cpSync(src, dest, { recursive: true, filter: s => !/node_modules|\.git$/.test(s) });
    return { installed: m.id };
  });
  handle('plugins:remove', async id => {
    if (!ID_RE.test(String(id))) throw new Error('id tidak valid.');
    const dest = path.join(userDirs.plugins, id);
    if (!fs.existsSync(dest)) throw new Error('Hanya plugin buatan pengguna yang bisa dihapus.');
    if (!(await approve('Hapus plugin', `Hapus plugin "${id}"?`, dest))) throw new Error('Ditolak oleh pengguna.');
    fs.rmSync(dest, { recursive: true, force: true });
    return {};
  });
}

module.exports = { register, parseFrontmatter, makeSafePath, isSecretName, validatePluginManifest };
