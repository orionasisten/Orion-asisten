'use strict';
/**
 * Probe audit Phase E (E1) — membuktikan temuan pada source AKTUAL.
 * Bukan unit test produk: setiap probe mencetak hasil apa adanya (PASS = perilaku aman,
 * FINDING = perilaku yang perlu diperbaiki). Jalankan: node scripts/audit-phaseE-probes.js
 */
const http = require('http');
const { start } = require('../src/central/server');

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
        resolve({ status: res.statusCode, body: json, headers: res.headers, text });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
const bearer = t => ({ Authorization: 'Bearer ' + t });
const sleep = ms => new Promise(r => setTimeout(r, ms));
function cookieHeader(setCookie){
  const list = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  return list.map(c => String(c).split(';')[0]).join('; ');
}
function cookieValue(setCookie, name){
  const list = Array.isArray(setCookie) ? setCookie : (setCookie ? [setCookie] : []);
  for (const c of list){
    const first = String(c).split(';')[0];
    if (first.startsWith(name + '=')) return decodeURIComponent(first.slice(name.length + 1));
  }
  return null;
}
function report(name, verdict, detail){
  console.log(JSON.stringify({ probe: name, verdict, detail }));
}

async function boot(){
  const s = await start({
    CENTRAL_PORT: '0', CENTRAL_HOST: '127.0.0.1', CENTRAL_DB_DRIVER: 'sqlite',
    CENTRAL_DB_FILE: ':memory:', CENTRAL_SETUP_KEY: 'phase-e-audit-setup-key',
    CENTRAL_RATE_LIMIT_PER_MIN: '1000', CENTRAL_TOKEN_TTL_HOURS: '720'
  });
  return { s, port: s.server.address().port };
}

async function bootstrap(port, email, password){
  const r = await req(port, 'POST', '/v1/auth/bootstrap', { email, displayName: email, password: 'OwnerPassw0rd!' }, { 'X-Setup-Key': 'phase-e-audit-setup-key' });
  if (r.status !== 201) throw new Error('bootstrap gagal: ' + r.status + ' ' + JSON.stringify(r.body));
  return r.body;
}

(async () => {
  const { s, port } = await boot();
  const db = s.db;
  try {
    const A = await bootstrap(port, 'owner-a@orion.test');
    const B = await bootstrap(port, 'owner-b@orion.test');
    const aTok = A.token, bTok = B.token;

    // ── 1. Refresh setelah access token kedaluwarsa ──
    {
      const login = await req(port, 'POST', '/v1/auth/login', { email: 'owner-a@orion.test', password: 'OwnerPassw0rd!' }, { Origin: 'https://app.orion.test' });
      const cookies = cookieHeader(login.headers['set-cookie']);
      const csrf = cookieValue(login.headers['set-cookie'], 'orion_csrf');
      await db.query('UPDATE sessions SET access_expires_at = ? WHERE owner_id = ?', [new Date(Date.now() - 60000).toISOString(), A.ownerId]);
      const r = await req(port, 'POST', '/v1/sessions/refresh', {}, { Cookie: cookies, 'X-CSRF-Token': csrf || '', Origin: 'https://app.orion.test' });
      report('refresh-setelah-access-expired', r.status === 200 ? 'PASS' : 'FINDING', { status: r.status, code: r.body && r.body.error && r.body.error.code });
    }

    // ── 2. Logout klien desktop / web setelah reload ──
    // Pakai token sekali-pakai agar probe berikutnya tidak ikut ter-logout.
    {
      const devD = await req(port, 'POST', '/v1/devices', { name: 'Logout Desktop' }, bearer(aTok));
      const d1 = await req(port, 'DELETE', '/v1/sessions/current', undefined, bearer(devD.body.token));
      const still = await req(port, 'GET', '/v1/session', undefined, bearer(devD.body.token));
      const devW = await req(port, 'POST', '/v1/devices', { name: 'Logout Web' }, bearer(aTok));
      const noId = await req(port, 'DELETE', '/v1/sessions', undefined, bearer(devW.body.token));
      const webStill = await req(port, 'GET', '/v1/session', undefined, bearer(devW.body.token));
      report('route-logout-tidak-ada', (d1.status === 404 || noId.status === 404 || (d1.body && d1.body.ok === false)) ? 'FINDING' : 'PASS', {
        desktopRouteStatus: d1.status, desktopRouteBody: d1.body,
        webNoIdRouteStatus: noId.status,
        tokenMasihValidSetelahLogout: still.status === 200 || webStill.status === 200
      });
    }

    // ── 2b. Refresh paralel dengan refresh token yang sama ──
    {
      const login = await req(port, 'POST', '/v1/auth/login', { email: 'owner-a@orion.test', password: 'OwnerPassw0rd!' }, { Origin: 'https://app.orion.test' });
      const cookies = cookieHeader(login.headers['set-cookie']);
      const csrf = cookieValue(login.headers['set-cookie'], 'orion_csrf');
      const h = { Cookie: cookies, 'X-CSRF-Token': csrf || '', Origin: 'https://app.orion.test' };
      const [r1, r2] = await Promise.all([
        req(port, 'POST', '/v1/sessions/refresh', {}, h),
        req(port, 'POST', '/v1/sessions/refresh', {}, h)
      ]);
      const sessRow = await db.query('SELECT status FROM sessions WHERE id = ?', [login.body.sessionId]);
      report('refresh-paralel-token-sama', (r1.status === 200 && r2.status === 200) || (r1.status === 401 || r2.status === 401) ? 'FINDING' : 'PASS',
        { status: [r1.status, r2.status], kode: [r1.body && r1.body.error && r1.body.error.code, r2.body && r2.body.error && r2.body.error.code], statusSesi: sessRow[0] && sessRow[0].status });
    }

    // ── 2c. Scope memori ditentukan klien (bukan token) ──
    {
      await db.query(`INSERT INTO memory_records (id, owner_id, schema_version, type, content, origin, created, updated, verification_status, scope, sensitivity, status, content_version)
                      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ['mem-private-audit', A.ownerId, 1, 'note', 'rahasia-misi', 'audit', new Date().toISOString(), new Date().toISOString(), 'verified', 'mission', 'private', 'active', 1]);
      const r = await req(port, 'GET', '/v1/memory', undefined, bearer(aTok));
      const r2 = await req(port, 'GET', '/v1/memory?scope=mission', undefined, bearer(aTok));
      const leaked = (r.body.records || []).some(x => x.id === 'mem-private-audit');
      const leaked2 = (r2.body.records || []).some(x => x.id === 'mem-private-audit');
      report('memory-scope-ditentukan-klien', (leaked || leaked2) ? 'FINDING' : 'PASS',
        { tanpaScope: leaked, scopeMission: leaked2, sensitivity: 'private' });
    }

    // ── 3. Device dicabut → push token tetap aktif ──
    {
      const dev = await req(port, 'POST', '/v1/devices', { name: 'Audit Device', platform: 'android' }, bearer(aTok));
      const devId = dev.body.deviceId, devTok = dev.body.token;
      await req(port, 'POST', '/v1/push/register', { token: 'ExponentPushToken[audit-device-token-1]', platform: 'android' }, bearer(devTok));
      const rev = await req(port, 'DELETE', '/v1/devices/' + devId, undefined, bearer(aTok));
      const rows = await db.query('SELECT status FROM push_tokens WHERE token = ?', ['ExponentPushToken[audit-device-token-1]']);
      report('device-revoke-tidak-mencabut-push', (rev.status === 200 && rows[0] && rows[0].status === 'active') ? 'FINDING' : 'PASS',
        { revokeStatus: rev.status, pushTokenStatus: rows[0] && rows[0].status });

      // ── 4. Sesi cookie tidak memeriksa status device ──
      const login = await req(port, 'POST', '/v1/auth/login', { email: 'owner-a@orion.test', password: 'OwnerPassw0rd!', deviceId: devId }, { Origin: 'https://app.orion.test' });
      const cookies = cookieHeader(login.headers['set-cookie']);
      const sess = await req(port, 'GET', '/v1/session', undefined, { Cookie: cookies, Origin: 'https://app.orion.test' });
      report('cookie-session-abaikan-device-revoked', (login.status === 200 && sess.status === 200) ? 'FINDING' : 'PASS',
        { loginStatus: login.status, sessionStatus: sess.status, deviceIdDipakai: devId });
    }

    // ── 5. Push token dapat direbut owner lain ──
    {
      const T = 'ExponentPushToken[audit-shared-token-2]';
      const ra = await req(port, 'POST', '/v1/push/register', { token: T, platform: 'android' }, bearer(aTok));
      const rb = await req(port, 'POST', '/v1/push/register', { token: T, platform: 'android' }, bearer(bTok));
      const row = await db.query('SELECT owner_id FROM push_tokens WHERE token = ?', [T]);
      report('push-token-reassign-lintas-owner', (ra.status === 201 && rb.status === 200 && row[0] && row[0].owner_id === B.ownerId) ? 'FINDING' : 'PASS',
        { ownerAStep: ra.status, ownerBStep: rb.status, ownerSetelahnya: row[0] && row[0].owner_id === B.ownerId ? 'B' : 'lain' });
      const list = await req(port, 'GET', '/v1/push/tokens', undefined, bearer(bTok));
      report('push-tokens-response-minimal', 'INFO', { fields: list.body && list.body.tokens && list.body.tokens[0] ? Object.keys(list.body.tokens[0]) : [] });
    }

    // ── 6. Event id global: owner lain dapat "membajak" id event ──
    {
      const sharedId = 'ev-audit-shared-1';
      const eb = await req(port, 'POST', '/v1/events', { events: [{ eventId: sharedId, type: 'agent.note', payload: { by: 'B' } }] }, bearer(bTok));
      const ea = await req(port, 'POST', '/v1/events', { events: [{ eventId: sharedId, type: 'agent.note', payload: { by: 'A' } }] }, bearer(aTok));
      const pullA = await req(port, 'GET', '/v1/events?after=0', undefined, bearer(aTok));
      const hadA = (pullA.body.events || []).some(e => e.id === sharedId);
      report('event-id-squatting-lintas-owner', (eb.body.accepted === 1 && ea.body.duplicates === 1 && !hadA) ? 'FINDING' : 'PASS',
        { ownerB: eb.body, ownerA: ea.body, eventMilikATerlihat: hadA });
    }

    // ── 7. Ganti password tidak mencabut token/sesi lain ──
    {
      const dev = await req(port, 'POST', '/v1/devices', { name: 'Old Device', platform: 'android' }, bearer(aTok));
      const ch = await req(port, 'POST', '/v1/auth/change-password', { oldPassword: 'OwnerPassw0rd!', newPassword: 'OwnerPassw0rd!-baru' }, bearer(aTok));
      const oldDev = await req(port, 'GET', '/v1/session', undefined, bearer(dev.body.token));
      report('ganti-password-tidak-mencabut-token', (ch.status === 200 && oldDev.status === 200) ? 'FINDING' : 'PASS',
        { changePassword: ch.status, tokenLamaMasihDiterima: oldDev.status });
      // kembalikan password untuk probe login berikutnya
      await req(port, 'POST', '/v1/auth/change-password', { oldPassword: 'OwnerPassw0rd!-baru', newPassword: 'OwnerPassw0rd!' }, bearer(aTok));
    }

    // ── 8. Delta feed: hasMore salah saat filter types dipakai ──
    {
      const base = await (async () => {
        const feed = await req(port, 'GET', '/v1/sync/changes?since=0', undefined, bearer(aTok));
        return feed.body.cursor || 0;
      })();
      const evs = [
        { eventId: 'ev-audit-filter-1', type: 'agent.note', payload: { n: 1 } },
        { eventId: 'ev-audit-filter-2', type: 'agent.note', payload: { n: 2 } },
        { eventId: 'ev-audit-filter-3', type: 'mission.state', payload: { n: 3 } }
      ];
      await req(port, 'POST', '/v1/events', { events: evs }, bearer(aTok));
      const r = await req(port, 'GET', '/v1/sync/changes?since=' + base + '&limit=2&types=mission.state', undefined, bearer(aTok));
      const missed = (r.body.changes || []).length === 0 && r.body.hasMore === false;
      report('delta-feed-hasMore-dengan-filter', missed ? 'FINDING' : 'PASS',
        { changes: (r.body.changes || []).length, hasMore: r.body.hasMore, cursor: r.body.cursor, cursorAwal: base });
    }

    // ── 9. Validasi input misi: budget/executions negatif diterima ──
    {
      const m = await req(port, 'POST', '/v1/missions', { title: 'Misi Negatif', budgetLimit: -100, maxExecutions: -1 }, bearer(aTok));
      report('misi-budget-negatif-diterima', m.status === 201 ? 'FINDING' : 'PASS', { status: m.status, missionId: m.body && m.body.missionId });
    }

    // ── 10. Token dengan deviceId sembarang diterbitkan tanpa validasi ──
    {
      const issued = await req(port, 'POST', '/v1/auth/token', { deviceId: 'dev-tidak-ada', label: 'audit', scopes: ['default'] }, bearer(aTok));
      const use = issued.body && issued.body.token ? await req(port, 'GET', '/v1/session', undefined, bearer(issued.body.token)) : null;
      report('token-deviceid-tanpa-validasi', (issued.status === 201 && use && use.status === 401) ? 'FINDING' : 'PASS',
        { issueStatus: issued.status, tokenBaruStatus: use && use.status, code: use && use.body && use.body.error && use.body.error.code });
    }

    // ── 11. Token dicabut: permintaan baru ditolak, SSE yang sudah terbuka tetap menerima event ──
    {
      const dev = await req(port, 'POST', '/v1/devices', { name: 'SSE Device', platform: 'android' }, bearer(aTok));
      const devId = dev.body.deviceId, devTok = dev.body.token;
      const seen = [];
      const streamReq = http.request({ host:'127.0.0.1', port, path:'/v1/stream', method:'GET', headers: bearer(devTok) }, res => {
        let buf = '';
        res.on('data', chunk => {
          buf += chunk.toString('utf8');
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0){
            const raw = buf.slice(0, i); buf = buf.slice(i + 2);
            if (raw.includes('event: ready')) seen.push('ready');
            if (raw.includes('event: change')) seen.push('change');
          }
        });
      });
      streamReq.on('error', () => {});
      streamReq.end();
      await sleep(500);
      await req(port, 'DELETE', '/v1/devices/' + devId, undefined, bearer(aTok));
      const newReq = await req(port, 'GET', '/v1/session', undefined, bearer(devTok));
      await req(port, 'POST', '/v1/events', { events: [{ eventId: 'ev-audit-after-revoke', type: 'agent.note', payload: { leak: true } }] }, bearer(aTok));
      await sleep(3600);
      try { streamReq.destroy(); } catch (e) { /* ignore */ }
      const changesAfter = seen.filter(x => x === 'change').length;
      report('sse-terbuka-bertahan-setelah-token-dicabut', (newReq.status === 401 && changesAfter > 0) ? 'FINDING' : 'PASS',
        { permintaanBaru: newReq.status, eventDiterimaSetelahRevoke: changesAfter });
    }

    // ── 12. Rate limit hanya per-IP, bukan per-token ──
    {
      const s2 = await start({
        CENTRAL_PORT: '0', CENTRAL_HOST: '127.0.0.1', CENTRAL_DB_DRIVER: 'sqlite',
        CENTRAL_DB_FILE: ':memory:', CENTRAL_SETUP_KEY: 'phase-e-audit-setup-key',
        CENTRAL_RATE_LIMIT_PER_MIN: '4'
      });
      const p2 = s2.server.address().port;
      const boot2 = await req(p2, 'POST', '/v1/auth/bootstrap', { email: 'rl@orion.test', password: 'OwnerPassw0rd!' }, { 'X-Setup-Key': 'phase-e-audit-setup-key' });
      const t = boot2.body.token;
      const r1 = await req(p2, 'GET', '/v1/session', undefined, bearer(t));
      const r2 = await req(p2, 'GET', '/v1/session');
      const r3 = await req(p2, 'GET', '/v1/session');
      const r4 = await req(p2, 'GET', '/v1/session', undefined, bearer(t));
      report('rate-limit-per-ip-bukan-per-token', (r1.status === 200 && r4.status === 429) ? 'FINDING' : 'PASS',
        { langkah: [boot2 ? 'bootstrap' : 'x', r1.status, r2.status, r3.status, r4.status], catatan: 'satu IP menghabiskan kuota semua token' });
      try { s2.server.close(); } catch (e) { /* ignore */ }
      try { await s2.db.close(); } catch (e) { /* ignore */ }
    }
  } finally {
    try { s.server.close(); } catch (e) { /* ignore */ }
    try { await db.close(); } catch (e) { /* ignore */ }
  }
})().catch(e => { console.error('PROBE_ERROR', e && e.stack || e); process.exit(2); });
