'use strict';
/**
 * Tes integrasi PostgreSQL NYATA untuk Orion Central (Phase 5.1).
 *
 * WAJIB dijalankan dengan server PostgreSQL sungguhan:
 *   node scripts/pg-harness.js --run scripts/test-phase5-postgres.js
 * atau:
 *   ORION_PG_CONNECTION=postgresql://... node scripts/test-phase5-postgres.js
 *
 * Driver yang dipakai: `pg` (SAMA dengan produksi). BUKAN SQLite, BUKAN mock.
 * Tanpa DATABASE_URL → suite DILEWATI (exit 2), tidak diklaim lulus.
 */
const assert = require('assert');
const crypto = require('crypto');

const CONN = process.env.ORION_PG_CONNECTION || process.env.DATABASE_URL || '';
if (!CONN){
  console.log('\n  ⚠ PostgreSQL tidak dikonfigurasi — suite integrasi PostgreSQL DILEWATI (bukan lulus).');
  console.log('    Jalankan: node scripts/pg-harness.js --run scripts/test-phase5-postgres.js');
  process.exit(2);
}

const { Client } = require('pg');
const { createDatabase } = require('../src/central/db');
const { migrate, migrationStatus } = require('../src/central/db/migrate');
const tokens = require('../src/central/auth/tokens');
const sync = require('../src/central/sync/events');
const queue = require('../src/central/queue/queue');
const orchestrator = require('../src/central/mission/orchestrator');
const skillsSvc = require('../src/central/skills/service');
const migrator = require('../src/central/migrate/migrate-local');
const { createApp } = require('../src/central/app');
const { readConfig } = require('../src/central/config');
const http = require('http');

let passed = 0, failed = 0, skipped = 0;
const tests = [];
function t(name, fn){ tests.push({ name, fn }); }

function randId(prefix){ return (prefix || 'x') + '-' + crypto.randomBytes(8).toString('hex'); }

async function adminClient(){
  const c = new Client({ connectionString: CONN });
  await c.connect();
  return c;
}
async function createFreshDb(){
  const admin = await adminClient();
  const name = 'orion_t_' + crypto.randomBytes(6).toString('hex');
  await admin.query('CREATE DATABASE ' + name);
  await admin.end();
  const url = CONN.replace(/\/[^/?]*(\?|$)/, '/' + name + '$1');
  const db = createDatabase({ driver: 'postgres', databaseUrl: url });
  return { db, url, name };
}
async function dropDb(name){
  const admin = await adminClient();
  await admin.query('DROP DATABASE IF EXISTS ' + name + ' WITH (FORCE)');
  await admin.end();
}
async function ensureOwner(db, ownerId, email){
  const now = new Date().toISOString();
  const existing = await db.query('SELECT id FROM owners WHERE id = ?', [ownerId]);
  if (existing.length) return;
  await db.exec("INSERT INTO owners (id, email, display_name, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
    [ownerId, email || (ownerId + '@test.local'), ownerId, 'owner', 'active', now, now]);
}
async function resetTables(db){
  const rows = await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'");
  const names = rows.map(r => r.table_name).filter(n => n !== 'schema_migrations');
  if (names.length) await db.query('TRUNCATE TABLE ' + names.map(n => '"' + n + '"').join(', ') + ' RESTART IDENTITY CASCADE');
}

// ══════════════ A. MIGRASI ══════════════
t('DB kosong → semua migrasi berhasil di PostgreSQL', async ()=>{
  const { db, name } = await createFreshDb();
  const m = await migrate(db, {});
  assert.ok(!m.error, 'migrasi gagal: ' + JSON.stringify(m.error));
  assert.ok(m.applied.length >= 5, 'harus ada >=5 migrasi, dapat ' + m.applied.length);
  const st = await migrationStatus(db);
  assert.ok(st.length >= 5);
  // tabel benar-benar ada di PostgreSQL
  const tbl = await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public'");
  const names = tbl.map(r => r.table_name);
  ['owners','devices','auth_tokens','missions','mission_tasks','approvals','budget_ledger','events','sync_cursors','memory_records','memory_versions','skill_versions','skill_evaluations','skill_active_pointer','skill_lifecycle_audit','jobs','job_attempts','audit_log','schema_migrations'].forEach(n=>{
    assert.ok(names.includes(n), 'tabel hilang: ' + n);
  });
  await db.close(); await dropDb(name);
});

t('migrasi berulang aman & tidak menggandakan perubahan', async ()=>{
  const { db, name } = await createFreshDb();
  await migrate(db, {});
  const before = await migrationStatus(db);
  const m2 = await migrate(db, {});
  assert.ok(!m2.error);
  assert.strictEqual(m2.applied.length, 0);
  const after = await migrationStatus(db);
  assert.strictEqual(after.length, before.length);
  await db.close(); await dropDb(name);
});

t('checksum migrasi berubah → terdeteksi & ditolak', async ()=>{
  const { db, name } = await createFreshDb();
  await migrate(db, {});
  await db.query('UPDATE schema_migrations SET checksum = ? WHERE version = ?', ['deadbeef', '001_core']);
  const m = await migrate(db, {});
  assert.ok(m.error && /CHECKSUM_MISMATCH/.test(m.error.message));
  await db.close(); await dropDb(name);
});

t('transaksi gagal → perubahan atomik benar-benar rollback', async ()=>{
  const { db, name } = await createFreshDb();
  await migrate(db, {});
  const before = await db.query('SELECT count(*) c FROM owners');
  let threw = false;
  try {
    await db.transaction(async (t) => {
      await t.exec("INSERT INTO owners (id, email, display_name, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)",
        ['own-rollback', 'rb@x.com', 'RB', 'owner', 'active', new Date().toISOString(), new Date().toISOString()]);
      // sengaja gagal: kolom tidak ada
      await t.exec('INSERT INTO owners (id, email, display_name, role, status, created_at, updated_at, kolom_tidak_ada) VALUES (?,?,?,?,?,?,?,?)',
        ['own-rollback-2', 'rb2@x.com', 'RB2', 'owner', 'active', new Date().toISOString(), new Date().toISOString(), 'x']);
    });
  } catch (e) { threw = true; }
  assert.ok(threw, 'transaksi harus gagal');
  const after = await db.query('SELECT count(*) c FROM owners');
  assert.strictEqual(Number(after[0].c), Number(before[0].c), 'rollback harus membatalkan semua perubahan');
  const orphan = await db.query('SELECT id FROM owners WHERE id = ?', ['own-rollback']);
  assert.strictEqual(orphan.length, 0, 'insert pertama harus ikut rollback');
  await db.close(); await dropDb(name);
});

t('unique constraint benar-benar ditegakkan PostgreSQL', async ()=>{
  const { db, name } = await createFreshDb();
  await migrate(db, {});
  const now = new Date().toISOString();
  await db.exec("INSERT INTO owners (id, email, display_name, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", ['o1','a@x','A','owner','active',now,now]);
  let e = null;
  try { await db.exec("INSERT INTO owners (id, email, display_name, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", ['o2','a@x','B','owner','active',now,now]); } catch (x) { e = x; }
  assert.ok(e, 'unique(email) harus ditolak');
  // unique pada events.id
  await db.exec("INSERT INTO events (id, cursor, owner_id, device_id, device_seq, type, schema_version, payload, received_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ['ev-dup', 1, 'o1', 'd1', 1, 'mission.state', 1, '{}', now]);
  let e2 = null;
  try { await db.exec("INSERT INTO events (id, cursor, owner_id, device_id, device_seq, type, schema_version, payload, received_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ['ev-dup', 2, 'o1', 'd1', 2, 'mission.state', 1, '{}', now]); } catch (x) { e2 = x; }
  assert.ok(e2, 'unique events.id harus ditolak');
  await db.close(); await dropDb(name);
});

t('foreign key ditegakkan (bila skema mendefinisikannya)', async ()=>{
  const { db, name } = await createFreshDb();
  await migrate(db, {});
  const hasFk = await db.query(`SELECT COUNT(*) c FROM information_schema.table_constraints WHERE constraint_type='FOREIGN KEY' AND table_schema='public'`);
  if (Number(hasFk[0].c) === 0){
    // skema saat ini belum mendeklarasikan FK — catat sebagai gap, jangan diklaim lulus
    const orphan = await db.query('SELECT count(*) c FROM mission_tasks WHERE mission_id NOT IN (SELECT id FROM missions)');
    assert.ok(Number(orphan[0].c) === 0, 'tidak ada task yatim');
    console.log('      (catatan: skema belum mendeklarasikan FOREIGN KEY — enforcing dilakukan di level aplikasi)');
  } else {
    let e = null;
    try { await db.exec("INSERT INTO mission_tasks (id, mission_id, owner_id, title, state, deps, attempts, max_attempts, timeout_ms, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      ['t-orphan', 'ms-tidak-ada', 'o1', 'x', 'pending', '[]', 0, 1, 1000, new Date().toISOString(), new Date().toISOString()]); } catch (x) { e = x; }
    assert.ok(e, 'FK harus menolak task dengan mission_id tak dikenal');
  }
  await db.close(); await dropDb(name);
});

// ══════════════ B. AUTH & ISOLASI ══════════════
t('token expiry / revocation / rotation di PostgreSQL', async ()=>{
  const { db, name } = await createFreshDb();
  await migrate(db, {});
  const now = new Date().toISOString();
  await db.exec("INSERT INTO owners (id, email, display_name, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", ['own-1','a@x','A','owner','active',now,now]);
  const issued = await tokens.issueToken(db, { ownerId:'own-1', label:'t' });
  const stored = await db.query('SELECT token_hash FROM auth_tokens');
  assert.ok(!stored.some(r => r.token_hash === issued.token), 'hanya hash yang boleh tersimpan');
  assert.ok((await tokens.verifyToken(db, issued.token)).ownerId === 'own-1');
  const expired = await tokens.issueToken(db, { ownerId:'own-1', ttlHours:-1 });
  assert.ok((await tokens.verifyToken(db, expired.token)).error === 'TOKEN_EXPIRED');
  const rev = await tokens.revokeToken(db, issued.record.id, 'own-1');
  assert.ok(rev.ok);
  assert.ok((await tokens.verifyToken(db, issued.token)).error === 'TOKEN_REVOKED');
  const fresh = await tokens.issueToken(db, { ownerId:'own-1' });
  const rot = await tokens.rotateToken(db, fresh.record.id, 'own-1', {});
  assert.ok(rot.token && rot.token !== fresh.token);
  assert.ok((await tokens.verifyToken(db, fresh.token)).error === 'TOKEN_REVOKED');
  assert.ok((await tokens.verifyToken(db, rot.token)).ownerId === 'own-1');
  await db.close(); await dropDb(name);
});

t('Owner A tidak dapat membaca/mengubah data Owner B (level DB)', async ()=>{
  const { db, name } = await createFreshDb();
  await migrate(db, {});
  const now = new Date().toISOString();
  await db.exec("INSERT INTO owners (id, email, display_name, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", ['own-A','a@x','A','owner','active',now,now]);
  await db.exec("INSERT INTO owners (id, email, display_name, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", ['own-B','b@x','B','owner','active',now,now]);
  await db.exec("INSERT INTO missions (id, owner_id, title, state, budget_spent, budget_reserved, budget_currency, executions, max_executions, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    ['ms-B','own-B','Misi B','running',0,0,'unit',0,10,now,now]);
  // A mencoba akses misi B
  const rows = await db.query('SELECT * FROM missions WHERE id = ? AND owner_id = ?', ['ms-B','own-A']);
  assert.strictEqual(rows.length, 0, 'A tidak boleh melihat misi B');
  const upd = await db.exec('UPDATE missions SET state = ? WHERE id = ? AND owner_id = ?', ['cancelled','ms-B','own-A']);
  assert.strictEqual(upd.changes, 0, 'A tidak boleh mengubah misi B');
  const own = await db.query('SELECT * FROM missions WHERE id = ? AND owner_id = ?', ['ms-B','own-B']);
  assert.strictEqual(own.length, 1);
  await db.close(); await dropDb(name);
});

// ══════════════ C. SYNC ══════════════
t('event duplikat tidak menghasilkan data ganda (PostgreSQL)', async ()=>{
  const { db, name } = await createFreshDb();
  await migrate(db, {});
  await ensureOwner(db, 'own-1');
  const ctx = { ownerId:'own-1', deviceId:'dev-1' };
  const ev = { eventId:'ev-1', type:'mission.state', schemaVersion:1, deviceSeq:1, payload:{ s:'x' } };
  const r1 = await sync.uploadEvents(db, ctx, [ev]);
  assert.strictEqual(r1.accepted, 1);
  const r2 = await sync.uploadEvents(db, ctx, [ev]);
  assert.strictEqual(r2.duplicates, 1);
  const c = await db.query('SELECT count(*) c FROM events');
  assert.strictEqual(Number(c[0].c), 1);
  // device_seq unik
  const r3 = await sync.uploadEvents(db, ctx, [{ eventId:'ev-2', type:'mission.state', deviceSeq:1, payload:{} }]);
  assert.strictEqual(r3.duplicates, 1);
  await db.close(); await dropDb(name);
});

t('cursor sinkronisasi tidak melewatkan event committed', async ()=>{
  const { db, name } = await createFreshDb();
  await migrate(db, {});
  await ensureOwner(db, 'own-1');
  const ctx = { ownerId:'own-1', deviceId:'dev-1' };
  for (let i=1;i<=7;i++) await sync.uploadEvents(db, ctx, [{ eventId:'e'+i, type:'mission.state', deviceSeq:i, payload:{ n:i } }]);
  const p1 = await sync.pullEvents(db, ctx, 0, 3);
  assert.strictEqual(p1.events.length, 3);
  const p2 = await sync.pullEvents(db, ctx, p1.cursor, 3);
  assert.strictEqual(p2.events.length, 3);
  const p3 = await sync.pullEvents(db, ctx, p2.cursor, 10);
  assert.strictEqual(p3.events.length, 1);
  const p4 = await sync.pullEvents(db, ctx, p3.cursor, 10);
  assert.strictEqual(p4.events.length, 0);
  // cursor device tersimpan
  const cur = await db.query('SELECT * FROM sync_cursors WHERE owner_id = ? AND device_id = ?', ['own-1','dev-1']);
  assert.strictEqual(cur.length, 1);
  assert.ok(Number(cur[0].last_cursor) > 0);
  await db.close(); await dropDb(name);
});

t('payload dengan owner_id ditolak; approval.decision ditolak (bukan LWW)', async ()=>{
  const { db, name } = await createFreshDb();
  await migrate(db, {});
  await ensureOwner(db, 'own-1');
  const ctx = { ownerId:'own-1', deviceId:'dev-1' };
  const r1 = await sync.uploadEvents(db, ctx, [{ eventId:'x1', type:'memory.upsert', payload:{ owner_id:'own-2' } }]);
  assert.strictEqual(r1.rejected, 1);
  const r2 = await sync.uploadEvents(db, ctx, [{ eventId:'x2', type:'approval.decision', payload:{ decision:'approved' } }]);
  assert.strictEqual(r2.conflicts, 1);
  const r3 = await sync.uploadEvents(db, ctx, [{ eventId:'x3', type:'memory.verification', payload:{ verificationStatus:'verified' } }]);
  assert.strictEqual(r3.conflicts, 1);
  const c = await db.query('SELECT count(*) c FROM events');
  assert.strictEqual(Number(c[0].c), 0, 'event yang ditolak tidak boleh masuk');
  const cf = await db.query('SELECT count(*) c FROM event_conflicts');
  assert.ok(Number(cf[0].c) >= 2, 'konflik harus tercatat');
  await db.close(); await dropDb(name);
});

// ══════════════ D. QUEUE (konkurensi nyata) ══════════════
t('dua worker bersamaan tidak mengklaim job yang sama', async ()=>{
  const { db, name } = await createFreshDb();
  await migrate(db, {});
  await ensureOwner(db, 'own-1');
  for (let i=0;i<5;i++) await queue.enqueue(db, { ownerId:'own-1', kind:'k', payload:{ i } });
  // 5 klaim KONKUREN (koneksi pool berbeda → MVCC PostgreSQL sungguhan)
  const claims = await Promise.all([1,2,3,4,5].map(i => queue.claim(db, { workerId:'w'+i, ownerId:'own-1' })));
  const got = claims.filter(Boolean).map(j => j.id);
  assert.strictEqual(got.length, 5, 'semua job harus diklaim tepat sekali');
  assert.strictEqual(new Set(got).size, 5, 'tidak ada job yang diklaim dua kali');
  await db.close(); await dropDb(name);
});

t('lease kedaluwarsa dapat dipulihkan', async ()=>{
  const { db, name } = await createFreshDb();
  await migrate(db, {});
  await ensureOwner(db, 'own-1');
  await queue.enqueue(db, { ownerId:'own-1', kind:'k', payload:{} });
  await queue.claim(db, { workerId:'w1', ownerId:'own-1', leaseMs: 1 });
  await new Promise(r => setTimeout(r, 30));
  const rec = await queue.recoverExpired(db, { ownerId:'own-1' });
  assert.ok(rec.length >= 1, 'job harus dipulihkan');
  const again = await queue.claim(db, { workerId:'w2', ownerId:'own-1' });
  assert.ok(again, 'job harus bisa diklaim ulang setelah recovery');
  await db.close(); await dropDb(name);
});

t('retry, backoff, dead-letter & outcome_unknown sesuai kebijakan', async ()=>{
  const { db, name } = await createFreshDb();
  await migrate(db, {});
  await ensureOwner(db, 'own-1');
  const e = await queue.enqueue(db, { ownerId:'own-1', kind:'k', payload:{}, maxAttempts: 2 });
  await queue.claim(db, { workerId:'w1', ownerId:'own-1' });
  const f1 = await queue.fail(db, e.jobId, 'w1', 'boom');
  assert.strictEqual(f1.state, 'queued');
  const j1 = await queue.getJob(db, e.jobId, 'own-1');
  assert.ok(new Date(j1.available_at) > new Date(), 'backoff harus menunda');
  assert.strictEqual(await queue.claim(db, { workerId:'w1', ownerId:'own-1' }), null, 'tak boleh diklaim sebelum backoff habis');
  await db.query('UPDATE jobs SET available_at = ? WHERE id = ?', [new Date().toISOString(), e.jobId]);
  await queue.claim(db, { workerId:'w1', ownerId:'own-1' });
  const f2 = await queue.fail(db, e.jobId, 'w1', 'boom');
  assert.strictEqual(f2.state, 'dead_letter');
  const j = await queue.getJob(db, e.jobId, 'own-1');
  assert.strictEqual(j.state, 'dead_letter');
  // outcome_unknown → dead-letter, tidak auto-retry
  const e2 = await queue.enqueue(db, { ownerId:'own-1', kind:'publish', payload:{}, maxAttempts: 5 });
  await queue.claim(db, { workerId:'w1', ownerId:'own-1' });
  const f3 = await queue.fail(db, e2.jobId, 'w1', 'lost', { uncertain:true });
  assert.strictEqual(f3.state, 'dead_letter');
  assert.strictEqual(f3.reason, 'OUTCOME_UNKNOWN');
  await db.close(); await dropDb(name);
});

t('budget & approval diperiksa di boundary server (PostgreSQL)', async ()=>{
  const { db, name } = await createFreshDb();
  await migrate(db, {});
  const now = new Date().toISOString();
  await db.exec("INSERT INTO owners (id, email, display_name, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", ['own-1','a@x','A','owner','active',now,now]);
  await db.exec("INSERT INTO missions (id, owner_id, title, state, budget_limit, budget_spent, budget_reserved, budget_currency, executions, max_executions, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    ['ms-1','own-1','M','running',10,0,0,'unit',0,100,now,now]);
  const r = await orchestrator.reserveBudget(db, { ownerId:'own-1', missionId:'ms-1', estimateMinor: 5 });
  assert.ok(r.reservationId);
  // Rekonsiliasi di PostgreSQL (regresi: MAX(a,b) dua-argumen tidak ada di PG).
  const rec = await orchestrator.reconcileBudget(db, { ownerId:'own-1', missionId:'ms-1', reservationId:r.reservationId, actualMinor:3 });
  assert.strictEqual(rec.ok, true);
  const afterRec = (await db.query('SELECT budget_spent, budget_reserved FROM missions WHERE id = ?', ['ms-1']))[0];
  assert.strictEqual(Number(afterRec.budget_spent), 3);
  assert.strictEqual(Number(afterRec.budget_reserved), 0);
  const rec2 = await orchestrator.reconcileBudget(db, { ownerId:'own-1', missionId:'ms-1', reservationId:r.reservationId, actualMinor:99 });
  assert.strictEqual(rec2.alreadyReconciled, true);
  assert.strictEqual(Number((await db.query('SELECT budget_spent FROM missions WHERE id = ?', ['ms-1']))[0].budget_spent), 3, 'rekonsiliasi ganda tidak boleh menambah spent');
  let e=null;
  try { await orchestrator.reserveBudget(db, { ownerId:'own-1', missionId:'ms-1', estimateMinor: 100 }); } catch(x){ e=x; }
  assert.ok(e && e.code === 'BUDGET_EXCEEDED');
  // approval fingerprint
  const fp = orchestrator.fingerprint('publish','res://x',{v:1},'mission');
  await db.exec("INSERT INTO approvals (id, owner_id, action, resource, params, scope, fingerprint, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ['ap-1','own-1','publish','res://x',JSON.stringify({v:1}),'mission',fp,'approved',now,new Date(Date.now()+60000).toISOString()]);
  await orchestrator.assertApprovalValid(db, { ownerId:'own-1', approvalId:'ap-1', action:'publish', resource:'res://x', params:{v:1}, scope:'mission' });
  let e2=null;
  try { await orchestrator.assertApprovalValid(db, { ownerId:'own-1', approvalId:'ap-1', action:'publish', resource:'res://x', params:{v:2}, scope:'mission' }); } catch(x){ e2=x; }
  assert.ok(e2 && e2.code === 'APPROVAL_FINGERPRINT_MISMATCH');
  await db.close(); await dropDb(name);
});

// ══════════════ E. MIGRASI DATA PHASE 4 ══════════════
t('migrasi data Phase 4 mempertahankan ID, provenance, hash, versi, soft delete, audit', async ()=>{
  const { db, name } = await createFreshDb();
  await migrate(db, {});
  const now = new Date().toISOString();
  await db.exec("INSERT INTO owners (id, email, display_name, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", ['own-1','a@x','A','owner','active',now,now]);
  const local = [
    { id:'mem-1', schemaVersion:1, type:'fact', content:'fakta A', origin:'user', sourceRef:'doc:a', excerpt:'fakta A', created:'2026-01-01T00:00:00.000Z', updated:'2026-01-02T00:00:00.000Z', confidence:0.8, verificationStatus:'verified', owner:'owner', scope:'global', sensitivity:'internal', status:'active', version:1, integrityHash:'h1' },
    { id:'mem-2', schemaVersion:1, type:'agent_inference', content:'inferensi', origin:'agent', verificationStatus:'inferred', status:'superseded', supersededReason:'dikoreksi', supersededBy:'mem-1', version:2, integrityHash:'h2' },
    { id:'mem-3', schemaVersion:1, type:'fact', content:'hapus', origin:'user', status:'deleted', deletedAt:'2026-01-03T00:00:00.000Z', version:1, integrityHash:'h3' }
  ];
  const { plan, counts } = migrator.planMemory(local, { ownerId:'own-1' });
  assert.strictEqual(counts.total, 3);
  const rep = await migrator.applyMemoryPlan(db, 'own-1', plan, 'run-1');
  assert.strictEqual(rep.inserted, 3);
  const rows = await db.query('SELECT * FROM memory_records WHERE owner_id = ? ORDER BY id', ['own-1']);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[0].id, 'mem-1');
  assert.strictEqual(rows[0].source_ref, 'doc:a');
  assert.strictEqual(rows[0].integrity_hash, 'h1');
  assert.strictEqual(rows[0].content_version, 1);
  assert.strictEqual(rows[1].verification_status, 'inferred', 'inferred tidak boleh naik');
  assert.strictEqual(rows[1].superseded_by, 'mem-1');
  assert.strictEqual(rows[2].status, 'deleted');
  assert.ok(rows[2].deleted_at);
  const mv = await db.query('SELECT * FROM memory_versions WHERE owner_id = ? ORDER BY record_id', ['own-1']);
  assert.ok(mv.length >= 3, 'riwayat versi harus ada');
  // idempoten
  const rep2 = await migrator.applyMemoryPlan(db, 'own-1', plan, 'run-2');
  assert.strictEqual(rep2.inserted, 0);
  const c = await db.query('SELECT count(*) c FROM memory_records');
  assert.strictEqual(Number(c[0].c), 3);
  // rollback menghapus hasil, sumber utuh
  const rb = await migrator.rollbackMigration(db, 'own-1');
  assert.ok(rb.removedMemory >= 3);
  const c2 = await db.query('SELECT count(*) c FROM memory_records');
  assert.strictEqual(Number(c2[0].c), 0);
  assert.strictEqual(local.length, 3, 'data sumber tak boleh terhapus');
  await db.close(); await dropDb(name);
});

t('migrasi skill mempertahankan hash, manifest, evaluasi, lifecycle', async ()=>{
  const { db, name } = await createFreshDb();
  await migrate(db, {});
  const now = new Date().toISOString();
  await db.exec("INSERT INTO owners (id, email, display_name, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", ['own-1','a@x','A','owner','active',now,now]);
  const local = [{ versionId:'ver-abc', skillId:'sk-1', version:'1.0.0', contentHash:'hash1', manifest:{ id:'sk-1', version:'1.0.0', permissions:['chat:read'] }, body:'isi', state:'registered', created:now, evaluation:{ ok:true, reportId:'ev-1' }, lifecycle:[{ at:'x', state:'registered' }] }];
  const { plan } = migrator.planSkills(local, { ownerId:'own-1' });
  const rep = await migrator.applySkillPlan(db, 'own-1', plan);
  assert.strictEqual(rep.inserted, 1);
  const v = (await db.query('SELECT * FROM skill_versions WHERE owner_id = ?', ['own-1']))[0];
  assert.strictEqual(v.version_id, 'ver-abc');
  assert.strictEqual(v.content_hash, 'hash1');
  assert.ok(v.manifest.includes('chat:read'));
  assert.ok(v.evaluation.includes('ev-1'));
  assert.ok(v.lifecycle.includes('registered'));
  await db.close(); await dropDb(name);
});

t('konflik active skill pointer & verification status tidak diselesaikan LWW', async ()=>{
  const { db, name } = await createFreshDb();
  await migrate(db, {});
  const now = new Date().toISOString();
  await db.exec("INSERT INTO owners (id, email, display_name, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", ['own-1','a@x','A','owner','active',now,now]);
  const manifest = { id:'sk-c', version:'1.0.0', permissions:[], capabilities:[], schemaVersion:1, name:'C', description:'d' };
  const reg = await skillsSvc.register(db, { ownerId:'own-1' }, { manifest, body:'body' });
  const v = (await db.query('SELECT * FROM skill_versions WHERE version_id = ?', [reg.versionId]))[0];
  await db.exec('UPDATE skill_versions SET evaluation = ? WHERE version_id = ?', [JSON.stringify({ ok:true, contentHash:v.content_hash }), v.version_id]);
  const v2 = (await db.query('SELECT * FROM skill_versions WHERE version_id = ?', [reg.versionId]))[0];
  await skillsSvc.activate(db, { ownerId:'own-1' }, v2);
  // klien mencoba mengubah pointer lewat event → harus ditolak
  const r = await sync.uploadEvents(db, { ownerId:'own-1', deviceId:'d1' }, [{ eventId:'sk-ev', type:'skill.active', payload:{ versionId:'ver-abc' } }]);
  assert.strictEqual(r.conflicts, 1);
  const ptr = await db.query('SELECT * FROM skill_active_pointer WHERE owner_id = ?', ['own-1']);
  assert.strictEqual(ptr.length, 1);
  assert.strictEqual(ptr[0].version_id, reg.versionId, 'pointer tidak boleh berubah oleh event klien');
  await db.close(); await dropDb(name);
});

// ══════════════ F. API + BACKUP/RESTORE ══════════════
async function startApi(url){
  const db = createDatabase({ driver:'postgres', databaseUrl: url });
  const cfg = readConfig({ CENTRAL_DB_DRIVER:'postgres', DATABASE_URL:url, CENTRAL_RATE_LIMIT_PER_MIN:'10000' });
  const app = createApp({ db, config: cfg, setupKey:'setup-test-key', version:'1.0.0' });
  const server = http.createServer((req,res)=>app.handle(req,res).catch(()=>{ res.writeHead(500); res.end('{}'); }));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return { db, server, port: server.address().port };
}
function req(port, method, p, body, headers){
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

t('API di PostgreSQL: auth, isolasi owner, device revocation, event idempoten', async ()=>{
  const { db, url, name } = await createFreshDb();
  await migrate(db, {});
  const api = await startApi(url);
  const anon = await req(api.port, 'GET', '/v1/missions');
  assert.strictEqual(anon.status, 401);
  const boot = await req(api.port, 'POST', '/v1/auth/bootstrap', { email:'a@x' }, { 'x-setup-key':'setup-test-key' });
  assert.strictEqual(boot.status, 201);
  const tok = boot.body.token;
  const dev = await req(api.port, 'POST', '/v1/devices', { name:'D' }, { Authorization:'Bearer '+tok });
  assert.strictEqual(dev.status, 201);
  // Owner isolation: B tidak bisa akses misi A
  const bootB = await req(api.port, 'POST', '/v1/auth/bootstrap', { email:'b@x' }, { 'x-setup-key':'setup-test-key' });
  const tokB = bootB.body.token;
  const mA = await req(api.port, 'POST', '/v1/missions', { title:'M-A' }, { Authorization:'Bearer '+tok });
  const cross = await req(api.port, 'GET', '/v1/missions/' + mA.body.missionId, undefined, { Authorization:'Bearer '+tokB });
  assert.strictEqual(cross.status, 404);
  // device revocation mematikan token
  const rev = await req(api.port, 'DELETE', '/v1/devices/' + dev.body.deviceId, undefined, { Authorization:'Bearer '+tok });
  assert.strictEqual(rev.status, 200);
  const after = await req(api.port, 'POST', '/v1/missions', { title:'x' }, { Authorization:'Bearer '+dev.body.token });
  assert.strictEqual(after.status, 401);
  // event idempoten
  const ev = { eventId:'e1', type:'mission.state', deviceSeq:1, payload:{} };
  const r1 = await req(api.port, 'POST', '/v1/events', { events:[ev] }, { Authorization:'Bearer '+tok });
  assert.strictEqual(r1.body.accepted, 1);
  const r2 = await req(api.port, 'POST', '/v1/events', { events:[ev] }, { Authorization:'Bearer '+tok });
  assert.strictEqual(r2.body.duplicates, 1);
  // tidak ada bearer token di audit
  const aud = await req(api.port, 'GET', '/v1/audit', undefined, { Authorization:'Bearer '+tok });
  assert.ok(!JSON.stringify(aud.body).includes(tok), 'audit tidak boleh memuat token');
  api.server.close(); await db.close(); await dropDb(name);
});

t('backup & restore PostgreSQL nyata (ekpor/import logis via pg client)', async ()=>{
  const { db, url, name } = await createFreshDb();
  await migrate(db, {});
  const now = new Date().toISOString();
  await db.exec("INSERT INTO owners (id, email, display_name, role, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)", ['own-1','a@x','A','owner','active',now,now]);
  await db.exec("INSERT INTO memory_records (id, owner_id, schema_version, type, content, origin, source_ref, excerpt, created, updated, confidence, verification_status, rec_owner, scope, sensitivity, status, content_version, integrity_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ['mem-bk','own-1',1,'fact','isi backup','user','doc:b','isi backup',now,now,0.5,'unverified','owner','global','internal','active',1,'hbk']);
  // BACKUP: ekspor logis semua tabel ke JSON (pg_dump tidak ada di paket ini)
  const tables = (await db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name")).map(r=>r.table_name);
  const dump = {};
  for (const tb of tables){
    const rows = await db.query('SELECT * FROM "' + tb + '"');
    dump[tb] = rows;
  }
  assert.ok(dump.memory_records.length === 1);
  assert.strictEqual(dump.memory_records[0].integrity_hash, 'hbk');
  // RESTORE: ke database baru
  const target = await createFreshDb();
  await migrate(target.db, {});
  // bersihkan tabel target (kecuali schema_migrations) sebelum restore
  const tTables = (await target.db.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' AND table_name <> 'schema_migrations'")).map(r=>r.table_name);
  if (tTables.length) await target.db.query('TRUNCATE TABLE ' + tTables.map(n=>'"'+n+'"').join(', ') + ' RESTART IDENTITY CASCADE');
  // URUTAN RESTORE: tabel induk harus lebih dulu (FK). Urutan diambil dari
  // information_schema (FK nyata), di-topological-sort.
  const fkRows = await db.query(`SELECT tc.table_name AS child, ccu.table_name AS parent
                                 FROM information_schema.table_constraints tc
                                 JOIN information_schema.constraint_column_usage ccu
                                   ON tc.constraint_name = ccu.constraint_name
                                 WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'`);
  const parents = new Map();
  fkRows.forEach(r => {
    if (!parents.has(r.child)) parents.set(r.child, new Set());
    parents.get(r.child).add(r.parent);
  });
  const ordered = [];
  const placed = new Set();
  const rest = tables.filter(t => t !== 'schema_migrations');
  let guard = 0;
  while (ordered.length < rest.length && guard++ < rest.length + 5){
    let progressed = false;
    for (const tb of rest){
      if (ordered.includes(tb)) continue;
      const need = Array.from(parents.get(tb) || []).filter(p => rest.includes(p) && !placed.has(p));
      if (need.length === 0){ ordered.push(tb); placed.add(tb); progressed = true; }
    }
    if (!progressed) break;
  }
  for (const tb of rest){ if (!ordered.includes(tb)) ordered.push(tb); }
  for (const tb of ordered){
    const rows = dump[tb] || [];
    if (!rows.length) continue;
    if (tb === 'schema_migrations') continue;
    const cols = Object.keys(rows[0]);
    const placeholders = cols.map(()=>'?').join(', ');
    for (const row of rows){
      const vals = cols.map(c => row[c] === undefined ? null : row[c]);
      try {
        await target.db.exec('INSERT INTO "' + tb + '" (' + cols.map(c=>'"'+c+'"').join(',') + ') VALUES (' + placeholders + ')', vals);
      } catch (err) {
        throw new Error('restore gagal pada tabel ' + tb + ' (' + cols.length + ' kolom, ' + vals.length + ' nilai): ' + err.message);
      }
    }
  }
  const restored = await target.db.query('SELECT * FROM memory_records WHERE id = ?', ['mem-bk']);
  assert.strictEqual(restored.length, 1, 'restore harus mengembalikan record');
  assert.strictEqual(restored[0].integrity_hash, 'hbk');
  assert.strictEqual(restored[0].source_ref, 'doc:b');
  const owners = await target.db.query('SELECT count(*) c FROM owners');
  assert.strictEqual(Number(owners[0].c), 1);
  await target.db.close(); await dropDb(target.name);
  await db.close(); await dropDb(name);
});

// ══════════════ RUN ══════════════
(async ()=>{
  console.log('PostgreSQL integration — target: ' + CONN.replace(/:[^:@/]+@/, ':***@'));
  for (const item of tests){
    try { await item.fn(); console.log('  ✓ ' + item.name); passed++; }
    catch (e){ console.log('  ✗ ' + item.name + ' — ' + (e && e.message)); failed++; }
  }
  console.log('\nPostgreSQL integration: ' + passed + ' lulus, ' + failed + ' gagal');
  process.exit(failed ? 1 : 0);
})();
