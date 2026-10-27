'use strict';
/**
 * Shared rate-limit store interface.
 * - InMemoryRateLimiter (current behavior, safe for single-instance/dev).
 * - PgRateLimiter (multi-instance, uses the DB with transaction isolation).
 */

function InMemoryRateLimiter(perMinute) {
  const hits = new Map();
  return {
    check(key) {
      const now = Date.now();
      const win = 60000;
      const cur = hits.get(key) || [];
      const kept = cur.filter(t => now - t < win);
      if (kept.length >= perMinute) {
        hits.set(key, kept);
        const e = new Error('RATE_LIMITED');
        e.code = 'RATE_LIMITED';
        e.status = 429;
        throw e;
      }
      kept.push(now);
      hits.set(key, kept);
      if (hits.size > 5000) hits.clear();
    },
    type: 'memory',
  };
}

function PgRateLimiter(perMinute, db, opts = {}) {
  // opts: { cleanupIntervalMs: 60000 }
  const winMs = 60000;
  const tableName = 'rate_limit_hits';
  return {
    async check(key) {
      const nowMs = Date.now();
      try {
        await db.query('BEGIN');
        // Lock row for update (or insert will create it)
        const row = await db.query(
          `SELECT hits, window_start FROM ${tableName} WHERE key = ? FOR UPDATE`,
          [key]
        );
        if (row && row.length > 0) {
          let hits = row[0].hits || 0;
          let ws = Number(row[0].window_start) || 0;
          if (nowMs - ws > winMs) {
            hits = 1;
            ws = nowMs;
          } else {
            hits += 1;
          }
          if (hits > perMinute) {
            await db.query('UPDATE ' + tableName + ' SET hits = ?, window_start = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?', [hits, ws, key]);
            await db.query('COMMIT');
            const e = new Error('RATE_LIMITED');
            e.code = 'RATE_LIMITED';
            e.status = 429;
            throw e;
          }
          await db.query('UPDATE ' + tableName + ' SET hits = ?, window_start = ?, updated_at = CURRENT_TIMESTAMP WHERE key = ?', [hits, ws, key]);
          await db.query('COMMIT');
        } else {
          await db.query('INSERT INTO ' + tableName + ' (key, hits, window_start, updated_at) VALUES (?, 1, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET hits = EXCLUDED.hits, window_start = EXCLUDED.window_start, updated_at = CURRENT_TIMESTAMP', [key, nowMs]);
          await db.query('COMMIT');
        }
      } catch (err) {
        try { await db.query('ROLLBACK'); } catch (_) { /* ignore */ }
        throw err;
      }
    },
    type: 'postgres',
  };
}

module.exports = { InMemoryRateLimiter, PgRateLimiter };
