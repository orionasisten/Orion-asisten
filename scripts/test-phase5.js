'use strict';
/**
 * Tes Phase 5 — Orion Central.
 * - Integrasi DB: SQL NYATA + transaksi NYATA + unique constraint NYATA (SQLite dev driver).
 * - API: HTTP NYATA via server in-process.
 * - Tidak ada mock untuk DB/API. Tidak ada panggilan jaringan keluar.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const { createDatabase } = require('../src/central/db');
const { migrate, listMigrations, migrationStatus } = require('../src/central/db/migrate');
const { createApp } = require('../src/central/app');
const { readConfig, validateConfig } = require('../src/central/config');
const tokens = require('../src/central/auth/tokens');
const { canAccessScope, conflictPolicy, PolicyError } = require('../src/central/policy/scope');
const sync = require('../src/central/sync/events');
const queue = require('../src/central/queue/queue');
const orchestrator = require('../src/central/mission/orchestrator');
const skillsSvc = require('../src/central/skills/service');
const migrator = require('../src/central/migrate/migrate-local');
const { Outbox } = require('../src/central/outbox');
const { CentralClient } = require('../src/central/client');

let passed = 0, failed = 0;
const queueTests = [];
function t(name, fn){ queueTests.push({ name, fn }); }
async function run(){
  for (const item of queueTests){
    try { await item.fn(); console.log('  ✓ ' + item.name); passed++; }
    catch (e){ console.log('  ✗ ' + item.name + ' — ' + (e && e.message)); failed++; }
  }
}

function tmp(){ return fs.mkdtempSync(path.join(os.tmpdir(), 'orion-c-')); }
async function freshDb(){
  const dir = tmp();
  const db = createDatabase({ driver: 'sqlite', dbFile: path.join(dir, 'test.db') });
  const m = await migrate(db, {});
  assert.ok(!m.error, 'migrasi gagal: ' + JSON.stringify(m.error));
  return { db, dir };
}

// ── 5A: migrasi DB ──
t('migrasi DB dari kondisi kosong berhasil', async ()=>{
  const { db } = await freshDb();
  const st = await migrationStatus(db);
  assert.ok(st.length >= 5, 'minimal 5 migrasi, dapat ' + st.length);
  db.close();
});
t('migrasi idempoten (jalankan dua kali)', async ()=>{
  const { db } = await freshDb();
  const m2 = await migrate(db, {});
  assert.ok(!m2.error);
  assert.strictEqual(m2.applied.length, 0, 'tidak ada migrasi baru');
  assert.ok(m2.skipped.length >= 5);
  db.close();
});
t('checksum migrasi terdeteksi jika berkas berubah', async ()=>{
  const { db } = await freshDb();
  await db.query('UPDATE schema_migrations SET checksum = ? WHERE version = ?', ['deadbeef', '001_core']);
  const m = await migrate(db, {});
  assert.ok(m.error && m.error.message.includes('CHECKSUM_MISMATCH'));
  db.close();
});
t('dry-run migrasi tidak menulis apa pun', async ()=>{
  const dir = tmp();
  const db = createDatabase({ driver:'sqlite', dbFile: path.join(dir,'d.db') });
  const m = await migrate(db, { dryRun: true });
  assert.ok(!m.error);
  assert.ok(m.applied.length >= 5);
  const st = await migrationStatus(db);
  assert.strictEqual(st.length, 0, 'dry-run tidak boleh menerapkan migrasi');
  db.close();
});
t('tabel inti dibuat (users/devices/missions/events/jobs/memory/skill)', async ()=>{
  const { db } = await freshDb();
  for (const t2 of ['owners','devices','auth_tokens','missions','mission_tasks','approvals','budget_ledger','events','sync_cursors','memory_records','memory_versions','skill_versions','skill_evaluations','skill_active_pointer','skill_lifecycle_audit','jobs','job_attempts','audit_log']){
    const rows = await db.query("SELECT name FROM sqlite_master WHERE type='table' AND name = ?", [t2]);
    assert.ok(rows.length, 'tabel hilang: ' + t2);
  }
  db.close();
});

// ── 5B: auth & isolasi ──
async function seedOwner(db, ownerId){
  const now = new Date().toISOString();
  await db.query('INSERT INTO owners (id, email, display_name, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    [ownerId, ownerId + '@orion.test', ownerId, 'owner', 'active', now, now]);
}
t('token diterbitkan & diverifikasi; hash disimpan (bukan plaintext)', async ()=>{
  const { db } = await freshDb();
  await seedOwner(db, 'own-1');
  const issued = await tokens.issueToken(db, { ownerId:'own-1', label:'t' });
  assert.ok(issued.token && issued.record.token_hash);
  assert.notStrictEqual(issued.record.token_hash, issued.token, 'hash tak boleh sama dgn plaintext');
  const ctx = await tokens.verifyToken(db, issued.token);
  assert.ok(ctx && ctx.ownerId === 'own-1');
  const stored = await db.query('SELECT token_hash FROM auth_tokens');
  assert.ok(!stored.some(r => r.token_hash === issued.token));
  db.close();
});
t('token salah/expired/revoked ditolak', async ()=>{
  const { db } = await freshDb();
  await seedOwner(db, 'own-1');
  const issued = await tokens.issueToken(db, { ownerId:'own-1' });
  assert.strictEqual(await tokens.verifyToken(db, 'token-palsu'), null);
  const expired = await tokens.issueToken(db, { ownerId:'own-1', ttlHours: -1 });
  const v = await tokens.verifyToken(db, expired.token);
  assert.ok(v && v.error === 'TOKEN_EXPIRED', 'got ' + JSON.stringify(v));
  await tokens.revokeToken(db, issued.record.id, 'own-1');
  const r = await tokens.verifyToken(db, issued.token);
  assert.ok(r && r.error === 'TOKEN_REVOKED');
  db.close();
});
t('rotasi token mencabut yang lama dan menerbitkan yang baru', async ()=>{
  const { db } = await freshDb();
  await seedOwner(db, 'own-1');
  const issued = await tokens.issueToken(db, { ownerId:'own-1' });
  const rot = await tokens.rotateToken(db, issued.record.id, 'own-1', {});
  assert.ok(rot.token && rot.token !== issued.token);
  const old = await tokens.verifyToken(db, issued.token);
  assert.ok(old && old.error === 'TOKEN_REVOKED');
  const neu = await tokens.verifyToken(db, rot.token);
  assert.ok(neu && neu.ownerId === 'own-1');
  db.close();
});
t('device dicabut → token device tidak berlaku', async ()=>{
  const { db } = await freshDb();
  await seedOwner(db, 'own-1');
  await db.query('INSERT INTO devices (id, owner_id, name, platform, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)', ['dev-1','own-1','D','win','active',new Date().toISOString(),new Date().toISOString()]);
  const issued = await tokens.issueToken(db, { ownerId:'own-1', deviceId:'dev-1' });
  assert.ok((await tokens.verifyToken(db, issued.token)).ownerId === 'own-1');
  await db.query('UPDATE devices SET status = ? WHERE id = ?', ['revoked','dev-1']);
  const v = await tokens.verifyToken(db, issued.token);
  assert.ok(v && v.error === 'DEVICE_REVOKED');
  db.close();
});
t('scope akses memori: session tak boleh baca misi privat; skill tak boleh baca private', ()=>{
  assert.strictEqual(canAccessScope({ scope:'mission', sensitivity:'private', status:'active' }, 'session'), false);
  assert.strictEqual(canAccessScope({ scope:'skill', sensitivity:'private', status:'active' }, 'skill'), false);
  assert.strictEqual(canAccessScope({ scope:'mission', sensitivity:'internal', status:'active' }, 'global'), true);
  assert.strictEqual(canAccessScope({ scope:'global', sensitivity:'internal', status:'deleted' }, 'global'), false);
});
t('kebijakan konflik bukan last-write-wins untuk approval/verifikasi', ()=>{
  assert.strictEqual(conflictPolicy('approval.decision').policy, 'server_authoritative');
  assert.strictEqual(conflictPolicy('memory.verification').policy, 'server_authoritative');
  assert.strictEqual(conflictPolicy('skill.active').policy, 'server_authoritative');
  assert.strictEqual(conflictPolicy('budget.spent').policy, 'server_authoritative');
});

// ── 5C: sinkronisasi event ──
t('upload event berulang tidak menduplikasi (idempoten)', async ()=>{
  const { db } = await freshDb();
  const ctx = { ownerId:'own-1', deviceId:'dev-1' };
  const ev = { eventId:'ev-1', type:'mission.state', schemaVersion:1, deviceSeq:1, payload:{ state:'running' } };
  const r1 = await sync.uploadEvents(db, ctx, [ev]);
  assert.strictEqual(r1.accepted, 1);
  const r2 = await sync.uploadEvents(db, ctx, [ev]);
  assert.strictEqual(r2.duplicates, 1);
  assert.strictEqual(r2.accepted, 0);
  const rows = await db.query('SELECT count(*) c FROM events');
  assert.strictEqual(Number(rows[0].c), 1);
  db.close();
});
t('event dengan owner_id di payload ditolak', async ()=>{
  const { db } = await freshDb();
  const r = await sync.uploadEvents(db, { ownerId:'own-1', deviceId:'dev-1' },
    [{ eventId:'ev-2', type:'memory.upsert', payload:{ owner_id:'own-2' } }]);
  assert.strictEqual(r.rejected, 1);
  assert.ok(r.errors[0].errors.includes('CLIENT_SCOPE_FIELD_FORBIDDEN'));
  db.close();
});
t('event approval.decision dari klien ditolak (server authoritative)', async ()=>{
  const { db } = await freshDb();
  const r = await sync.uploadEvents(db, { ownerId:'own-1', deviceId:'dev-1' },
    [{ eventId:'ev-3', type:'approval.decision', payload:{ decision:'approved' } }]);
  assert.strictEqual(r.conflicts, 1);
  assert.strictEqual(r.accepted, 0);
  db.close();
});
t('cursor tidak melewatkan event yang sudah committed', async ()=>{
  const { db } = await freshDb();
  const ctx = { ownerId:'own-1', deviceId:'dev-1' };
  for (let i=1;i<=5;i++) await sync.uploadEvents(db, ctx, [{ eventId:'e'+i, type:'mission.state', deviceSeq:i, payload:{ n:i } }]);
  const p1 = await sync.pullEvents(db, ctx, 0, 2);
  assert.strictEqual(p1.events.length, 2);
  const p2 = await sync.pullEvents(db, ctx, p1.cursor, 10);
  assert.strictEqual(p2.events.length, 3);
  const p3 = await sync.pullEvents(db, ctx, p2.cursor, 10);
  assert.strictEqual(p3.events.length, 0);
  db.close();
});
t('event out-of-order device_seq tetap idempoten', async ()=>{
  const { db } = await freshDb();
  const ctx = { ownerId:'own-1', deviceId:'dev-1' };
  await sync.uploadEvents(db, ctx, [{ eventId:'a', type:'mission.state', deviceSeq:5, payload:{} }]);
  const r = await sync.uploadEvents(db, ctx, [{ eventId:'b', type:'mission.state', deviceSeq:5, payload:{} }]);
  assert.strictEqual(r.duplicates, 1);
  db.close();
});
t('outbox desktop tahan restart & hanya markSynced setelah konfirmasi', ()=>{
  const dir = tmp();
  const ob = new Outbox(dir);
  ob.enqueue('mission.state', { a:1 });
  ob.enqueue('mission.state', { a:2 });
  assert.strictEqual(ob.count(), 2);
  const ob2 = new Outbox(dir); // restart
  assert.strictEqual(ob2.count(), 2, 'event tidak boleh hilang saat restart');
  const pend = ob2.pending(10);
  ob2.markSynced([pend[0].eventId]);
  assert.strictEqual(ob2.count(), 1);
  db_close_helper();
  function db_close_helper(){}
});

t('outbox: kegagalan permanen disimpan (tidak dihapus/di-retry otomatis)', ()=>{
  const dir = tmp();
  const ob = new Outbox(dir);
  const ev = ob.enqueue('message.send', { content:'penting', clientMessageId:'f-1' });
  ob.markFailed([ev.eventId], 'NOT_FOUND conversation');
  assert.strictEqual(ob.count(), 1, 'entri failed tidak boleh dihapus');
  assert.strictEqual(ob.countPending(), 0, 'entri failed tidak boleh dianggap pending');
  assert.strictEqual(ob.countFailed(), 1);
  assert.strictEqual(ob.pending(10).length, 0, 'failed tidak di-retry otomatis');
  assert.strictEqual(ob.get(ev.eventId).state, 'failed');
  // Bertahan setelah restart
  const ob2 = new Outbox(dir);
  assert.strictEqual(ob2.countFailed(), 1);
  assert.strictEqual(ob2.get(ev.eventId).lastError, 'NOT_FOUND conversation');
  // Pemulihan hanya lewat aksi sadar
  ob2.retryFailed([ev.eventId]);
  assert.strictEqual(ob2.countPending(), 1);
  assert.strictEqual(ob2.pending(10)[0].eventId, ev.eventId);
  ob2.markSynced([ev.eventId]);
  assert.strictEqual(ob2.count(), 0);
});

// ── 5D: queue ──
t('dua worker tidak mengklaim job yang sama', async ()=>{
  const { db } = await freshDb();
  await queue.enqueue(db, { ownerId:'own-1', kind:'test', payload:{} });
  const w1 = await queue.claim(db, { workerId:'w1', ownerId:'own-1' });
  const w2 = await queue.claim(db, { workerId:'w2', ownerId:'own-1' });
  assert.ok(w1 && !w2, 'job hanya boleh diklaim satu worker');
  db.close();
});
t('job yang ditinggalkan (lease kedaluwarsa) dipulihkan', async ()=>{
  const { db } = await freshDb();
  await queue.enqueue(db, { ownerId:'own-1', kind:'test', payload:{} });
  await queue.claim(db, { workerId:'w1', ownerId:'own-1', leaseMs: 1 });
  await new Promise(r => setTimeout(r, 20));
  const rec = await queue.recoverExpired(db, { ownerId:'own-1' });
  assert.ok(rec.length >= 1, 'job harus dipulihkan');
  const again = await queue.claim(db, { workerId:'w2', ownerId:'own-1' });
  assert.ok(again, 'job harus bisa diklaim ulang');
  db.close();
});
t('retry terbatas & dead-letter bekerja', async ()=>{
  const { db } = await freshDb();
  const e = await queue.enqueue(db, { ownerId:'own-1', kind:'test', payload:{}, maxAttempts: 2 });
  await queue.claim(db, { workerId:'w1', ownerId:'own-1' });
  const f1 = await queue.fail(db, e.jobId, 'w1', 'boom');
  assert.strictEqual(f1.state, 'queued');
  // backoff harus hormati: job belum tersedia sebelum available_at
  const j1 = await queue.getJob(db, e.jobId, 'own-1');
  assert.ok(new Date(j1.available_at) > new Date(), 'backoff harus menunda percobaan berikutnya');
  const notYet = await queue.claim(db, { workerId:'w1', ownerId:'own-1' });
  assert.strictEqual(notYet, null, 'job tidak boleh diklaim sebelum backoff selesai');
  // simulasi waktu backoff habis
  await db.query('UPDATE jobs SET available_at = ? WHERE id = ?', [new Date().toISOString(), e.jobId]);
  const again = await queue.claim(db, { workerId:'w1', ownerId:'own-1' });
  assert.ok(again, 'job harus bisa diklaim setelah backoff');
  const f2 = await queue.fail(db, e.jobId, 'w1', 'boom');
  assert.strictEqual(f2.state, 'dead_letter', 'percobaan ke-2 dari max 2 harus dead-letter');
  const j = await queue.getJob(db, e.jobId, 'own-1');
  assert.strictEqual(j.state, 'dead_letter');
  assert.ok(j.dead_letter, 'dead_letter metadata harus ada');
  db.close();
});
t('outcome_unknown tidak di-retry otomatis (dead-letter manual)', async ()=>{
  const { db } = await freshDb();
  const e = await queue.enqueue(db, { ownerId:'own-1', kind:'publish', payload:{}, maxAttempts: 5 });
  await queue.claim(db, { workerId:'w1', ownerId:'own-1' });
  const f = await queue.fail(db, e.jobId, 'w1', 'response lost', { uncertain: true });
  assert.strictEqual(f.state, 'dead_letter');
  assert.strictEqual(f.reason, 'OUTCOME_UNKNOWN');
  db.close();
});
t('idempotency key mencegah job ganda', async ()=>{
  const { db } = await freshDb();
  const a = await queue.enqueue(db, { ownerId:'own-1', kind:'k', payload:{}, idempotencyKey:'idem-1' });
  const b = await queue.enqueue(db, { ownerId:'own-1', kind:'k', payload:{}, idempotencyKey:'idem-1' });
  assert.strictEqual(b.duplicate, true);
  assert.strictEqual(b.jobId, a.jobId);
  db.close();
});
t('budget dicek di server: eksekusi melebihi limit ditolak', async ()=>{
  const { db } = await freshDb();
  await db.query(`INSERT INTO missions (id, owner_id, title, state, budget_limit, budget_spent, budget_reserved, budget_currency, executions, max_executions, created_at, updated_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['ms-1','own-1','M','running',10,0,0,'unit',0,100,new Date().toISOString(),new Date().toISOString()]);
  const r = await orchestrator.reserveBudget(db, { ownerId:'own-1', missionId:'ms-1', estimateMinor: 5 });
  assert.ok(r.reservationId);
  let e=null;
  try { await orchestrator.reserveBudget(db, { ownerId:'own-1', missionId:'ms-1', estimateMinor: 100 }); } catch(x){ e=x; }
  assert.ok(e && e.code === 'BUDGET_EXCEEDED', 'got ' + (e&&e.code));
  db.close();
});
t('approval divalidasi di boundary server (fingerprint & expiry)', async ()=>{
  const { db } = await freshDb();
  const fp = orchestrator.fingerprint('publish','res://x',{v:1},'mission');
  await db.query(`INSERT INTO approvals (id, owner_id, action, resource, params, scope, fingerprint, status, created_at, expires_at)
                 VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ['ap-1','own-1','publish','res://x',JSON.stringify({v:1}),'mission',fp,'approved',new Date().toISOString(), new Date(Date.now()+60000).toISOString()]);
  await orchestrator.assertApprovalValid(db, { ownerId:'own-1', approvalId:'ap-1', action:'publish', resource:'res://x', params:{v:1}, scope:'mission' });
  let e=null;
  try { await orchestrator.assertApprovalValid(db, { ownerId:'own-1', approvalId:'ap-1', action:'publish', resource:'res://x', params:{v:2}, scope:'mission' }); } catch(x){ e=x; }
  assert.ok(e && e.code === 'APPROVAL_FINGERPRINT_MISMATCH');
  db.close();
});

// ── 5E: migrasi memori/skill ──
t('migrasi memori mempertahankan ID, provenance, hash, soft-delete', async ()=>{
  const { db } = await freshDb();
  const local = [
    { id:'mem-1', schemaVersion:1, type:'fact', content:'fakta A', origin:'user', sourceRef:'doc:a', excerpt:'fakta A', created:'2026-01-01T00:00:00.000Z', updated:'2026-01-02T00:00:00.000Z', confidence:0.8, verificationStatus:'verified', owner:'owner', scope:'global', sensitivity:'internal', status:'active', version:1, integrityHash:'h1' },
    { id:'mem-2', schemaVersion:1, type:'agent_inference', content:'inferensi B', origin:'agent', verificationStatus:'inferred', status:'superseded', supersededReason:'dikoreksi', version:2, integrityHash:'h2' },
    { id:'mem-3', schemaVersion:1, type:'fact', content:'hapus', origin:'user', status:'deleted', deletedAt:'2026-01-03T00:00:00.000Z', version:1, integrityHash:'h3' }
  ];
  const { plan, counts } = migrator.planMemory(local, { ownerId:'own-1' });
  assert.strictEqual(counts.total, 3);
  const rep = await migrator.applyMemoryPlan(db, 'own-1', plan, 'run-1');
  assert.strictEqual(rep.inserted, 3);
  const rows = await db.query('SELECT * FROM memory_records WHERE owner_id = ? ORDER BY id', ['own-1']);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].id, 'mem-1');
  assert.strictEqual(rows[0].origin, 'user');
  assert.strictEqual(rows[0].source_ref, 'doc:a');
  assert.strictEqual(rows[0].integrity_hash, 'h1');
  assert.strictEqual(rows[1].verification_status, 'inferred', 'inferred tidak boleh naik jadi verified');
  assert.strictEqual(rows[2].status, 'deleted');
  assert.ok(rows[2].deleted_at);
  // versi riwayat dibuat
  const mv = await db.query('SELECT count(*) c FROM memory_versions WHERE owner_id = ?', ['own-1']);
  assert.ok(Number(mv[0].c) >= 3);
  db.close();
});
t('migrasi memori idempoten (jalan dua kali tidak duplikasi)', async ()=>{
  const { db } = await freshDb();
  const local = [{ id:'mem-x', schemaVersion:1, type:'fact', content:'c', origin:'user', integrityHash:'hx', version:1, created:'2026-01-01T00:00:00.000Z' }];
  const { plan } = migrator.planMemory(local, { ownerId:'own-1' });
  await migrator.applyMemoryPlan(db, 'own-1', plan, 'r1');
  const rep2 = await migrator.applyMemoryPlan(db, 'own-1', plan, 'r2');
  assert.strictEqual(rep2.inserted, 0);
  assert.strictEqual(rep2.skipped, 1);
  const c = await db.query('SELECT count(*) c FROM memory_records');
  assert.strictEqual(Number(c[0].c), 1);
  db.close();
});
t('secret terdeteksi → diredact & ditandai, tidak terkirim utuh', async ()=>{
  const { db } = await freshDb();
  const local = [{ id:'mem-s', schemaVersion:1, type:'fact', content:'token sk-abcdef123456789', origin:'user', integrityHash:'hs', version:1, created:'2026-01-01T00:00:00.000Z' }];
  const { plan, counts } = migrator.planMemory(local, { ownerId:'own-1' });
  assert.strictEqual(counts.secret, 1);
  assert.ok(!/sk-abcdef123456789/.test(plan[0].record.content));
  await migrator.applyMemoryPlan(db, 'own-1', plan, 'r1');
  const row = await db.query('SELECT content, metadata FROM memory_records WHERE id = ?', ['mem-s']);
  assert.ok(!/sk-abcdef123456789/.test(row[0].content));
  assert.ok(row[0].metadata.includes('secretRedacted'));
  db.close();
});
t('migrasi skill mempertahankan hash, manifest, evaluasi, lifecycle', async ()=>{
  const { db } = await freshDb();
  const local = [{ versionId:'ver-abc', skillId:'sk-1', version:'1.0.0', contentHash:'hash1', manifest:{ id:'sk-1', version:'1.0.0', permissions:['chat:read'] }, body:'isi', state:'registered', created:'2026-01-01T00:00:00.000Z', evaluation:{ ok:true, reportId:'ev-1' }, lifecycle:[{ at:'x', state:'registered' }] }];
  const { plan } = migrator.planSkills(local, { ownerId:'own-1' });
  const rep = await migrator.applySkillPlan(db, 'own-1', plan);
  assert.strictEqual(rep.inserted, 1);
  const rows = await db.query('SELECT * FROM skill_versions WHERE owner_id = ?', ['own-1']);
  assert.strictEqual(rows[0].version_id, 'ver-abc');
  assert.strictEqual(rows[0].content_hash, 'hash1');
  assert.ok(rows[0].manifest.includes('chat:read'));
  assert.ok(rows[0].evaluation.includes('ev-1'));
  db.close();
});
t('rollback migrasi menghapus hasil, sumber data tidak tersentuh', async ()=>{
  const { db } = await freshDb();
  const local = [{ id:'mem-rb', schemaVersion:1, type:'fact', content:'c', origin:'user', integrityHash:'h', version:1, created:'2026-01-01T00:00:00.000Z' }];
  const { plan } = migrator.planMemory(local, { ownerId:'own-1' });
  await migrator.applyMemoryPlan(db, 'own-1', plan, 'r1');
  const rb = await migrator.rollbackMigration(db, 'own-1');
  assert.ok(rb.removedMemory >= 1);
  const c = await db.query('SELECT count(*) c FROM memory_records');
  assert.strictEqual(Number(c[0].c), 0);
  // data sumber (objek lokal) tetap ada
  assert.strictEqual(local.length, 1);
  assert.strictEqual(local[0].content, 'c');
  db.close();
});
t('aktivasi skill server: hash + evaluasi wajib', async ()=>{
  const { db } = await freshDb();
  const manifest = { id:'sk-a', version:'1.0.0', permissions:[], capabilities:[], schemaVersion:1, name:'A', description:'d' };
  const reg = await skillsSvc.register(db, { ownerId:'own-1' }, { manifest, body:'body' });
  const v = (await db.query('SELECT * FROM skill_versions WHERE version_id = ?', [reg.versionId]))[0];
  let e=null;
  try { await skillsSvc.activate(db, { ownerId:'own-1' }, v); } catch(x){ e=x; }
  assert.ok(e && e.code === 'NOT_EVALUATED');
  // set evaluasi lulus
  const hash = v.content_hash;
  await db.query('UPDATE skill_versions SET evaluation = ? WHERE version_id = ?', [JSON.stringify({ ok:true, contentHash: hash }), v.version_id]);
  const v2 = (await db.query('SELECT * FROM skill_versions WHERE version_id = ?', [reg.versionId]))[0];
  const res = await skillsSvc.activate(db, { ownerId:'own-1' }, v2);
  assert.ok(res.ok);
  const ptr = await db.query('SELECT * FROM skill_active_pointer WHERE owner_id = ?', ['own-1']);
  assert.strictEqual(ptr.length, 1);
  const aud = await db.query('SELECT * FROM skill_lifecycle_audit WHERE owner_id = ?', ['own-1']);
  assert.ok(aud.length >= 1, 'audit lifecycle harus ada');
  db.close();
});

// ── API HTTP nyata ──
async function startServer(){
  const { db, dir } = await freshDb();
  const cfg = readConfig({ CENTRAL_DB_DRIVER:'sqlite', CENTRAL_DB_FILE: path.join(dir,'api.db'), CENTRAL_RATE_LIMIT_PER_MIN:'10000' });
  assert.ok(validateConfig(cfg).ok);
  const app = createApp({ db, config: cfg, setupKey:'setup-test-key', version:'1.0.0' });
  const server = http.createServer((req,res) => app.handle(req,res).catch(()=>{ res.writeHead(500); res.end('{}'); }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const client = new CentralClient({ baseUrl:'http://127.0.0.1:' + port });
  return { db, dir, server, client, port };
}
function req(port, method, p, body, headers){
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body),'utf8');
    const h = Object.assign({ 'Content-Type':'application/json' }, headers||{});
    if (data) h['Content-Length'] = data.length;
    const r = http.request({ hostname:'127.0.0.1', port, path:p, method, headers:h }, res => {
      const c=[]; res.on('data',x=>c.push(x)); res.on('end',()=>{
        const txt=Buffer.concat(c).toString('utf8');
        let j=null; try{ j=txt?JSON.parse(txt):null; }catch(e){}
        resolve({ status:res.statusCode, body:j, raw:txt });
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

t('API: request tanpa autentikasi ditolak', async ()=>{
  const s = await startServer();
  const r = await req(s.port, 'GET', '/v1/missions', undefined, {});
  assert.strictEqual(r.status, 401);
  s.server.close(); s.db.close();
});
t('API: health & readiness berfungsi', async ()=>{
  const s = await startServer();
  const h = await req(s.port, 'GET', '/v1/health');
  assert.strictEqual(h.status, 200);
  assert.strictEqual(h.body.status, 'ok');
  const rd = await req(s.port, 'GET', '/v1/ready');
  assert.strictEqual(rd.status, 200);
  assert.strictEqual(rd.body.status, 'ready');
  s.server.close(); s.db.close();
});
t('API: bootstrap butuh setup key; owner+token terbit', async ()=>{
  const s = await startServer();
  const bad = await req(s.port, 'POST', '/v1/auth/bootstrap', { email:'a@b.c' }, {});
  assert.strictEqual(bad.status, 403);
  const ok = await req(s.port, 'POST', '/v1/auth/bootstrap', { email:'a@b.c' }, { 'x-setup-key':'setup-test-key' });
  assert.strictEqual(ok.status, 201);
  assert.ok(ok.body.token && ok.body.ownerId);
  s.server.close(); s.db.close();
});
t('API: Owner A tidak dapat membaca/mengubah record Owner B', async ()=>{
  const s = await startServer();
  const a = await req(s.port, 'POST', '/v1/auth/bootstrap', { email:'a@b.c' }, { 'x-setup-key':'setup-test-key' });
  const tokA = a.body.token, ownerA = a.body.ownerId;
  const b = await req(s.port, 'POST', '/v1/auth/bootstrap', { email:'x@y.z' }, { 'x-setup-key':'setup-test-key' });
  const tokB = b.body.token, ownerB = b.body.ownerId;
  // B buat misi
  const mb = await req(s.port, 'POST', '/v1/missions', { title:'Misi B' }, { Authorization:'Bearer '+tokB });
  assert.strictEqual(mb.status, 201);
  // A coba akses misi B
  const get = await req(s.port, 'GET', '/v1/missions/' + mb.body.missionId, undefined, { Authorization:'Bearer '+tokA });
  assert.strictEqual(get.status, 404, 'A tak boleh melihat misi B');
  const cancel = await req(s.port, 'POST', '/v1/missions/' + mb.body.missionId + '/cancel', {}, { Authorization:'Bearer '+tokA });
  assert.strictEqual(cancel.status, 404);
  // list A tidak memuat misi B
  const list = await req(s.port, 'GET', '/v1/missions', undefined, { Authorization:'Bearer '+tokA });
  assert.strictEqual(list.body.missions.length, 0);
  s.server.close(); s.db.close();
});
t('API: device registration & revocation', async ()=>{
  const s = await startServer();
  const a = await req(s.port, 'POST', '/v1/auth/bootstrap', { email:'a@b.c' }, { 'x-setup-key':'setup-test-key' });
  const tok = a.body.token;
  const d = await req(s.port, 'POST', '/v1/devices', { name:'Laptop' }, { Authorization:'Bearer '+tok });
  assert.strictEqual(d.status, 201);
  assert.ok(d.body.deviceId && d.body.token);
  // token device bisa dipakai
  const m = await req(s.port, 'POST', '/v1/missions', { title:'M' }, { Authorization:'Bearer '+d.body.token });
  assert.strictEqual(m.status, 201);
  // revoke device → token device tidak berlaku
  const rev = await req(s.port, 'DELETE', '/v1/devices/' + d.body.deviceId, undefined, { Authorization:'Bearer '+tok });
  assert.strictEqual(rev.status, 200);
  const m2 = await req(s.port, 'POST', '/v1/missions', { title:'M2' }, { Authorization:'Bearer '+d.body.token });
  assert.strictEqual(m2.status, 401);
  s.server.close(); s.db.close();
});
t('API: upload event berulang tidak duplikasi di server', async ()=>{
  const s = await startServer();
  const a = await req(s.port, 'POST', '/v1/auth/bootstrap', { email:'a@b.c' }, { 'x-setup-key':'setup-test-key' });
  const tok = a.body.token;
  const ev = { eventId:'e-1', type:'mission.state', deviceSeq:1, payload:{ s:'x' } };
  const r1 = await req(s.port, 'POST', '/v1/events', { events:[ev] }, { Authorization:'Bearer '+tok });
  assert.strictEqual(r1.body.accepted, 1);
  const r2 = await req(s.port, 'POST', '/v1/events', { events:[ev] }, { Authorization:'Bearer '+tok });
  assert.strictEqual(r2.body.duplicates, 1);
  const pull = await req(s.port, 'GET', '/v1/events?after=0', undefined, { Authorization:'Bearer '+tok });
  assert.strictEqual(pull.body.events.length, 1);
  s.server.close(); s.db.close();
});
t('API: approval decision divalidasi server-side & idempoten', async ()=>{
  const s = await startServer();
  const a = await req(s.port, 'POST', '/v1/auth/bootstrap', { email:'a@b.c' }, { 'x-setup-key':'setup-test-key' });
  const tok = a.body.token, ownerId = a.body.ownerId;
  await s.db.query(`INSERT INTO approvals (id, owner_id, action, resource, params, scope, fingerprint, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ['ap-1', ownerId, 'publish','res://x',JSON.stringify({v:1}),'mission','fp1','pending',new Date().toISOString(), new Date(Date.now()+60000).toISOString()]);
  const d = await req(s.port, 'POST', '/v1/approvals/ap-1/decision', { decision:'approved' }, { Authorization:'Bearer '+tok });
  assert.strictEqual(d.status, 200);
  const d2 = await req(s.port, 'POST', '/v1/approvals/ap-1/decision', { decision:'rejected' }, { Authorization:'Bearer '+tok });
  assert.strictEqual(d2.status, 409, 'keputusan kedua harus ditolak');
  s.server.close(); s.db.close();
});
t('API: memory privat tidak bocor ke scope lain', async ()=>{
  const s = await startServer();
  const a = await req(s.port, 'POST', '/v1/auth/bootstrap', { email:'a@b.c' }, { 'x-setup-key':'setup-test-key' });
  const tok = a.body.token, ownerId = a.body.ownerId;
  await s.db.query(`INSERT INTO memory_records (id, owner_id, schema_version, type, content, origin, created, updated, verification_status, scope, sensitivity, status, content_version)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ['mem-priv', ownerId, 1, 'fact','rahasia','user',new Date().toISOString(),new Date().toISOString(),'unverified','mission','private','active',1]);
  const asGlobal = await req(s.port, 'GET', '/v1/memory?scope=global', undefined, { Authorization:'Bearer '+tok });
  assert.strictEqual(asGlobal.body.records.length, 0, 'scope global tak boleh melihat record mission private');
  s.server.close(); s.db.close();
});
t('API: error tidak membocorkan stack trace', async ()=>{
  const s = await startServer();
  const r = await req(s.port, 'GET', '/v1/tidak-ada', undefined, {});
  assert.strictEqual(r.status, 404);
  assert.ok(!/at Object|\.js:\d+/.test(r.raw), 'respons tidak boleh berisi stack trace');
  s.server.close(); s.db.close();
});
t('API: payload melebihi batas ditolak', async ()=>{
  const s = await startServer();
  const a = await req(s.port, 'POST', '/v1/auth/bootstrap', { email:'a@b.c' }, { 'x-setup-key':'setup-test-key' });
  const big = 'x'.repeat(2 * 1024 * 1024);
  const r = await req(s.port, 'POST', '/v1/events', { events:[{ eventId:'e', type:'mission.state', payload:{ big } }] }, { Authorization:'Bearer '+a.body.token });
  assert.ok(r.status === 413 || r.status === 200, 'got ' + r.status);
  if (r.status === 200) assert.ok(r.body.rejected >= 1, 'payload besar harus ditolak');
  s.server.close(); s.db.close();
});
t('API: audit log mencatat tindakan sensitif tanpa token', async ()=>{
  const s = await startServer();
  const a = await req(s.port, 'POST', '/v1/auth/bootstrap', { email:'a@b.c' }, { 'x-setup-key':'setup-test-key' });
  const tok = a.body.token;
  await req(s.port, 'POST', '/v1/missions', { title:'M' }, { Authorization:'Bearer '+tok });
  const aud = await req(s.port, 'GET', '/v1/audit', undefined, { Authorization:'Bearer '+tok });
  assert.ok(aud.body.entries.length >= 1);
  const dump = JSON.stringify(aud.body);
  assert.ok(!dump.includes(tok), 'audit tidak boleh memuat bearer token');
  s.server.close(); s.db.close();
});
t('API: job list hanya milik owner', async ()=>{
  const s = await startServer();
  const a = await req(s.port, 'POST', '/v1/auth/bootstrap', { email:'a@b.c' }, { 'x-setup-key':'setup-test-key' });
  const tok = a.body.token, ownerId = a.body.ownerId;
  await s.db.query('INSERT INTO jobs (id, owner_id, kind, payload, state, attempts, max_attempts, available_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
    ['job-1', ownerId, 'k','{}','queued',0,3,new Date().toISOString(),new Date().toISOString(),new Date().toISOString()]);
  const r = await req(s.port, 'GET', '/v1/jobs', undefined, { Authorization:'Bearer '+tok });
  assert.strictEqual(r.body.jobs.length, 1);
  s.server.close(); s.db.close();
});
t('Client HTTP desktop bekerja terhadap server nyata', async ()=>{
  const s = await startServer();
  const a = await req(s.port, 'POST', '/v1/auth/bootstrap', { email:'a@b.c' }, { 'x-setup-key':'setup-test-key' });
  s.client.setToken(a.body.token);
  const h = await s.client.health();
  assert.strictEqual(h.status, 'ok');
  const m = await s.client.createMission ? null : null;
  const push = await s.client.pushEvents([{ eventId:'c-1', type:'mission.state', deviceSeq:1, payload:{} }]);
  assert.strictEqual(push.accepted, 1);
  s.server.close(); s.db.close();
});
t('Client HTTP: token salah ditolak dengan error terstruktur', async ()=>{
  const s = await startServer();
  s.client.setToken('token-ngawur');
  let e=null;
  try { await s.client.listMissions(); } catch(x){ e=x; }
  assert.ok(e && e.status === 401);
  s.server.close(); s.db.close();
});

// ── regresi Phase 2/3 ──
t('regresi: Phase 2 mission persistence masih kompatibel', async ()=>{
  const { MissionRuntime } = require('../src/missions/runtime');
  const { MissionStore } = require('../src/missions/store');
  const dir = tmp();
  const rt = new MissionRuntime(new MissionStore(dir), { workspaceRoot: path.join(dir,'ws') });
  const m = rt.createMission({ title:'Compat', tasks:[{title:'A'}] });
  assert.ok(m.id);
  db_close2();
  function db_close2(){}
});

run().then(()=>{
  console.log('\nPhase 5 tests: ' + passed + ' lulus, ' + failed + ' gagal');
  process.exit(failed ? 1 : 0);
});
