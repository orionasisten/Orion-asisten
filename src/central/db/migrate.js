'use strict';
/**
 * Runner migrasi terversi.
 * - Migrasi dibaca dari folder migrations/ dan dijalankan BERURUTAN.
 * - Checksum SHA-256 tiap berkas disimpan; perubahan pada migrasi yang sudah diterapkan
 *  Dideteksi (tampering) dan DITOLAK (tidak diam-diam damaged).
 * - Idempoten: migrasi yang sudah tercatat dilewati.
 * - Semua migrasi dijalankan dalam transaksi (dibungkus per-migrasi).
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIG_DIR = path.join(__dirname, 'migrations');

function listMigrations(dir){
  dir = dir || MIG_DIR;
  return fs.readdirSync(dir)
    .filter(f => /^\d+_[a-z0-9_]+\.sql$/i.test(f))
    .sort()
    .map(f => {
      const content = fs.readFileSync(path.join(dir, f), 'utf8');
      // Directive dialect: "-- only: postgres" / "-- only: sqlite" (baris pertama)
      const m = content.match(/^\s*--\s*only:\s*(postgres|sqlite)\s*$/im);
      return {
        version: f.replace(/\.sql$/i, ''),
        file: f,
        sql: content,
        only: m ? m[1].toLowerCase() : null,
        checksum: crypto.createHash('sha256').update(content).digest('hex')
      };
    });
}

async function ensureMigrationTable(db){
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TEXT NOT NULL)`);
}

/**
 * Jalankan migrasi. Return { applied:[], skipped:[], error }.
 * error = { version, message } bila ada migrasi yang gagal atau checksum berubah.
 *
 * Koordinasi multi-instance: pada PostgreSQL, migrasi dijalankan di bawah advisory lock
 * global sehingga beberapa instance (mis. Railway scaling) tidak menjalankan DDL bersamaan.
 */
async function migrate(db, opts){
  opts = opts || {};
  const dialect = opts.dialect || db.kind || 'sqlite';
  const run = async () => {
    await ensureMigrationTable(db);
    const applied = await db.query('SELECT version, checksum FROM schema_migrations ORDER BY version');
    const appliedMap = new Map(applied.map(r => [r.version, r.checksum]));
    const result = { applied: [], skipped: [], error: null, dryRun: !!opts.dryRun, dialect };
    for (const mig of listMigrations(opts.dir)){
      // Directive dialect: migrasi hanya dijalankan pada engine yang dituju.
      if (mig.only && mig.only !== dialect){
        result.skipped.push(mig.version + ' (dialect:' + mig.only + ')');
        continue;
      }
      if (appliedMap.has(mig.version)){
        if (appliedMap.get(mig.version) !== mig.checksum){
          result.error = { version: mig.version, message: 'CHECKSUM_MISMATCH: berkas migrasi berubah setelah diterapkan' };
          return result;
        }
        result.skipped.push(mig.version);
        continue;
      }
      if (opts.dryRun){
        result.applied.push(mig.version);
        continue;
      }
      try {
        await db.transaction(async (t) => {
          await t.execScript(mig.sql);
          await t.exec('INSERT INTO schema_migrations (version, checksum, applied_at) VALUES (?, ?, ?)',
            [mig.version, mig.checksum, new Date().toISOString()]);
        });
        result.applied.push(mig.version);
      } catch (e) {
        result.error = { version: mig.version, message: String((e && e.message) || e) };
        return result;
      }
    }
    return result;
  };
  if (dialect === 'postgres' && !opts.dryRun && typeof db.withAdvisoryLock === 'function'){
    return db.withAdvisoryLock(run);
  }
  return run();
}

function migrationStatus(db){
  return db.query('SELECT version, checksum, applied_at FROM schema_migrations ORDER BY version');
}

module.exports = { migrate, listMigrations, migrationStatus, ensureMigrationTable, MIG_DIR };
