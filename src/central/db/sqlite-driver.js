'use strict';
/**
 * Driver SQLite (node:sqlite, bawaan Node 24) — dipakai untuk dev lokal & tes integrasi.
 * Menjalankan SQL NYATA, transaksi NYATA, unique constraint NYATA (bukan mock).
 * Skema SQL sama dengan PostgreSQL (lihat src/central/db/migrations).
 */
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');
const { toSqlitePlaceholders } = require('./sql');

class SqliteDriver {
  constructor(opts){
    opts = opts || {};
    this.file = opts.file || ':memory:';
    if (this.file !== ':memory:'){
      const dir = path.dirname(path.resolve(this.file));
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(this.file);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec('PRAGMA foreign_keys = ON');
    this.kind = 'sqlite';
    this._txDepth = 0;
  }
  _prep(sql){ return this.db.prepare(toSqlitePlaceholders(sql)); }
  query(sql, params){
    const stmt = this._prep(sql);
    const rows = stmt.all(...(params || []));
    return rows.map(r => ({ ...r }));
  }
  get(sql, params){
    const stmt = this._prep(sql);
    const row = stmt.get(...(params || []));
    return row ? { ...row } : null;
  }
  exec(sql, params){
    const stmt = this._prep(sql);
    const res = stmt.run(...(params || []));
    return { changes: Number(res.changes || 0) };
  }
  /** Multi-statement script (dipakai migrasi DDL). node:sqlite exec() mendukung banyak statement. */
  execScript(sql){ this.db.exec(toSqlitePlaceholders(sql)); return { changes: 0 }; }
  /** Transaksi nyata; nested dipetakan ke savepoint. */
  async transaction(fn){
    if (this._txDepth === 0){
      this.db.exec('BEGIN IMMEDIATE');
      this._txDepth++;
      try {
        const out = await fn(this);
        this.db.exec('COMMIT');
        this._txDepth--;
        return out;
      } catch (e) {
        try { this.db.exec('ROLLBACK'); } catch (x) { /* ignore */ }
        this._txDepth--;
        throw e;
      }
    }
    const sp = 'sp_' + Math.random().toString(36).slice(2, 10);
    this.db.exec('SAVEPOINT ' + sp);
    try {
      const out = await fn(this);
      this.db.exec('RELEASE ' + sp);
      return out;
    } catch (e) {
      try { this.db.exec('ROLLBACK TO ' + sp); this.db.exec('RELEASE ' + sp); } catch (x) { /* ignore */ }
      throw e;
    }
  }
  close(){ try { this.db.close(); } catch (e) { /* ignore */ } }
}

module.exports = { SqliteDriver };
