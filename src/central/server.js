'use strict';
/**
 * Bootstrap server Orion Central (node:http).
 * Jalankan: node src/central/server.js
 * Semua konfigurasi dari environment; secret tidak pernah dicetak.
 */
const http = require('http');
const { readConfig, validateConfig, redactConfig } = require('./config');
const { createDatabase } = require('./db');
const { migrate } = require('./db/migrate');
const { createApp } = require('./app');

async function start(env){
  env = env || process.env;
  const cfg = readConfig(env);
  const check = validateConfig(cfg);
  if (!check.ok){
    const err = new Error('KONFIGURASI_INVALID: ' + check.problems.join('; '));
    err.problems = check.problems;
    throw err;
  }
  let db = null;
  try {
    db = createDatabase(cfg);
  } catch (e) {
    // Kegagalan koneksi DB tidak boleh menyebabkan retry loop tak terbatas: keluar dengan pesan jelas.
    throw new Error('KONEKSI_DATABASE_GAGAL: ' + String((e && e.message) || e));
  }
  let mig;
  try {
    mig = await migrate(db, { dryRun: false });
  } catch (e) {
    try { await db.close(); } catch (x) { /* ignore */ }
    throw new Error('MIGRASI_GAGAL: ' + String((e && e.message) || e));
  }
  if (mig.error){
    try { await db.close(); } catch (x) { /* ignore */ }
    throw new Error('MIGRASI_GAGAL ' + mig.error.version + ': ' + mig.error.message);
  }
  const setupKey = env.CENTRAL_SETUP_KEY || '';
  const app = createApp({ db, config: cfg, setupKey, version: '1.0.0', provider: cfg.provider, setupPassword: cfg.setupPassword });
  const server = http.createServer((req, res) => {
    app.handle(req, res).catch(() => {
      try { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { code: 'INTERNAL_ERROR' } })); } catch (e) { /* ignore */ }
    });
  });
  server.headersTimeout = 20000;
  server.requestTimeout = 60000;
  server.keepAliveTimeout = 15000;
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(cfg.port, cfg.host, resolve);
  });
  // Shutdown rapi: stop menerima request → tunggu request aktif → tutup pool DB.
  const shutdown = async () => {
    try { server.close(); } catch (e) { /* ignore */ }
    try { await db.close(); } catch (e) { /* ignore */ }
    process.exit(0);
  };
  return { server, db, config: cfg, migrations: mig, shutdown };
}

if (require.main === module){
  start().then(({ server, config, shutdown }) => {
    process.stdout.write('Orion Central listen di http://' + config.host + ':' + config.port + ' (driver=' + config.driver + ')\n');
    process.stdout.write('Konfigurasi: ' + JSON.stringify(redactConfig(config)) + '\n');
    process.on('SIGINT', () => { shutdown(); });
    process.on('SIGTERM', () => { shutdown(); });
  }).catch(e => {
    process.stderr.write('Gagal start: ' + (e && e.message) + '\n');
    if (e && e.problems) process.stderr.write('Detail: ' + e.problems.join('; ') + '\n');
    process.exit(1);
  });
}

module.exports = { start };
