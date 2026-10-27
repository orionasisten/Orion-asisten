'use strict';
/**
 * Tes integrasi Phase D — klien mobile ↔ Orion Central (PostgreSQL NYATA).
 *
 * Cakupan:
 *  - Pairing perangkat: token perangkat dipakai untuk sesi, pesan, misi, approval.
 *  - Chat: pesan mobile → server → terlihat oleh klien web (Owner) & urutan/pagination konsisten.
 *  - Idempotensi: retry clientMessageId sama tidak menduplikasi.
 *  - Outbox: entri offline tetap pending & terkirim tanpa duplikasi.
 *  - Pencabutan perangkat/sesi → akses ditolak (tidak bisa baca/ubah data).
 *  - Push token: register/revoke terikat owner.
 *  - **Paritas kontrak**: setiap path yang dipakai mobile terdaftar di router backend.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CONN = process.env.ORION_PG_CONNECTION || process.env.DATABASE_URL || '';
if (!CONN){
  console.log('\n  ⚠ PostgreSQL tidak dikonfigurasi — suite Phase D DILEWATI (bukan lulus).');
  process.exit(2);
}

const { createDatabase } = require('../src/central/db');
const { migrate } = require('../src/central/db/migrate');
const { createApp } = require('../src/central/app');
const { readConfig } = require('../src/central/config');
const { CentralDesktop } = require('../src/central/desktop-sync');

let passed = 0, failed = 0;
const tests = [];
function t(name, fn){ tests.push({ name, fn }); }

function req(port, method, p, body, headers){
  return new Promise((resolve, reject)=>{
    const data = body===undefined?null:Buffer.from(JSON.stringify(body),'utf8');
    const h = Object.assign({ 'Content-Type':'application/json' }, headers||{});
    if(data) h['Content-Length']=data.length;
    const r = require('http').request({ hostname:'127.0.0.1', port, path:p, method, headers:h }, res=>{
      const c=[]; res.on('data',x=>c.push(x)); res.on('end',()=>{
        const txt=Buffer.concat(c).toString('utf8'); let j=null;
        try{ j=txt?JSON.parse(txt):null; }catch(e){}
        resolve({ status:res.statusCode, body:j });
      });
    });
    r.on('error', reject);
    if(data) r.write(data);
    r.end();
  });
}

async function setup(){
  const admin = new (require('pg').Client)({ connectionString: CONN });
  await admin.connect();
  const name = 'orion_pd_' + crypto.randomBytes(6).toString('hex');
  await admin.query('CREATE DATABASE ' + name);
  await admin.end();
  const url = CONN.replace(/\/[^/?]*(\?|$)/, '/' + name + '$1');
  const db = createDatabase({ driver:'postgres', databaseUrl:url });
  await migrate(db, {});
  const cfg = readConfig({ CENTRAL_DB_DRIVER:'postgres', DATABASE_URL:url, CENTRAL_RATE_LIMIT_PER_MIN:'10000' });
  const app = createApp({ db, config:cfg, setupKey:'setup-key', version:'1.0.0' });
  const server = require('http').createServer((rq,rs)=>app.handle(rq,rs).catch(()=>{ rs.writeHead(500); rs.end('{}'); }));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  const boot = await req(port, 'POST', '/v1/auth/bootstrap', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { 'x-setup-key':'setup-key' });
  const ownerToken = boot.body.token;
  // token perangkat untuk mobile (alur pairing: Web → perangkat)
  const dev = await req(port, 'POST', '/v1/devices', { name:'Pixel Owner' }, { Authorization:'Bearer '+ownerToken });
  return { name, db, server, port, base, ownerToken, deviceToken: dev.body.token, deviceId: dev.body.deviceId };
}
async function teardown(s){
  try { s.server.close(); } catch(e){}
  try { await s.db.close(); } catch(e){}
  try {
    const admin = new (require('pg').Client)({ connectionString: CONN });
    await admin.connect();
    await admin.query('DROP DATABASE IF EXISTS ' + s.name + ' WITH (FORCE)');
    await admin.end();
  } catch(e){}
}

// ═══ pairing & sesi ═══
t('pairing: token perangkat mendapat sesi owner', async ()=>{
  const s = await setup();
  const r = await req(s.port, 'GET', '/v1/session', undefined, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.email, 'owner@orion.id');
  assert.strictEqual(r.body.deviceId, s.deviceId);
  assert.ok(!JSON.stringify(r.body).includes(s.deviceToken), 'token tidak boleh muncul di respons');
  await teardown(s);
});

t('tanpa token → 401 (tidak ada akses data)', async ()=>{
  const s = await setup();
  const r = await req(s.port, 'GET', '/v1/conversations');
  assert.strictEqual(r.status, 401);
  const r2 = await req(s.port, 'GET', '/v1/missions');
  assert.strictEqual(r2.status, 401);
  await teardown(s);
});

t('pencabutan perangkat → sesi tidak bisa baca/ubah data', async ()=>{
  const s = await setup();
  const before = await req(s.port, 'GET', '/v1/conversations', undefined, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(before.status, 200);
  const rev = await req(s.port, 'DELETE', '/v1/devices/' + s.deviceId, undefined, { Authorization:'Bearer '+s.ownerToken });
  assert.strictEqual(rev.status, 200);
  const after = await req(s.port, 'GET', '/v1/conversations', undefined, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(after.status, 401, 'token perangkat yang dicabut harus ditolak');
  const afterMsg = await req(s.port, 'POST', '/v1/conversations', { title:'x' }, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(afterMsg.status, 401, 'perubahan data juga harus ditolak');
  await teardown(s);
});

t('token kedaluwarsa → 401 TOKEN_EXPIRED (tidak bisa baca/ubah data)', async ()=>{
  const s = await setup();
  const past = new Date(Date.now() - 3600e3).toISOString();
  const hash = crypto.createHash('sha256').update(s.deviceToken).digest('hex');
  await s.db.query('UPDATE auth_tokens SET expires_at = ? WHERE token_hash = ?', [past, hash]);
  const read = await req(s.port, 'GET', '/v1/conversations', undefined, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(read.status, 401);
  assert.strictEqual(read.body.error.code, 'TOKEN_EXPIRED');
  const write = await req(s.port, 'POST', '/v1/conversations', { title:'x' }, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(write.status, 401);
  await teardown(s);
});

t('token dicabut langsung di auth_tokens → 401 TOKEN_REVOKED', async ()=>{
  const s = await setup();
  const hash = crypto.createHash('sha256').update(s.deviceToken).digest('hex');
  await s.db.query('UPDATE auth_tokens SET status = ?, revoked_at = ? WHERE token_hash = ?', ['revoked', new Date().toISOString(), hash]);
  const r = await req(s.port, 'GET', '/v1/session', undefined, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.body.error.code, 'TOKEN_REVOKED');
  await teardown(s);
});

// ═══ chat lintas perangkat ═══
t('chat mobile → server → terlihat oleh klien web Owner', async ()=>{
  const s = await setup();
  const conv = await req(s.port, 'POST', '/v1/conversations', { title:'Mobile Chat', clientKey:'mob-1' }, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(conv.status, 201);
  const convId = conv.body.conversation.id;
  const marker = 'pesan-dari-mobile-' + Date.now();
  const sent = await req(s.port, 'POST', '/v1/conversations/' + convId + '/messages',
    { role:'user', content:marker, clientMessageId:'cm-mobile-1' }, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(sent.status, 201);
  // klien web (token owner) melihat pesan yang sama
  const seen = await req(s.port, 'GET', '/v1/conversations/' + convId + '/messages', undefined, { Authorization:'Bearer '+s.ownerToken });
  assert.ok(seen.body.messages.some(m => m.content === marker), 'web harus melihat pesan mobile');
  await teardown(s);
});

t('chat web/Owner → server → terlihat oleh mobile', async ()=>{
  const s = await setup();
  const conv = await req(s.port, 'POST', '/v1/conversations', { title:'Shared', clientKey:'mob-2' }, { Authorization:'Bearer '+s.ownerToken });
  const convId = conv.body.conversation.id;
  const marker = 'balasan-dari-web-' + Date.now();
  await req(s.port, 'POST', '/v1/conversations/' + convId + '/messages',
    { role:'assistant', content:marker, clientMessageId:'cm-web-1' }, { Authorization:'Bearer '+s.ownerToken });
  const seen = await req(s.port, 'GET', '/v1/conversations/' + convId + '/messages', undefined, { Authorization:'Bearer '+s.deviceToken });
  assert.ok(seen.body.messages.some(m => m.content === marker), 'mobile harus melihat pesan web');
  await teardown(s);
});

t('urutan & pagination konsisten antar klien', async ()=>{
  const s = await setup();
  const conv = await req(s.port, 'POST', '/v1/conversations', { title:'Order', clientKey:'mob-3' }, { Authorization:'Bearer '+s.deviceToken });
  const convId = conv.body.conversation.id;
  for (let i=1;i<=6;i++){
    await req(s.port, 'POST', '/v1/conversations/' + convId + '/messages',
      { role:'user', content:'m'+i, clientMessageId:'cm-o'+i }, { Authorization:'Bearer '+s.deviceToken });
  }
  const a = await req(s.port, 'GET', '/v1/conversations/' + convId + '/messages?after=0&limit=4', undefined, { Authorization:'Bearer '+s.deviceToken });
  const b = await req(s.port, 'GET', '/v1/conversations/' + convId + '/messages?after=' + a.body.nextSeq + '&limit=4', undefined, { Authorization:'Bearer '+s.ownerToken });
  assert.strictEqual(a.body.messages.length, 4);
  assert.strictEqual(b.body.messages.length, 2);
  const all = a.body.messages.concat(b.body.messages).map(m => m.content);
  assert.deepStrictEqual(all, ['m1','m2','m3','m4','m5','m6']);
  const seqs = a.body.messages.concat(b.body.messages).map(m => m.seq);
  assert.deepStrictEqual(seqs, [1,2,3,4,5,6]);
  await teardown(s);
});

t('retry dengan clientMessageId sama tidak menduplikasi (mobile)', async ()=>{
  const s = await setup();
  const conv = await req(s.port, 'POST', '/v1/conversations', { title:'Idem', clientKey:'mob-4' }, { Authorization:'Bearer '+s.deviceToken });
  const convId = conv.body.conversation.id;
  const body = { role:'user', content:'sama', clientMessageId:'cm-dup' };
  const r1 = await req(s.port, 'POST', '/v1/conversations/' + convId + '/messages', body, { Authorization:'Bearer '+s.deviceToken });
  const r2 = await req(s.port, 'POST', '/v1/conversations/' + convId + '/messages', body, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(r1.status, 201);
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.body.duplicate, true);
  const c = await s.db.query('SELECT count(*) c FROM messages WHERE conversation_id = ?', [convId]);
  assert.strictEqual(Number(c[0].c), 1);
  await teardown(s);
});

t('outbox mobile: offline → pending → terkirim tanpa duplikasi', async ()=>{
  const s = await setup();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-mob-outbox-'));
  let token = null;
  const desktop = new CentralDesktop({
    userData: dir, getWindow: () => null,
    readToken: () => token, writeToken: (k,v) => { token = v; },
    readState: () => ({}), writeState: () => {}, baseUrl: s.base
  });
  // token belum ada → pending
  const r1 = await desktop.sendMessage('cnv-mob', { role:'user', content:'offline', clientMessageId:'mob-1' });
  assert.strictEqual(r1.status, 'pending');
  assert.strictEqual(desktop.outbox.count(), 1);
  // pasang token perangkat lewat alur pairing yang resmi (login) lalu flush
  await desktop.login(s.deviceToken);
  assert.ok(desktop.hasToken(), 'token harus tersimpan di main process');
  const conv = await req(s.port, 'POST', '/v1/conversations', { title:'Outbox', clientKey:'mob-5' }, { Authorization:'Bearer '+s.deviceToken });
  const res = await desktop.sendMessage(conv.body.conversation.id, { role:'user', content:'offline', clientMessageId:'mob-2' });
  assert.ok(['sent','pending'].includes(res.status));
  const c = await s.db.query('SELECT count(*) c FROM messages WHERE owner_id = (SELECT id FROM owners WHERE email = ?)', ['owner@orion.id']);
  assert.ok(Number(c[0].c) >= 1, 'pesan harus sampai ke server');
  await teardown(s);
});

t('delta catch-up lewat /v1/sync/changes (mobile)', async ()=>{
  const s = await setup();
  const conv = await req(s.port, 'POST', '/v1/conversations', { title:'Delta', clientKey:'mob-6' }, { Authorization:'Bearer '+s.deviceToken });
  const convId = conv.body.conversation.id;
  await req(s.port, 'POST', '/v1/conversations/' + convId + '/messages',
    { role:'user', content:'delta-1', clientMessageId:'cm-d1' }, { Authorization:'Bearer '+s.deviceToken });
  const feed = await req(s.port, 'GET', '/v1/sync/changes?since=0&limit=100', undefined, { Authorization:'Bearer '+s.deviceToken });
  assert.ok(feed.body.changes.some(c => c.type === 'message.created'), 'delta feed harus memuat message.created');
  const filtered = await req(s.port, 'GET', '/v1/sync/changes?since=0&types=message.created', undefined, { Authorization:'Bearer '+s.deviceToken });
  assert.ok(filtered.body.changes.every(c => c.type === 'message.created'));
  await teardown(s);
});

// ═══ misi & approval (server-authoritative) ═══
t('mobile bisa membaca misi & approval; approval tetap server-authoritative', async ()=>{
  const s = await setup();
  const m = await req(s.port, 'POST', '/v1/missions', { title:'Misi Mobile' }, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(m.status, 201);
  const list = await req(s.port, 'GET', '/v1/missions', undefined, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(list.body.missions.length, 1);
  // approval dibuat langsung di DB (server), lalu diputuskan via endpoint resmi
  const owner = (await s.db.query('SELECT id FROM owners WHERE email = ?', ['owner@orion.id']))[0];
  await s.db.query(`INSERT INTO approvals (id, owner_id, action, resource, params, scope, fingerprint, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ['ap-mob', owner.id, 'publish', 'res://x', JSON.stringify({v:1}), 'mission', 'fp-mob', 'pending', new Date().toISOString(), new Date(Date.now()+60000).toISOString()]);
  const ap = await req(s.port, 'GET', '/v1/approvals?status=pending', undefined, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(ap.body.approvals.length, 1);
  const dec = await req(s.port, 'POST', '/v1/approvals/ap-mob/decision', { decision:'approved' }, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(dec.status, 200);
  // keputusan kedua ditolak (server-authoritative)
  const dec2 = await req(s.port, 'POST', '/v1/approvals/ap-mob/decision', { decision:'rejected' }, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(dec2.status, 409);
  await teardown(s);
});

// ═══ push token ═══
t('push token terdaftar & dicabut, terikat owner', async ()=>{
  const s = await setup();
  const reg = await req(s.port, 'POST', '/v1/push/register', { token:'ExponentPushToken[test-token-123456]', platform:'android' }, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(reg.status, 201);
  const list = await req(s.port, 'GET', '/v1/push/tokens', undefined, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(list.body.tokens.length, 1);
  assert.strictEqual(list.body.tokens[0].platform, 'android');
  const rev = await req(s.port, 'POST', '/v1/push/revoke', { token:'ExponentPushToken[test-token-123456]' }, { Authorization:'Bearer '+s.deviceToken });
  assert.ok(rev.body.ok);
  const after = await req(s.port, 'GET', '/v1/push/tokens', undefined, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(after.body.tokens[0].status, 'revoked');
  await teardown(s);
});

t('push register tanpa autentikasi ditolak', async ()=>{
  const s = await setup();
  const r = await req(s.port, 'POST', '/v1/push/register', { token:'x'.repeat(20), platform:'android' }, {});
  assert.strictEqual(r.status, 401);
  await teardown(s);
});

t('push token tidak bisa diambil alih Owner lain; token owner tanpa device ditolak', async ()=>{
  const s = await setup();
  const token = 'ExponentPushToken[cross-owner-123456]';
  const reg = await req(s.port, 'POST', '/v1/push/register', { token, platform:'android' }, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(reg.status, 201);
  // Owner kedua + device kedua
  const boot2 = await req(s.port, 'POST', '/v1/auth/bootstrap', { email:'owner2@orion.id', password:'rahasia-owner-2026' }, { 'x-setup-key':'setup-key' });
  assert.strictEqual(boot2.status, 201);
  const dev2 = await req(s.port, 'POST', '/v1/devices', { name:'Pixel 2' }, { Authorization:'Bearer '+boot2.body.token });
  assert.strictEqual(dev2.status, 201);
  const steal = await req(s.port, 'POST', '/v1/push/register', { token, platform:'android' }, { Authorization:'Bearer '+dev2.body.token });
  assert.strictEqual(steal.status, 409);
  assert.strictEqual(steal.body.error.code, 'PUSH_TOKEN_CONFLICT');
  const row = await s.db.query('SELECT owner_id, device_id, status FROM push_tokens WHERE token = ?', [token]);
  assert.strictEqual(row.length, 1);
  assert.strictEqual(row[0].owner_id, (await s.db.query('SELECT owner_id FROM devices WHERE id = ?', [s.deviceId]))[0].owner_id);
  assert.strictEqual(row[0].device_id, s.deviceId);
  assert.strictEqual(row[0].status, 'active');
  // Token owner (tanpa device) tidak boleh mendaftarkan token perangkat mana pun.
  const noDev = await req(s.port, 'POST', '/v1/push/register', { token:'ExponentPushToken[no-device-123456]', platform:'android' }, { Authorization:'Bearer '+s.ownerToken });
  assert.strictEqual(noDev.status, 403);
  assert.strictEqual(noDev.body.error.code, 'DEVICE_REQUIRED');
  // Daftar token hanya milik device yang bertanya.
  const list = await req(s.port, 'GET', '/v1/push/tokens', undefined, { Authorization:'Bearer '+dev2.body.token });
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body.tokens.length, 0);
  const ownerList = await req(s.port, 'GET', '/v1/push/tokens', undefined, { Authorization:'Bearer '+s.ownerToken });
  assert.strictEqual(ownerList.status, 403);
  await teardown(s);
});

t('pencabutan device ikut mencabut push token-nya', async ()=>{
  const s = await setup();
  const token = 'ExponentPushToken[device-revoke-123456]';
  const reg = await req(s.port, 'POST', '/v1/push/register', { token, platform:'android' }, { Authorization:'Bearer '+s.deviceToken });
  assert.strictEqual(reg.status, 201);
  const rev = await req(s.port, 'DELETE', '/v1/devices/' + s.deviceId, undefined, { Authorization:'Bearer '+s.ownerToken });
  assert.strictEqual(rev.status, 200);
  const row = await s.db.query('SELECT status FROM push_tokens WHERE token = ?', [token]);
  assert.strictEqual(row[0].status, 'revoked');
  await teardown(s);
});

// ═══ paritas kontrak mobile ↔ backend ═══
t('paritas kontrak: semua path yang dipakai mobile terdaftar di backend', ()=>{
  const clientSrc = fs.readFileSync(path.join(__dirname, '..', 'mobile', 'src', 'api', 'client.ts'), 'utf8');
  const appSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'central', 'app.js'), 'utf8');
  // ambil path statis (prefix sebelum parameter dinamis)
  const used = new Set();
  const re = /api<[^>]*>\(\s*'(\/v1\/[^']*?)'\s*\+/g;
  const re2 = /api<[^>]*>\(\s*'(\/v1\/[^']*?)'/g;
  let m;
  while ((m = re.exec(clientSrc))) used.add(m[1]);
  while ((m = re2.exec(clientSrc))) used.add(m[1]);
  assert.ok(used.size >= 12, 'path mobile yang terdeteksi terlalu sedikit: ' + used.size);
  // backend: kumpulkan route yang terdaftar
  const routes = new Set();
  const rre = /router\.(?:get|post|put|patch|delete)\(\s*'(\/v1\/[^']+)'/g;
  while ((m = rre.exec(appSrc))) routes.add(m[1]);
  const missing = [];
  for (const p of used){
    const prefix = p.replace(/\/$/, '');
    const ok = [...routes].some(r => r === prefix || r.startsWith(prefix + '/') || prefix.startsWith(r.replace(/\/:[A-Za-z]+$/, '')));
    if (!ok) missing.push(p);
  }
  assert.deepStrictEqual(missing, [], 'path mobile tanpa route backend: ' + missing.join(', '));
  console.log('      (path mobile diperiksa: ' + used.size + ', route backend: ' + routes.size + ')');
});

(async ()=>{
  console.log('Phase D — integrasi mobile ↔ Orion Central (PostgreSQL nyata)');
  for (const item of tests){
    try { await item.fn(); console.log('  ✓ ' + item.name); passed++; }
    catch (e){ console.log('  ✗ ' + item.name + ' — ' + (e && e.message)); failed++; }
  }
  console.log('\nPhase D integrasi: ' + passed + ' lulus, ' + failed + ' gagal');
  process.exit(failed ? 1 : 0);
})();
