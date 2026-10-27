'use strict';
/* Menguji kabel bridge.js dengan Electron TIRUAN (ipcMain/dialog/safeStorage palsu) di Node.
 * Yang diuji: nama channel IPC, pemeriksaan pengirim tepercaya, dialog persetujuan, secret terenkripsi, validasi,
 * pemasangan skill di filesystem nyata, emergency stop. BUKAN pengujian Electron/UI native. */
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { register } = require('../src/bridge');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-ud-'));
const handlers = {}; const dialogs = []; const opened = []; let answers = []; let openPath = null;
const sender = {}; const win = { webContents: sender };
register({
  ipcMain: { handle: (ch, fn) => { handlers[ch] = fn; } },
  app: { getPath: () => userData, isPackaged: false, getVersion: () => 'test', on() {} },
  dialog: {
    showMessageBox: async (w, o) => { dialogs.push(o); const a = answers.length ? answers.shift() : {}; return Object.assign({ response: 1, checkboxChecked: false }, a); },
    showOpenDialog: async () => (openPath ? { canceled: false, filePaths: [openPath] } : { canceled: true, filePaths: [] })
  },
  shell: { openExternal: async u => { opened.push(u); }, openPath: async () => '' },
  safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'gnome_libsecret', encryptString: s => Buffer.from('E:' + s), decryptString: b => Buffer.from(b).toString().slice(2) },
  getWindow: () => win, updater: null
});
const call = (ch, ...a) => handlers['orion:' + ch]({ sender, senderFrame: { url: 'file:///app/index.html' } }, ...a);
const ask = (...a) => { answers = a; dialogs.length = 0; };

const queue = []; let pass = 0, fail = 0;
const test = (n, fn) => queue.push({ n, fn });
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('semua channel IPC yang dipakai preload terdaftar', () => {
  const pre = fs.readFileSync(path.join(__dirname, '../src/preload.js'), 'utf8');
  const used = [...pre.matchAll(/call\('([A-Za-z:]+)'/g)].map(m => m[1]);
  const missing = [...new Set(used)].filter(ch => !handlers['orion:' + ch]);
  assert.deepStrictEqual(missing, [], 'channel tak terdaftar: ' + missing.join(', ')); assert.ok(used.length > 60);
});

/* ── Phase 5: Orion Central (klien desktop) ── */
test('central:status melaporkan konfigurasi tanpa membocorkan token', async () => {
  const r = await call('central:status');
  assert.ok(r && r.status);
  assert.strictEqual(r.status.hasToken, false);
  assert.ok(!JSON.stringify(r).includes('Bearer'));
});
test('central:enqueue menaruh event di outbox (tahan restart)', async () => {
  const r = await call('central:enqueue', 'mission.state', { x: 1 });
  assert.ok(r && r.ok && r.eventId);
  const st = await call('central:status');
  assert.ok(st.status.pending >= 1);
  // event type tidak valid ditolak
  const bad = await call('central:enqueue', 'EVENT TYPE!!', {});
  assert.strictEqual(bad.ok, false);
  assert.ok(/EVENT_TYPE_INVALID/.test(bad.error), 'got ' + bad.error);
});
test('central:sync tanpa konfigurasi ditolak dengan pesan jelas', async () => {
  const r = await call('central:sync');
  assert.strictEqual(r.ok, false);
  assert.ok(/CENTRAL_NOT_CONFIGURED/.test(r.error), 'got ' + r.error);
});
test('central:setToken menolak token tak masuk akal & tidak mengembalikan token', async () => {
  const bad = await call('central:setToken', 'pendek');
  assert.strictEqual(bad.ok, false);
  assert.ok(/TOKEN_TIDAK_VALID/.test(bad.error));
  const r = await call('central:setToken', 'token-yang-cukup-panjang-untuk-validasi-1234567890');
  assert.ok(r && r.ok);
  const st = await call('central:status');
  assert.strictEqual(st.status.hasToken, true);
  assert.ok(!JSON.stringify(st).includes('token-yang-cukup'), 'token tidak boleh dikembalikan');
  await call('central:clearToken');
});
test('central:migrateLocal dry-run tidak menulis & melaporkan jumlah', async () => {
  const r = await call('central:migrateLocal', { dryRun: true });
  assert.ok(r && r.ok && r.report);
  assert.strictEqual(r.report.dryRun, true);
  assert.ok(typeof r.report.memory.total === 'number');
  assert.ok(r.report.checksum);
});
test('memory:create mewajibkan origin (provenance)', async () => {
  const bad = await call('memory:create', { type: 'fact', content: 'tanpa asal' }, 'global');
  assert.ok(bad && bad.error && /ORIGIN_REQUIRED/.test(bad.error), 'harus ditolak: ' + JSON.stringify(bad));
});
test('memory:create tidak mengizinkan renderer memalsukan owner/verifikasi', async () => {
  const r = await call('memory:create', { type: 'fact', content: 'forge', origin: 'user', owner: 'attacker', verificationStatus: 'verified' }, 'global');
  assert.ok(r && r.record);
  assert.strictEqual(r.record.owner, 'owner');
  assert.strictEqual(r.record.verificationStatus, 'unverified');
});
test('memory:create meredaksi secret', async () => {
  const r = await call('memory:create', { type: 'fact', content: 'kuncinya sk-abcdef123456', origin: 'user' }, 'global');
  assert.ok(r && r.record);
  assert.ok(!/sk-abcdef123456/.test(r.record.content), 'secret tidak boleh tersimpan');
});
test('memory:search mengembalikan insufficientEvidence bila tidak ada bukti', async () => {
  const r = await call('memory:search', 'zzzz-tidak-ada-sama-sekali', { callerScope: 'global' });
  assert.ok(r); assert.strictEqual(r.insufficientEvidence, true); assert.strictEqual(r.results.length, 0);
});
test('memory:search mengembalikan provenance pada setiap hasil', async () => {
  await call('memory:create', { type: 'fact', content: 'provenance marker unik', origin: 'user', sourceRef: 'doc:x' }, 'global');
  const r = await call('memory:search', 'provenance marker', { callerScope: 'global' });
  assert.ok(r.results.length > 0);
  const m = r.results[0];
  assert.ok(m.origin); assert.ok(m.verificationStatus); assert.ok(m.created); assert.ok('scope' in m);
});
test('memory:list menghormati scope caller (tidak bocor lintas scope)', async () => {
  await call('memory:create', { type: 'fact', content: 'rahasia misi', origin: 'user', scope: 'mission', missionId: 'm-1', sensitivity: 'private' }, 'global');
  const asSession = await call('memory:list', { scope: 'mission', missionId: 'm-1', callerScope: 'session' });
  assert.strictEqual(asSession.records.length, 0, 'scope session tidak boleh melihat memori misi privat');
  const asGlobal = await call('memory:list', { scope: 'mission', missionId: 'm-1', callerScope: 'global' });
  assert.ok(asGlobal.records.length > 0);
});
test('skillversion:register menolak manifest invalid', async () => {
  const r = await call('skillversion:register', { id: 'X', name: '', version: 'nope', schemaVersion: 9 }, 'body');
  assert.ok(r && r.error && /SKILL_MANIFEST_INVALID/.test(r.error), 'got ' + JSON.stringify(r));
});
test('skillversion:evaluate gagal pada permission terlarang, aktivasi ditolak', async () => {
  const reg = await call('skillversion:register', { id: 'skill-ipv', name: 'Izin Terlarang', version: '1.0.0', description: 'd', schemaVersion: 1, permissions: ['system:admin'], capabilities: ['text'] }, 'body');
  assert.ok(reg && reg.version && reg.version.versionId);
  const ev = await call('skillversion:evaluate', reg.version.versionId);
  assert.ok(ev && ev.report);
  assert.strictEqual(ev.report.result, 'fail', 'evaluasi harus gagal');
  const act = await call('skillversion:activate', reg.version.versionId);
  assert.ok(act && act.error, 'aktivasi harus ditolak');
});
test('skillversion:rollback ke versi yang belum dievaluasi ditolak', async () => {
  const reg = await call('skillversion:register', { id: 'skill-roll', name: 'Rollback', version: '1.0.0', description: 'd', schemaVersion: 1, permissions: [], capabilities: ['text'] }, 'body');
  const rb = await call('skillversion:rollback', reg.version.versionId);
  assert.ok(rb && rb.error && /SKILL_TARGET_NOT_EVALUATED/.test(rb.error), 'got ' + JSON.stringify(rb));
});
test('skillversion:activate → rollback mempertahankan versi lama', async () => {
  const v1 = await call('skillversion:register', { id: 'skill-rb2', name: 'RB2 v1', version: '1.0.0', description: 'd', schemaVersion: 1, permissions: [], capabilities: ['text'] }, 'b1');
  await call('skillversion:evaluate', v1.version.versionId);
  await call('skillversion:activate', v1.version.versionId);
  const v2 = await call('skillversion:register', { id: 'skill-rb2', name: 'RB2 v2', version: '2.0.0', description: 'd', schemaVersion: 1, permissions: [], capabilities: ['text'] }, 'b2');
  await call('skillversion:evaluate', v2.version.versionId);
  await call('skillversion:activate', v2.version.versionId);
  const rb = await call('skillversion:rollback', v1.version.versionId);
  assert.ok(rb && rb.versionId === v1.version.versionId, 'rollback harus mengembalikan v1');
  const active = await call('skillversion:active', 'skill-rb2');
  assert.ok(active && active.version && active.version.versionId === v1.version.versionId);
});
test('pengirim tidak tepercaya ditolak (bukan jendela ORION / bukan file://)', async () => {
  const r1 = await handlers['orion:web:overview']({ sender: {}, senderFrame: { url: 'file:///x' } }); assert.strictEqual(r1.ok, false);
  const r2 = await handlers['orion:web:overview']({ sender, senderFrame: { url: 'https://evil.example/' } }); assert.strictEqual(r2.ok, false);
  assert.strictEqual((await call('web:overview')).ok, true);
});
test('konfigurasi pencarian: validasi penyedia, SearXNG (https publik), cx', async () => {
  assert.strictEqual((await call('web:config:set', { provider: 'tidak-ada' })).ok, false);
  for (const u of ['http://searx.example.org', 'https://127.0.0.1/', 'https://localhost/', 'https://intranet/x']) assert.strictEqual((await call('web:config:set', { searxngBase: u })).ok, false, u);
  assert.strictEqual((await call('web:config:set', { googleCx: 'bad cx!' })).ok, false);
  const ok = await call('web:config:set', { provider: 'searxng', searxngBase: 'https://searx.example.org/sub/', googleCx: 'abc:123' });
  assert.strictEqual(ok.ok, true); assert.strictEqual(ok.config.searxngBase, 'https://searx.example.org/sub');
  await call('web:config:set', { provider: 'wikipedia-id' });
});
test('API key pencarian: hanya penyedia berkunci; terenkripsi di disk; tidak pernah dikembalikan', async () => {
  assert.strictEqual((await call('web:key:set', 'wikipedia-id', 'x')).ok, false);
  assert.strictEqual((await call('web:key:set', 'brave', 'brave-RAHASIA-777')).ok, true);
  const ov = await call('web:overview'); assert.strictEqual(ov.providers.find(p => p.id === 'brave').hasKey, true); assert.ok(!JSON.stringify(ov).includes('RAHASIA'));
  const disk = fs.readFileSync(path.join(userData, 'orion-desktop.json'), 'utf8'); assert.ok(!disk.includes('RAHASIA-777'), 'secret tidak boleh tersimpan polos');
  assert.ok(!fs.readdirSync(path.join(userData, 'connectors')).some(f => fs.readFileSync(path.join(userData, 'connectors', f), 'utf8').includes('RAHASIA-777')));
  assert.strictEqual((await call('web:key:del', 'brave')).ok, true); assert.strictEqual((await call('web:overview')).providers.find(p => p.id === 'brave').hasKey, false);
});
test('sesi web: dialog persetujuan memuat penyedia & batas; "semua host" diperingatkan; ditolak → tidak ada sesi', async () => {
  ask({ response: 0 }); const rej = await call('web:session:start', { provider: 'wikipedia-id' }); assert.strictEqual(rej.ok, false); assert.strictEqual(rej.code, 'USER_REJECTED');
  assert.ok(dialogs[0].detail.includes('Wikipedia') && dialogs[0].detail.includes('maks 10 pencarian')); assert.strictEqual((await call('web:overview')).sessions.length, 0);
  ask(); const all = await call('web:session:start', { provider: 'wikipedia-id', mode: 'research', allowAllHosts: true });
  assert.strictEqual(all.ok, true); assert.ok(dialogs[0].detail.includes('SEMUA host publik') && dialogs[0].detail.includes('riset mendalam')); assert.strictEqual(all.session.maxSearches, 25);
  assert.strictEqual((await call('web:session:end', all.session.id)).ok, true); assert.strictEqual((await call('web:overview')).sessions.filter(s => s.active).length, 0);
});
test('web:fetch / data:fetchUrl: URL berbahaya ditolak tanpa menanyai pengguna', async () => {
  assert.strictEqual((await call('web:fetch', 'ws-x', { url: 'https://example.com' })).code, 'NO_SESSION');
  ask(); const s = (await call('web:session:start', { provider: 'wikipedia-id' })).session; dialogs.length = 0;
  for (const [u, code] of [['http://example.com/', 'PROTOCOL_BLOCKED'], ['https://127.0.0.1/', 'IP_LITERAL_BLOCKED'], ['https://localhost/', 'HOST_BLOCKED'], ['https://metadata.google.internal/', 'HOST_BLOCKED']]) {
    assert.strictEqual((await call('web:fetch', s.id, { url: u })).code, code, u); assert.strictEqual((await call('data:fetchUrl', { url: u })).code, code, u);
  }
  assert.strictEqual(dialogs.length, 0, 'tidak boleh ada dialog untuk URL yang pasti ditolak'); await call('web:session:end', s.id);
});
test('discover:open hanya membuka repositori GitHub; discover:search meminta persetujuan (ditolak → tidak mencari)', async () => {
  assert.strictEqual((await call('discover:open', 'https://evil.example/x/y')).ok, false); assert.strictEqual((await call('discover:open', 'https://github.com/acme/mcp-cuaca/../x')).ok, false);
  assert.strictEqual((await call('discover:open', 'https://github.com/acme/mcp-cuaca')).ok, true); assert.deepStrictEqual(opened, ['https://github.com/acme/mcp-cuaca']);
  ask({ response: 0 }); const r = await call('discover:search', { kind: 'mcp', q: 'cuaca' }); assert.strictEqual(r.code, 'USER_REJECTED'); assert.ok(dialogs[0].detail.includes('api.github.com'));
});
test('skills:install — validasi, hanya berkas teks, tanpa symlink/skrip, persetujuan, tolak = tidak menyalin', async () => {
  const src = tmp('orion-skill-'); fs.mkdirSync(path.join(src, 'references'));
  fs.writeFileSync(path.join(src, 'SKILL.md'), '---\nname: Analis Keuangan Mini\ndescription: Membantu analisis laporan keuangan\n---\nInstruksi.');
  fs.writeFileSync(path.join(src, 'references', 'rasio.md'), '# rasio'); fs.writeFileSync(path.join(src, 'install.sh'), 'rm -rf /'); fs.writeFileSync(path.join(src, 'biner.exe'), 'MZ');
  try { fs.symlinkSync('/etc/passwd', path.join(src, 'link.md')); } catch (e) { /* tanpa izin symlink */ }
  openPath = src; ask({ response: 0 }); const no = await call('skills:install', 'folder'); assert.strictEqual(no.code, 'USER_REJECTED');
  assert.ok(!fs.existsSync(path.join(userData, 'skills', 'analis-keuangan-mini')), 'ditolak = tidak ada salinan');
  ask(); const ok = await call('skills:install', 'folder'); assert.strictEqual(ok.ok, true); assert.strictEqual(ok.installed, 'analis-keuangan-mini');
  const dest = path.join(userData, 'skills', 'analis-keuangan-mini');
  assert.ok(fs.existsSync(path.join(dest, 'SKILL.md')) && fs.existsSync(path.join(dest, 'references', 'rasio.md'))); assert.ok(!fs.existsSync(path.join(dest, 'install.sh')) && !fs.existsSync(path.join(dest, 'biner.exe')) && !fs.existsSync(path.join(dest, 'link.md')));
  assert.ok(dialogs[0].detail.includes('Berkas: 2') && dialogs[0].detail.includes('tidak menjalankan kode'));
  const list = await call('skills:list'); assert.ok(list.skills.some(s => s.name === 'Analis Keuangan Mini' && s.source === 'user'));
  const bad = tmp('orion-skill-bad-'); fs.writeFileSync(path.join(bad, 'SKILL.md'), 'tanpa frontmatter'); openPath = bad; assert.strictEqual((await call('skills:install', 'folder')).ok, false);
  const big = tmp('orion-skill-big-'); fs.writeFileSync(path.join(big, 'SKILL.md'), '---\nname: x\ndescription: y\n---\n' + 'a'.repeat(70000)); openPath = big; assert.strictEqual((await call('skills:install', 'folder')).ok, false);
  const single = tmp('orion-skill-file-'); fs.writeFileSync(path.join(single, 'SKILL.md'), '---\nname: Skill Berkas Tunggal\ndescription: uji\n---\nisi'); openPath = path.join(single, 'SKILL.md'); ask();
  assert.strictEqual((await call('skills:install', 'file')).installed, 'skill-berkas-tunggal'); openPath = null; assert.strictEqual((await call('skills:install', 'folder')).installed, null);
});
test('MCP jarak jauh default MATI; aktif hanya lewat dialog; tutup lagi bekerja', async () => {
  const spec = { id: 'remote1', name: 'R', url: 'https://remote.example.com/mcp' };
  const off = await call('mcp:add', spec, 'tok'); assert.strictEqual(off.ok, false); assert.ok(/dinonaktifkan/.test(off.error));
  ask({ response: 0 }); assert.strictEqual((await call('app:setExperimental', 'remoteMcp', true)).code, 'USER_REJECTED'); assert.strictEqual((await call('app:info')).experimental.remoteMcp, false);
  ask(); assert.strictEqual((await call('app:setExperimental', 'remoteMcp', true)).remoteMcp, true); assert.strictEqual((await call('mcp:add', spec, 'tok-RAHASIA-1')).ok, true);
  assert.ok(!fs.readFileSync(path.join(userData, 'orion-desktop.json'), 'utf8').includes('tok-RAHASIA-1'), 'token MCP tidak polos');
  await call('mcp:remove', 'remote1'); assert.strictEqual((await call('app:setExperimental', 'remoteMcp', false)).remoteMcp, false); assert.strictEqual((await call('mcp:add', spec)).ok, false);
  assert.strictEqual((await call('app:setExperimental', 'lain', true)).ok, false);
});
test('emergency stop: menutup sesi web, memblokir pencarian & mission, resume lewat dialog', async () => {
  ask(); const s = (await call('web:session:start', { provider: 'wikipedia-id' })).session;
  const stop = await call('api:stop'); assert.strictEqual(stop.ok, true); assert.ok((await call('api:overview')).stopped);
  assert.strictEqual((await call('web:search', s.id, { query: 'x' })).code, 'NO_SESSION');
  ask(); assert.strictEqual((await call('web:session:start', { provider: 'wikipedia-id' })).code, 'EMERGENCY_STOP');
  ask({ response: 0 }); assert.strictEqual((await call('api:resume')).code, 'USER_REJECTED'); assert.ok((await call('api:overview')).stopped);
  ask(); assert.strictEqual((await call('api:resume')).ok, true); assert.strictEqual((await call('api:overview')).stopped, false);
  assert.ok((await call('api:audit:verify')).ok); const tail = (await call('api:audit:tail', 50)).records; assert.ok(tail.some(r => r.kind === 'emergency.scope'));
});
test('connector: aktivasi tanpa uji ditolak; secret connector terenkripsi di disk; katalog impor dari berkas', async () => {
  const rv = await call('api:connector:review', { id: 'cuaca-demo', name: 'Cuaca', baseUrl: 'https://api.example.com/v1', allowedHosts: ['api.example.com'], authType: 'apiKey', riskLevel: 'read-private', testPath: '/ping' }, null);
  assert.strictEqual(rv.ok, true); ask(); const en = await call('api:connector:enable', 'cuaca-demo'); assert.strictEqual(en.ok, false); assert.ok(/tested/.test(en.error));
  assert.strictEqual((await call('api:secret:set', 'cuaca-demo', 'apiKey', 'conn-RAHASIA-555')).ok, true);
  assert.ok(!fs.readdirSync(userData).some(f => f.endsWith('.json') && fs.readFileSync(path.join(userData, f), 'utf8').includes('conn-RAHASIA-555')));
  assert.strictEqual((await call('api:secret:has', 'cuaca-demo', 'apiKey')).has, true); assert.ok(!JSON.stringify(await call('api:overview')).includes('conn-RAHASIA-555'));
  const md = tmp('orion-cat-'); fs.writeFileSync(path.join(md, 'README.md'), '### Animals\n| API | Description | Auth | HTTPS | CORS |\n|:---|:---|:---|:---|:---|\n| [Axolotl](https://theaxolotlapi.netlify.app/) | fakta | No | Yes | No |\n');
  openPath = path.join(md, 'README.md'); const imp = await call('api:catalog:importFile'); assert.strictEqual(imp.parsed, 1); openPath = null;
  assert.strictEqual((await call('api:catalog:list', { q: 'axolotl' })).total, 1);
});

test('Linux tanpa keyring (backend basic_text): semua penyimpanan secret ditolak, tidak tersimpan polos', async () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-ud2-')); const h2 = {}; const snd = {};
  register({
    ipcMain: { handle: (ch, fn) => { h2[ch] = fn; } }, app: { getPath: () => ud, isPackaged: false, getVersion: () => 't', on() {} },
    dialog: { showMessageBox: async () => ({ response: 1, checkboxChecked: false }), showOpenDialog: async () => ({ canceled: true, filePaths: [] }) }, shell: { openExternal: async () => {}, openPath: async () => '' },
    safeStorage: { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => 'basic_text', encryptString: s => Buffer.from(s), decryptString: b => Buffer.from(b).toString() },
    getWindow: () => ({ webContents: snd }), updater: null
  });
  const c2 = (ch, ...a) => h2['orion:' + ch]({ sender: snd, senderFrame: { url: 'file:///app/index.html' } }, ...a);
  assert.strictEqual((await c2('app:info')).secureStore, false); assert.strictEqual((await c2('api:overview')).secureStore, false);
  const k = await c2('web:key:set', 'brave', 'RAHASIA-LINUX-1'); assert.strictEqual(k.ok, false); assert.ok(/tidak tersedia/.test(k.error));
  assert.strictEqual((await c2('secret:set', 'aikey', 'RAHASIA-LINUX-2')).ok, false);
  assert.ok(!fs.readdirSync(ud).some(f => fs.statSync(path.join(ud, f)).isFile() && fs.readFileSync(path.join(ud, f), 'utf8').includes('RAHASIA-LINUX')));
});

(async () => {
  for (const t of queue) { try { await t.fn(); pass++; console.log('  ✓ ' + t.n); } catch (e) { fail++; console.log('  ✗ ' + t.n + '\n      ' + String((e && e.stack) || e).split('\n').slice(0, 4).join('\n      ')); } }
  console.log(`\nBridge (Electron tiruan): ${pass} lulus, ${fail} gagal (total ${queue.length}).`); process.exit(fail ? 1 : 0);
})();
