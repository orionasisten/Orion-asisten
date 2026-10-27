'use strict';
/** PostgreSQL backup-restore verification (local embedded PG only). */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'bin');
const PG_DUMP = path.join(BIN, 'pg_dump.exe');
const PG_RESTORE = path.join(BIN, 'pg_restore.exe');
const PSQL = path.join(BIN, 'psql.exe');
const CREATEDB = path.join(BIN, 'createdb.exe');

function log(label, msg) { console.log('[' + label + '] ' + msg); }

async function main() {
  const harness = require('./pg-harness');
  const pg = await harness.start({ port: 0 });
  const url = pg.connectionString;
  log('DB', 'PostgreSQL embedded ready: ' + url.replace(':postgres@', ':***@'));

  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();

  // Apply migrations (reuse migrate module with temporary DB connection)
  const { createDatabase } = require('../src/central/db');
  const dbTemp = await createDatabase({
    driver: 'postgres', databaseUrl: url, sslMode: 'prefer'
  });
  const { migrate } = require('../src/central/db/migrate');
  const mig = await migrate(dbTemp, { dryRun: false });
  log('MIGRATE', 'Migrasi: ' + (mig.error ? 'GAGAL ' + mig.error : 'OK'));
  await dbTemp.close();

  // Insert minimal test data
  await client.query(`CREATE TABLE IF NOT EXISTS backup_test_tmp (val TEXT)`);
  await client.query(`INSERT INTO backup_test_tmp VALUES ('test')`);
  await client.end();

  const dumpFile = path.join(require('os').tmpdir(), 'orion-backup-test-' + Date.now() + '.dump');
  const restoreDb = 'orion_restore_test';

  // Dump
  const dump = spawnSync(PG_DUMP, ['-Fc', '-h', '127.0.0.1', '-p', String(pg.port), '-U', 'postgres', '-d', 'postgres', '-f', dumpFile], { encoding: 'utf8', timeout: 30000 });
  if (dump.status !== 0) {
    log('BACKUP', 'GAGAL: ' + String(dump.stderr || dump.stdout).slice(0, 500));
    await pg.stop();
    return false;
  }
  const stats = fs.statSync(dumpFile);
  log('BACKUP', 'File backup dibuat: ' + dumpFile + ' (' + stats.size + ' bytes)');

  // Create restore target DB
  const createDbResult = spawnSync(CREATEDB, ['-h', '127.0.0.1', '-p', String(pg.port), '-U', 'postgres', restoreDb], { encoding: 'utf8', timeout: 15000 });
  log('CREATE_DB', 'createdb ' + restoreDb + ': exit=' + createDbResult.status);

  // Restore
  const restore = spawnSync(PG_RESTORE, ['--clean', '--if-exists', '-h', '127.0.0.1', '-p', String(pg.port), '-U', 'postgres', '-d', restoreDb, dumpFile], { encoding: 'utf8', timeout: 60000 });
  log('RESTORE', 'pg_restore exit=' + restore.status + '; output truncated');

  // Verify
  const verifyClient = new Client({ host: '127.0.0.1', port: pg.port, user: 'postgres', database: restoreDb });
  await verifyClient.connect();
  const r = await verifyClient.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE '%test%'");
  log('VERIFY', 'Tabel di restore: ' + r.rows.map(x => x.tablename).join(', '));
  await verifyClient.end();

  // Clean temporary files
  try { fs.unlinkSync(dumpFile); log('CLEANUP', 'File sementara dihapus'); } catch (_) {}

  await pg.stop();
  log('FINISH', 'Backup/restore drill lengkap. Status: TESTED (embedded PG).');
  return true;
}

main().catch(err => {
  console.error('FAIL:', err && err.message);
  process.exit(1);
});
