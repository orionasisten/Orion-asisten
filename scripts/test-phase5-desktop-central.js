'use strict';
/**
 * Tes integrasi Desktop ↔ Orion Central (Phase 5.1) memakai PostgreSQL NYATA.
 * - Outbox: event bertahan setelah restart.
 * - Event ditandai synced HANYA setelah server mengonfirmasi commit.
 * - Kegagalan jaringan dapat dipulihkan tanpa duplikasi.
 * - Token dicabut/kedaluwarsa tidak bisa dipakai lagi.
 * - Status lokal tidak menimpa approval/verification server.
 * - Konflik tercatat jelas.
 * - Tidak ada token/secret di payload IPC, log, atau error.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const CONN = process.env.ORION_PG_CONNECTION || process.env.DATABASE_URL || '';
if (!CONN){
  console.log('\n  ⚠ PostgreSQL tidak dikonfigurasi — integrasi Desktop↔Central DILEWATI (bukan lulus).');
  process.exit(2);
}

const { createDatabase } = require('../src/central/db');
const { migrate } = require('../src/central/db/migrate');
const { createApp } = require('../src/central/app');
const { readConfig } = require('../src/central/config');
const { Outbox } = require('../src/central/outbox');
const { CentralClient } = require('../src/central/client');
const crypto = require('crypto');

let passed = 0, failed = 0;
const tests = [];
function t(name, fn){ tests.push({ name, fn }); }
function tmp(){ return fs.mkdtempSync(path.join(os.tmpdir(), 'orion-d2c-')); }

async function setup(){
  const admin = new (require('pg').Client)({ connectionString: CONN });
  await admin.connect();
  const name = 'orion_d2c_' + crypto.randomBytes(6).toString('hex');
  await admin.query('CREATE DATABASE ' + name);
  await admin.end();
  const url = CONN.replace(/\/[^/?]*(\?|$)/, '/' + name + '$1');
  const db = createDatabase({ driver:'postgres', databaseUrl: url });
  await migrate(db, {});
  const cfg = readConfig({ CENTRAL_DB_DRIVER:'postgres', DATABASE_URL:url, CENTRAL_RATE_LIMIT_PER_MIN:'10000' });
  const app = createApp({ db, config: cfg, setupKey:'setup-key', version:'1.0.0' });
  const server = http.createServer((req,res)=>app.handle(req,res).catch(()=>{ res.writeHead(500); res.end('{}'); }));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port = server.address().port;
  const client = new CentralClient({ baseUrl:'http://127.0.0.1:' + port });
  // bootstrap owner + token
  const boot = await new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify({ email:'owner@test.local' }),'utf8');
    const r = http.request({ hostname:'127.0.0.1', port, path:'/v1/auth/bootstrap', method:'POST', headers:{'Content-Type':'application/json','Content-Length':data.length,'x-setup-key':'setup-key'} }, res=>{
      const c=[]; res.on('data',x=>c.push(x)); res.on('end',()=>resolve(JSON.parse(Buffer.concat(c).toString())));
    });
    r.on('error', reject); r.write(data); r.end();
  });
  client.setToken(boot.token);
  return { db, server, client, port, url, name, token: boot.token, ownerId: boot.ownerId };
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

// ── D1: Desktop tetap bisa jalan tanpa Central ──
t('desktop tetap dapat dibuka saat Central tidak tersedia', async ()=>{
  const client = new CentralClient({ baseUrl:'http://127.0.0.1:1', timeoutMs: 800 });
  client.setToken('token-palsu');
  let e = null;
  try { await client.health(); } catch (x) { e = x; }
  assert.ok(e, 'koneksi ke Central mati harus menghasilkan error (bukan crash/diam)');
  // outbox lokal tetap berfungsi tanpa server
  const ob = new Outbox(tmp());
  const ev = ob.enqueue('mission.state', { x:1 });
  assert.ok(ev.eventId);
  assert.strictEqual(ob.count(), 1);
});

// ── D2: outbox bertahan setelah restart ──
t('outbox event bertahan setelah restart & ditandai synced hanya setelah commit server', async ()=>{
  const s = await setup();
  const dir = tmp();
  const ob1 = new Outbox(dir);
  ob1.enqueue('mission.state', { a:1 });
  ob1.enqueue('mission.state', { a:2 });
  // restart desktop (objek baru, folder sama)
  const ob2 = new Outbox(dir);
  assert.strictEqual(ob2.count(), 2, 'event harus bertahan setelah restart');
  const pend = ob2.pending(10);
  assert.strictEqual(pend.length, 2);
  // sinkron ke server sungguhan
  const res = await s.client.pushEvents(pend);
  assert.strictEqual(res.accepted, 2);
  // tandai synced SETELAH konfirmasi server
  ob2.markSynced(pend.map(e => e.eventId));
  assert.strictEqual(ob2.count(), 0);
  // event ada di DB server
  const rows = await s.db.query('SELECT count(*) c FROM events WHERE owner_id = ?', [s.ownerId]);
  assert.strictEqual(Number(rows[0].c), 2);
  await teardown(s);
});

// ── D3: kegagalan jaringan dipulihkan tanpa duplikasi ──
t('kegagalan jaringan → dipulihkan tanpa duplikasi (retry idempoten)', async ()=>{
  const s = await setup();
  const dir = tmp();
  const ob = new Outbox(dir);
  ob.enqueue('mission.state', { a:1 });
  // coba sinkron ke server MATI (port salah) → gagal
  const dead = new CentralClient({ baseUrl:'http://127.0.0.1:1', timeoutMs: 700 });
  dead.setToken(s.token);
  let failed = false;
  try { await dead.pushEvents(ob.pending(10)); } catch (e) { failed = true; }
  assert.ok(failed, 'push ke server mati harus gagal');
  assert.strictEqual(ob.count(), 1, 'event yang gagal TIDAK boleh ditandai synced');
  // server hidup → retry berhasil, tanpa duplikasi
  const pend = ob.pending(10);
  const r1 = await s.client.pushEvents(pend);
  assert.strictEqual(r1.accepted, 1);
  ob.markSynced(pend.map(e => e.eventId));
  assert.strictEqual(ob.count(), 0);
  // retry lagi dengan event yang sama (mis. commit sebelumnya tapi respons hilang)
  const r2 = await s.client.pushEvents(pend);
  assert.strictEqual(r2.duplicates, 1, 'retry tidak boleh menduplikasi');
  const rows = await s.db.query('SELECT count(*) c FROM events WHERE owner_id = ?', [s.ownerId]);
  assert.strictEqual(Number(rows[0].c), 1);
  await teardown(s);
});

// ── D4: token dicabut / kedaluwarsa tidak bisa dipakai ──
t('token dicabut / kedaluwarsa tidak dapat digunakan kembali', async ()=>{
  const s = await setup();
  // token dicabut via endpoint
  const dev = await s.client._request('POST', '/v1/devices', { name:'D' });
  const revoked = await s.client._request('DELETE', '/v1/devices/' + dev.deviceId);
  assert.ok(revoked && revoked.ok);
  const dead = new CentralClient({ baseUrl:'http://127.0.0.1:' + s.port, timeoutMs: 2000 });
  dead.setToken(dev.token);
  let e = null;
  try { await dead.listMissions(); } catch (x) { e = x; }
  assert.ok(e && e.status === 401, 'token device yang dicabut harus 401');
  // token kedaluwarsa
  const tokens = require('../src/central/auth/tokens');
  const exp = await tokens.issueToken(s.db, { ownerId: s.ownerId, ttlHours: -1 });
  const dead2 = new CentralClient({ baseUrl:'http://127.0.0.1:' + s.port, timeoutMs: 2000 });
  dead2.setToken(exp.token);
  let e2 = null;
  try { await dead2.listMissions(); } catch (x) { e2 = x; }
  assert.ok(e2 && e2.status === 401, 'token kedaluwarsa harus 401');
  await teardown(s);
});

// ── D5: status lokal tidak menimpa approval/verification server ──
t('status lokal tidak diam-diam menimpa approval / verification status server', async ()=>{
  const s = await setup();
  const now = new Date().toISOString();
  await s.db.exec("INSERT INTO approvals (id, owner_id, action, resource, params, scope, fingerprint, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ['ap-1', s.ownerId, 'publish', 'res://x', JSON.stringify({v:1}), 'mission', 'fp1', 'approved', now, new Date(Date.now()+60000).toISOString()]);
  await s.db.exec("INSERT INTO memory_records (id, owner_id, schema_version, type, content, origin, created, updated, verification_status, scope, sensitivity, status, content_version) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ['mem-1', s.ownerId, 1, 'fact', 'x', 'user', now, now, 'unverified', 'global', 'internal', 'active', 1]);
  // desktop mencoba push event yang mengubah hal server-authoritative
  const r = await s.client.pushEvents([
    { eventId:'bad-1', type:'approval.decision', payload:{ approvalId:'ap-1', decision:'rejected' } },
    { eventId:'bad-2', type:'memory.verification', payload:{ recordId:'mem-1', verificationStatus:'verified' } }
  ]);
  assert.strictEqual(r.conflicts, 2, 'kedua event harus ditolak sebagai konflik');
  // server state tidak berubah
  const ap = await s.db.query('SELECT status, decision FROM approvals WHERE id = ?', ['ap-1']);
  assert.strictEqual(ap[0].status, 'approved');
  assert.ok(!ap[0].decision, 'keputusan tidak boleh berubah dari event klien');
  const mem = await s.db.query('SELECT verification_status FROM memory_records WHERE id = ?', ['mem-1']);
  assert.strictEqual(mem[0].verification_status, 'unverified', 'status verifikasi tidak boleh diubah klien');
  await teardown(s);
});

// ── D6: konflik tercatat jelas ──
t('konflik tercatat & terlihat (event_conflicts + audit)', async ()=>{
  const s = await setup();
  await s.client.pushEvents([{ eventId:'cf-1', type:'approval.decision', payload:{ decision:'approved' } }]);
  const cf = await s.db.query('SELECT * FROM event_conflicts WHERE owner_id = ?', [s.ownerId]);
  assert.ok(cf.length >= 1, 'konflik harus tercatat di event_conflicts');
  assert.strictEqual(cf[0].resolution, 'rejected_client_change');
  const aud = await s.db.query('SELECT * FROM audit_log WHERE owner_id = ? AND action = ?', [s.ownerId, 'events.upload']);
  assert.ok(aud.length >= 1, 'audit harus mencatat upload');
  await teardown(s);
});

// ── D7: tidak ada token/secret di payload, log, atau error ──
t('tidak ada token/secret di respons, log, atau error output', async ()=>{
  const s = await setup();
  const status = await s.client.health();
  assert.ok(status && status.status);
  assert.ok(!JSON.stringify(status).includes(s.token), 'health tidak boleh memuat token');
  const aud = await s.client._request('GET', '/v1/audit');
  assert.ok(!JSON.stringify(aud).includes(s.token), 'audit tidak boleh memuat token');
  // error dari server tidak boleh memuat token/stack trace
  const dead = new CentralClient({ baseUrl:'http://127.0.0.1:' + s.port, timeoutMs: 2000 });
  dead.setToken('token-ngawur-yang-panjang-sekali');
  let e = null;
  try { await dead.listMissions(); } catch (x) { e = x; }
  assert.ok(e);
  assert.ok(!/token-ngawur/.test(e.message), 'error tidak boleh memuat token');
  await teardown(s);
});

// ── D8: migrasi lokal → server lewat endpoint import (provenance terjaga) ──
t('migrasi lokal → server lewat endpoint import (provenance terjaga, idempoten)', async ()=>{
  const s = await setup();
  const records = [
    { id:'mem-l1', schemaVersion:1, type:'fact', content:'dari desktop', origin:'user', sourceRef:'doc:d', excerpt:'dari desktop', created:new Date().toISOString(), updated:new Date().toISOString(), confidence:0.7, verificationStatus:'verified', owner:'owner', scope:'global', sensitivity:'internal', status:'active', version:1, integrityHash:'hl1' },
    { id:'mem-l2', schemaVersion:1, type:'agent_inference', content:'inferensi', origin:'agent', verificationStatus:'inferred', status:'active', version:1, integrityHash:'hl2', created:new Date().toISOString() }
  ];
  const r1 = await s.client.importMemory(records);
  assert.strictEqual(r1.inserted, 2);
  const rows = await s.db.query('SELECT * FROM memory_records WHERE owner_id = ? ORDER BY id', [s.ownerId]);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].id, 'mem-l1');
  assert.strictEqual(rows[0].source_ref, 'doc:d');
  assert.strictEqual(rows[0].integrity_hash, 'hl1');
  assert.strictEqual(rows[1].verification_status, 'inferred', 'inferred tidak boleh naik jadi verified');
  // idempoten
  const r2 = await s.client.importMemory(records);
  assert.strictEqual(r2.inserted, 0);
  const c = await s.db.query('SELECT count(*) c FROM memory_records WHERE owner_id = ?', [s.ownerId]);
  assert.strictEqual(Number(c[0].c), 2);
  // skill import
  const versions = [{ versionId:'ver-d1', skillId:'sk-d', version:'1.0.0', contentHash:'hd1', manifest:{ id:'sk-d', version:'1.0.0', permissions:[] }, body:'isi', state:'registered', created:new Date().toISOString() }];
  const r3 = await s.client.importSkillVersions(versions);
  assert.strictEqual(r3.inserted, 1);
  const v = await s.db.query('SELECT * FROM skill_versions WHERE owner_id = ?', [s.ownerId]);
  assert.strictEqual(v[0].content_hash, 'hd1');
  await teardown(s);
});

(async ()=>{
  console.log('Desktop <-> Central integration (PostgreSQL nyata)');
  for (const item of tests){
    try { await item.fn(); console.log('  ✓ ' + item.name); passed++; }
    catch (e){ console.log('  ✗ ' + item.name + ' — ' + (e && e.message)); failed++; }
  }
  console.log('\nDesktop<->Central: ' + passed + ' lulus, ' + failed + ' gagal');
  process.exit(failed ? 1 : 0);
})();
