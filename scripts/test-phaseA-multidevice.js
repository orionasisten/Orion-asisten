'use strict';
/**
 * Tes integrasi Phase A — API contract & fondasi multi-perangkat (PostgreSQL NYATA).
 *
 * Cakupan: percakapan & pesan lintas perangkat, idempotensi, pagination,
 * optimistic concurrency (bukan LWW), sesi browser (create/refresh/rotate/revoke/replay),
 * delta feed terpadu, SSE, isolasi owner, pencabutan device, & validasi input.
 *
 * Jalankan: node scripts/pg-harness.js --run scripts/test-phaseA-multidevice.js
 */
const assert = require('assert');
const http = require('http');
const crypto = require('crypto');

const CONN = process.env.ORION_PG_CONNECTION || process.env.DATABASE_URL || '';
if (!CONN){
  console.log('\n  ⚠ PostgreSQL tidak dikonfigurasi — suite Phase A DILEWATI (bukan lulus).');
  process.exit(2);
}

const { createDatabase } = require('../src/central/db');
const { migrate } = require('../src/central/db/migrate');
const { createApp } = require('../src/central/app');
const { readConfig } = require('../src/central/config');

let passed = 0, failed = 0;
const tests = [];
function t(name, fn){ tests.push({ name, fn }); }

async function setup(){
  const admin = new (require('pg').Client)({ connectionString: CONN });
  await admin.connect();
  const name = 'orion_pa_' + crypto.randomBytes(6).toString('hex');
  await admin.query('CREATE DATABASE ' + name);
  await admin.end();
  const url = CONN.replace(/\/[^/?]*(\?|$)/, '/' + name + '$1');
  const db = createDatabase({ driver:'postgres', databaseUrl: url });
  await migrate(db, {});
  const cfg = readConfig({ CENTRAL_DB_DRIVER:'postgres', DATABASE_URL:url, CENTRAL_RATE_LIMIT_PER_MIN:'10000' });
  const app = createApp({ db, config: cfg, setupKey:'setup-key', version:'1.0.0' });
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
        resolve({ status:res.statusCode, body:j, raw:txt });
      });
    });
    r.on('error', reject);
    if(data) r.write(data);
    r.end();
  });
}
async function bootstrap(port, email){
  const r = await call(port, 'POST', '/v1/auth/bootstrap', { email }, { 'x-setup-key':'setup-key' });
  return r.body;
}

// ══════════ percakapan & pesan ══════════
t('buat percakapan: 201, owner dari server, event terkirim', async ()=>{
  const s = await setup();
  const b = await bootstrap(s.port, 'a@x');
  const r = await call(s.port, 'POST', '/v1/conversations', { title:'Percakapan 1' }, { Authorization:'Bearer '+b.token });
  assert.strictEqual(r.status, 201);
  assert.ok(r.body.conversation.id);
  assert.strictEqual(r.body.conversation.owner_id, b.ownerId, 'owner harus dari token');
  const ev = await s.db.query('SELECT * FROM events WHERE owner_id = ? AND type = ?', [b.ownerId, 'conversation.created']);
  assert.ok(ev.length >= 1, 'event conversation.created harus tercatat');
  await teardown(s);
});

t('idempotensi pembuatan percakapan (clientKey) — tidak duplikat', async ()=>{
  const s = await setup();
  const b = await bootstrap(s.port, 'a@x');
  const h = { Authorization:'Bearer '+b.token };
  const r1 = await call(s.port, 'POST', '/v1/conversations', { title:'X', clientKey:'k-1' }, h);
  const r2 = await call(s.port, 'POST', '/v1/conversations', { title:'X', clientKey:'k-1' }, h);
  assert.strictEqual(r1.status, 201);
  assert.strictEqual(r2.status, 200);
  assert.strictEqual(r2.body.duplicate, true);
  assert.strictEqual(r2.body.conversation.id, r1.body.conversation.id);
  const c = await s.db.query('SELECT count(*) c FROM conversations WHERE owner_id = ?', [b.ownerId]);
  assert.strictEqual(Number(c[0].c), 1);
  await teardown(s);
});

t('pesan idempoten (clientMessageId) — retry tidak menduplikasi', async ()=>{
  const s = await setup();
  const b = await bootstrap(s.port, 'a@x');
  const h = { Authorization:'Bearer '+b.token };
  const c = (await call(s.port, 'POST', '/v1/conversations', { title:'C' }, h)).body.conversation;
  const p1 = await call(s.port, 'POST', '/v1/conversations/' + c.id + '/messages', { role:'user', content:'halo', clientMessageId:'m-1' }, h);
  const p2 = await call(s.port, 'POST', '/v1/conversations/' + c.id + '/messages', { role:'user', content:'halo', clientMessageId:'m-1' }, h);
  assert.strictEqual(p1.status, 201);
  assert.strictEqual(p2.status, 200);
  assert.strictEqual(p2.body.duplicate, true);
  assert.strictEqual(p2.body.message.id, p1.body.message.id);
  const m = await s.db.query('SELECT count(*) c FROM messages WHERE owner_id = ?', [b.ownerId]);
  assert.strictEqual(Number(m[0].c), 1);
  await teardown(s);
});

t('urutan pesan memakai seq server (bukan timestamp klien)', async ()=>{
  const s = await setup();
  const b = await bootstrap(s.port, 'a@x');
  const h = { Authorization:'Bearer '+b.token };
  const c = (await call(s.port, 'POST', '/v1/conversations', { title:'C' }, h)).body.conversation;
  // pesan lama dikirim setelah pesan baru (timestamp klien sengaja terbalik)
  await call(s.port, 'POST', '/v1/conversations/' + c.id + '/messages', { role:'assistant', content:'baru', clientMessageId:'a' }, h);
  await call(s.port, 'POST', '/v1/conversations/' + c.id + '/messages', { role:'user', content:'lama', clientMessageId:'b', createdAt:'2000-01-01T00:00:00Z' }, h);
  const list = await call(s.port, 'GET', '/v1/conversations/' + c.id + '/messages', undefined, h);
  assert.strictEqual(list.body.messages.length, 2);
  assert.ok(list.body.messages[0].seq < list.body.messages[1].seq, 'seq harus menaik');
  await teardown(s);
});

t('riwayat yang sama bisa dilanjutkan dari perangkat lain (cross-device continuity)', async ()=>{
  const s = await setup();
  const b = await bootstrap(s.port, 'a@x');
  // perangkat A: buat percakapan + pesan
  const devA = await call(s.port, 'POST', '/v1/devices', { name:'Desktop' }, { Authorization:'Bearer '+b.token });
  const hA = { Authorization:'Bearer '+devA.body.token };
  const conv = (await call(s.port, 'POST', '/v1/conversations', { title:'Lintas Perangkat' }, hA)).body.conversation;
  await call(s.port, 'POST', '/v1/conversations/' + conv.id + '/messages', { role:'user', content:'halo dari desktop', clientMessageId:'x1' }, hA);
  // perangkat B (web/ponsel): baca & lanjutkan percakapan yang sama
  const devB = await call(s.port, 'POST', '/v1/devices', { name:'Web' }, { Authorization:'Bearer '+b.token });
  const hB = { Authorization:'Bearer '+devB.body.token };
  const list = await call(s.port, 'GET', '/v1/conversations/' + conv.id, undefined, hB);
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body.messages.length, 1);
  assert.strictEqual(list.body.messages[0].content, 'halo dari desktop');
  const reply = await call(s.port, 'POST', '/v1/conversations/' + conv.id + '/messages', { role:'user', content:'lanjut dari web', clientMessageId:'x2' }, hB);
  assert.strictEqual(reply.status, 201);
  // urutan tetap konsisten lintas perangkat
  const msgs = await call(s.port, 'GET', '/v1/conversations/' + conv.id + '/messages', undefined, hA);
  assert.deepStrictEqual(msgs.body.messages.map(m=>m.content), ['halo dari desktop','lanjut dari web']);
  await teardown(s);
});

t('pagination percakapan & pesan: limit + cursor stabil', async ()=>{
  const s = await setup();
  const b = await bootstrap(s.port, 'a@x');
  const h = { Authorization:'Bearer '+b.token };
  for (let i=0;i<7;i++) await call(s.port, 'POST', '/v1/conversations', { title:'C'+i }, h);
  const p1 = await call(s.port, 'GET', '/v1/conversations?limit=3', undefined, h);
  assert.strictEqual(p1.body.conversations.length, 3);
  assert.strictEqual(p1.body.hasMore, true);
  const p2 = await call(s.port, 'GET', '/v1/conversations?limit=3&before=' + encodeURIComponent(p1.body.nextCursor), undefined, h);
  assert.ok(p2.body.conversations.length >= 1);
  // tidak ada duplikat antar halaman
  const ids1 = p1.body.conversations.map(c=>c.id);
  const ids2 = p2.body.conversations.map(c=>c.id);
  assert.strictEqual(ids1.filter(id=>ids2.includes(id)).length, 0);
  await teardown(s);
});

t('konflik metadata percakapan → 409 (bukan last-write-wins)', async ()=>{
  const s = await setup();
  const b = await bootstrap(s.port, 'a@x');
  const h = { Authorization:'Bearer '+b.token };
  const conv = (await call(s.port, 'POST', '/v1/conversations', { title:'Awal' }, h)).body.conversation;
  // perangkat lain mengubah judul
  const r1 = await call(s.port, 'PATCH', '/v1/conversations/' + conv.id, { title:'Diubah perangkat lain', expectedUpdatedAt: conv.updated_at }, h);
  assert.strictEqual(r1.status, 200);
  // perangkat pertama mencoba update dengan versi lama → konflik
  const r2 = await call(s.port, 'PATCH', '/v1/conversations/' + conv.id, { title:'Bentrok', expectedUpdatedAt: conv.updated_at }, h);
  assert.strictEqual(r2.status, 409);
  const cur = await call(s.port, 'GET', '/v1/conversations/' + conv.id, undefined, h);
  assert.strictEqual(cur.body.conversation.title, 'Diubah perangkat lain', 'tidak boleh ditimpa diam-diam');
  await teardown(s);
});

t('isolasi owner: Owner B tidak bisa baca/ubah percakapan Owner A', async ()=>{
  const s = await setup();
  const a = await bootstrap(s.port, 'a@x');
  const b = await bootstrap(s.port, 'b@x');
  const hA = { Authorization:'Bearer '+a.token };
  const hB = { Authorization:'Bearer '+b.token };
  const conv = (await call(s.port, 'POST', '/v1/conversations', { title:'Rahasia A' }, hA)).body.conversation;
  const get = await call(s.port, 'GET', '/v1/conversations/' + conv.id, undefined, hB);
  assert.strictEqual(get.status, 404, 'percakapan owner lain harus 404');
  const msg = await call(s.port, 'POST', '/v1/conversations/' + conv.id + '/messages', { role:'user', content:'x' }, hB);
  assert.strictEqual(msg.status, 404);
  const list = await call(s.port, 'GET', '/v1/conversations', undefined, hB);
  assert.strictEqual(list.body.conversations.length, 0);
  await teardown(s);
});

t('validasi input: role salah, pesan kosong, pesan kelewat besar ditolak', async ()=>{
  const s = await setup();
  const b = await bootstrap(s.port, 'a@x');
  const h = { Authorization:'Bearer '+b.token };
  const conv = (await call(s.port, 'POST', '/v1/conversations', { title:'C' }, h)).body.conversation;
  const badRole = await call(s.port, 'POST', '/v1/conversations/' + conv.id + '/messages', { role:'root', content:'x' }, h);
  assert.strictEqual(badRole.status, 400);
  const empty = await call(s.port, 'POST', '/v1/conversations/' + conv.id + '/messages', { role:'user', content:'   ' }, h);
  assert.strictEqual(empty.status, 400);
  const huge = await call(s.port, 'POST', '/v1/conversations/' + conv.id + '/messages', { role:'user', content:'x'.repeat(40000) }, h);
  assert.strictEqual(huge.status, 413);
  await teardown(s);
});

// ══════════ sesi browser ══════════
t('sesi browser: create → refresh (rotasi) → replay terdeteksi → sesi dicabut', async ()=>{
  const s = await setup();
  const b = await bootstrap(s.port, 'a@x');
  const h = { Authorization:'Bearer '+b.token };
  const ses = await call(s.port, 'POST', '/v1/sessions', { userAgent:'Mozilla/5.0 (test)' }, h);
  assert.strictEqual(ses.status, 201);
  assert.ok(ses.body.accessToken && ses.body.refreshToken);
  const stored = await s.db.query('SELECT * FROM sessions WHERE id = ?', [ses.body.sessionId]);
  assert.strictEqual(stored.length, 1);
  assert.ok(!JSON.stringify(stored[0]).includes(ses.body.accessToken), 'token tak boleh tersimpan polos');
  // refresh → token baru
  const ref = await call(s.port, 'POST', '/v1/sessions/refresh', { refreshToken: ses.body.refreshToken }, h);
  assert.strictEqual(ref.status, 200);
  assert.ok(ref.body.accessToken !== ses.body.accessToken);
  // Gunakan token LAMA setelah grace window → replay → revoke.
  // (Di dalam grace window, request paralel mengembalikan 409 REFRESH_RACE.)
  await s.db.query('UPDATE sessions SET rotated_at = ? WHERE id = ?',
    [new Date(Date.now() - 60000).toISOString(), ses.body.sessionId]);
  const replay = await call(s.port, 'POST', '/v1/sessions/refresh', { refreshToken: ses.body.refreshToken }, h);
  assert.strictEqual(replay.status, 401);
  assert.ok(/REPLAY/.test(replay.body.error.code), 'got ' + JSON.stringify(replay.body));
  const after = await s.db.query('SELECT status FROM sessions WHERE id = ?', [ses.body.sessionId]);
  assert.strictEqual(after[0].status, 'revoked');
  await teardown(s);
});

t('refresh paralel dengan token sama tidak menghapus sesi (409 race, bukan replay)', async ()=>{
  const s = await setup();
  const b = await bootstrap(s.port, 'a@x');
  const h = { Authorization:'Bearer '+b.token };
  const ses = await call(s.port, 'POST', '/v1/sessions', {}, h);
  const [r1, r2] = await Promise.all([
    call(s.port, 'POST', '/v1/sessions/refresh', { refreshToken: ses.body.refreshToken }, h),
    call(s.port, 'POST', '/v1/sessions/refresh', { refreshToken: ses.body.refreshToken }, h)
  ]);
  const statuses = [r1.status, r2.status].sort();
  assert.deepStrictEqual(statuses, [200, 409], 'got ' + JSON.stringify([r1.body, r2.body]));
  const row = await s.db.query('SELECT status FROM sessions WHERE id = ?', [ses.body.sessionId]);
  assert.strictEqual(row[0].status, 'active', 'race tidak boleh mencabut sesi');
  const fresh = r1.status === 200 ? r1.body.refreshToken : r2.body.refreshToken;
  const ok = await call(s.port, 'POST', '/v1/sessions/refresh', { refreshToken: fresh }, h);
  assert.strictEqual(ok.status, 200);
  await teardown(s);
});

t('logout /v1/sessions/current mencabut token yang dipakai & berlaku juga untuk /v1/sessions', async ()=>{
  const s = await setup();
  const b = await bootstrap(s.port, 'a@x');
  const dev = await call(s.port, 'POST', '/v1/devices', { name:'Logout' }, { Authorization:'Bearer '+b.token });
  const h = { Authorization:'Bearer '+dev.body.token };
  const out = await call(s.port, 'DELETE', '/v1/sessions/current', undefined, h);
  assert.strictEqual(out.status, 200);
  assert.strictEqual(out.body.revokedToken, true);
  const after = await call(s.port, 'GET', '/v1/session', undefined, h);
  assert.strictEqual(after.status, 401);
  const dbToken = await s.db.query('SELECT status FROM auth_tokens WHERE id = ?', [dev.body.tokenId]);
  assert.strictEqual(dbToken[0].status, 'revoked');
  // alias tanpa id (klien web lama) juga mencabut, bukan 404
  const dev2 = await call(s.port, 'POST', '/v1/devices', { name:'Logout2' }, { Authorization:'Bearer '+b.token });
  const out2 = await call(s.port, 'DELETE', '/v1/sessions', undefined, { Authorization:'Bearer '+dev2.body.token });
  assert.strictEqual(out2.status, 200);
  const still = await call(s.port, 'GET', '/v1/session', undefined, { Authorization:'Bearer '+dev2.body.token });
  assert.strictEqual(still.status, 401);
  await teardown(s);
});

t('ganti password mencabut token & sesi lain', async ()=>{
  const s = await setup();
  const b = await bootstrap(s.port, 'a@x');
  const initial = await call(s.port, 'POST', '/v1/auth/set-initial-password', { password:'PasswordAwal-2026!' }, { Authorization:'Bearer '+b.token });
  assert.strictEqual(initial.status, 200);
  const dev = await call(s.port, 'POST', '/v1/devices', { name:'Lama' }, { Authorization:'Bearer '+b.token });
  const changed = await call(s.port, 'POST', '/v1/auth/change-password', { oldPassword:'PasswordAwal-2026!', newPassword:'PasswordBaru123!' }, { Authorization:'Bearer '+b.token });
  assert.strictEqual(changed.status, 200, JSON.stringify(changed.body));
  const other = await call(s.port, 'GET', '/v1/session', undefined, { Authorization:'Bearer '+dev.body.token });
  assert.strictEqual(other.status, 401, 'token perangkat lama harus dicabut');
  const me = await call(s.port, 'GET', '/v1/session', undefined, { Authorization:'Bearer '+b.token });
  assert.strictEqual(me.status, 200, 'token saat ini dipertahankan');
  await teardown(s);
});

t('sesi browser bisa dicabut (logout) dan tidak bisa dipakai lagi', async ()=>{
  const s = await setup();
  const b = await bootstrap(s.port, 'a@x');
  const h = { Authorization:'Bearer '+b.token };
  const ses = await call(s.port, 'POST', '/v1/sessions', {}, h);
  const rev = await call(s.port, 'DELETE', '/v1/sessions/' + ses.body.sessionId, undefined, h);
  assert.strictEqual(rev.status, 200);
  const list = await call(s.port, 'GET', '/v1/sessions', undefined, h);
  const found = list.body.sessions.find(x=>x.id===ses.body.sessionId);
  assert.ok(found && found.status==='revoked');
  await teardown(s);
});

t('pencabutan device → sesi & token device ikut mati', async ()=>{
  const s = await setup();
  const b = await bootstrap(s.port, 'a@x');
  const dev = await call(s.port, 'POST', '/v1/devices', { name:'Ponsel' }, { Authorization:'Bearer '+b.token });
  const hDev = { Authorization:'Bearer '+dev.body.token };
  const ses = await call(s.port, 'POST', '/v1/sessions', {}, hDev);
  assert.strictEqual(ses.status, 201);
  // cabut device
  const rev = await call(s.port, 'DELETE', '/v1/devices/' + dev.body.deviceId, undefined, { Authorization:'Bearer '+b.token });
  assert.strictEqual(rev.status, 200);
  // token device harus ditolak
  const after = await call(s.port, 'GET', '/v1/missions', undefined, hDev);
  assert.strictEqual(after.status, 401);
  // sesi device harus dicabut
  const sesList = await s.db.query('SELECT status FROM sessions WHERE id = ?', [ses.body.sessionId]);
  assert.strictEqual(sesList[0].status, 'revoked');
  await teardown(s);
});

// ══════════ delta feed & SSE ══════════
t('delta feed terpadu: percakapan & pesan muncul di /v1/sync/changes', async ()=>{
  const s = await setup();
  const b = await bootstrap(s.port, 'a@x');
  const h = { Authorization:'Bearer '+b.token };
  const conv = (await call(s.port, 'POST', '/v1/conversations', { title:'C' }, h)).body.conversation;
  await call(s.port, 'POST', '/v1/conversations/' + conv.id + '/messages', { role:'user', content:'hi', clientMessageId:'z1' }, h);
  const feed = await call(s.port, 'GET', '/v1/sync/changes?since=0', undefined, h);
  assert.ok(feed.body.changes.length >= 2);
  const types = feed.body.changes.map(c=>c.type);
  assert.ok(types.includes('conversation.created'));
  assert.ok(types.includes('message.created'));
  // filter tipe
  const filtered = await call(s.port, 'GET', '/v1/sync/changes?since=0&types=message.created', undefined, h);
  assert.ok(filtered.body.changes.every(c=>c.type==='message.created'));
  // cursor lanjutan tidak mengulang
  const c1 = feed.body.cursor;
  const feed2 = await call(s.port, 'GET', '/v1/sync/changes?since=' + c1, undefined, h);
  assert.ok(feed2.body.changes.every(c=>c.cursor > c1), 'cursor tidak boleh mengulang event');
  await teardown(s);
});

t('eventId yang sama boleh dipakai dua Owner berbeda (tidak saling squat)', async ()=>{
  const s = await setup();
  const a = await bootstrap(s.port, 'a@x');
  const b = await bootstrap(s.port, 'b@x');
  const ha = { Authorization:'Bearer '+a.token };
  const hb = { Authorization:'Bearer '+b.token };
  const r1 = await call(s.port, 'POST', '/v1/events', { events:[{ eventId:'same-event-id', type:'agent.note', deviceSeq:1, payload:{ note:'A' } }] }, ha);
  const r2 = await call(s.port, 'POST', '/v1/events', { events:[{ eventId:'same-event-id', type:'agent.note', deviceSeq:1, payload:{ note:'B' } }] }, hb);
  assert.strictEqual(r1.status, 200, JSON.stringify(r1.body));
  assert.strictEqual(r2.status, 200, JSON.stringify(r2.body));
  assert.strictEqual(r1.body.accepted, 1);
  assert.strictEqual(r2.body.accepted, 1, 'eventId Owner B tidak boleh dianggap duplikat milik A');
  const fa = await call(s.port, 'GET', '/v1/sync/changes?since=0', undefined, ha);
  const fb = await call(s.port, 'GET', '/v1/sync/changes?since=0', undefined, hb);
  assert.strictEqual(fa.body.changes.filter(e => e.id === 'same-event-id').length, 1);
  assert.strictEqual(fb.body.changes.filter(e => e.id === 'same-event-id').length, 1);
  // replay oleh owner yang sama tetap idempoten
  const dup = await call(s.port, 'POST', '/v1/events', { events:[{ eventId:'same-event-id', type:'agent.note', deviceSeq:1, payload:{ note:'A' } }] }, ha);
  assert.strictEqual(dup.body.duplicates, 1);
  await teardown(s);
});

t('delta types memakai filter SQL: hasMore akurat saat ada tipe lain', async ()=>{
  const s = await setup();
  const b = await bootstrap(s.port, 'a@x');
  const h = { Authorization:'Bearer '+b.token };
  const conv = (await call(s.port, 'POST', '/v1/conversations', { title:'C' }, h)).body.conversation;
  await call(s.port, 'POST', '/v1/conversations/' + conv.id + '/messages', { role:'user', content:'hi', clientMessageId:'t1' }, h);
  // limit=1 + types=message.created: harus ada tepat 1 dan hasMore=false
  const r = await call(s.port, 'GET', '/v1/sync/changes?since=0&limit=1&types=message.created', undefined, h);
  assert.strictEqual(r.body.changes.length, 1);
  assert.strictEqual(r.body.changes[0].type, 'message.created');
  assert.strictEqual(r.body.hasMore, false, 'hasMore tidak boleh true hanya karena limit terpenuhi');
  await teardown(s);
});

t('memori: scope & sensitivity ditentukan server, bukan query klien', async ()=>{
  const s = await setup();
  const a = await bootstrap(s.port, 'a@x');
  const b = await bootstrap(s.port, 'b@x');
  const ha = { Authorization:'Bearer '+a.token };
  const hb = { Authorization:'Bearer '+b.token };
  const missionId = (await call(s.port, 'POST', '/v1/missions', { title:'Misi Rahasia' }, ha)).body.missionId;
  const now = new Date().toISOString();
  const base = [1, 'note', 'isi', 'test', now, now, 'verified'];
  await s.db.query(`INSERT INTO memory_records (id, owner_id, schema_version, type, content, origin, created, updated, verification_status, scope, mission_id, sensitivity, status, content_version)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['mem-mission-private', a.ownerId, ...base, 'mission', missionId, 'private', 'active', 1]);
  await s.db.query(`INSERT INTO memory_records (id, owner_id, schema_version, type, content, origin, created, updated, verification_status, scope, mission_id, sensitivity, status, content_version)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ['mem-global-public', a.ownerId, ...base, 'global', null, 'internal', 'active', 1]);
  // Tanpa konteks: hanya global; private mission tidak bocor.
  const plain = await call(s.port, 'GET', '/v1/memory', undefined, ha);
  assert.strictEqual(plain.status, 200);
  assert.deepStrictEqual(plain.body.records.map(r => r.id), ['mem-global-public']);
  // Query `scope=mission` tanpa missionId tidak boleh membuka data.
  const noCtx = await call(s.port, 'GET', '/v1/memory?scope=mission', undefined, ha);
  assert.strictEqual(noCtx.status, 400);
  assert.strictEqual(noCtx.body.error.code, 'MISSION_CONTEXT_REQUIRED');
  // Dengan konteks misi yang benar, record mission/private terlihat.
  const scoped = await call(s.port, 'GET', '/v1/memory?scope=mission&missionId=' + missionId, undefined, ha);
  assert.strictEqual(scoped.status, 200);
  assert.deepStrictEqual(scoped.body.records.map(r => r.id), ['mem-mission-private']);
  // Detail tanpa konteks → 404 (bukan membocorkan isi).
  const detail = await call(s.port, 'GET', '/v1/memory/mem-mission-private', undefined, ha);
  assert.strictEqual(detail.status, 404);
  const detailOk = await call(s.port, 'GET', '/v1/memory/mem-mission-private?scope=mission&missionId=' + missionId, undefined, ha);
  assert.strictEqual(detailOk.status, 200);
  // Owner B tidak bisa memakai missionId milik A.
  const cross = await call(s.port, 'GET', '/v1/memory?scope=mission&missionId=' + missionId, undefined, hb);
  assert.strictEqual(cross.status, 404);
  await teardown(s);
});

t('SSE berhenti & menolak event setelah token/device dicabut', async ()=>{
  const s = await setup();
  const b = await bootstrap(s.port, 'a@x');
  const dev = await call(s.port, 'POST', '/v1/devices', { name:'Stream' }, { Authorization:'Bearer '+b.token });
  const other = await call(s.port, 'POST', '/v1/devices', { name:'Emitter' }, { Authorization:'Bearer '+b.token });
  const got = await new Promise((resolve) => {
    let closed = false;
    const r = http.request({ hostname:'127.0.0.1', port:s.port, path:'/v1/stream', method:'GET', headers:{ Authorization:'Bearer '+dev.body.token } }, res => {
      let buf = '';
      res.on('data', d => { buf += d.toString(); });
      res.on('end', () => { if (!closed){ closed = true; resolve(buf); } });
    });
    r.on('error', ()=>{});
    r.end();
    setTimeout(async () => {
      // Setelah koneksi terbuka, cabut device; lalu kirim event dari device lain.
      await call(s.port, 'DELETE', '/v1/devices/' + dev.body.deviceId, undefined, { Authorization:'Bearer '+b.token });
      await call(s.port, 'POST', '/v1/events', { events:[{ eventId:'sse-after-revoke', type:'mission.state', deviceSeq:1, payload:{} }] }, { Authorization:'Bearer '+other.body.token });
    }, 1200);
    setTimeout(() => { if (!closed){ closed = true; r.destroy(); resolve('TIMEOUT:' + ''); } }, 9000);
  });
  assert.ok(got.includes('event: ready'), 'SSE harus mengirim ready');
  assert.ok(got.includes('AUTH_REVOKED') || got.includes('event: revoked'), 'stream harus memberi sinyal revoked');
  assert.ok(!/event: change[\s\S]*sse-after-revoke/.test(got), 'tidak boleh ada event setelah pencabutan');
  await teardown(s);
});

t('SSE: butuh autentikasi & memakai owner yang benar', async ()=>{
  const s = await setup();
  const b = await bootstrap(s.port, 'a@x');
  // tanpa token → 401
  const anon = await call(s.port, 'GET', '/v1/stream');
  assert.strictEqual(anon.status, 401);
  // dengan token → streaming (respons tidak diakhiri)
  const got = await new Promise((resolve) => {
    const r = http.request({ hostname:'127.0.0.1', port:s.port, path:'/v1/stream', method:'GET', headers:{ Authorization:'Bearer '+b.token } }, res => {
      let buf = '';
      res.on('data', d => { buf += d.toString(); if (buf.includes('event: ready')) { r.destroy(); resolve(buf); } });
    });
    r.on('error', ()=>{});
    r.end();
    setTimeout(()=>{ r.destroy(); resolve(''); }, 3000);
  });
  assert.ok(got.includes('event: ready'), 'SSE harus mengirim event ready');
  assert.ok(got.includes(b.ownerId), 'SSE harus ter-scope owner');
  await teardown(s);
});

// ══════════ regresi ══════════
t('regresi: endpoint lama tetap berfungsi (misi, approval, events, memory)', async ()=>{
  const s = await setup();
  const b = await bootstrap(s.port, 'a@x');
  const h = { Authorization:'Bearer '+b.token };
  const m = await call(s.port, 'POST', '/v1/missions', { title:'M' }, h);
  assert.strictEqual(m.status, 201);
  const ap = await call(s.port, 'GET', '/v1/approvals', undefined, h);
  assert.strictEqual(ap.status, 200);
  const ev = await call(s.port, 'POST', '/v1/events', { events:[{ eventId:'e1', type:'mission.state', deviceSeq:1, payload:{} }] }, h);
  assert.strictEqual(ev.body.accepted, 1);
  const mem = await call(s.port, 'GET', '/v1/memory', undefined, h);
  assert.strictEqual(mem.status, 200);
  await teardown(s);
});

(async ()=>{
  console.log('Phase A — API contract & fondasi multi-perangkat (PostgreSQL nyata)');
  for (const item of tests){
    try { await item.fn(); console.log('  ✓ ' + item.name); passed++; }
    catch (e){ console.log('  ✗ ' + item.name + ' — ' + (e && e.message)); failed++; }
  }
  console.log('\nPhase A: ' + passed + ' lulus, ' + failed + ' gagal');
  process.exit(failed ? 1 : 0);
})();
