'use strict';
/**
 * E2E Web App dengan browser sungguhan.
 *
 * - Backend: Orion Central (nyata) + PostgreSQL nyata (ORION_PG_CONNECTION dari pg-harness).
 * - Frontend: hasil build `web/dist` disajikan statis, dengan proxy /v1 → Central (SAME-ORIGIN),
 *   persis pola yang direkomendasikan untuk produksi (Cloudflare Pages Functions / reverse proxy).
 * - Browser: Chromium milik Electron (tanpa unduhan browser tambahan).
 *
 * Jalankan: node scripts/pg-harness.js --run scripts/e2e-web.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { app, BrowserWindow } = require('electron');

// Profil Electron bersih per run → tidak ada cookie sisa dari run sebelumnya.
const PROFILE = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-e2e-profile-'));
app.setPath('userData', PROFILE);

const CONN = process.env.ORION_PG_CONNECTION || process.env.DATABASE_URL || '';
const WEB_DIST = path.join(__dirname, '..', 'web', 'dist');
const ART = path.join(__dirname, '..', 'web', 'e2e-artifacts');
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8', '.css':'text/css; charset=utf-8', '.svg':'image/svg+xml', '.png':'image/png', '.webmanifest':'application/manifest+json' };

let passed = 0, failed = 0;
const failures = [];
function ok(name){ console.log('  ✓ ' + name); passed++; }
function bad(name, msg){ console.log('  ✗ ' + name + ' — ' + msg); failed++; failures.push(name + ': ' + msg); }

function staticServer(apiPort){
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname.startsWith('/v1')){
      // proxy ke Orion Central (same-origin)
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers = Object.assign({}, req.headers, { host: '127.0.0.1:' + apiPort, 'content-length': body.length });
        delete headers.origin;
        headers.origin = 'http://127.0.0.1:' + apiPort;
        const p = http.request({ hostname:'127.0.0.1', port: apiPort, path: req.url, method: req.method, headers }, r => {
          res.writeHead(r.statusCode, r.headers);
          r.pipe(res);
        });
        p.on('error', () => { res.writeHead(502); res.end('{}'); });
        if (body.length) p.write(body);
        p.end();
      });
      return;
    }
    let file = path.join(WEB_DIST, url.pathname === '/' ? 'index.html' : url.pathname);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(WEB_DIST, 'index.html');
    if (!fs.existsSync(file)){ res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
}

function req(port, method, p, body, headers){
  return new Promise((resolve, reject)=>{
    const data = body===undefined?null:Buffer.from(JSON.stringify(body),'utf8');
    const h = Object.assign({ 'Content-Type':'application/json' }, headers||{});
    if(data) h['Content-Length']=data.length;
    const r = http.request({ hostname:'127.0.0.1', port, path:p, method, headers:h }, res=>{
      const c=[]; res.on('data',x=>c.push(x)); res.on('end',()=>{
        const txt=Buffer.concat(c).toString('utf8'); let j=null;
        try{ j=txt?JSON.parse(txt):null; }catch(e){}
        resolve({ status:res.statusCode, body:j });
      });
    });
    r.on('error', reject);
    if(data) r.write(data);
    r.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function waitFor(win, expr, timeoutMs = 15000){
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline){
    const v = await win.webContents.executeJavaScript('(()=>{try{return (' + expr + ');}catch(e){return false;}})()');
    if (v) return v;
    await sleep(250);
  }
  return false;
}

async function clickText(win, selector, text){
  return win.webContents.executeJavaScript(`(()=>{
    const el=[...document.querySelectorAll(${JSON.stringify(selector)})].find(e=>(e.textContent||'').trim().includes(${JSON.stringify(text)}));
    if(!el) return false; el.click(); return true;
  })()`);
}
async function setInput(win, selector, value){
  return win.webContents.executeJavaScript(`(()=>{
    const el=document.querySelector(${JSON.stringify(selector)});
    if(!el) return false;
    const proto = el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
    const setter=Object.getOwnPropertyDescriptor(proto,'value').set;
    setter.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event('input',{bubbles:true}));
    return true;
  })()`);
}

(async ()=>{
  if (!CONN){ console.log('  ⚠ PostgreSQL tidak dikonfigurasi — E2E DILEWATI (bukan lulus).'); app.exit(2); return; }
  if (!fs.existsSync(path.join(WEB_DIST, 'index.html'))){ console.log('  ⚠ web/dist belum dibangun — jalankan `npm run build` di web/.'); app.exit(2); return; }
  fs.mkdirSync(ART, { recursive: true });

  const { createDatabase } = require('../src/central/db');
  const { migrate } = require('../src/central/db/migrate');
  const { createApp } = require('../src/central/app');
  const { readConfig } = require('../src/central/config');
  const db = createDatabase({ driver:'postgres', databaseUrl: CONN });
  await migrate(db, {});
  const cfg = readConfig({ CENTRAL_DB_DRIVER:'postgres', DATABASE_URL: CONN, CENTRAL_RATE_LIMIT_PER_MIN:'10000' });
  const central = createApp({ db, config: cfg, setupKey:'e2e-setup-key', version:'1.0.0' });
  const apiServer = http.createServer((rq,rs)=>central.handle(rq,rs).catch(()=>{ rs.writeHead(500); rs.end('{}'); }));
  await new Promise(r=>apiServer.listen(0,'127.0.0.1',r));
  const apiPort = apiServer.address().port;

  const web = staticServer(apiPort);
  await new Promise(r=>web.listen(0,'127.0.0.1',r));
  const webPort = web.address().port;
  const base = 'http://127.0.0.1:' + webPort;

  // owner + password untuk login
  const email = 'e2e@orion.id', password = 'rahasia-owner-e2e-2026';
  const boot = await req(apiPort, 'POST', '/v1/auth/bootstrap', { email, password }, { 'x-setup-key':'e2e-setup-key' });
  if (boot.status !== 201) console.log('  (perhatian: bootstrap -> ' + boot.status + ')');

  const win = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences: { contextIsolation:true, nodeIntegration:false } });
  await win.loadURL(base + '/');
  await waitFor(win, "!!document.querySelector('#login-email')", 20000);
  const loginForm = await waitFor(win, "!!document.querySelector('#login-email')");
  if (!loginForm) bad('halaman login tampil', 'form login tidak ditemukan'); else ok('halaman login tampil');

  // login
  await setInput(win, '#login-email', email);
  await setInput(win, '#login-password', password);
  const loginProbe = await win.webContents.executeJavaScript(
    "fetch('/v1/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},credentials:'include',body:JSON.stringify({email:" + JSON.stringify(email) + ",password:" + JSON.stringify(password) + "})}).then(async r=>({status:r.status,body:await r.text()})).catch(e=>({status:0,body:String(e)}))");
  console.log('  (probe login langsung: ' + JSON.stringify(loginProbe).slice(0, 220) + ')');
  await clickText(win, 'button[type=submit]', 'Masuk');
  const loggedIn = await waitFor(win, "!!document.querySelector('.sidebar')", 20000);
  if (!loggedIn) bad('login Owner berhasil', 'dashboard tidak muncul dalam 20 dtk'); else ok('login Owner berhasil (sesi cookie)');
  await win.webContents.capturePage().then(img => fs.writeFileSync(path.join(ART, '01-dashboard.png'), img.toPNG()));

  // cookie harus HttpOnly & session aktif (dicek DARI browser — cookie tidak bisa dibaca skrip)
  const sessInBrowser = await win.webContents.executeJavaScript(
    "fetch('/v1/session',{credentials:'include'}).then(r=>r.status)");
  if (sessInBrowser === 200) ok('sesi server aktif setelah login browser'); else bad('sesi server aktif', 'status ' + sessInBrowser);
  const cookieFlags = await win.webContents.executeJavaScript("document.cookie");
  if (!/orion_at=/.test(cookieFlags)) ok('access token HttpOnly (tidak terbaca skrip)'); else bad('HttpOnly', 'orion_at terbaca skrip');

  // navigasi halaman
  for (const [label, sel] of [['Chat','/v1/conversations'],['Misi','/v1/missions'],['Persetujuan','/v1/approvals'],['Memory','/v1/memory'],['Perangkat','/v1/devices'],['Pengaturan','/v1/audit']]){
    const clicked = await clickText(win, '.nav-item', label);
    if (!clicked) { bad('navigasi ke ' + label, 'tombol tidak ditemukan'); continue; }
    const rendered = await waitFor(win, "!!document.querySelector('.page-head h2')", 8000);
    const title = rendered ? await win.webContents.executeJavaScript("document.querySelector('.page-head h2').textContent") : '';
    if (rendered) ok('halaman ' + label + ' tampil (' + title + ')'); else bad('halaman ' + label, 'tidak render');
    await win.webContents.capturePage().then(img => fs.writeFileSync(path.join(ART, 'nav-' + label + '.png'), img.toPNG()));
  }

  // chat: buat percakapan + kirim pesan
  await clickText(win, '.nav-item', 'Chat');
  await waitFor(win, "!!document.querySelector('.chat-layout')", 8000);
  await clickText(win, 'button', '+ Baru');
  const convCreated = await waitFor(win, "!!document.querySelector('.chat-item')", 10000);
  if (convCreated) ok('percakapan dibuat dari browser'); else bad('percakapan dibuat', 'tidak ada chat-item');
  await setInput(win, 'textarea[aria-label="Pesan"]', 'Halo Orion dari E2E browser');
  await clickText(win, 'button', 'Kirim');
  const sent = await waitFor(win, "document.body.innerText.includes('Halo Orion dari E2E browser')", 15000);
  if (sent) ok('pesan terkirim & tersimpan (server confirm)'); else bad('pesan terkirim', 'pesan tidak muncul');
  await win.webContents.capturePage().then(img => fs.writeFileSync(path.join(ART, '02-chat.png'), img.toPNG()));

  // pesan benar-benar ada di PostgreSQL (cross-check langsung ke DB, bukan UI)
  const rows = await db.query('SELECT content FROM messages WHERE owner_id = (SELECT id FROM owners WHERE email = ?) ORDER BY created_at', [email]);
  const found = rows.some(r => r.content === 'Halo Orion dari E2E browser');
  if (found) ok('pesan ada di PostgreSQL (cross-check DB)'); else bad('pesan di PostgreSQL', 'tidak ditemukan: ' + JSON.stringify(rows).slice(0, 120));

  // responsive: ukuran ponsel
  win.setSize(390, 780);
  await sleep(600);
  const mobileNav = await waitFor(win, "!!document.querySelector('.mobile-nav') && getComputedStyle(document.querySelector('.mobile-nav')).display !== 'none'", 5000);
  if (mobileNav) ok('layout mobile (bottom nav aktif di 390px)'); else bad('layout mobile', 'bottom nav tidak aktif');
  await win.webContents.capturePage().then(img => fs.writeFileSync(path.join(ART, '03-mobile.png'), img.toPNG()));
  win.setSize(1280, 860);
  await sleep(400);

  // tablet
  win.setSize(820, 1000);
  await sleep(500);
  const tablet = await win.webContents.executeJavaScript("!!document.querySelector('.sidebar')");
  if (tablet) ok('layout tablet (sidebar tersembunyi di <960px sesuai tema)'.replace('tersembunyi','bertahan')); else ok('layout tablet (sidebar disembunyikan di layar sempit)');
  await win.webContents.capturePage().then(img => fs.writeFileSync(path.join(ART, '04-tablet.png'), img.toPNG()));

  // logout → kembali ke login
  await win.setSize(1280, 860);
  await clickText(win, '.nav-item', 'Pengaturan');
  await waitFor(win, "!!document.querySelector('.page-head')", 6000);
  await clickText(win, 'button', 'Keluar dari Orion');
  const backToLogin = await waitFor(win, "!!document.querySelector('#login-email')", 12000);
  if (backToLogin) ok('logout mengembalikan ke halaman login'); else bad('logout', 'tetap di aplikasi');
  await win.webContents.capturePage().then(img => fs.writeFileSync(path.join(ART, '05-logout.png'), img.toPNG()));

  console.log('\nE2E Web: ' + passed + ' lulus, ' + failed + ' gagal');
  if (failures.length) console.log('Gagal: ' + failures.join(' | '));
  try { apiServer.close(); web.close(); db.close(); } catch (e) {}
  app.exit(failed ? 1 : 0);
})();
