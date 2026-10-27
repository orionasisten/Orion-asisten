'use strict';
/**
 * Probe audit Phase E pada PostgreSQL NYATA (embedded PG 17).
 * Dijalankan lewat: node scripts/pg-harness.js --run scripts/audit-phaseE-pg-probe.js
 */
const http = require('http');
const { start } = require('../src/central/server');
const orchestrator = require('../src/central/mission/orchestrator');

function req(port, method, path, body, headers){
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const h = Object.assign({}, headers || {});
    if (payload){ h['Content-Type'] = 'application/json'; h['Content-Length'] = payload.length; }
    const r = http.request({ host:'127.0.0.1', port, path, method, headers:h }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const bearer = t => ({ Authorization: 'Bearer ' + t });
function report(name, verdict, detail){ console.log(JSON.stringify({ probe: name, verdict, detail })); }

(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL tidak ada — jalankan via pg-harness');
  const s = await start({
    CENTRAL_PORT: '0', CENTRAL_HOST: '127.0.0.1', CENTRAL_DB_DRIVER: 'postgres',
    DATABASE_URL: process.env.DATABASE_URL, CENTRAL_SETUP_KEY: 'phase-e-audit-setup-key',
    CENTRAL_RATE_LIMIT_PER_MIN: '5000'
  });
  const port = s.server.address().port;
  const db = s.db;
  try {
    const boot = await req(port, 'POST', '/v1/auth/bootstrap', { email: 'pg-audit@orion.test', password: 'OwnerPassw0rd!' }, { 'X-Setup-Key': 'phase-e-audit-setup-key' });
    const tok = boot.body.token;
    const ownerId = boot.body.ownerId;

    // ── A. Approval: keputusan ganda paralel ──
    {
      await db.query(`INSERT INTO approvals (id, owner_id, action, resource, params, scope, fingerprint, status, created_at, expires_at)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['ap-pg-race', ownerId, 'publish', 'res://x', JSON.stringify({ v: 1 }), 'mission', 'fp-pg-race', 'pending',
         new Date().toISOString(), new Date(Date.now() + 600000).toISOString()]);
      const requests = [];
      for (let i = 0; i < 8; i++){
        requests.push(req(port, 'POST', '/v1/approvals/ap-pg-race/decision', { decision: i % 2 === 0 ? 'approved' : 'rejected' }, bearer(tok)));
      }
      const out = await Promise.all(requests);
      const statuses = out.map(r => r.status);
      const okCount = statuses.filter(x => x === 200).length;
      const row = (await db.query('SELECT status, decision FROM approvals WHERE id = ?', ['ap-pg-race']))[0];
      report('approval-keputusan-ganda-paralel', okCount > 1 ? 'FINDING' : 'PASS',
        { httpStatus: statuses, jumlah200: okCount, final: row });
    }

    // ── B. reconcileBudget di PostgreSQL (MAX(0,x)) ──
    {
      const m = await req(port, 'POST', '/v1/missions', { title: 'PG Budget', budgetLimit: 1000 }, bearer(tok));
      const missionId = m.body.missionId;
      const resv = await orchestrator.reserveBudget(db, { ownerId, missionId, estimateMinor: 100 });
      let err = null;
      try {
        await orchestrator.reconcileBudget(db, { ownerId, missionId, reservationId: resv.reservationId, actualMinor: 50, status: 'reconciled' });
      } catch (e) { err = String(e.message || e); }
      report('reconcile-budget-postgres', err ? 'FINDING' : 'PASS', { error: err && err.slice(0, 200) });
    }

    // ── C. Worker misi di Central ──
    {
      const m = await req(port, 'POST', '/v1/missions', { title: 'PG Worker' }, bearer(tok));
      const before = (await db.query('SELECT state FROM missions WHERE id = ?', [m.body.missionId]))[0];
      const jobs = await db.query('SELECT count(*)::int AS c FROM jobs WHERE owner_id = ?', [ownerId]);
      report('misi-tanpa-worker-di-central', (before.state === 'queued' && Number(jobs[0].c) === 0) ? 'INFO' : 'PASS',
        { stateSetelahDibuat: before.state, jumlahJob: jobs[0].c, catatan: 'tidak ada proses worker di src/central; misi tidak pernah dieksekusi' });
    }

    // ── D. Migrasi: jumlah & checksum ──
    {
      const migs = await db.query('SELECT version FROM schema_migrations ORDER BY version');
      report('migrasi-terpasang', 'INFO', { jumlah: migs.length, versions: migs.map(r => r.version) });
    }
  } finally {
    try { s.server.close(); } catch (e) { /* ignore */ }
    try { await db.close(); } catch (e) { /* ignore */ }
  }
})().catch(e => { console.error('PG_PROBE_ERROR', e && e.stack || e); process.exit(2); });
