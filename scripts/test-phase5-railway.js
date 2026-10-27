'use strict';
/**
 * Tes kesiapan Railway / operasional (Phase 5.1).
 * partly butuh PostgreSQL nyata (advisory lock migrasi); partly murni (config, readiness, shutdown).
 */
const assert = require('assert');
const http = require('http');
const path = require('path');

const CONN = process.env.ORION_PG_CONNECTION || process.env.DATABASE_URL || '';
const { readConfig, validateConfig, redactConfig } = require('../src/central/config');
const { createDatabase } = require('../src/central/db');
const { migrate } = require('../src/central/db/migrate');
const { createApp } = require('../src/central/app');
const { start } = require('../src/central/server');

let passed = 0, failed = 0;
const tests = [];
function t(name, fn){ tests.push({ name, fn }); }
function req(port, method, p, body, headers){
  return new Promise((resolve, reject)=>{
    const data = body===undefined?null:Buffer.from(JSON.stringify(body),'utf8');
    const h = Object.assign({ 'Content-Type':'application/json' }, headers||{});
    if(data) h['Content-Length']=data.length;
    const r = http.request({ hostname:'127.0.0.1', port, path:p, method, headers:h }, res=>{
      const c=[]; res.on('data',x=>c.push(x)); res.on('end',()=>{
        const txt=Buffer.concat(c).toString('utf8'); let j=null;
        try{ j=txt?JSON.parse(txt):null; }catch(e){}
        resolve({ status:res.statusCode, body:j, raw:txt });
      });
    });
    r.on('error', reject);
    if(data) r.write(data);
    r.end();
  });
}

// ── C1: port & binding mengikuti platform ──
t('CENTRAL_PORT dipakai bila diset; PORT platform dipakai bila tidak', ()=>{
  const a = readConfig({ CENTRAL_PORT:'9000' });
  assert.strictEqual(a.port, 9000);
  const b = readConfig({});                       // tanpa CENTRAL_PORT
  assert.strictEqual(b.port, 8787);               // default
  const c = readConfig({ PORT:'4321' });           // Railway menyediakan PORT
  assert.strictEqual(c.port, 4321, 'PORT platform harus dipakai');
  assert.strictEqual(c.host, '0.0.0.0', 'dengan PORT platform, bind harus 0.0.0.0 (container)');
  const d = readConfig({ PORT:'4321', CENTRAL_HOST:'127.0.0.1' });
  assert.strictEqual(d.host, '127.0.0.1', 'host eksplisit harus dihormati');
});
t('validasi konfigurasi menolak postgres tanpa DATABASE_URL', ()=>{
  const c = readConfig({ CENTRAL_DB_DRIVER:'postgres' });
  const v = validateConfig(c);
  assert.strictEqual(v.ok, false);
  assert.ok(v.problems.some(p=>/DATABASE_URL/.test(p)));
});
t('redaksi konfigurasi tidak membocorkan DATABASE_URL', ()=>{
  const c = readConfig({ CENTRAL_DB_DRIVER:'postgres', DATABASE_URL:'postgresql://u:rahasia@host/db' });
  const red = redactConfig(c);
  assert.ok(!JSON.stringify(red).includes('rahasia'));
  assert.strictEqual(red.databaseUrl, '***');
});
t('CENTRAL_PG_SSL: disable/require/verify-full Modes diterima', ()=>{
  const c = readConfig({ CENTRAL_DB_DRIVER:'postgres', DATABASE_URL:'postgresql://u:p@h/db', CENTRAL_PG_SSL:'verify-full' });
  assert.strictEqual(c.pgSsl, 'verify-full');
  assert.strictEqual(validateConfig(c).ok, true);
});

// ── C2: readiness gagal dengan benar & tidak menggantung ──
t('readiness mengembalikan 503 bila dependensi mati (tanpa hang)', async ()=>{
  const deadDb = { kind:'sqlite', query: async () => { throw new Error('DB_DOWN'); }, exec: async()=>({changes:0}), close: async()=>{} };
  const cfg = readConfig({ CENTRAL_DB_DRIVER:'sqlite', CENTRAL_DB_FILE:':memory:' });
  const app = createApp({ db: deadDb, config: cfg, setupKey:'', version:'1.0.0' });
  const server = http.createServer((rq,rs)=>app.handle(rq,rs).catch(()=>{ rs.writeHead(500); rs.end('{}'); }));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port = server.address().port;
  const started = Date.now();
  const r = await req(port, 'GET', '/v1/ready');
  const elapsed = Date.now() - started;
  assert.strictEqual(r.status, 503);
  assert.strictEqual(r.body.status, 'not_ready');
  assert.ok(elapsed < 6000, 'readiness tidak boleh menggantung (took ' + elapsed + 'ms)');
  // health tetap 200 walau DB mati (liveness != readiness)
  const h = await req(port, 'GET', '/v1/health');
  assert.strictEqual(h.status, 200);
  assert.ok(!/DB_DOWN|at Object|\.js:\d+/.test(h.raw), 'health tidak boleh membocorkan detail internal');
  server.close();
});
t('health/readiness tidak membocorkan secret', async ()=>{
  const { createDatabase: cd } = require('../src/central/db');
  const db = cd({ driver:'sqlite', dbFile:':memory:' });
  await migrate(db, {});
  const cfg = readConfig({ CENTRAL_DB_DRIVER:'sqlite', CENTRAL_DB_FILE:':memory:' });
  const app = createApp({ db, config: cfg, setupKey:'super-secret-setup-key', version:'1.0.0' });
  const server = http.createServer((rq,rs)=>app.handle(rq,rs).catch(()=>{ rs.writeHead(500); rs.end('{}'); }));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const port = server.address().port;
  const h = await req(port, 'GET', '/v1/health');
  const rd = await req(port, 'GET', '/v1/ready');
  assert.ok(!h.raw.includes('super-secret-setup-key'));
  assert.ok(!rd.raw.includes('super-secret-setup-key'));
  assert.ok(!/DATABASE_URL|postgres:\/\//.test(h.raw + rd.raw));
  server.close(); db.close();
});

// ── C3: migrasi tidak jalan bersamaan tanpa koordinasi (advisory lock) ──
t('migrasi konkuren di PostgreSQL terkoordinasi (advisory lock) — tidak error & tidak dobel', async ()=>{
  if (!CONN) { throw new Error('BUTUH_POSTGRESQL'); }
  const admin = new (require('pg').Client)({ connectionString: CONN });
  await admin.connect();
  const name = 'orion_lock_' + require('crypto').randomBytes(6).toString('hex');
  await admin.query('CREATE DATABASE ' + name);
  await admin.end();
  const url = CONN.replace(/\/[^/?]*(\?|$)/, '/' + name + '$1');
  const db = createDatabase({ driver:'postgres', databaseUrl: url });
  // 3 instance "server" menjalankan migrasi BERSAMAAN
  const results = await Promise.all([migrate(db, {}), migrate(db, {}), migrate(db, {})]);
  results.forEach(r => assert.ok(!r.error, 'migrasi paralel tidak boleh error: ' + JSON.stringify(r.error)));
  const total = results.reduce((n, r) => n + r.applied.length, 0);
  const status = await db.query('SELECT count(*) c FROM schema_migrations');
  // tidak boleh ada versi yang tercatat dobel
  const dupes = await db.query('SELECT version, count(*) c FROM schema_migrations GROUP BY version HAVING count(*) > 1');
  assert.strictEqual(dupes.length, 0, 'tidak boleh ada migrasi tercatat dua kali');
  assert.ok(Number(status[0].c) >= 7, 'semua migrasi harus tercatat: ' + status[0].c);
  assert.ok(total >= 7, 'total appliedacross instance: ' + total);
  await db.close();
  const admin2 = new (require('pg').Client)({ connectionString: CONN });
  await admin2.connect();
  await admin2.query('DROP DATABASE IF EXISTS ' + name + ' WITH (FORCE)');
  await admin2.end();
});

// ── C4: start server & shutdown rapi ──
t('server start & shutdown menutup pool DB dengan rapi', async ()=>{
  const dir = require('fs').mkdtempSync(require('path').join(require('os').tmpdir(), 'orion-srv-'));
  const s = await start({ CENTRAL_DB_DRIVER:'sqlite', CENTRAL_DB_FILE: path.join(dir,'s.db'), CENTRAL_PORT:'0', CENTRAL_SETUP_KEY:'k1234567890' });
  assert.ok(s.server.listening);
  const port = s.server.address().port;
  const h = await req(port, 'GET', '/v1/health');
  assert.strictEqual(h.status, 200);
  // shutdown menutup pool (tidak melempar)
  await s.shutdown();
  assert.ok(true, 'shutdown harus selesai tanpa error');
});
t('start dengan driver postgres tanpa DATABASE_URL gagal cepat (tanpa retry loop)', async ()=>{
  const t0 = Date.now();
  let e = null;
  try { await start({ CENTRAL_DB_DRIVER:'postgres', DATABASE_URL:'' }); } catch (x) { e = x; }
  assert.ok(e, 'start harus gagal');
  assert.ok(/KONFIGURASI_INVALID/.test(e.message), 'got ' + e.message);
  assert.ok(Date.now() - t0 < 5000, 'gagal start tidak boleh retry tanpa batas');
});

(async ()=>{
  console.log('Railway readiness — ' + (CONN ? 'PostgreSQL nyata tersedia' : 'PostgreSQL TIDAK tersedia (sebagian tes dilewati)'));
  for (const item of tests){
    try { await item.fn(); console.log('  ✓ ' + item.name); passed++; }
    catch (e){ console.log('  ✗ ' + item.name + ' — ' + (e && e.message)); failed++; }
  }
  console.log('\nRailway readiness: ' + passed + ' lulus, ' + failed + ' gagal');
  process.exit(failed ? 1 : 0);
})();
