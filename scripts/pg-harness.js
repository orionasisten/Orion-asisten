'use strict';
/**
 * Harness PostgreSQL nyata untuk tes integrasi Phase 5.1.
 * Menjalankan server PostgreSQL asli (binari @embedded-postgres/windows-x64) di cluster
 * sementara, lalu mengembalikan connection string. TIDAK memakai SQLite atau mock.
 *
 * Pemakaian:
 *   node scripts/pg-harness.js            -> start server, print DATABASE_URL, stay hidup
 *   node scripts/pg-harness.js --run <file> -> start, jalankan file test, stop, exit dengan kode test
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');

const BIN = path.join(__dirname, '..', 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'bin');
const INITDB = path.join(BIN, 'initdb.exe');
const PG_CTL = path.join(BIN, 'pg_ctl.exe');

function freePort(){
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

async function waitReady(port, timeoutMs){
  const deadline = Date.now() + (timeoutMs || 60000);
  const { Client } = require('pg');
  while (Date.now() < deadline){
    const c = new Client({ host:'127.0.0.1', port, user:'postgres', database:'postgres', connectionTimeoutMillis: 3000 });
    try { await c.connect(); await c.query('SELECT version()'); await c.end(); return true; }
    catch (e){ try { await c.end(); } catch (x){} await sleep(400); }
  }
  return false;
}

async function start(opts){
  opts = opts || {};
  if (!fs.existsSync(INITDB)) throw new Error('BINARI_POSTGRESQL_TIDAK_ADA: ' + INITDB);
  const dir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'orion-pg-'));
  const port = opts.port || (await freePort());
  // initdb (password-less trust untuk lokal test terisolasi)
  const init = spawnSync(INITDB, ['-D', dir, '-U', 'postgres', '-A', 'trust', '-E', 'UTF8', '--no-sync'], {
    encoding: 'utf8', timeout: 120000
  });
  if (init.status !== 0){
    throw new Error('INITDB_GAGAL: ' + String(init.stderr || init.stdout || '').slice(0, 800));
  }
  // start server
  const logFile = path.join(dir, 'server.log');
  const proc = spawn(path.join(BIN, 'postgres.exe'), ['-D', dir, '-p', String(port), '-h', '127.0.0.1', '-k', ''], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let log = '';
  proc.stdout.on('data', d => { log += d; });
  proc.stderr.on('data', d => { log += d; });
  proc.on('error', e => { log += 'spawn error: ' + e.message; });
  const ready = await waitReady(port, opts.timeoutMs || 60000);
  if (!ready){
    try { proc.kill(); } catch (e){}
    throw new Error('POSTGRESQL_TIDAK_SIAP\n' + log.slice(-1500));
  }
  return {
    port, dir, proc, logFile,
    connectionString: 'postgresql://postgres@127.0.0.1:' + port + '/postgres',
    logs(){ return log; },
    async stop(){
      try { await new Promise(resolve => {
        const c = spawn(PG_CTL, ['-D', dir, '-m', 'fast', 'stop'], { encoding:'utf8' });
        c.on('exit', code => resolve(code));
        c.on('error', () => resolve(1));
      }); } catch (e){ /* ignore */ }
      try { proc.kill(); } catch (e){}
    }
  };
}

module.exports = { start, sleep, BIN, INITDB, PG_CTL };

if (require.main === module){
  (async () => {
    const args = process.argv.slice(2);
    if (args[0] === '--run' && args[1]){
      const pg = await start({});
      process.stdout.write('PostgreSQL 17.10 aktif di ' + pg.connectionString + '\n');
      const r = spawnSync(process.execPath, [args[1]], {
        stdio: 'inherit',
        env: Object.assign({}, process.env, { ORION_PG_CONNECTION: pg.connectionString, DATABASE_URL: pg.connectionString })
      });
      await pg.stop();
      process.exit(r.status === null ? 1 : r.status);
    }
    if (args[0] === '--run-electron' && args[1]){
      // Menjalankan skrip di dalam Electron (browser Chromium milik Electron) — untuk E2E Web App.
      const pg = await start({});
      process.stdout.write('PostgreSQL 17.10 aktif di ' + pg.connectionString + '\n');
      const electronBin = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe');
      const r = spawnSync(electronBin, [args[1]], {
        stdio: 'inherit',
        env: Object.assign({}, process.env, {
          ORION_PG_CONNECTION: pg.connectionString,
          DATABASE_URL: pg.connectionString,
          ELECTRON_DISABLE_SECURITY_WARNINGS: '1'
        })
      });
      await pg.stop();
      process.exit(r.status === null ? 1 : r.status);
    }
    const pg = await start({});
    process.stdout.write(pg.connectionString + '\n');
    process.on('SIGINT', async () => { await pg.stop(); process.exit(0); });
  })().catch(e => { process.stderr.write('GAGAL: ' + (e && e.message) + '\n'); process.exit(1); });
}
