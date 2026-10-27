'use strict';
/**
 * Orkestrasi misi sisi server.
 * - Boundary eksekusi tepercaya: budget & approval DICEK DI SERVER, bukan dari renderer/klien.
 * - Misi cloud hanya menjalankan job terotorisasi; TIDAK menjalankan perintah di komputer pengguna.
 * - Pembatalan setelah side effect eksternal dapat menghasilkan `outcome_unknown` (Phase 3.1).
 */
const { id, nowISO } = require('../auth/tokens');
const queue = require('../queue/queue');
const { PolicyError } = require('../policy/scope');

/** Alokasi budget: reservasi atomik di server (minor units). */
async function reserveBudget(db, { ownerId, missionId, estimateMinor, provider, model, metadata }){
  const est = Number.isInteger(estimateMinor) && estimateMinor >= 0 ? estimateMinor : 0;
  return db.transaction(async (t) => {
    const rows = await t.query('SELECT budget_limit, budget_spent, budget_reserved, budget_currency, executions, max_executions, state FROM missions WHERE id = ? AND owner_id = ?', [missionId, ownerId]);
    if (!rows.length) throw new PolicyError('MISSION_NOT_FOUND', 'Misi tidak ditemukan.', 404);
    const m = rows[0];
    if (m.state === 'cancelled') throw new PolicyError('MISSION_CANCELLED', 'Misi dibatalkan.', 409);
    if (m.executions >= m.max_executions) throw new PolicyError('EXECUTION_LIMIT', 'Batas eksekusi misi tercapai.', 403);
    if (m.budget_limit !== null && m.budget_limit !== undefined){
      const used = Number(m.budget_spent || 0) + Number(m.budget_reserved || 0);
      if (used + est > Number(m.budget_limit)) throw new PolicyError('BUDGET_EXCEEDED', 'Anggaran misi tidak cukup.', 403);
    }
    const reservation = id('res');
    await t.query(`INSERT INTO budget_ledger (id, owner_id, mission_id, reservation, estimate_minor, status, provider, model, metadata, created_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [reservation, ownerId, missionId, reservation, est, 'reserved', provider || null, model || null, JSON.stringify(metadata || {}), nowISO()]);
    await t.query('UPDATE missions SET budget_reserved = budget_reserved + ?, executions = executions + 1, updated_at = ? WHERE id = ? AND owner_id = ?',
      [est, nowISO(), missionId, ownerId]);
    return { reservationId: reservation, estimateMinor: est };
  });
}

/** Rekonsiliasi reservasi terhadap pemakaian aktual. */
async function reconcileBudget(db, { ownerId, missionId, reservationId, actualMinor, status }){
  return db.transaction(async (t) => {
    const rows = await t.query('SELECT * FROM budget_ledger WHERE reservation = ? AND owner_id = ? AND mission_id = ?', [reservationId, ownerId, missionId]);
    if (!rows.length) throw new PolicyError('RESERVATION_NOT_FOUND', 'Reservasi tidak ditemukan.', 404);
    const rec = rows[0];
    if (rec.status === 'reconciled') return { ok: true, alreadyReconciled: true, actualMinor: rec.actual_minor };
    const actual = Number.isInteger(actualMinor) && actualMinor >= 0 ? actualMinor : rec.estimate_minor;
    const finalStatus = ['reconciled', 'failed', 'cancelled'].includes(status) ? status : 'reconciled';
    // `MAX(a,b)` dua-argumen hanya ada di SQLite; PostgreSQL memakai GREATEST.
    // CASE portabel dan tetap atomik.
    const upd = await t.exec(`UPDATE budget_ledger SET actual_minor = ?, status = ?, reconciled_at = ?
                              WHERE reservation = ? AND owner_id = ? AND mission_id = ? AND status <> ?`,
      [actual, finalStatus, nowISO(), reservationId, ownerId, missionId, 'reconciled']);
    if (!upd.changes) return { ok: true, alreadyReconciled: true, actualMinor: rec.actual_minor };
    await t.query(`UPDATE missions
                   SET budget_reserved = CASE WHEN budget_reserved > ? THEN budget_reserved - ? ELSE 0 END,
                       budget_spent = budget_spent + ?, updated_at = ?
                   WHERE id = ? AND owner_id = ?`,
      [rec.estimate_minor, rec.estimate_minor, actual, nowISO(), missionId, ownerId]);
    return { ok: true, actualMinor: actual, status: finalStatus };
  });
}

/** Validasi approval di boundary eksekusi server. */
async function assertApprovalValid(db, { ownerId, approvalId, action, resource, params, scope }){
  if (!approvalId) throw new PolicyError('APPROVAL_REQUIRED', 'Tindakan ini memerlukan approval.', 403);
  const rows = await db.query('SELECT * FROM approvals WHERE id = ? AND owner_id = ?', [approvalId, ownerId]);
  if (!rows.length) throw new PolicyError('APPROVAL_NOT_FOUND', 'Approval tidak ditemukan.', 404);
  const a = rows[0];
  if (a.status !== 'approved') throw new PolicyError('APPROVAL_NOT_APPROVED', 'Approval belum disetujui.', 403);
  if (new Date(a.expires_at) <= new Date()) throw new PolicyError('APPROVAL_EXPIRED', 'Approval kedaluwarsa.', 403);
  let storedParams = a.params;
  if (typeof storedParams === 'string'){ try { storedParams = JSON.parse(storedParams); } catch (e) { storedParams = {}; } }
  const fp = fingerprint(a.action, a.resource, storedParams, a.scope);
  const want = fingerprint(action, resource, params || {}, scope || a.scope);
  if (fp !== want) throw new PolicyError('APPROVAL_FINGERPRINT_MISMATCH', 'Parameter berbeda dari approval.', 403);
  return true;
}

function fingerprint(action, resource, params, scope){
  const payload = JSON.stringify({ action, resource, scope, params: params || {} });
  return require('crypto').createHash('sha256').update(payload).digest('hex');
}

/**
 * Enqueue pekerjaan misi. Budget dicek SEBELUM job dibuat; approval bila diperlukan.
 */
async function scheduleMissionJob(db, ctx, { missionId, kind, payload, estimateMinor, approval }) {
  const mission = await db.query('SELECT id, state, max_executions FROM missions WHERE id = ? AND owner_id = ?', [missionId, ctx.ownerId]);
  if (!mission.length) throw new PolicyError('MISSION_NOT_FOUND', 'Misi tidak ditemukan.', 404);
  if (mission[0].state === 'cancelled') throw new PolicyError('MISSION_CANCELLED', 'Misi dibatalkan.', 409);
  if (approval) await assertApprovalValid(db, Object.assign({ ownerId: ctx.ownerId }, approval));
  const resv = await reserveBudget(db, { ownerId: ctx.ownerId, missionId, estimateMinor, provider: payload && payload.provider, model: payload && payload.model });
  const job = await queue.enqueue(db, {
    ownerId: ctx.ownerId, missionId, kind, payload: Object.assign({}, payload || {}, { reservationId: resv.reservationId }),
    idempotencyKey: (payload && payload.idempotencyKey) || null, maxAttempts: payload && payload.maxAttempts
  });
  return { jobId: job.jobId, reservationId: resv.reservationId, duplicate: job.duplicate };
}

module.exports = { reserveBudget, reconcileBudget, assertApprovalValid, scheduleMissionJob, fingerprint };
