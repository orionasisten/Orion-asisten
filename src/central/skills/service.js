'use strict';
/**
 * Layanan skill sisi server (metadata Phase 4, dengan preservasi provenance penuh).
 * Aktivasi WAJIB: hash cocok + evaluasi lulus untuk hash itu + pointer update atomik + audit.
 */
const crypto = require('crypto');
const { id, nowISO } = require('../auth/tokens');
const { PolicyError } = require('../policy/scope');

function contentHash(manifest, body){
  return crypto.createHash('sha256').update(JSON.stringify({ manifest, body: body || '' })).digest('hex');
}

/** Daftarkan versi skill (immutable). Idempoten; konflik id+version dengan konten berbeda = error. */
async function register(db, ctx, { manifest, body }){
  const m = Object.assign({}, manifest || {});
  m.owner = ctx.ownerId; // owner dari server, bukan klien
  if (!m.id || !/^[a-z0-9][a-z0-9_-]{2,63}$/.test(String(m.id))) throw new PolicyError('BAD_MANIFEST', 'id skill tidak valid.', 400);
  if (!m.version || !/^\d+\.\d+\.\d+$/.test(String(m.version))) throw new PolicyError('BAD_MANIFEST', 'versi skill harus semver.', 400);
  const hash = contentHash(m, body || '');
  const versionId = 'ver-' + hash.slice(0, 16);
  const existing = await db.query('SELECT * FROM skill_versions WHERE version_id = ? AND owner_id = ?', [versionId, ctx.ownerId]);
  if (existing.length) return { versionId, duplicate: true, version: existing[0] };
  const dup = await db.query('SELECT * FROM skill_versions WHERE owner_id = ? AND skill_id = ? AND version = ?', [ctx.ownerId, m.id, m.version]);
  if (dup.length && dup[0].content_hash !== hash) throw new PolicyError('VERSION_CONFLICT', 'Versi skill sudah ada dengan konten berbeda.', 409);
  await db.query(`INSERT INTO skill_versions (version_id, skill_id, owner_id, version, content_hash, manifest, body, state, created, created_by, evaluation, lifecycle, quarantined)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [versionId, m.id, ctx.ownerId, m.version, hash, JSON.stringify(m), String(body || ''), 'registered', nowISO(), ctx.ownerId, null, JSON.stringify([{ at: nowISO(), state: 'registered', by: ctx.ownerId }]), 0]);
  return { versionId, duplicate: false };
}

/** Aktifkan versi: hash + evaluasi + policy + pointer atomik + audit. */
async function activate(db, ctx, version){
  if (version.quarantined) throw new PolicyError('QUARANTINED', 'Versi dikarantina.', 409);
  const m = JSON.parse(version.manifest);
  const hash = contentHash(m, version.body);
  if (hash !== version.content_hash) throw new PolicyError('HASH_MISMATCH', 'Hash versi tidak cocok — isi versi berubah setelah evaluasi.', 409);
  const ev = version.evaluation ? JSON.parse(version.evaluation) : null;
  if (!ev || !ev.ok) throw new PolicyError('NOT_EVALUATED', 'Versi belum dievaluasi lulus.', 409);
  if (ev.contentHash && ev.contentHash !== version.content_hash) throw new PolicyError('STALE_EVALUATION', 'Evaluasi tidak berlaku untuk versi ini.', 409);
  const FORBIDDEN = ['system:admin','secret:read-all','filesystem:unrestricted','policy:override','approval:bypass','secret:read'];
  const perms = Array.isArray(m.permissions) ? m.permissions : [];
  const bad = perms.filter(p => FORBIDDEN.includes(p));
  if (bad.length) throw new PolicyError('FORBIDDEN_PERMISSIONS', 'Izin terlarang: ' + bad.join(','), 403);
  const now = nowISO();
  await db.transaction(async (t) => {
    const prev = await t.query('SELECT version_id FROM skill_active_pointer WHERE owner_id = ? AND skill_id = ?', [ctx.ownerId, version.skill_id]);
    const prevId = prev.length ? prev[0].version_id : null;
    await t.query(`INSERT INTO skill_active_pointer (owner_id, skill_id, version_id, updated_at, updated_by) VALUES (?, ?, ?, ?, ?)
                   ON CONFLICT(owner_id, skill_id) DO UPDATE SET version_id = excluded.version_id, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      [ctx.ownerId, version.skill_id, version.version_id, now, ctx.ownerId]);
    await t.query('UPDATE skill_versions SET state = ? WHERE version_id = ? AND owner_id = ?', ['active', version.version_id, ctx.ownerId]);
    await t.query('UPDATE skill_versions SET state = ? WHERE owner_id = ? AND skill_id = ? AND version_id = ? AND state = ?', ['deprecated', ctx.ownerId, version.skill_id, prevId, 'active']);
    const life = JSON.parse(version.lifecycle || '[]');
    life.push({ at: now, state: 'active', by: ctx.ownerId, previous: prevId });
    await t.query('UPDATE skill_versions SET lifecycle = ? WHERE version_id = ? AND owner_id = ?', [JSON.stringify(life), version.version_id, ctx.ownerId]);
    await t.query('INSERT INTO skill_lifecycle_audit (id, owner_id, version_id, skill_id, action, from_state, to_state, reason, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id('sla'), ctx.ownerId, version.version_id, version.skill_id, 'activate', prevId, version.version_id, 'activated', ctx.ownerId, now]);
  });
  return { ok: true, skillId: version.skill_id, versionId: version.version_id, previous: version.version_id };
}

/** Karantina versi (menonaktifkan pointer bila aktif). */
async function quarantine(db, ctx, version, reason){
  const now = nowISO();
  await db.transaction(async (t) => {
    await t.query('UPDATE skill_versions SET state = ?, quarantined = 1, quarantine_reason = ? WHERE version_id = ? AND owner_id = ?',
      ['quarantined', String(reason || '').slice(0, 500), version.version_id, ctx.ownerId]);
    await t.query('DELETE FROM skill_active_pointer WHERE owner_id = ? AND skill_id = ? AND version_id = ?', [ctx.ownerId, version.skill_id, version.version_id]);
    await t.query('INSERT INTO skill_lifecycle_audit (id, owner_id, version_id, skill_id, action, from_state, to_state, reason, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [id('sla'), ctx.ownerId, version.version_id, version.skill_id, 'quarantine', 'active', 'quarantined', String(reason || ''), ctx.ownerId, now]);
  });
  return { ok: true, versionId: version.version_id, state: 'quarantined' };
}

module.exports = { register, activate, quarantine, contentHash };
