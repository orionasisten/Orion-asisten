'use strict';
/**
 * Tes integrasi Phase B — auth web, cookie session, CSRF, CORS, login Owner,
 * inferensi server (mock provider), & delta sync — PostgreSQL NYATA.
 *
 * Jalankan: node scripts/pg-harness.js --run scripts/test-phaseB-webauth.js
 */
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');

const CONN = process.env.ORION_PG_CONNECTION || process.env.DATABASE_URL || '';
if (!CONN){
  console.log('\n  ⚠ PostgreSQL tidak dikonfigurasi — suite Phase B DILEWATI (bukan lulus).');
  process.exit(2);
}

const { createDatabase } = require('../src/central/db');
const { migrate } = require('../src/central/db/migrate');
const { createApp } = require('../src/central/app');
const { readConfig } = require('../src/central/config');

let passed = 0, failed = 0;
const tests = [];
function t(name, fn){ tests.push({ name, fn }); }

const ORIGIN = 'https://orion.pages.dev';

async function setup(opts){
  opts = opts || {};
  const admin = new (require('pg').Client)({ connectionString: CONN });
  await admin.connect();
  const name = 'orion_pb_' + crypto.randomBytes(6).toString('hex');
  await admin.query('CREATE DATABASE ' + name);
  await admin.end();
  const url = CONN.replace(/\/[^/?]*(\?|$)/, '/' + name + '$1');
  const db = createDatabase({ driver:'postgres', databaseUrl: url });
  await migrate(db, {});
  const cfg = readConfig({
    CENTRAL_DB_DRIVER:'postgres', DATABASE_URL:url,
    CENTRAL_RATE_LIMIT_PER_MIN:'10000',
    CENTRAL_CORS_ORIGINS: opts.corsOrigins || ORIGIN
  });
  const app = createApp({ db, config: cfg, setupKey:'setup-key', version:'1.0.0', provider: opts.provider || null, setupPassword: opts.setupPassword || '' });
  const server = http.createServer((rq,rs)=>app.handle(rq,rs).catch(()=>{ try{ rs.writeHead(500); rs.end('{}'); }catch(e){} }));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port = server.address().port;
  return { db, server, port, url, name, base:'http://127.0.0.1:' + port };
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
function call(port, method, p, body, headers){
  return new Promise((resolve, reject)=>{
    const data = body===undefined?null:Buffer.from(JSON.stringify(body),'utf8');
    const h = Object.assign({ 'Content-Type':'application/json' }, headers||{});
    if(data) h['Content-Length']=data.length;
    const r = http.request({ hostname:'127.0.0.1', port, path:p, method, headers:h }, res=>{
      const c=[]; res.on('data',x=>c.push(x)); res.on('end',()=>{
        const txt=Buffer.concat(c).toString('utf8'); let j=null;
        try{ j=txt?JSON.parse(txt):null; }catch(e){}
        resolve({ status:res.statusCode, body:j, raw:txt, headers:res.headers, cookies:res.headers['set-cookie'] || [] });
      });
    });
    r.on('error', reject);
    if(data) r.write(data);
    r.end();
  });
}
function cookieHeader(setCookies, name){
  const hit = (setCookies || []).find(c => c.startsWith(name + '='));
  if (!hit) return null;
  return hit.split(';')[0];
}
function csrfOf(setCookies){
  const hit = (setCookies || []).find(c => c.startsWith('orion_csrf='));
  if (!hit) return null;
  return decodeURIComponent(hit.split(';')[0].slice('orion_csrf='.length));
}

// ══════════ login Owner ══════════
t('login Owner: kredensial salah ditolak, benar berhasil (cookie mode)', async ()=>{
  const s = await setup({ setupPassword:'rahasia-owner-2026' });
  // bootstrap dengan password
  const boot = await call(s.port, 'POST', '/v1/auth/bootstrap', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { 'x-setup-key':'setup-key' });
  assert.strictEqual(boot.status, 201);
  assert.strictEqual(boot.body.passwordConfigured, true);
  // password salah
  const bad = await call(s.port, 'POST', '/v1/auth/login', { email:'owner@orion.id', password:'salah' }, { Origin: ORIGIN });
  assert.strictEqual(bad.status, 401);
  assert.strictEqual(bad.body.error.code, 'INVALID_CREDENTIALS');
  // password benar
  const ok = await call(s.port, 'POST', '/v1/auth/login', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { Origin: ORIGIN });
  assert.strictEqual(ok.status, 200);
  assert.ok(ok.body.sessionId);
  // token TIDAK boleh dikembalikan di body pada mode cookie
  assert.strictEqual(ok.body.accessToken, undefined, 'access token tidak boleh di body saat mode cookie');
  assert.strictEqual(ok.body.refreshToken, undefined, 'refresh token tidak boleh di body saat mode cookie');
  // cookie HttpOnly untuk access & refresh
  const at = (ok.cookies || []).find(c => c.startsWith('orion_at='));
  const rt = (ok.cookies || []).find(c => c.startsWith('orion_rt='));
  assert.ok(at && /HttpOnly/i.test(at), 'orion_at harus HttpOnly');
  assert.ok(rt && /HttpOnly/i.test(rt), 'orion_rt harus HttpOnly');
  assert.ok(/SameSite=None/i.test(at), 'cross-site (origin web != origin API) wajib SameSite=None');
  assert.ok(!/Secure/i.test(at), 'tanpa HTTPS, cookie tidak boleh ditandai Secure');
  // melalui reverse proxy HTTPS → Secure dipasang
  const viaProxy = await call(s.port, 'POST', '/v1/auth/login', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { Origin: ORIGIN, 'x-forwarded-proto':'https' });
  const at2 = (viaProxy.cookies || []).find(c => c.startsWith('orion_at='));
  assert.ok(at2 && /Secure/i.test(at2), 'HTTPS wajib memberi Secure');
  // CSRF cookie harus terbaca skrip (tanpa HttpOnly)
  const cs = (ok.cookies || []).find(c => c.startsWith('orion_csrf='));
  assert.ok(cs && !/HttpOnly/i.test(cs), 'orion_csrf harus dapat dibaca skrip (double-submit)');
  await teardown(s);
});

t('cookie same-origin → SameSite=Strict (tidak melonggarkan proteksi)', async ()=>{
  const s = await setup({ setupPassword:'rahasia-owner-2026' });
  await call(s.port, 'POST', '/v1/auth/bootstrap', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { 'x-setup-key':'setup-key' });
  // tanpa header Origin (permintaan same-origin) → Strict
  const ok = await call(s.port, 'POST', '/v1/auth/login', { email:'owner@orion.id', password:'rahasia-owner-2026' }, {});
  const at = (ok.cookies || []).find(c => c.startsWith('orion_at='));
  assert.ok(at && /SameSite=Strict/i.test(at), 'same-origin harus SameSite=Strict: ' + at);
  await teardown(s);
});

t('login dengan email yang tidak ada → 401 (tidak membocorkan keberadaan)', async ()=>{
  const s = await setup();
  const r = await call(s.port, 'POST', '/v1/auth/login', { email:'tidak@ada.id', password:'apapun12345' }, { Origin: ORIGIN });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.body.error.code, 'INVALID_CREDENTIALS');
  await teardown(s);
});

t('login throttling: percobaan berulang diblokir 429', async ()=>{
  const s = await setup({ setupPassword:'rahasia-owner-2026' });
  await call(s.port, 'POST', '/v1/auth/bootstrap', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { 'x-setup-key':'setup-key' });
  let limited = false;
  for (let i=0;i<15;i++){
    const r = await call(s.port, 'POST', '/v1/auth/login', { email:'owner@orion.id', password:'salah' }, { Origin: ORIGIN });
    if (r.status === 429){ limited = true; break; }
  }
  assert.ok(limited, 'login(throttle) harus membatasi percobaan');
  await teardown(s);
});

// ══════════ cookie session + CSRF ══════════
t('cookie session: request terautentikasi berhasil; tanpa CSRF ditolak (403)', async ()=>{
  const s = await setup({ setupPassword:'rahasia-owner-2026' });
  await call(s.port, 'POST', '/v1/auth/bootstrap', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { 'x-setup-key':'setup-key' });
  const login = await call(s.port, 'POST', '/v1/auth/login', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { Origin: ORIGIN });
  const cookie = (login.cookies || []).map(c => c.split(';')[0]).join('; ');
  const csrf = csrfOf(login.cookies);
  // GET dengan cookie → 200
  const g = await call(s.port, 'GET', '/v1/session', undefined, { Cookie: cookie, Origin: ORIGIN });
  assert.strictEqual(g.status, 200);
  assert.strictEqual(g.body.email, 'owner@orion.id');
  assert.strictEqual(g.body.authMethod, 'cookie');
  // POST tanpa header CSRF → 403
  const noCsrf = await call(s.port, 'POST', '/v1/conversations', { title:'X' }, { Cookie: cookie, Origin: ORIGIN });
  assert.strictEqual(noCsrf.status, 403);
  assert.strictEqual(noCsrf.body.error.code, 'CSRF_FAILED');
  // POST dengan CSRF salah → 403
  const badCsrf = await call(s.port, 'POST', '/v1/conversations', { title:'X' }, { Cookie: cookie, 'X-CSRF-Token': 'salah', Origin: ORIGIN });
  assert.strictEqual(badCsrf.status, 403);
  // POST dengan CSRF benar → 201
  const ok = await call(s.port, 'POST', '/v1/conversations', { title:'X' }, { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: ORIGIN });
  assert.strictEqual(ok.status, 201);
  await teardown(s);
});

t('sesi kedaluwarsa / dicabut → 401 (bukan diam)', async ()=>{
  const s = await setup({ setupPassword:'rahasia-owner-2026' });
  const boot = await call(s.port, 'POST', '/v1/auth/bootstrap', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { 'x-setup-key':'setup-key' });
  const ownerToken = boot.body.token;
  const login = await call(s.port, 'POST', '/v1/auth/login', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { Origin: ORIGIN });
  const cookie = (login.cookies || []).map(c => c.split(';')[0]).join('; ');
  // logout: hapus sesi milik owner yang sama (token bootstrap owner tersebut)
  const del = await call(s.port, 'DELETE', '/v1/sessions/' + login.body.sessionId, undefined, { Authorization:'Bearer ' + ownerToken });
  assert.strictEqual(del.status, 200);
  const after = await call(s.port, 'GET', '/v1/session', undefined, { Cookie: cookie, Origin: ORIGIN });
  assert.strictEqual(after.status, 401);
  assert.strictEqual(after.body.error.code, 'SESSION_REVOKED');
  await teardown(s);
});
async function bootstrapToken(s){
  const r = await call(s.port, 'POST', '/v1/auth/bootstrap', { email:'helper@orion.id' }, { 'x-setup-key':'setup-key' });
  return r.body.token;
}

t('refresh via cookie: token lama diganti, token lama tidak berlaku', async ()=>{
  const s = await setup({ setupPassword:'rahasia-owner-2026' });
  await call(s.port, 'POST', '/v1/auth/bootstrap', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { 'x-setup-key':'setup-key' });
  const login = await call(s.port, 'POST', '/v1/auth/login', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { Origin: ORIGIN });
  const cookie = (login.cookies || []).map(c => c.split(';')[0]).join('; ');
  const csrf = csrfOf(login.cookies);
  const ref = await call(s.port, 'POST', '/v1/sessions/refresh', {}, { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: ORIGIN });
  assert.strictEqual(ref.status, 200);
  const newCookie = (ref.cookies || []).map(c => c.split(';')[0]).join('; ');
  assert.ok(newCookie.includes('orion_at='));
  // cookie lama tidak berlaku
  const old = await call(s.port, 'GET', '/v1/session', undefined, { Cookie: cookie, Origin: ORIGIN });
  assert.strictEqual(old.status, 401, 'access token lama harus tidak berlaku setelah rotasi');
  // cookie baru berlaku
  const nu = await call(s.port, 'GET', '/v1/session', undefined, { Cookie: newCookie, Origin: ORIGIN });
  assert.strictEqual(nu.status, 200);
  await teardown(s);
});

t('refresh via cookie berhasil setelah access token kedaluwarsa (bukan 401)', async ()=>{
  const s = await setup({ setupPassword:'rahasia-owner-2026' });
  await call(s.port, 'POST', '/v1/auth/bootstrap', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { 'x-setup-key':'setup-key' });
  const login = await call(s.port, 'POST', '/v1/auth/login', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { Origin: ORIGIN });
  const cookie = (login.cookies || []).map(c => c.split(';')[0]).join('; ');
  const csrf = csrfOf(login.cookies);
  // Access token sudah lewat masa berlaku, refresh masih valid.
  await s.db.query('UPDATE sessions SET access_expires_at = ? WHERE id = ?',
    [new Date(Date.now() - 60000).toISOString(), login.body.sessionId]);
  const expired = await call(s.port, 'GET', '/v1/session', undefined, { Cookie: cookie, Origin: ORIGIN });
  assert.strictEqual(expired.status, 401);
  assert.strictEqual(expired.body.error.code, 'SESSION_EXPIRED');
  const ref = await call(s.port, 'POST', '/v1/sessions/refresh', {}, { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: ORIGIN });
  assert.strictEqual(ref.status, 200, JSON.stringify(ref.body));
  const newCookie = (ref.cookies || []).map(c => c.split(';')[0]).join('; ');
  const after = await call(s.port, 'GET', '/v1/session', undefined, { Cookie: newCookie, Origin: ORIGIN });
  assert.strictEqual(after.status, 200);
  await teardown(s);
});

t('cookie sesi milik device yang dicabut → 401 & tidak bisa refresh', async ()=>{
  const s = await setup({ setupPassword:'rahasia-owner-2026' });
  const boot = await call(s.port, 'POST', '/v1/auth/bootstrap', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { 'x-setup-key':'setup-key' });
  const ownerToken = boot.body.token;
  // Buat sesi cookie untuk sebuah device nyata.
  const dev = await call(s.port, 'POST', '/v1/devices', { name:'Browser' }, { Authorization:'Bearer ' + ownerToken });
  assert.strictEqual(dev.status, 201);
  const ses = await call(s.port, 'POST', '/v1/sessions', { delivery:'cookie' }, { Authorization:'Bearer ' + dev.body.token, Origin: ORIGIN });
  assert.strictEqual(ses.status, 201);
  const cookie = (ses.cookies || []).map(c => c.split(';')[0]).join('; ');
  const csrf = csrfOf(ses.cookies);
  const ok = await call(s.port, 'GET', '/v1/session', undefined, { Cookie: cookie, Origin: ORIGIN });
  assert.strictEqual(ok.status, 200);
  // Cabut device lewat token owner.
  const rev = await call(s.port, 'DELETE', '/v1/devices/' + dev.body.deviceId, undefined, { Authorization:'Bearer ' + ownerToken });
  assert.strictEqual(rev.status, 200);
  const after = await call(s.port, 'GET', '/v1/session', undefined, { Cookie: cookie, Origin: ORIGIN });
  assert.strictEqual(after.status, 401);
  assert.ok(['DEVICE_REVOKED', 'SESSION_REVOKED'].includes(after.body.error.code), 'got ' + JSON.stringify(after.body));
  const ref = await call(s.port, 'POST', '/v1/sessions/refresh', {}, { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: ORIGIN });
  assert.strictEqual(ref.status, 401);
  assert.ok(['DEVICE_REVOKED', 'SESSION_REVOKED'].includes(ref.body.error.code), 'got ' + JSON.stringify(ref.body));
  await teardown(s);
});

t('logout menghapus cookie & mencabut sesi; sesudahnya refresh ditolak', async ()=>{
  const s = await setup({ setupPassword:'rahasia-owner-2026' });
  await call(s.port, 'POST', '/v1/auth/bootstrap', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { 'x-setup-key':'setup-key' });
  const login = await call(s.port, 'POST', '/v1/auth/login', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { Origin: ORIGIN });
  const cookie = (login.cookies || []).map(c => c.split(';')[0]).join('; ');
  const csrf = csrfOf(login.cookies);
  const out = await call(s.port, 'DELETE', '/v1/sessions/current', undefined, { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: ORIGIN });
  assert.strictEqual(out.status, 200);
  assert.ok((out.cookies || []).some(c => /^orion_at=;/.test(c)), 'cookie access harus dihapus');
  assert.ok((out.cookies || []).some(c => /^orion_rt=;/.test(c)), 'cookie refresh harus dihapus');
  const after = await call(s.port, 'GET', '/v1/session', undefined, { Cookie: cookie, Origin: ORIGIN });
  assert.strictEqual(after.status, 401);
  const ref = await call(s.port, 'POST', '/v1/sessions/refresh', {}, { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: ORIGIN });
  assert.strictEqual(ref.status, 401);
  await teardown(s);
});

t('ganti password mencabut sesi cookie lain, sesi saat ini tetap hidup', async ()=>{
  const s = await setup({ setupPassword:'rahasia-owner-2026' });
  await call(s.port, 'POST', '/v1/auth/bootstrap', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { 'x-setup-key':'setup-key' });
  const a = await call(s.port, 'POST', '/v1/auth/login', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { Origin: ORIGIN });
  const b = await call(s.port, 'POST', '/v1/auth/login', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { Origin: ORIGIN });
  const cookieA = (a.cookies || []).map(c => c.split(';')[0]).join('; ');
  const csrfA = csrfOf(a.cookies);
  const cookieB = (b.cookies || []).map(c => c.split(';')[0]).join('; ');
  const ch = await call(s.port, 'POST', '/v1/auth/change-password', { oldPassword:'rahasia-owner-2026', newPassword:'PasswordBaru-2026!' },
    { Cookie: cookieA, 'X-CSRF-Token': csrfA, Origin: ORIGIN });
  assert.strictEqual(ch.status, 200, JSON.stringify(ch.body));
  const still = await call(s.port, 'GET', '/v1/session', undefined, { Cookie: cookieA, Origin: ORIGIN });
  assert.strictEqual(still.status, 200);
  const gone = await call(s.port, 'GET', '/v1/session', undefined, { Cookie: cookieB, Origin: ORIGIN });
  assert.strictEqual(gone.status, 401);
  await teardown(s);
});

// ══════════ CORS ══════════
t('CORS: origin diizinkan mendapat header; origin asing tidak', async ()=>{
  const s = await setup();
  const ok = await call(s.port, 'GET', '/v1/health', undefined, { Origin: ORIGIN });
  assert.strictEqual(ok.headers['access-control-allow-origin'], ORIGIN);
  assert.strictEqual(ok.headers['access-control-allow-credentials'], 'true');
  const evil = await call(s.port, 'GET', '/v1/health', undefined, { Origin: 'https://evil.example' });
  assert.strictEqual(evil.headers['access-control-allow-origin'], undefined, 'origin asing tidak boleh mendapat CORS');
  // preflight
  const pre = await call(s.port, 'OPTIONS', '/v1/conversations', undefined, { Origin: ORIGIN, 'Access-Control-Request-Method':'POST' });
  assert.strictEqual(pre.status, 204);
  assert.ok(String(pre.headers['access-control-allow-methods'] || '').includes('POST'));
  assert.ok(String(pre.headers['access-control-allow-headers'] || '').toLowerCase().includes('x-csrf-token'));
  await teardown(s);
});

t('CORS tidak menggantikan autentikasi (origin asing tetap 401)', async ()=>{
  const s = await setup();
  const r = await call(s.port, 'GET', '/v1/missions', undefined, { Origin: 'https://evil.example' });
  assert.strictEqual(r.status, 401);
  await teardown(s);
});

// ══════════ inferensi server: worker resmi belum ada ══════════
t('respond tanpa worker resmi → 503 eksplisit, provider tidak dipanggil, tidak ada pesan palsu', async ()=>{
  let providerHits = 0;
  const provider = http.createServer((rq,rs)=>{
    providerHits++;
    let b=''; rq.on('data',c=>b+=c); rq.on('end',()=>{
      rs.writeHead(200, {'Content-Type':'application/json'});
      rs.end(JSON.stringify({ choices:[{ message:{ content:'Jawaban dari provider.' } }], usage:{ prompt_tokens:10, completion_tokens:5, total_tokens:15 } }));
    });
  });
  await new Promise(r=>provider.listen(0,'127.0.0.1',r));
  const pport = provider.address().port;
  const s = await setup({ setupPassword:'rahasia-owner-2026',
    provider: { base:'http://127.0.0.1:' + pport + '/v1', model:'mock-model', apiKey:'', timeoutMs:5000 } });
  await call(s.port, 'POST', '/v1/auth/bootstrap', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { 'x-setup-key':'setup-key' });
  const login = await call(s.port, 'POST', '/v1/auth/login', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { Origin: ORIGIN });
  const cookie = (login.cookies || []).map(c => c.split(';')[0]).join('; ');
  const csrf = csrfOf(login.cookies);
  const conv = (await call(s.port, 'POST', '/v1/conversations', { title:'C' }, { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: ORIGIN })).body.conversation;
  await call(s.port, 'POST', '/v1/conversations/' + conv.id + '/messages', { role:'user', content:'Halo Orion', clientMessageId:'u1' }, { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: ORIGIN });
  const resp = await call(s.port, 'POST', '/v1/conversations/' + conv.id + '/respond', {}, { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: ORIGIN });
  assert.strictEqual(resp.status, 503);
  assert.strictEqual(resp.body.error.code, 'INFERENCE_WORKER_UNAVAILABLE');
  assert.strictEqual(providerHits, 0, 'provider tidak boleh dipanggil tanpa boundary misi');
  // tidak ada respons assistant yang disimpan/dikarang
  const rows = await s.db.query('SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq', [conv.id]);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].role, 'user');
  provider.close();
  await teardown(s);
});

t('respond tetap 503 walau provider dikonfigurasi (tidak ada bypass budget/approval)', async ()=>{
  const s = await setup({ setupPassword:'rahasia-owner-2026',
    provider: { base:'http://127.0.0.1:1/v1', model:'mock-model', apiKey:'', timeoutMs:500 } });
  await call(s.port, 'POST', '/v1/auth/bootstrap', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { 'x-setup-key':'setup-key' });
  const login = await call(s.port, 'POST', '/v1/auth/login', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { Origin: ORIGIN });
  const cookie = (login.cookies || []).map(c => c.split(';')[0]).join('; ');
  const csrf = csrfOf(login.cookies);
  const conv = (await call(s.port, 'POST', '/v1/conversations', { title:'C' }, { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: ORIGIN })).body.conversation;
  await call(s.port, 'POST', '/v1/conversations/' + conv.id + '/messages', { role:'user', content:'Halo' }, { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: ORIGIN });
  const resp = await call(s.port, 'POST', '/v1/conversations/' + conv.id + '/respond', {}, { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: ORIGIN });
  assert.strictEqual(resp.status, 503);
  assert.strictEqual(resp.body.error.code, 'INFERENCE_WORKER_UNAVAILABLE');
  await teardown(s);
});

// ══════════ XSS: konten disimpan apa adanya, tidak dieksekusi ══════════
t('XSS: payload pada pesan disimpan sebagai DATA (tidak dieksekusi server)', async ()=>{
  const s = await setup({ setupPassword:'rahasia-owner-2026' });
  await call(s.port, 'POST', '/v1/auth/bootstrap', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { 'x-setup-key':'setup-key' });
  const login = await call(s.port, 'POST', '/v1/auth/login', { email:'owner@orion.id', password:'rahasia-owner-2026' }, { Origin: ORIGIN });
  const cookie = (login.cookies || []).map(c => c.split(';')[0]).join('; ');
  const csrf = csrfOf(login.cookies);
  const conv = (await call(s.port, 'POST', '/v1/conversations', { title:'C' }, { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: ORIGIN })).body.conversation;
  const payload = '<script>window.__pwned=1</script><img src=x onerror=alert(1)>';
  const msg = await call(s.port, 'POST', '/v1/conversations/' + conv.id + '/messages', { role:'user', content: payload, clientMessageId:'x1' }, { Cookie: cookie, 'X-CSRF-Token': csrf, Origin: ORIGIN });
  assert.strictEqual(msg.status, 201);
  // server menyimpan apa adanya (data), dan tidak pernah mengeksekusi
  const rows = await s.db.query('SELECT content FROM messages WHERE id = ?', [msg.body.message.id]);
  assert.strictEqual(rows[0].content, payload);
  await teardown(s);
});

(async ()=>{
  console.log('Phase B — auth web, cookie, CSRF, CORS, inferensi server (PostgreSQL nyata)');
  for (const item of tests){
    try { await item.fn(); console.log('  ✓ ' + item.name); passed++; }
    catch (e){ console.log('  ✗ ' + item.name + ' — ' + (e && e.message)); failed++; }
  }
  console.log('\nPhase B backend: ' + passed + ' lulus, ' + failed + ' gagal');
  process.exit(failed ? 1 : 0);
})();
