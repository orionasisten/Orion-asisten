'use strict';
/**
 * Durable queue berbasis database (tanpa Redis).
 * - Claim ATOMIK: satu UPDATE yang mengambil job terkualifikasi dan menandainya running.
 * - Lease: worker harus heartbeat sebelum lease_expires_at; job yang mati dipulihkan.
 * - Retry terbatas + backoff eksponensial; melewati max_attempts → dead_letter.
 * - Idempotency key mencegah job ganda.
 * - Job dengan side-effect eksternal yang hasilnya tidak diketahui TIDAK di-retry otomatis
 *   (harus outcome_unknown → rekonsiliasi manual).
 */
const { id, nowISO } = require('../auth/tokens');

const STATES = ['queued', 'running', 'succeeded', 'failed', 'dead_letter', 'cancelled'];

/** Backoff eksponensial dengan jitter deterministik-friendly. */
function backoffMs(attempt, baseMs){
  const base = baseMs || 1000;
  const exp = Math.min(base * Math.pow(2, Math.max(0, attempt - 1)), 5 * 60 * 1000);
  const jitter = (attempt * 7919) % 1000; // jitter deterministik (testable)
  return exp + jitter;
}

async function enqueue(db, { ownerId, missionId, kind, payload, idempotencyKey, maxAttempts, priority, availableAt }){
  if (idempotencyKey){
    const existing = await db.query('SELECT id, state FROM jobs WHERE owner_id = ? AND idempotency_key = ?', [ownerId, idempotencyKey]);
    if (existing.length) return { jobId: existing[0].id, duplicate: true, state: existing[0].state };
  }
  const jobId = id('job');
  const now = nowISO();
  await db.query(`INSERT INTO jobs (id, owner_id, mission_id, kind, payload, state, priority, attempts, max_attempts, idempotency_key, available_at, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [jobId, ownerId, missionId || null, kind, JSON.stringify(payload || {}), 'queued',
     Number.isFinite(priority) ? priority : 100, 0, Number.isFinite(maxAttempts) ? maxAttempts : 5,
     idempotencyKey || null, availableAt || now, now, now]);
  return { jobId, duplicate: false, state: 'queued' };
}

/**
 * Claim satu job secara atomik. Hanya worker dengan owner/mission yang sesuai.
 *
 * PostgreSQL: subquery memakai `FOR UPDATE SKIP LOCKED` — tanpa itu, beberapa worker
 * konkuren bisa memilih baris yang sama (snapshot identik) lalu saling berebut, dan
 * job tertentu "terkunci" tanpa pernah diklaim (starvasi) — dibuktikan tes integrasi PG.
 * SQLite: transaksi BENAR-BENAR diserialisasi oleh `BEGIN IMMEDIATE`, jadi subquery biasa cukup.
 */
async function claim(db, { workerId, ownerId, leaseMs }){
  const lease = leaseMs || 30000;
  const now = nowISO();
  const leaseUntil = new Date(Date.now() + lease).toISOString();
  // 1) pulihkan job yang lease-nya kedaluwarsa (worker mati)
  await recoverExpired(db, { ownerId });
  // 2) claim atomik: UPDATE ... WHERE id = (SELECT ...) AND state='queued'
  const ownerClause = ownerId ? ' AND owner_id = ?' : '';
  const isPg = db.kind === 'postgres';
  const lockClause = isPg ? ' FOR UPDATE SKIP LOCKED' : '';
  const sql = `UPDATE jobs SET state = 'running', worker_id = ?, lease_expires_at = ?, heartbeat_at = ?, attempts = attempts + 1, updated_at = ?
               WHERE id = (
                 SELECT id FROM jobs
                 WHERE state = 'queued' AND available_at <= ?${ownerClause}
                 ORDER BY priority ASC, available_at ASC, created_at ASC${lockClause}
                 LIMIT 1
               ) AND state = 'queued'
               RETURNING *`;
  const rows = await db.query(sql, [workerId, leaseUntil, now, now, now, ...(ownerId ? [ownerId] : [])]);
  if (!rows.length) return null;
  const job = rows[0];
  await db.query('INSERT INTO job_attempts (id, job_id, owner_id, attempt, worker_id, outcome, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id('jat'), job.id, job.owner_id, job.attempts, workerId, 'running', now]);
  return job;
}

/** Heartbeat memperpanjang lease. */
async function heartbeat(db, jobId, workerId, leaseMs){
  const now = nowISO();
  const until = new Date(Date.now() + (leaseMs || 30000)).toISOString();
  const rows = await db.query('UPDATE jobs SET lease_expires_at = ?, heartbeat_at = ?, updated_at = ? WHERE id = ? AND worker_id = ? AND state = ? RETURNING id',
    [until, now, now, jobId, workerId, 'running']);
  return rows.length > 0;
}

/** Selesaikan job sukses. */
async function complete(db, jobId, workerId, result){
  const now = nowISO();
  const rows = await db.query(`UPDATE jobs SET state = 'succeeded', result = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ?
                               WHERE id = ? AND worker_id = ? AND state = 'running' RETURNING id`,
    [JSON.stringify(result === undefined ? null : result), now, jobId, workerId]);
  if (rows.length){
    const last = await db.query('SELECT id FROM job_attempts WHERE job_id = ? AND outcome = ? ORDER BY attempt DESC LIMIT 1', [jobId, 'running']);
    if (last.length) await db.query('UPDATE job_attempts SET outcome = ?, finished_at = ? WHERE id = ?', ['succeeded', now, last[0].id]);
  }
  return rows.length > 0;
}

/**
 * Gagalkan job. Retry terbatas dengan backoff; melewati batas → dead_letter.
 * `uncertain` = hasil side effect tidak diketahui → TIDAK auto-retry (harus rekonsiliasi).
 */
async function fail(db, jobId, workerId, error, opts){
  opts = opts || {};
  const now = nowISO();
  const rows = await db.query('SELECT * FROM jobs WHERE id = ?', [jobId]);
  if (!rows.length) return { ok: false, reason: 'JOB_NOT_FOUND' };
  const job = rows[0];
  const lastAttempt = await db.query('SELECT id FROM job_attempts WHERE job_id = ? AND outcome = ? ORDER BY attempt DESC LIMIT 1', [jobId, 'running']);
  if (lastAttempt.length){
    await db.query('UPDATE job_attempts SET outcome = ?, error = ?, finished_at = ? WHERE id = ?',
      [opts.uncertain ? 'uncertain' : 'failed', String(error || '').slice(0, 500), now, lastAttempt[0].id]);
  }
  if (opts.uncertain){
    // hasil tidak diketahui → dead_letter manual, TIDAK di-retry otomatis
    await db.query('UPDATE jobs SET state = ?, last_error = ?, dead_letter = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?',
      ['dead_letter', String(error || 'uncertain outcome').slice(0, 500), JSON.stringify({ reason: 'outcome_unknown', at: now }), now, jobId]);
    return { ok: true, state: 'dead_letter', reason: 'OUTCOME_UNKNOWN' };
  }
  if (job.attempts >= job.max_attempts){
    await db.query('UPDATE jobs SET state = ?, last_error = ?, dead_letter = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?',
      ['dead_letter', String(error || '').slice(0, 500), JSON.stringify({ reason: 'max_attempts_exceeded', at: now }), now, jobId]);
    return { ok: true, state: 'dead_letter', reason: 'MAX_ATTEMPTS' };
  }
  const nextAt = new Date(Date.now() + backoffMs(job.attempts)).toISOString();
  await db.query('UPDATE jobs SET state = ?, last_error = ?, available_at = ?, worker_id = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?',
    ['queued', String(error || '').slice(0, 500), nextAt, now, jobId]);
  return { ok: true, state: 'queued', nextAttemptAt: nextAt };
}

/** Pulihkan job yang lease-nya kedaluwarsa (worker mati). */
async function recoverExpired(db, opts){
  opts = opts || {};
  const now = nowISO();
  const ownerClause = opts.ownerId ? ' AND owner_id = ?' : '';
  const rows = await db.query(`UPDATE jobs SET state = 'queued', worker_id = NULL, lease_expires_at = NULL, last_error = ?, updated_at = ?
                               WHERE state = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at < ?${ownerClause}
                               RETURNING id, attempts, max_attempts`,
    ['lease expired (worker berhenti)', now, now, ...(opts.ownerId ? [opts.ownerId] : [])]);
  return rows;
}

async function getJob(db, jobId, ownerId){
  const rows = await db.query('SELECT * FROM jobs WHERE id = ? AND owner_id = ?', [jobId, ownerId]);
  return rows.length ? rows[0] : null;
}

module.exports = { enqueue, claim, heartbeat, complete, fail, recoverExpired, getJob, backoffMs, STATES };
