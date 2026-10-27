'use strict';
/**
 * Driver PostgreSQL (`pg`) — dipakai untuk deployment Railway/Orion Central produksi.
 * Sengaja TIDAK di-require pada proses desktop: modul ini hanya dimuat bila
 * CENTRAL_DB_DRIVER=postgres. Bila `pg` tidak terpasang, error jelas (bukan crash misterius).
 */
const { toPgPlaceholders } = require('./sql');

// Kunci advisory global untuk migrasi (PostgreSQL). Nilai tetap & stabil antar instance.
const MIGRATION_LOCK_KEY = 8421377;

class PgDriver {
  constructor(opts){
    opts = opts || {};
    let pg;
    try { pg = require('pg'); } catch (e) {
      throw new Error('Driver postgres membutuhkan paket "pg". Jalankan: npm install pg');
    }
    this.kind = 'postgres';
    // TLS: TIDAK dipaksa. `pg` membaca `sslmode=` dari connection string
    // (require/verify-full/prefer/disable). Memaksa SSL membuat server PostgreSQL
    // lokal (tanpa SSL) tidak dapat diakses, dan `require` tanpa CA memverifikasi sia-sia.
    // Verifikasi sertifikat yang sesungguhnya = sslmode=verify-full (atau explicit below).
    const mode = String(opts.sslMode || '').trim().toLowerCase();
    let ssl;
    if (mode === 'disable') ssl = false;
    else if (mode === 'verify-full') ssl = { rejectUnauthorized: true };
    else if (mode === 'require') ssl = { rejectUnauthorized: false };
    else ssl = undefined; // ikuti connection string
    this.sslMode = mode || '(dari connection string)';
    this.pool = new pg.Pool({
      connectionString: opts.connectionString,
      max: opts.max || 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: opts.connectionTimeoutMs || 10000,
      ssl
    });
    this.pool.on('error', () => { /* pool error tidak boleh menjatuhkan proses */ });
  }
  query(sql, params){
    return this.pool.query(toPgPlaceholders(sql), params || []).then(r => r.rows.map(x => ({ ...x })));
  }
  get(sql, params){
    return this.query(sql, params).then(rows => rows.length ? rows[0] : null);
  }
  exec(sql, params){
    return this.pool.query(toPgPlaceholders(sql), params || []).then(r => ({ changes: r.rowCount || 0 }));
  }
  /** Multi-statement script (dipakai migrasi DDL). */
  execScript(sql){
    return this.pool.query(sql).then(r => ({ changes: r.rowCount || 0 }));
  }
  async transaction(fn){
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const wrapped = {
        kind: 'postgres',
        query: (sql, params) => client.query(toPgPlaceholders(sql), params || []).then(r => r.rows.map(x => ({ ...x }))),
        get: (sql, params) => client.query(toPgPlaceholders(sql), params || []).then(r => r.rows.length ? r.rows[0] : null),
        exec: (sql, params) => client.query(toPgPlaceholders(sql), params || []).then(r => ({ changes: r.rowCount || 0 })),
        execScript: (sql) => client.query(sql).then(r => ({ changes: r.rowCount || 0 })),
        transaction: async (f) => { /* nested → savepoint */ }
      };
      const out = await fn(wrapped);
      await client.query('COMMIT');
      return out;
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (x) { /* ignore */ }
      throw e;
    } finally {
      client.release();
    }
  }
  /** Advisory lock (PostgreSQL) — mencegah banyak instance menjalankan migrasi bersamaan. */
  async withAdvisoryLock(fn){
    const client = await this.pool.connect();
    let locked = false;
    try {
      await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
      locked = true;
      return await fn();
    } finally {
      try { if (locked) await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]); } catch (e) { /* ignore */ }
      client.release();
    }
  }
  async close(){ await this.pool.end(); }
}

module.exports = { PgDriver };
