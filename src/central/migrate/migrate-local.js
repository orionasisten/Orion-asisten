'use strict';
/**
 * Migrasi data lokal Phase 4 (memori & skill) → Orion Central.
 *
 * ATURAN KETAT (Phase 5):
 *  - ID dipertahankan (referensi misi & audit tidak rusak).
 *  - Provenance dipertahankan penuh: origin, sourceRef, excerpt, verificationStatus, owner,
 *    scope, sensitivity, status, integrityHash, contentVersion, created/updated.
 *  - TIDAK menaikkan status 'inferred' → 'verified' (dan tidak juga sebaliknya).
 *  - Secret yang terdeteksi TIDAK diimpor (isi diredact; record ditandai).
 *  - Idempoten: migrasi ulang tidak menduplikasi (upsert by id + hash check).
 *  - Dry-run: menghitung & melaporkan tanpa menulis.
 *  - Sumber data TIDAK dihapus; rollback terdokumentasi (hapus baris hasil migrasi by run id).
 *  - Metadata skill (hash, manifest, evaluasi, lifecycle) ikut termigrasi.
 */
const crypto = require('crypto');
const { id, nowISO } = require('../auth/tokens');

const SECRET_RE = /(sk-[A-Za-z0-9_-]{8,}|AIza[A-Za-z0-9_-]{8,}|ghp_[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]+)/g;

function containsSecret(text){ SECRET_RE.lastIndex = 0; return SECRET_RE.test(String(text || '')); }
function redact(text){ SECRET_RE.lastIndex = 0; return String(text || '').replace(SECRET_RE, '[redacted]'); }
function sha(s){ return crypto.createHash('sha256').update(String(s)).digest('hex'); }

/**
 * Plan migrasi dari record lokal.
 * @param records array record memori lokal (format Phase 4)
 * @returns { plan: [{record, action, reason}], counts }
 */
function planMemory(records, opts){
  opts = opts || {};
  const plan = [];
  const counts = { total: 0, insert: 0, skip: 0, conflict: 0, secret: 0, inferredPreserved: 0 };
  for (const r of records || []){
    counts.total++;
    if (!r || !r.id){ plan.push({ record: r, action: 'skip', reason: 'NO_ID' }); counts.skip++; continue; }
    // secret detection → redacted + flag (tidak pernah mengirim secret ke cloud)
    let content = r.content || '';
    let flagged = false;
    if (containsSecret(content)){ content = redact(content); flagged = true; counts.secret++; }
    const excerpt = containsSecret(r.excerpt) ? redact(r.excerpt) : (r.excerpt || '');
    // verifikasi TIDAK boleh naik: 'inferred' tetap 'inferred'; 'unverified' tidak jadi 'verified'
    let verification = r.verificationStatus || 'unverified';
    if (verification === 'inferred'){ counts.inferredPreserved++; }
    if (!['unverified','verified','conflicting','inferred'].includes(verification)) verification = 'unverified';
    const rec = {
      id: r.id,
      schema_version: Number.isFinite(r.schemaVersion) ? r.schemaVersion : 1,
      type: r.type || 'fact',
      content,
      origin: r.origin || 'user',
      source_ref: r.sourceRef || null,
      excerpt,
      created: r.created || nowISO(),
      updated: r.updated || r.created || nowISO(),
      confidence: Number.isFinite(r.confidence) ? r.confidence : 0.5,
      verification_status: verification,
      rec_owner: r.owner || opts.ownerId || null,
      scope: r.scope || 'global',
      mission_id: r.missionId || null,
      sensitivity: r.sensitivity || 'internal',
      status: r.status || 'active',
      content_version: Number.isFinite(r.version) ? r.version : 1,
      integrity_hash: r.integrityHash || null,
      expiry: r.expiry || null,
      superseded_reason: r.supersededReason || null,
      superseded_by: r.supersededBy || null,
      deleted_at: r.deletedAt || null,
      metadata: JSON.stringify({ migratedFrom: 'orion-desktop-phase4', secretRedacted: flagged })
    };
    plan.push({ record: rec, action: 'insert', reason: flagged ? 'INSERT_REDACTED' : 'INSERT' });
    counts.insert++;
  }
  return { plan, counts };
}

/** Plan migrasi versi skill lokal. */
function planSkills(versions, opts){
  opts = opts || {};
  const plan = [];
  const counts = { total: 0, insert: 0, skip: 0, conflict: 0, secret: 0 };
  for (const v of versions || []){
    counts.total++;
    if (!v || !v.versionId || !v.skillId){ plan.push({ record: v, action: 'skip', reason: 'NO_ID' }); counts.skip++; continue; }
    let body = v.body || '';
    let flagged = false;
    if (containsSecret(body)){ body = redact(body); flagged = true; counts.secret++; }
    const rec = {
      version_id: v.versionId,
      skill_id: v.skillId,
      version: v.version,
      content_hash: v.contentHash,
      manifest: typeof v.manifest === 'string' ? v.manifest : JSON.stringify(v.manifest || {}),
      body,
      state: v.state || 'registered',
      created: v.created || nowISO(),
      created_by: v.createdBy || opts.ownerId || null,
      evaluation: v.evaluation ? JSON.stringify(v.evaluation) : null,
      lifecycle: JSON.stringify(v.lifecycle || []),
      quarantined: v.quarantined ? 1 : 0,
      quarantine_reason: v.quarantineReason || null,
      metadata: JSON.stringify({ migratedFrom: 'orion-desktop-phase4', secretRedacted: flagged })
    };
    plan.push({ record: rec, action: 'insert', reason: flagged ? 'INSERT_REDACTED' : 'INSERT' });
    counts.insert++;
  }
  return { plan, counts };
}

/**
 * Terapkan plan ke DB Central (idempoten). Records yang sudah ada & hash sama → skip.
 * Hash berbeda → conflict (tidak menimpa diam-diam).
 */
async function applyMemoryPlan(db, ownerId, plan, runId){
  const report = { runId, inserted: 0, skipped: 0, conflicts: [], errors: [] };
  for (const item of plan){
    if (item.action !== 'insert'){ report.skipped++; continue; }
    const r = item.record;
    const existing = await db.query('SELECT id, integrity_hash, content_version FROM memory_records WHERE id = ? AND owner_id = ?', [r.id, ownerId]);
    if (existing.length){
      if (existing[0].integrity_hash && r.integrity_hash && existing[0].integrity_hash === r.integrity_hash){
        report.skipped++; continue; // idempoten
      }
      // konflik: jangan timpa; buat versi baru (riwayat) tapi pertahankan record lama
      report.conflicts.push({ id: r.id, reason: 'CONTENT_DIFFERS', resolution: 'VERSION_APPENDED' });
      await appendMemoryVersion(db, ownerId, r);
      continue;
    }
    await db.query(`INSERT INTO memory_records (id, owner_id, schema_version, type, content, origin, source_ref, excerpt, created, updated, confidence, verification_status, rec_owner, scope, mission_id, sensitivity, status, content_version, integrity_hash, expiry, superseded_reason, superseded_by, deleted_at, metadata)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.id, ownerId, r.schema_version, r.type, r.content, r.origin, r.source_ref, r.excerpt, r.created, r.updated, r.confidence,
       r.verification_status, r.rec_owner, r.scope, r.mission_id, r.sensitivity, r.status, r.content_version, r.integrity_hash,
       r.expiry, r.superseded_reason, r.superseded_by, r.deleted_at, r.metadata]);
    await appendMemoryVersion(db, ownerId, r);
    report.inserted++;
  }
  return report;
}

async function appendMemoryVersion(db, ownerId, r){
  await db.query(`INSERT INTO memory_versions (id, record_id, owner_id, content_version, content, verification_status, integrity_hash, reason, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id('mv'), r.id, ownerId, r.content_version, r.content, r.verification_status, r.integrity_hash, 'migrated-from-desktop', nowISO()]);
}

async function applySkillPlan(db, ownerId, plan){
  const report = { inserted: 0, skipped: 0, conflicts: [], evaluations: 0 };
  for (const item of plan){
    if (item.action !== 'insert'){ report.skipped++; continue; }
    const r = item.record;
    const existing = await db.query('SELECT version_id, content_hash FROM skill_versions WHERE version_id = ? AND owner_id = ?', [r.version_id, ownerId]);
    if (existing.length){
      if (existing[0].content_hash === r.content_hash){ report.skipped++; continue; }
      report.conflicts.push({ versionId: r.version_id, reason: 'CONTENT_DIFFERS', resolution: 'REJECTED' });
      continue;
    }
    await db.query(`INSERT INTO skill_versions (version_id, skill_id, owner_id, version, content_hash, manifest, body, state, created, created_by, evaluation, lifecycle, quarantined, quarantine_reason, metadata)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [r.version_id, r.skill_id, ownerId, r.version, r.content_hash, r.manifest, r.body, r.state, r.created, r.created_by,
       r.evaluation, r.lifecycle, r.quarantined, r.quarantine_reason, r.metadata]);
    report.inserted++;
  }
  return report;
}

/** Checksum laporan migrasi (untuk verifikasi & rollback). */
function reportChecksum(report){
  return sha(JSON.stringify(report));
}

/**
 * ROLLBACK: hapus baris hasil migrasi (by metadata migratedFrom) — data sumber TIDAK tersentuh.
 * Memerlukan run marker: migrasi storing metadata. Dipakai hanya pada kegagalan.
 */
async function rollbackMigration(db, ownerId){
  const mem = await db.query("SELECT id FROM memory_records WHERE owner_id = ? AND metadata LIKE ?", [ownerId, '%orion-desktop-phase4%']);
  for (const m of mem) await db.query('DELETE FROM memory_records WHERE id = ? AND owner_id = ?', [m.id, ownerId]);
  const ver = await db.query("SELECT record_id FROM memory_versions WHERE owner_id = ? AND reason = ?", [ownerId, 'migrated-from-desktop']);
  for (const v of ver) await db.query('DELETE FROM memory_versions WHERE record_id = ? AND owner_id = ?', [v.record_id, ownerId]);
  const sk = await db.query("SELECT version_id FROM skill_versions WHERE owner_id = ? AND metadata LIKE ?", [ownerId, '%orion-desktop-phase4%']);
  for (const s of sk) await db.query('DELETE FROM skill_versions WHERE version_id = ? AND owner_id = ?', [s.version_id, ownerId]);
  return { removedMemory: mem.length, removedMemoryVersions: ver.length, removedSkillVersions: sk.length };
}

module.exports = { planMemory, planSkills, applyMemoryPlan, applySkillPlan, rollbackMigration, reportChecksum, containsSecret, redact };
