'use strict';
/**
 * Factory database Orion Central.
 * - Driver 'sqlite'  : node:sqlite (dev lokal & tes integrasi — SQL & transaksi nyata).
 * - Driver 'postgres': `pg` (produksi / Railway) — perlu DATABASE_URL.
 * Desktop TIDAK pernah memakai modul ini (hanya proses server Central).
 */
const path = require('path');

function createDatabase(cfg){
  const driver = (cfg && cfg.driver) || 'sqlite';
  if (driver === 'postgres'){
    const { PgDriver } = require('./pg-driver');
    return new PgDriver({ connectionString: cfg.databaseUrl, sslMode: cfg.pgSsl, max: cfg.pgPoolMax });
  }
  if (driver === 'sqlite'){
    const { SqliteDriver } = require('./sqlite-driver');
    const file = cfg.dbFile && cfg.dbFile !== ':memory:' ? path.resolve(cfg.dbFile) : ':memory:';
    return new SqliteDriver({ file });
  }
  throw new Error('DB_DRIVER_TIDAK_DIDUKUNG: ' + driver);
}

module.exports = { createDatabase };
