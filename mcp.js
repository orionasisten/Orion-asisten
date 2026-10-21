'use strict';
/**
 * Klien MCP (Model Context Protocol), JSON-RPC 2.0. Dua transport:
 *   - stdio  : server lokal berupa proses anak (pesan dipisah newline)
 *   - http   : "Streamable HTTP" untuk server jarak jauh (POST; balasan JSON atau SSE; header Mcp-Session-Id)
 * Tidak bergantung pada Electron sehingga bisa diuji dengan Node biasa; HTTP memakai modul http/https
 * bawaan (Electron 22 / Node 16 belum punya fetch di main process).
 * Keamanan: server hanya terhubung setelah persetujuan pengguna; setiap pemanggilan tool juga meminta
 * persetujuan (kecuali pengguna memilih "izinkan semua dari server ini" untuk sesi).
 */
const { spawn } = require('child_process');
const http = require('http');
const https = require('https');

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_RESULT = 100 * 1024;
const MAX_BODY = 4 * 1024 * 1024;
const hasCtl = s => /[\u0000-\u001f]/.test(s);
// Variabel environment per server (stdio). Yang dapat membelokkan loader/interpreter/jaringan diblokir.
const ENV_DENY = /^(PATH|PATHEXT|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED|LD_[A-Z0-9_]*|DYLD_[A-Z0-9_]*|PYTHON[A-Z0-9_]*|PERL[A-Z0-9_]*|RUBY[A-Z0-9_]*|ELECTRON_[A-Z0-9_]*|COMSPEC|SHELL|IFS|BASH_ENV|ENV|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TMPDIR|TEMP|TMP|SSL_CERT_[A-Z0-9_]*|HTTPS?_PROXY|ALL_PROXY|NO_PROXY|NPM_CONFIG_[A-Z0-9_]*)$/;

function validateEnv(e) {
  const out = {};
  if (!e || typeof e !== 'object') return out;
  const keys = Object.keys(e);
  if (keys.length > 10) throw new Error('Maksimal 10 variabel environment.');
  keys.forEach(k => {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k)) throw new Error('Nama variabel env tidak valid: ' + k + ' (huruf besar, angka, _).');
    if (ENV_DENY.test(k)) throw new Error('Variabel env diblokir demi keamanan: ' + k);
    const v = String(e[k]);
    if (v.length > 500 || hasCtl(v)) throw new Error('Nilai env tidak valid: ' + k);
    out[k] = v;
  });
  return out;
}

function validateSpec(s) {
  if (!s || !ID_RE.test(String(s.id || ''))) throw new Error('id server: huruf kecil/angka/-/_ (maks 32 karakter).');
  const name = String(s.name || s.id).slice(0, 60);
  if (s.url) {
    let u;
    try { u = new URL(String(s.url)); } catch (e) { throw new Error('URL tidak valid.'); }
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
    if (!(u.protocol === 'https:' || (u.protocol === 'http:' && local))) throw new Error('URL harus https:// (http:// hanya untuk localhost).');
    if (u.username || u.password) throw new Error('Jangan menaruh kredensial di URL; gunakan kolom token.');
    return Object.assign({ id: s.id, name, transport: 'http', url: u.toString() }, s.strict ? { strict: true } : {});
  }
  const command = String(s.command || '').trim();
  if (!command || command.length > 200 || hasCtl(command)) throw new Error('Command tidak valid.');
  const args = Array.isArray(s.args) ? s.args.map(String) : [];
  if (args.length > 20 || args.some(a => a.length > 500 || hasCtl(a))) throw new Error('Argumen tidak valid (maks 20, tanpa karakter kontrol).');
  const env = validateEnv(s.env);
  return Object.assign({ id: s.id, name, transport: 'stdio', command, args },
    Object.keys(env).length ? { env } : {}, s.strict ? { strict: true } : {});
}

/* Windows: npx/uvx berupa .cmd sehingga perlu shell. Karakter meta cmd.exe ditolak agar baris
   perintah yang dilihat pengguna di dialog persis sama dengan yang dijalankan. */
function winLine(command, args) {
  const all = [command].concat(args);
  all.forEach(a => { if (/["%^&|<>]/.test(a)) throw new Error('Karakter khusus (" % ^ & | < >) tidak diizinkan pada argumen di Windows.'); });
  return all.map(a => (/\s/.test(a) ? '"' + a + '"' : a)).join(' ');
}

class McpServer {
  constructor(spec, deps) {
    this.spec = spec; this.deps = deps;
    this.status = 'stopped'; this.error = ''; this.tools = [];
    this.proc = null; this.buf = ''; this.nextId = 1; this.pending = new Map(); this.tail = ''; this.sessionAllow = false;
  }

  _alive() { return !!this.proc; }
  _send(o) { if (this.proc && this.proc.stdin.writable) this.proc.stdin.write(JSON.stringify(o) + '\n'); }

  _rejectAll(err) {
    this.pending.forEach(p => { clearTimeout(p.timer); p.reject(err); });
    this.pending.clear();
  }

  _onLine(line) { let m; try { m = JSON.parse(line); } catch (e) { return; } this._onMessage(m); }

  _onMessage(m) {
    if (Array.isArray(m)) return m.forEach(x => this._onMessage(x));
    if (!m || typeof m !== 'object') return;
    if (m.method && m.id !== undefined) { // permintaan dari server: kita tidak mengiklankan kapabilitas apa pun
      this._send(Object.assign({ jsonrpc: '2.0', id: m.id }, m.method === 'ping' ? { result: {} } : { error: { code: -32601, message: 'Method not found' } }));
    } else if (m.id !== undefined && !m.method) {
      const p = this.pending.get(m.id); if (!p) return;
      this.pending.delete(m.id); clearTimeout(p.timer);
      if (m.error) p.reject(new Error(m.error.message || 'Kesalahan MCP')); else p.resolve(m.result);
    }
  }

  request(method, params, timeout) {
    return new Promise((resolve, reject) => {
      if (!this._alive()) return reject(new Error('Server tidak berjalan.'));
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Timeout: ' + method)); }, timeout || 30000);
      this.pending.set(id, { resolve, reject, timer });
      this._send({ jsonrpc: '2.0', id, method, params });
    });
  }

  async start() {
    if (this.status === 'running' || this.status === 'starting') return;
    this.status = 'starting'; this.error = ''; this.tools = []; this.tail = ''; this.buf = '';
    const env = Object.assign({}, await this.deps.getEnv(), this.spec.env || {});
    const cwd = this.deps.cwd && this.deps.cwd() ? this.deps.cwd() : undefined;
    const { command, args } = this.spec;
    const win = process.platform === 'win32';
    const proc = win
      ? spawn(winLine(command, args), [], { env, cwd, shell: true, windowsHide: true })
      : spawn(command, args, { env, cwd, detached: true });
    this.proc = proc;
    proc.on('error', e => {
      this.error = e.code === 'ENOENT' ? `"${command}" tidak ditemukan di PATH (pasang Node.js/uv dulu).` : e.message;
      this.status = 'error'; this._rejectAll(new Error(this.error));
    });
    proc.on('close', code => {
      if (this.proc === proc) this.proc = null;
      if (this.status === 'stopping') this.status = 'stopped';
      else if (this.status !== 'error') {
        this.status = code === 0 ? 'stopped' : 'error';
        if (code !== 0) {
          const tail = this.tail.trim();
          /* Di Windows perintah dijalankan lewat shell, jadi perintah yang tidak ada dilaporkan
           * cmd.exe sebagai teks biasa alih-alih ENOENT. Samakan pesannya dengan platform lain. */
          this.error = /(is not recognized as an internal or external command|not recognized as a name of a cmdlet|command not found|No such file or directory)/i.test(tail)
            ? `"${command}" tidak ditemukan di PATH (pasang Node.js/uv dulu).`
            : `Proses berhenti (kode ${code}). ${tail.slice(-300)}`;
        }
      }
      this._rejectAll(new Error('Server berhenti.'));
    });
    proc.stdout.on('data', d => {
      this.buf += d.toString('utf8');
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) { const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1); if (line) this._onLine(line); }
      if (this.buf.length > MAX_BODY) this.buf = '';
    });
    proc.stderr.on('data', d => { this.tail = (this.tail + d.toString('utf8')).slice(-4000); });
    proc.stdin.on('error', () => { /* proses sudah mati */ });
    await this._handshake(90000, '2024-11-05', () => this.tail);
  }

  async _handshake(initTimeout, version, tailFn) {
    try {
      const init = await this.request('initialize', { protocolVersion: version, capabilities: {}, clientInfo: { name: 'orion-desktop', version: this.deps.version || '0' } }, initTimeout);
      this.serverInfo = init && init.serverInfo; this.protoVersion = (init && init.protocolVersion) || version;
      this._send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      this.tools = await this._listTools();
      this.status = 'running';
    } catch (e) {
      if (this.status !== 'error') { const t = tailFn(); this.status = 'error'; this.error = e.message + (t ? ' — ' + t.slice(-300) : ''); }
      this._kill();
    }
  }

  async _listTools() {
    const out = []; let cursor;
    for (let page = 0; page < 5; page++) {
      const r = await this.request('tools/list', cursor ? { cursor } : {}, 30000);
      (r.tools || []).forEach(t => out.push({ name: String(t.name), description: String(t.description || '').slice(0, 500), inputSchema: t.inputSchema || { type: 'object', properties: {} } }));
      if (!r.nextCursor) break; cursor = r.nextCursor;
    }
    return out;
  }

  async callTool(name, args) {
    if (this.status !== 'running') throw new Error('Server belum berjalan.');
    if (!this.tools.some(t => t.name === name)) throw new Error('Tool tidak dikenal: ' + name);
    const r = await this.request('tools/call', { name, arguments: args || {} }, 120000);
    let text = (r.content || []).map(c => (c.type === 'text' ? c.text : `[${c.type} tidak ditampilkan]`)).join('\n');
    if (!text && r.structuredContent !== undefined) text = JSON.stringify(r.structuredContent);
    const truncated = text.length > MAX_RESULT;
    return { text: truncated ? text.slice(0, MAX_RESULT) + '\n[HASIL DIPOTONG — bukan JSON utuh; minta tampilan ringkas/halaman berikutnya]' : text, isError: !!r.isError, truncated };
  }

  _kill() {
    const p = this.proc; if (!p) return;
    try {
      if (process.platform === 'win32') spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { windowsHide: true });
      else { process.kill(-p.pid, 'SIGTERM'); setTimeout(() => { try { process.kill(-p.pid, 'SIGKILL'); } catch (e) { /* sudah mati */ } }, 2000).unref(); }
    } catch (e) { try { p.kill('SIGKILL'); } catch (e2) { /* selesai */ } }
  }

  stop() { if (this.proc) { this.status = 'stopping'; this._kill(); } else if (this.status !== 'error') this.status = 'stopped'; }
}

/* ───── transport HTTP (Streamable HTTP) ───── */
class McpHttpServer extends McpServer {
  constructor(spec, deps) { super(spec, deps); this.live = false; this.sessionId = null; this.protoVersion = null; this.reqs = new Set(); }

  _alive() { return this.live; }

  _send(o) {
    this._post(o).catch(e => {
      if (o.id === undefined || !o.method) return; // notifikasi/balasan: abaikan kegagalan; hanya request yang ditolak
      const p = this.pending.get(o.id);
      if (p) { this.pending.delete(o.id); clearTimeout(p.timer); p.reject(e); }
    });
  }

  _post(o) {
    return new Promise((resolve, reject) => {
      const u = new URL(this.spec.url);
      const lib = u.protocol === 'https:' ? https : http;
      const body = JSON.stringify(o);
      const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'Content-Length': Buffer.byteLength(body) };
      if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
      if (this.protoVersion) headers['MCP-Protocol-Version'] = this.protoVersion;
      const tok = this.deps.getToken && this.deps.getToken(this.spec.id);
      if (tok) headers.Authorization = 'Bearer ' + tok;
      const req = lib.request(u, { method: 'POST', headers }, res => {
        const sid = res.headers['mcp-session-id']; if (sid) this.sessionId = String(sid);
        const code = res.statusCode;
        if (code === 202) { res.resume(); return resolve(); }
        if (code < 200 || code >= 300) {
          let d = ''; res.on('data', c => { if (d.length < 400) d += c; });
          res.on('end', () => reject(new Error('HTTP ' + code + (code === 401 || code === 403 ? ' — periksa token' : '') + (d ? ' — ' + d.replace(/\s+/g, ' ').slice(0, 160) : ''))));
          return;
        }
        const finish = () => {
          if (o.id !== undefined && o.method && this.pending.has(o.id)) reject(new Error('Server menutup respons tanpa jawaban.')); else resolve();
        };
        let size = 0;
        const sse = /text\/event-stream/i.test(String(res.headers['content-type'] || ''));
        let buf = '';
        res.setEncoding('utf8');
        res.on('data', c => {
          size += c.length; if (size > MAX_BODY) { req.destroy(new Error('Respons terlalu besar.')); return; }
          buf += c;
          if (!sse) return;
          let m;
          while ((m = /\r?\n\r?\n/.exec(buf))) {
            const block = buf.slice(0, m.index); buf = buf.slice(m.index + m[0].length);
            const data = block.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n');
            if (data) this._onLine(data);
          }
        });
        res.on('end', () => { if (!sse && buf.trim()) this._onLine(buf); finish(); });
        res.on('error', reject);
      });
      this.reqs.add(req);
      req.on('close', () => this.reqs.delete(req));
      req.on('error', reject);
      req.write(body); req.end();
    });
  }

  async start() {
    if (this.status === 'running' || this.status === 'starting') return;
    this.status = 'starting'; this.error = ''; this.tools = []; this.sessionId = null; this.protoVersion = null; this.live = true;
    await this._handshake(30000, '2025-03-26', () => '');
  }

  _kill() {
    this.live = false;
    this.reqs.forEach(r => { try { r.destroy(); } catch (e) { /* abaikan */ } });
    this._rejectAll(new Error('Koneksi ditutup.'));
    if (this.sessionId) { // akhiri sesi (best effort)
      try {
        const u = new URL(this.spec.url); const lib = u.protocol === 'https:' ? https : http;
        const h = { 'Mcp-Session-Id': this.sessionId }; const tok = this.deps.getToken && this.deps.getToken(this.spec.id); if (tok) h.Authorization = 'Bearer ' + tok;
        const r = lib.request(u, { method: 'DELETE', headers: h }, res => res.resume()); r.on('error', () => {}); r.end();
      } catch (e) { /* abaikan */ }
      this.sessionId = null;
    }
  }

  stop() { this._kill(); if (this.status !== 'error') this.status = 'stopped'; }
}

function createMcp(deps) {
  // deps: getEnv(), approve(title,msg,detail,allowSession)->'deny'|'once'|'session', cwd(), version, getToken(id), load(), save(list)
  const servers = new Map();
  const specs = () => deps.load() || [];
  const find = id => { const sp = specs().find(s => s.id === id); if (!sp) throw new Error('Server tidak terdaftar.'); return sp; };

  return {
    list() {
      return specs().map(sp => {
        const s = servers.get(sp.id);
        return { id: sp.id, name: sp.name, transport: sp.url ? 'http' : 'stdio', url: sp.url || '', command: sp.command || '', args: sp.args || [], env: sp.env || {}, strict: !!sp.strict, status: s ? s.status : 'stopped', error: s ? s.error : '', tools: s ? s.tools : [] };
      });
    },
    add(spec) {
      const sp = validateSpec(spec);
      const cur = servers.get(sp.id); if (cur) cur.stop();
      servers.delete(sp.id);
      deps.save(specs().filter(s => s.id !== sp.id).concat([sp]));
      return sp;
    },
    remove(id) {
      const s = servers.get(id); if (s) s.stop(); servers.delete(id);
      deps.save(specs().filter(x => x.id !== id));
    },
    async start(id) {
      const sp = find(id);
      let server, choice;
      if (sp.url) {
        choice = await deps.approve('Hubungkan server MCP jarak jauh',
          `Izinkan ORION terhubung ke server MCP "${sp.name}"? Argumen tool yang dipanggil model akan dikirim ke server ini, dan hasilnya masuk ke percakapan.`,
          'URL: ' + sp.url + (deps.getToken && deps.getToken(sp.id) ? '\nToken: tersimpan (dikirim sebagai Authorization: Bearer)' : '\nTanpa token'), false);
        if (choice === 'deny') throw new Error('Ditolak oleh pengguna.');
        server = new McpHttpServer(sp, deps);
      } else {
        const ws = deps.cwd && deps.cwd();
        if (sp.args.some(a => a.includes('{{workspace}}')) && !ws) throw new Error('Server ini butuh workspace — pilih workspace dulu.');
        const args = sp.args.map(a => a.split('{{workspace}}').join(ws || ''));
        choice = await deps.approve('Jalankan server MCP',
          `Izinkan ORION menjalankan server MCP "${sp.name}"? Server adalah program yang berjalan dengan hak akses akun Anda.`,
          'Perintah: ' + sp.command + ' ' + args.join(' ') + (sp.env ? '\nEnv: ' + Object.keys(sp.env).map(k => k + '=' + sp.env[k]).join(' ') : '') + (sp.strict ? '\n\nServer ini ditandai ketat: setiap pemanggilan tool akan diminta izin satu per satu.' : '') + (/^(npx|uvx|pnpm|bunx)$/.test(sp.command) ? '\n\nPerhatian: perintah ini dapat mengunduh dan menjalankan paket dari internet.' : ''), false);
        if (choice === 'deny') throw new Error('Ditolak oleh pengguna.');
        server = new McpServer({ id: sp.id, name: sp.name, command: sp.command, args, env: sp.env, strict: sp.strict }, deps);
      }
      const old = servers.get(id); if (old) old.stop();
      servers.set(id, server);
      await server.start();
      if (server.status !== 'running') throw new Error(server.error || 'Server gagal berjalan.');
      return { tools: server.tools };
    },
    stop(id) { const s = servers.get(id); if (s) s.stop(); },
    stopAll() { servers.forEach(s => s.stop()); },
    async call(id, tool, args) {
      const s = servers.get(id);
      if (!s || s.status !== 'running') throw new Error('Server belum berjalan.');
      if (!s.tools.some(t => t.name === tool)) throw new Error('Tool tidak dikenal: ' + tool);
      const argJson = JSON.stringify(args || {});
      if (argJson.length > 100000) throw new Error('Argumen terlalu besar.');
      if (s.spec.strict || !s.sessionAllow) {
        const c = await deps.approve('Panggil tool MCP', `Server "${s.spec.name}" ingin menjalankan tool "${tool}".`, JSON.stringify(args || {}, null, 2).slice(0, 1200), !s.spec.strict);
        if (c === 'deny') throw new Error('Ditolak oleh pengguna.');
        if (c === 'session' && !s.spec.strict) s.sessionAllow = true;
      }
      return s.callTool(tool, args);
    }
  };
}

module.exports = { createMcp, validateSpec, validateEnv, winLine, McpServer, McpHttpServer };
