'use strict';
/* Uji mandiri tanpa Electron: node scripts/selftest.js */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { createMcp, validateSpec, validateEnv, winLine } = require('../src/mcp');
const fakeHttp = require('./fake-mcp-http');
const { parseFrontmatter, makeSafePath, isSecretName, validatePluginManifest } = require('../src/bridge');

const root = path.join(__dirname, '..');
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ✓ ' + name); };

t('parseFrontmatter', () => {
  const r = parseFrontmatter('---\nname: "Uji"\ndescription: ok\n---\nisi');
  assert.strictEqual(r.meta.name, 'Uji'); assert.strictEqual(r.body, 'isi');
  assert.deepStrictEqual(parseFrontmatter('tanpa fm').meta, {});
});

t('makeSafePath menolak traversal & symlink keluar workspace', () => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-ws-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-out-'));
  fs.mkdirSync(path.join(ws, 'sub'));
  fs.writeFileSync(path.join(outside, 'rahasia.txt'), 'x');
  assert.ok(makeSafePath(ws, 'sub').endsWith('sub'));
  assert.ok(makeSafePath(ws, 'baru/belum/ada.txt'));
  assert.throws(() => makeSafePath(ws, '../'), /luar workspace/);
  assert.throws(() => makeSafePath(ws, '../../etc/passwd'), /luar workspace/);
  assert.throws(() => makeSafePath(null, 'x'), /Workspace belum/);
  /* Uji symlink hanya bisa dijalankan bila OS benar-benar dapat membuat tautan yang berfungsi.
   * Di Windows tanpa hak istimewa, symlinkSync "berhasil" tetapi menghasilkan direktori kosong
   * yang tidak menunjuk ke mana pun, sehingga uji ini tidak bermakna — lewati dengan jujur. */
  let linkWorks = false;
  try {
    fs.symlinkSync(outside, path.join(ws, 'link'), 'dir');
    linkWorks = fs.existsSync(path.join(ws, 'link', 'rahasia.txt'));
  } catch (e) { if (e.code !== 'EPERM') throw e; }
  if (linkWorks) assert.throws(() => makeSafePath(ws, 'link/rahasia.txt'), /luar workspace/);
  else console.log('  (info: OS ini tidak dapat membuat symlink/junction yang berfungsi — asersi symlink dilewati, bukan lulus)');
});

t('isSecretName', () => {
  ['.env', '.env.local', 'server.pem', 'id_rsa', '.npmrc', 'credentials.json'].forEach(f => assert.ok(isSecretName(f), f));
  ['index.js', 'README.md', 'environment.ts'].forEach(f => assert.ok(!isSecretName(f), f));
});

t('validatePluginManifest', () => {
  const ok = validatePluginManifest({ id: 'abc', name: 'A', commands: [{ id: 'x', title: 'T', prompt: 'P' }] }, 'abc');
  assert.strictEqual(ok.commands.length, 1);
  assert.throws(() => validatePluginManifest({ id: '../evil', name: 'A' }), /id plugin/);
  assert.throws(() => validatePluginManifest({ id: 'a', name: 'A', commands: [{ id: 'x', title: 'T' }] }), /Command/);
});

t('semua skill bundel valid', () => {
  const dir = path.join(root, 'resources', 'skills');
  const names = fs.readdirSync(dir);
  assert.ok(names.length >= 8);
  names.forEach(d => {
    const { meta, body } = parseFrontmatter(fs.readFileSync(path.join(dir, d, 'SKILL.md'), 'utf8'));
    assert.ok(meta.name && meta.description, d); assert.ok(body.trim().length > 40, d);
  });
});

t('semua plugin bundel valid', () => {
  const dir = path.join(root, 'resources', 'plugins');
  fs.readdirSync(dir).forEach(d => validatePluginManifest(JSON.parse(fs.readFileSync(path.join(dir, d, 'plugin.json'), 'utf8')), d));
});

t('preset connector valid', () => {
  const p = JSON.parse(fs.readFileSync(path.join(root, 'resources', 'connectors', 'presets.json'), 'utf8'));
  p.providers.forEach(x => assert.ok(/^https?:\/\//.test(x.base) && x.name));
  Object.values(p.agents).forEach(a => assert.ok(/^[\w.-]+$/.test(a.cmd) && Array.isArray(a.args)));
});


t('mcp: validasi spec & baris perintah Windows', () => {
  assert.throws(() => validateSpec({ id: 'Bad Id', command: 'x' }), /id server/);
  assert.throws(() => validateSpec({ id: 'ok', command: 'x\ny' }), /Command/);
  assert.strictEqual(winLine('npx', ['-y', 'pkg', 'C:\\My Dir']), 'npx -y pkg "C:\\My Dir"');
  assert.strictEqual(validateSpec({ id: 'r', url: 'https://x.example/mcp' }).transport, 'http');
  assert.ok(validateSpec({ id: 'l', url: 'http://localhost:3000/mcp' }).url);
  assert.throws(() => validateSpec({ id: 'r', url: 'http://evil.example/mcp' }), /https/);
  assert.throws(() => validateSpec({ id: 'r', url: 'https://u:p@x.example/mcp' }), /kredensial/);
  assert.throws(() => validateSpec({ id: 'r', url: 'ftp://x.example' }), /https/);
  assert.throws(() => winLine('npx', ['a&calc']), /tidak diizinkan/);
});

t('mcp: validasi env & strict', () => {
  assert.deepStrictEqual(validateSpec({ id: 'a', command: 'x', env: { REA_MCP_INPUT_SCHEMA_PROFILE: 'compact' }, strict: true }).env, { REA_MCP_INPUT_SCHEMA_PROFILE: 'compact' });
  ['PATH', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES', 'PYTHONPATH', 'HTTPS_PROXY', 'ELECTRON_RUN_AS_NODE'].forEach(k => assert.throws(() => validateEnv({ [k]: 'x' }), /diblokir/, k));
  assert.throws(() => validateEnv({ 'bad-name': '1' }), /tidak valid/);
  assert.throws(() => validateEnv({ A: 'x\ny' }), /tidak valid/);
  assert.strictEqual(validateSpec({ id: 'a', command: 'x' }).strict, undefined);
});

const idx = path.join(root, 'app', 'index.html');
if (fs.existsSync(idx)) {
  t('app/index.html ter-patch', () => {
    const h = fs.readFileSync(idx, 'utf8');
    ['Content-Security-Policy', 'id="view-hub"', 'data-view="hub"', 'orion-desktop.js', 'orion-stt.js', 'window.OrionHub.testTool', 'window.OrionHub.openConnectors'].forEach(s => assert.ok(h.includes(s), s));
  });
  t('app/index.html memuat inti adapter AI yang sudah diperbaiki', () => {
    const h = fs.readFileSync(idx, 'utf8');
    ['ORION-AI-CORE:BEGIN', 'ORION-AI-CORE:END', 'aiCreateAdapter', 'aiEndpoint', 'x-goog-api-key', 'generateContent', 'AI_STATE']
      .forEach(s => assert.ok(h.includes(s), s));
    assert.ok(!/\/v1main/.test(h), 'app/index.html tidak boleh memuat versi API "v1main"');
  });
  t('semua skrip inline (source & app) valid secara sintaksis', () => {
    const files = [path.join(root, 'source', 'Orion_v_4_0.html'), idx];
    files.forEach(f => {
      const h = fs.readFileSync(f, 'utf8');
      const blocks = [...h.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
      assert.ok(blocks.length >= 1, 'tidak ada skrip inline di ' + path.basename(f));
      blocks.forEach((code, i) => new vm.Script(code, { filename: path.basename(f) + '#inline' + i }));
    });
  });
} else console.log('  (lewati cek app/index.html — jalankan npm run prepare:app dulu)');


(async () => {
  const fake = path.join(__dirname, 'fake-mcp-server.js');
  let store = [], decision = 'once', approvals = 0;
  const mcp = createMcp({
    getEnv: async () => process.env, cwd: () => null, version: 'test',
    load: () => store, save: l => { store = l; },
    approve: async () => { approvals++; return decision; }
  });
  mcp.add({ id: 'fake', name: 'Fake', command: process.execPath, args: [fake] });
  const r = await mcp.start('fake');
  assert.strictEqual(r.tools.length, 4);
  assert.strictEqual(mcp.list()[0].status, 'running'); n++; console.log('  ✓ mcp: start, initialize, tools/list');
  const c = await mcp.call('fake', 'echo', { text: 'hi' });
  assert.strictEqual(c.text, 'echo:hi'); n++; console.log('  ✓ mcp: tools/call');
  assert.strictEqual((await mcp.call('fake', 'boom', {})).isError, true); n++; console.log('  ✓ mcp: isError diteruskan');
  await assert.rejects(() => mcp.call('fake', 'hapus_semua', {}), /tidak dikenal/); n++; console.log('  ✓ mcp: tool tak dikenal ditolak');
  decision = 'session'; await mcp.call('fake', 'echo', { text: 'a' }); const before = approvals;
  await mcp.call('fake', 'echo', { text: 'b' }); assert.strictEqual(approvals, before); n++; console.log('  ✓ mcp: izin sesi tidak bertanya ulang');
  /* Menunggu kondisi dengan batas waktu — jangan mengandalkan satu jeda tetap,
   * karena waktu keluar proses anak berbeda-beda antar mesin. */
  const waitFor = async (fn, ms = 5000, step = 50) => {
    const until = Date.now() + ms;
    while (Date.now() < until) { if (fn()) return true; await new Promise(res => setTimeout(res, step)); }
    return fn();
  };
  mcp.stop('fake');
  assert.ok(await waitFor(() => mcp.list()[0].status === 'stopped'), 'server harus berhenti (status: ' + mcp.list()[0].status + ')');
  assert.strictEqual(mcp.list()[0].status, 'stopped'); n++; console.log('  ✓ mcp: stop');
  decision = 'deny';
  await assert.rejects(() => mcp.start('fake'), /Ditolak/); n++; console.log('  ✓ mcp: start ditolak pengguna');
  mcp.add({ id: 'nope', name: 'Nope', command: 'perintah-yang-tidak-ada-123', args: [] }); decision = 'once';
  await assert.rejects(() => mcp.start('nope'), /tidak ditemukan/); n++; console.log('  ✓ mcp: command hilang -> pesan jelas');

  /* ───── env, strict, structuredContent ───── */
  decision = 'once';
  mcp.add({ id: 'fakeenv', name: 'FakeEnv', command: process.execPath, args: [fake], env: { FAKE_VAR: 'halo' }, strict: true });
  await mcp.start('fakeenv');
  assert.strictEqual(mcp.list().find(x => x.id === 'fakeenv').strict, true);
  assert.strictEqual((await mcp.call('fakeenv', 'envvar', {})).text, 'FAKE_VAR=halo'); n++; console.log('  ✓ mcp: env per server diteruskan ke proses');
  assert.strictEqual((await mcp.call('fakeenv', 'structured', {})).text, '{"ok":true,"n":3}'); n++; console.log('  ✓ mcp: fallback ke structuredContent');
  decision = 'session'; const b4 = approvals;
  await mcp.call('fakeenv', 'envvar', {}); await mcp.call('fakeenv', 'envvar', {});
  assert.strictEqual(approvals - b4, 2); n++; console.log('  ✓ mcp: server "strict" selalu minta izin (opsi sesi diabaikan)');
  mcp.remove('fakeenv');
  mcp.remove('fake'); assert.strictEqual(mcp.list().length, 1);

  /* ───── transport HTTP ───── */
  const h = await fakeHttp.start();
  const tokens = { rem: 'sekret' };
  let store2 = [];
  const mcp2 = createMcp({
    getEnv: async () => process.env, cwd: () => null, version: 'test', getToken: id => tokens[id],
    load: () => store2, save: l => { store2 = l; }, approve: async () => 'once'
  });
  mcp2.add({ id: 'rem', name: 'Remote', url: `http://127.0.0.1:${h.port}/mcp` });
  const r2 = await mcp2.start('rem');
  assert.strictEqual(r2.tools.length, 2); assert.strictEqual(mcp2.list()[0].transport, 'http'); n++; console.log('  ✓ mcp http: initialize, session id, tools/list');
  assert.strictEqual((await mcp2.call('rem', 'echo', { text: 'hi' })).text, 'echo:hi'); n++; console.log('  ✓ mcp http: tools/call lewat SSE (notifikasi dilewati)');
  mcp2.stop('rem');
  /* DELETE sesi dikirim asinkron — tunggu kedua kondisi, jangan pakai jeda tetap. */
  assert.ok(await waitFor(() => mcp2.list()[0].status === 'stopped' && h.server.deleted), 'server HTTP harus berhenti dan mengakhiri sesi (DELETE)');
  assert.strictEqual(mcp2.list()[0].status, 'stopped'); assert.ok(h.server.deleted); n++; console.log('  ✓ mcp http: stop mengakhiri sesi (DELETE)');
  tokens.rem = 'salah';
  await assert.rejects(() => mcp2.start('rem'), /HTTP 401/); n++; console.log('  ✓ mcp http: token salah -> pesan jelas');
  mcp2.add({ id: 'mati', name: 'Mati', url: 'http://127.0.0.1:1/mcp' });
  await assert.rejects(() => mcp2.start('mati'), /ECONNREFUSED/); n++; console.log('  ✓ mcp http: server tidak terjangkau -> error');
  h.server.close();


  /* ───── updater (dengan mock) ───── */
  const EventEmitter = require('events');
  const { setup: setupUpd } = require('../src/updater');
  const tick = () => new Promise(res => setTimeout(res, 20));
  const mkUpd = (pkg, answers, packaged) => {
    const calls = [];
    const au = Object.assign(new EventEmitter(), { checkForUpdates: async () => { calls.push('check'); }, downloadUpdate: async () => { calls.push('download'); }, quitAndInstall: () => calls.push('install') });
    const dialog = { showMessageBox: async (w, o) => { calls.push('dlg'); return { response: answers.length ? answers.shift() : 0 }; } };
    const shell = { openExternal: u => calls.push('open:' + u) };
    const isPackaged = packaged === undefined ? true : packaged;
    const u = setupUpd({ app: { getVersion: () => '4.0.0', isPackaged }, dialog, shell, getWindow: () => null, pkg, updaterLib: au, isPackaged });
    return { u, au, calls };
  };
  { // alur normal: tersedia -> unduh -> mulai ulang
    const { u, au, calls } = mkUpd({ orionRepo: 'o/r', orionProfile: 'modern' }, [1, 1]);
    assert.ok(u.enabled); assert.strictEqual(au.autoDownload, false); assert.strictEqual(au.autoInstallOnAppQuit, false);
    await u.check(false); au.emit('update-available', { version: '4.1.0' }); await tick();
    assert.ok(calls.includes('download')); au.emit('update-downloaded', { version: '4.1.0' }); await tick();
    assert.ok(calls.includes('install')); n++; console.log('  ✓ updater: tersedia → unduh → pasang (selalu bertanya dulu)');
  }
  { // menolak -> tidak mengunduh, dan pemeriksaan berikutnya tetap jalan
    const { u, au, calls } = mkUpd({ orionRepo: 'o/r' }, [0]);
    await u.check(false); au.emit('update-available', { version: '4.1.0' }); await tick();
    assert.ok(!calls.includes('download')); await u.check(false);
    assert.strictEqual(calls.filter(c => c === 'check').length, 2); n++; console.log('  ✓ updater: "Nanti" tidak mengunduh; cek berikutnya tidak macet');
  }
  { // error: senyap bila otomatis, dialog + buka rilis bila manual
    const a = mkUpd({ orionRepo: 'o/r' }, []); await a.u.check(false); a.au.emit('error', new Error('x')); await tick();
    assert.ok(!a.calls.includes('dlg'));
    const b = mkUpd({ orionRepo: 'o/r' }, [1]); await b.u.check(true); b.au.emit('error', new Error('Code signature invalid')); await tick();
    assert.ok(b.calls.includes('open:https://github.com/o/r/releases/latest')); n++; console.log('  ✓ updater: error otomatis senyap; error manual menawarkan halaman rilis');
  }
  { // tanpa repo / legacy / belum terpasang -> updater nonaktif, jalur manual aman
    const a = mkUpd({}, []); await a.u.check(true); assert.ok(!a.u.enabled && a.calls.includes('dlg') && !a.calls.includes('check'));
    const b = mkUpd({ orionRepo: 'o/r', orionProfile: 'legacy' }, [1]); await b.u.check(true);
    assert.ok(!b.u.enabled && b.calls.includes('open:https://github.com/o/r/releases/latest'));
    const c = mkUpd({ orionRepo: 'o/r' }, [], false); assert.ok(!c.u.enabled); n++; console.log('  ✓ updater: nonaktif tanpa repo / legacy / belum terpasang');
  }
  /* ═══════════════════════════════════════════════════════════════════════
   * ADAPTER AI PROVIDER — menguji KODE NYATA yang dikirim ke aplikasi.
   * Blok inti diekstrak langsung dari source/Orion_v_4_0.html (penanda
   * ORION-AI-CORE) lalu dijalankan di vm dengan fetch tiruan.
   * ═══════════════════════════════════════════════════════════════════════ */
  const htmlSrc = fs.readFileSync(path.join(root, 'source', 'Orion_v_4_0.html'), 'utf8');  const coreMatch = /\/\* ==== ORION-AI-CORE:BEGIN ==== \*\/([\s\S]*?)\/\* ==== ORION-AI-CORE:END ==== \*\//.exec(htmlSrc);
  assert.ok(coreMatch, 'blok ORION-AI-CORE tidak ditemukan di source/Orion_v_4_0.html');
  const sandbox = { console, URL, JSON, Date, Math, encodeURIComponent, setTimeout, clearTimeout };
  vm.createContext(sandbox);
  vm.runInContext(coreMatch[1] + `
;this.__AI = { AI_PROTOCOL, AI_STATE, aiRedact, aiDetectProtocol, aiTrimBase, aiNormalizeBase,
  aiNormalizeModel, aiValidateModel, aiEndpoint, aiAuthHeaders, aiSameHost, aiBuildBody, aiParseResponse,
  aiParseModels, aiModelMatches, aiSuggestModels, aiMapError, aiMigrateProvider, aiCreateAdapter };`, sandbox);
  const C = sandbox.__AI;
  /* Objek buatan vm hidup di realm lain; ubah ke objek biasa agar perbandingan mendalam valid. */
  const plain = x => JSON.parse(JSON.stringify(x));
  const G = 'https://generativelanguage.googleapis.com/v1beta';
  const mkRes = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    json: async () => (typeof body === 'string' ? JSON.parse(body) : body)
  });
  const mkAdapter = (provider, key, handler) => {
    const calls = []; const states = [];
    const A = C.aiCreateAdapter({
      fetch: async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); },
      getKey: () => key,
      getProvider: () => provider,
      onState: s => states.push(s)
    });
    return { A, calls, states };
  };

  t('ai: deteksi mode protokol dari Base URL', () => {
    assert.strictEqual(C.aiDetectProtocol(G), 'gemini');
    assert.strictEqual(C.aiDetectProtocol(G + '/openai'), 'openai');
    assert.strictEqual(C.aiDetectProtocol('https://generativelanguage.googleapis.com'), 'gemini');
    assert.strictEqual(C.aiDetectProtocol('https://openrouter.ai/api/v1'), 'openai');
    assert.strictEqual(C.aiDetectProtocol('http://localhost:11434/v1'), 'openai');
    assert.strictEqual(C.aiDetectProtocol(''), 'openai');
  });

  t('ai: Base URL kanonik tidak pernah memakai jalur /openai untuk mode Gemini', () => {
    assert.strictEqual(C.aiNormalizeBase(G + '/openai', 'gemini'), G);
    assert.strictEqual(C.aiNormalizeBase('https://generativelanguage.googleapis.com', 'gemini'), G);
    assert.strictEqual(C.aiNormalizeBase(G + '/', 'gemini'), G);
    assert.strictEqual(C.aiNormalizeBase('https://openrouter.ai/api/v1/', 'openai'), 'https://openrouter.ai/api/v1');
  });

  t('ai: pembentukan endpoint per mode', () => {
    assert.strictEqual(C.aiEndpoint('gemini', G, 'gemini-3.5-flash-lite', 'generate'),
      G + '/models/gemini-3.5-flash-lite:generateContent');
    assert.strictEqual(C.aiEndpoint('gemini', G + '/openai', 'models/gemini-2.5-flash', 'generate'),
      G + '/models/gemini-2.5-flash:generateContent');
    assert.strictEqual(C.aiEndpoint('gemini', G, 'x', 'list'), G + '/models');
    assert.strictEqual(C.aiEndpoint('openai', 'https://openrouter.ai/api/v1', 'google/gemini-3.5-flash-lite', 'generate'),
      'https://openrouter.ai/api/v1/chat/completions');
    assert.strictEqual(C.aiEndpoint('openai', 'https://openrouter.ai/api/v1', 'x', 'list'), 'https://openrouter.ai/api/v1/models');
  });

  t('ai: format autentikasi per mode (key tidak pernah masuk URL)', () => {
    assert.deepStrictEqual(plain(C.aiAuthHeaders('gemini', 'k123')), { 'x-goog-api-key': 'k123' });
    assert.deepStrictEqual(plain(C.aiAuthHeaders('openai', 'k123')), { Authorization: 'Bearer k123' });
    assert.deepStrictEqual(plain(C.aiAuthHeaders('gemini', '')), {});
    assert.ok(!/key=/.test(C.aiEndpoint('gemini', G, 'gemini-2.5-flash', 'generate')));
  });

  t('ai: ID model router ditolak pada mode Gemini (dengan usulan), diterima pada mode OpenAI', () => {
    const bad = C.aiValidateModel('google/gemini-3.5-flash-lite', 'gemini');
    assert.strictEqual(bad.ok, false);
    assert.strictEqual(bad.suggest, 'gemini-3.5-flash-lite');
    const ok = C.aiValidateModel('models/gemini-2.5-flash', 'gemini');
    assert.strictEqual(ok.ok, true); assert.strictEqual(ok.id, 'gemini-2.5-flash');
    assert.strictEqual(C.aiValidateModel('google/gemini-3.5-flash-lite', 'openai').ok, true);
    assert.strictEqual(C.aiValidateModel('', 'openai').ok, false);
    assert.strictEqual(C.aiValidateModel('dua kata', 'openai').ok, false);
  });

  t('ai: body permintaan per mode', () => {
    const msgs = [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }, { role: 'assistant', content: 'A' }];
    const g = C.aiBuildBody('gemini', { model: 'gemini-2.5-flash', messages: msgs, temperature: 0.2 });
    assert.deepStrictEqual(plain(g.systemInstruction), { parts: [{ text: 'S' }] });
    assert.deepStrictEqual(plain(g.contents), [{ role: 'user', parts: [{ text: 'U' }] }, { role: 'model', parts: [{ text: 'A' }] }]);
    assert.strictEqual(g.generationConfig.temperature, 0.2);
    assert.strictEqual(g.model, undefined);
    const o = C.aiBuildBody('openai', { model: 'm', messages: msgs });
    assert.strictEqual(o.model, 'm'); assert.strictEqual(o.messages, msgs); assert.strictEqual(o.temperature, 0.7);
  });

  t('ai: parser respons per mode', () => {
    assert.strictEqual(C.aiParseResponse('openai', { choices: [{ message: { content: 'halo' } }] }), 'halo');
    assert.strictEqual(C.aiParseResponse('gemini', { candidates: [{ content: { parts: [{ text: 'ha' }, { text: 'i' }] } }] }), 'hai');
    assert.throws(() => C.aiParseResponse('openai', { choices: [] }), /Format respons/);
    assert.throws(() => C.aiParseResponse('gemini', { candidates: [] }), /kandidat/);
    assert.throws(() => C.aiParseResponse('gemini', { promptFeedback: { blockReason: 'SAFETY' } }), /blockReason: SAFETY/);
    assert.throws(() => C.aiParseResponse('gemini', { candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }), /MAX_TOKENS/);
  });

  t('ai: parser daftar model (discovery)', () => {
    assert.deepStrictEqual(
      plain(C.aiParseModels('gemini', { models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent', 'countTokens'] }] })),
      [{ id: 'gemini-2.5-flash', methods: ['generateContent', 'countTokens'], label: '' }]);
    assert.strictEqual(C.aiParseModels('openai', { data: [{ id: 'models/foo' }] })[0].id, 'foo');
    assert.deepStrictEqual(plain(C.aiParseModels('openai', {})), []);
  });

  t('ai: pemetaan error HTTP 400/401/403/404/429/5xx', () => {
    const codes = [400, 401, 403, 404, 429, 500, 503];
    const msgs = codes.map(c => C.aiMapError(c, '').msg);
    assert.strictEqual(new Set(msgs).size, codes.length, 'setiap status harus punya pesan berbeda');
    codes.forEach((c, i) => assert.ok(msgs[i].includes(String(c)), 'pesan harus menyebut status ' + c));
    assert.ok(/rate limit/i.test(C.aiMapError(429, '').msg));
    assert.ok(/tidak tersedia|Server provider/.test(C.aiMapError(503, '').msg));
    const g = C.aiMapError(404, JSON.stringify([{ error: { code: 404, message: 'models/google/x is not found for API version v1main' } }]));
    assert.ok(/v1main/.test(g.detail), 'pesan provider harus diteruskan ke UI');
    assert.ok(/404/.test(g.msg));
  });

  t('ai: penyaringan rahasia dari teks error dan log', () => {
    const s = C.aiRedact('Authorization: Bearer sk-abc123456789 gagal; url?key=AIzaSyD-1234567890&x=1; x-goog-api-key: sekret');
    assert.ok(!/sk-abc123456789/.test(s), 'sk- harus disaring');
    assert.ok(!/AIzaSyD-1234567890/.test(s), 'AIza harus disaring');
    assert.ok(!/sekret/.test(s), 'header x-goog-api-key harus disaring');
    assert.ok(/\[REDACTED\]/.test(s));
  });

  t('ai: host endpoint harus sama dengan host Base URL', () => {
    assert.strictEqual(C.aiSameHost('https://api.openai.com/v1', 'https://api.openai.com/v1/chat/completions'), true);
    assert.strictEqual(C.aiSameHost('https://api.openai.com/v1', 'https://evil.example/v1/chat/completions'), false);
    assert.strictEqual(C.aiSameHost('//evil.example/v1', '//evil.example/v1/chat/completions'), false);
  });

  t('ai: ekspor statis AI tidak menimpa metode adapter', () => {
    const m = /Object\.assign\(AI,\{([\s\S]*?)\n\}\);/.exec(htmlSrc);
    assert.ok(m, 'blok Object.assign(AI,{...}) tidak ditemukan di source/Orion_v_4_0.html');
    ['config', 'configured', 'ready', 'label', 'chip', 'chat', 'test', 'discoverModels', 'status', 'restore', 'headers', 'endpoint', 'protocol']
      .forEach(k => assert.ok(!new RegExp('(?:^|[,\\{\\s])' + k + '\\s*:').test(m[1]),
        'nama statis "' + k + '" menimpa metode adapter AI — pakai nama lain (mis. buildEndpoint)'));
  });

  t('ai: migrasi konfigurasi aman (base/model/key tidak diubah)', () => {
    const s = { provider: { base: 'https://openrouter.ai/api/v1', model: 'google/gemini-3.5-flash-lite' } };
    C.aiMigrateProvider(s);
    assert.strictEqual(s.provider.base, 'https://openrouter.ai/api/v1');
    assert.strictEqual(s.provider.model, 'google/gemini-3.5-flash-lite');
    assert.strictEqual(s.provider.protocol, 'openai');
    const s2 = { provider: { base: G, model: 'google/gemini-3.5-flash-lite', aikey: 'tetap' } };
    const r2 = C.aiMigrateProvider(s2);
    assert.strictEqual(s2.provider.protocol, 'gemini');
    assert.strictEqual(s2.provider.base, G);
    assert.strictEqual(s2.provider.model, 'google/gemini-3.5-flash-lite');
    assert.strictEqual(s2.provider.aikey, 'tetap', 'API key tidak boleh dihapus');
    assert.ok(r2.notes.some(x => /gemini-3\.5-flash-lite/.test(x)), 'harus melaporkan model yang tidak cocok');
  });

  t('ai: status tidak pernah "Terhubung"/"Siap" sebelum diverifikasi', () => {
    const A = C.aiCreateAdapter({ fetch: async () => mkRes(200, {}), getKey: () => 'k',
      getProvider: () => ({ base: G, model: 'gemini-2.5-flash', protocol: 'gemini' }) });
    assert.strictEqual(A.ready(), true, 'terkonfigurasi berarti siap dipakai, bukan berarti terverifikasi');
    assert.strictEqual(A.status().state, 'UNVERIFIED');
    assert.strictEqual(A.chip().text, 'AI: Terkonfigurasi (belum diuji)');
    assert.ok(!/Terhubung|Siap/.test(A.chip().text));
    assert.ok(!/Terhubung|Siap/.test(A.label()));
  });

  t('ai: belum dikonfigurasi → Demo, bukan Terhubung', () => {
    const A = C.aiCreateAdapter({ fetch: async () => mkRes(200, {}), getKey: () => '', getProvider: () => ({ base: '', model: '' }) });
    assert.strictEqual(A.ready(), false);
    assert.strictEqual(A.chip().text, 'AI: Demo');
    assert.strictEqual(A.label(), 'Demo (belum dikonfigurasi)');
  });

  { /* ── Mode Gemini asli: endpoint, header, body, status ── */
    const { A, calls } = mkAdapter({ base: G, model: 'gemini-2.5-flash', protocol: 'gemini' }, 'AIzaTESTKEY123456',
      () => mkRes(200, { candidates: [{ content: { parts: [{ text: 'Hai!' }] }, finishReason: 'STOP' }] }));
    const txt = await A.chat([{ role: 'system', content: 'S' }, { role: 'user', content: 'Hai' }]);
    assert.strictEqual(txt, 'Hai!');
    assert.strictEqual(calls[0].url, G + '/models/gemini-2.5-flash:generateContent');
    assert.strictEqual(calls[0].init.method, 'POST');
    assert.strictEqual(calls[0].init.headers['x-goog-api-key'], 'AIzaTESTKEY123456');
    assert.strictEqual(calls[0].init.headers.Authorization, undefined);
    assert.ok(!/key=/.test(calls[0].url), 'API key tidak boleh ada di URL');
    const body = JSON.parse(calls[0].init.body);
    assert.strictEqual(body.contents.length, 1);
    assert.strictEqual(body.systemInstruction.parts[0].text, 'S');
    assert.strictEqual(A.status().state, 'HEALTHY');
    assert.strictEqual(A.chip().text, 'AI: Siap');
    n++; console.log('  ✓ ai gemini: generateContent nyata (mock) — endpoint, header, body, status');
  }

  { /* ── Mode kompatibel OpenAI: ID router dipertahankan ── */
    const { A, calls } = mkAdapter({ base: 'https://openrouter.ai/api/v1', model: 'google/gemini-3.5-flash-lite', protocol: 'openai' }, 'sk-or-v1-TESTKEY123456',
      () => mkRes(200, { choices: [{ message: { content: 'ok' } }] }));
    assert.strictEqual(await A.chat([{ role: 'user', content: 'hai' }]), 'ok');
    assert.strictEqual(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
    assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer sk-or-v1-TESTKEY123456');
    assert.strictEqual(calls[0].init.headers['x-goog-api-key'], undefined);
    assert.strictEqual(JSON.parse(calls[0].init.body).model, 'google/gemini-3.5-flash-lite');
    n++; console.log('  ✓ ai openai-compat: ID router (vendor/model) dipertahankan apa adanya');
  }

  { /* ── Skenario akar masalah: base Gemini + ID router ── */
    let fetched = false;
    const { A } = mkAdapter({ base: G, model: 'google/gemini-3.5-flash-lite', protocol: 'gemini' }, 'AIzaTESTKEY123456',
      () => { fetched = true; return mkRes(200, {}); });
    await assert.rejects(() => A.chat([{ role: 'user', content: 'hai' }]), /format router/);
    assert.strictEqual(fetched, false, 'permintaan tidak boleh dikirim untuk konfigurasi yang salah mode');
    assert.strictEqual(A.status().state, 'FAILED');
    n++; console.log('  ✓ ai: base Gemini + ID router → ditolak sebelum request (bukan 404 dari provider)');
  }

  { /* ── Status HTTP: pesan spesifik + FAILED ── */
    for (const status of [400, 401, 403, 404, 429, 500, 503]) {
      const { A, states } = mkAdapter({ base: G, model: 'gemini-2.5-flash', protocol: 'gemini' }, 'AIzaTESTKEY123456',
        () => mkRes(status, [{ error: { code: status, message: 'boom ' + status } }]));
      await assert.rejects(() => A.chat([{ role: 'user', content: 'x' }]), new RegExp(String(status)));
      assert.strictEqual(A.status().state, 'FAILED', 'status harus FAILED untuk HTTP ' + status);
      assert.ok(states.some(s => s.state === 'GENERATING'), 'harus melewati GENERATING');
    }
    n++; console.log('  ✓ ai: HTTP 400/401/403/404/429/500/503 → pesan spesifik + status FAILED');
  }

  { /* ── Rahasia tidak bocor ke UI/status ── */
    const KEY = 'AIzaSySUPER-SECRET-KEY-1234567890';
    const { A } = mkAdapter({ base: G, model: 'gemini-2.5-flash', protocol: 'gemini' }, KEY,
      () => mkRes(401, [{ error: { message: 'API key not valid: ' + KEY + ' (key=' + KEY + ')' } }]));
    let msg = '';
    try { await A.chat([{ role: 'user', content: 'x' }]); } catch (e) { msg = e.message; }
    assert.ok(msg && !msg.includes(KEY), 'API key tidak boleh muncul di pesan error');
    assert.ok(!A.status().detail.includes(KEY), 'API key tidak boleh muncul di status');
    n++; console.log('  ✓ ai: API key/secret disaring dari pesan error dan status');
  }

  { /* ── Base URL tidak aman → permintaan dihentikan ── */
    let fetched = false;
    const { A } = mkAdapter({ base: '//evil.example/v1', model: 'm', protocol: 'openai' }, 'sk-or-v1-SECRET123456',
      () => { fetched = true; return mkRes(200, { choices: [{ message: { content: 'x' } }] }); });
    await assert.rejects(() => A.chat([{ role: 'user', content: 'x' }]), /host berbeda/);
    assert.strictEqual(fetched, false, 'permintaan tidak boleh dikirim ke host lain');
    n++; console.log('  ✓ ai: Base URL tidak aman → permintaan dihentikan, key tidak dikirim');
  }

  { /* ── Model tidak tersedia (daftar resmi provider tidak memuatnya) ── */
    const models = [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash-lite', supportedGenerationMethods: ['generateContent'] }];
    const { A } = mkAdapter({ base: G, model: 'gemini-9.9-tidak-ada', protocol: 'gemini' }, 'AIzaTESTKEY123456',
      (url, init, i) => (i === 1 ? mkRes(200, { models }) : mkRes(200, { candidates: [{ content: { parts: [{ text: 'ok' }] } }] })));
    const r = await A.test();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(A.status().state, 'FAILED');
    assert.ok(/tidak terdaftar/.test(r.msg));
    assert.ok(/gemini-2\.5-flash/.test(r.msg), 'pesan harus menyertakan model yang benar-benar tersedia');
    n++; console.log('  ✓ ai: model tidak tersedia → gagal dengan usulan model valid');
  }

  { /* ── Model terdaftar tetapi tanpa generateContent ── */
    const { A } = mkAdapter({ base: G, model: 'gemini-embedding-001', protocol: 'gemini' }, 'k',
      () => mkRes(200, { models: [{ name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] }] }));
    const r = await A.test();
    assert.strictEqual(r.ok, false);
    assert.ok(/generateContent/.test(r.msg));
    n++; console.log('  ✓ ai: model tanpa dukungan generateContent ditolak');
  }

  { /* ── Test koneksi lengkap: discovery → validasi model → generasi nyata ── */
    const { A, calls } = mkAdapter({ base: G, model: 'gemini-2.5-flash', protocol: 'gemini' }, 'AIzaTESTKEY123456',
      (url, init, i) => (i === 1
        ? mkRes(200, { models: [{ name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] }] })
        : mkRes(200, { candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] })));
    const r = await A.test();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(A.status().state, 'HEALTHY');
    assert.strictEqual(calls[0].init.method, 'GET');
    assert.strictEqual(calls[0].url, G + '/models');
    assert.strictEqual(calls[0].init.headers['x-goog-api-key'], 'AIzaTESTKEY123456');
    assert.strictEqual(calls[1].init.method, 'POST');
    assert.ok(/\/models\/gemini-2\.5-flash:generateContent$/.test(calls[1].url));
    assert.ok(/benar-benar menghasilkan respons/.test(r.msg));
    n++; console.log('  ✓ ai: Test koneksi = daftar model → validasi model → generasi nyata (HEALTHY)');
  }

  { /* ── Base URL salah → gagal jelas, bukan sukses palsu ── */
    const { A } = mkAdapter({ base: 'https://api.contoh-salah.example/v1', model: 'gpt-4o-mini', protocol: 'openai' }, 'sk-x',
      () => { throw new TypeError('fetch failed'); });
    const r = await A.test();
    assert.strictEqual(r.ok, false);
    assert.strictEqual(A.status().state, 'FAILED');
    assert.ok(/Koneksi gagal/.test(r.msg));
    n++; console.log('  ✓ ai: Base URL salah → gagal jelas, tidak pernah dilaporkan sebagai terhubung');
  }

  console.log(`\n${n} pengujian lulus.`);
  process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });

