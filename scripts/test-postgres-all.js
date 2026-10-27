'use strict';
/**
 * Menjalankan SELURUH suite integrasi PostgreSQL nyata (Phase 5.1) di atas satu
 * instance PostgreSQL yang di-boot otomatis.
 *
 *   node scripts/test-postgres-all.js
 *
 * Suite yang dijalankan:
 *   1) scripts/test-phase5-postgres.js        — integrasi PostgreSQL (migrasi, auth, sync, queue, API, backup/restore)
 *   2) scripts/test-phase5-desktop-central.js — integrasi Desktop <-> Central
 *   3) scripts/test-phase5-railway.js         — kesiapan Railway/operasional
 *
 * Suite TIDAK memakai SQLite atau mock. Tanpa binari PostgreSQL → dilewati (exit 2).
 */
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const BIN = path.join(__dirname, '..', 'node_modules', '@embedded-postgres', 'windows-x64', 'native', 'bin');
const SUITES = [
  ['Integrasi PostgreSQL', 'test-phase5-postgres.js'],
  ['Desktop <-> Central', 'test-phase5-desktop-central.js'],
  ['Railway readiness', 'test-phase5-railway.js'],
  ['Phase A — multi-device', 'test-phaseA-multidevice.js'],
  ['Phase B — auth web', 'test-phaseB-webauth.js'],
  ['Phase C — desktop ↔ central', 'test-phaseC-desktop-sync.js'],
  ['Phase D — mobile ↔ central', 'test-phaseD-mobile.js']
];

(async ()=>{
  if (!fs.existsSync(path.join(BIN, 'postgres.exe'))){
    console.log('\n  ⚠ Binari PostgreSQL tidak tersedia — suite integrasi PostgreSQL DILEWATI (bukan lulus).');
    console.log('    Pasang: npm install --no-save embedded-postgres@17.10.0-beta.17');
    console.log('    Lalu jalankan ulang: node scripts/test-postgres-all.js');
    process.exit(2);
  }
  const harness = require('./pg-harness');
  const pg = await harness.start({});
  process.stdout.write('PostgreSQL ' + pg.connectionString.replace(/:[^:@/]+@/, ':***@') + '\n\n');
  let failed = 0;
  for (const [label, file] of SUITES){
    process.stdout.write('── ' + label + ' ──\n');
    const r = spawnSync(process.execPath, [path.join(__dirname, file)], {
      stdio: 'inherit',
      env: Object.assign({}, process.env, { ORION_PG_CONNECTION: pg.connectionString, DATABASE_URL: pg.connectionString })
    });
    if (r.status !== 0) failed++;
    process.stdout.write('\n');
  }
  await pg.stop();
  process.stdout.write(failed ? ('\n' + failed + ' suite gagal.') : '\nSemua suite integrasi PostgreSQL lulus.');
  process.exit(failed ? 1 : 0);
})().catch(e => { process.stderr.write('GAGAL: ' + (e && e.message) + '\n'); process.exit(1); });
