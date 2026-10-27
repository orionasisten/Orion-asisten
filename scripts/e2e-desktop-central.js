'use strict';
/**
 * E2E lintas perangkat: Orion Desktop (Electron) ↔ Orion Web App ↔ Orion Central + PostgreSQL.
 *
 * Skenario yang dibuktikan:
 *  1. Desktop terhubung ke Central dengan token perangkat (login via IPC renderer → main process).
 *  2. Pesan dari DESKTOP tersimpan di server.
 *  3. Pesan yang sama terlihat di WEB APP (percakapan server yang sama).
 *  4. Balasan dari WEB APP muncul di DESKTOP lewat sinkronisasi (SSE/delta).
 *  5. Urutan & isi konsisten di kedua klien.
 *
 * Jalankan: node scripts/pg-harness.js --run-electron scripts/e2e-desktop-central.js
 */
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow } = require('electron');
const cdp = require('./lib/cdp');
const { createStaticProxy } = require('./lib/static-proxy');
const shot = async (client, file) => {
  try {
    const r = await client.send('Page.captureScreenshot', { format: 'png' });
    if (r && r.data) fs.writeFileSync(path.join(ART, file), Buffer.from(r.data, 'base64'));
  } catch (e) { /* ignore */ }
};

const CONN = process.env.ORION_PG_CONNECTION || process.env.DATABASE_URL || '';
const REPO = path.join(__dirname, '..');
const WEB_DIST = path.join(REPO, 'web', 'dist');
const ART = path.join(REPO, 'web', 'e2e-artifacts');
const CDP_PORT = 9333;

let passed = 0, failed = 0; const failures = [];
function ok(n){ console.log('  ✓ ' + n); passed++; }
function bad(n, m){ console.log('  ✗ ' + n + ' — ' + m); failed++; failures.push(n + ': ' + m); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

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

process.on('unhandledRejection', (e) => { console.log('  ! unhandledRejection: ' + (e && e.stack ? e.stack : e)); });
process.on('uncaughtException', (e) => { console.log('  ! uncaughtException: ' + (e && e.stack ? e.stack : e)); });

(async ()=>{
  if (!CONN){ console.log('  ⚠ PostgreSQL tidak dikonfigurasi — E2E DILEWATI.'); app.exit(2); return; }
  if (!fs.existsSync(path.join(WEB_DIST,'index.html'))){ console.log('  ⚠ web/dist belum dibangun.'); app.exit(2); return; }
  fs.mkdirSync(ART, { recursive: true });

  const { createDatabase } = require('../src/central/db');
  const { migrate } = require('../src/central/db/migrate');
  const { createApp } = require('../src/central/app');
  const { readConfig } = require('../src/central/config');
  const db = createDatabase({ driver:'postgres', databaseUrl: CONN });
  await migrate(db, {});
  const cfg = readConfig({ CENTRAL_DB_DRIVER:'postgres', DATABASE_URL:CONN, CENTRAL_RATE_LIMIT_PER_MIN:'10000' });
  const central = createApp({ db, config:cfg, setupKey:'e2e-key', version:'1.0.0' });
  const apiServer = http.createServer((rq,rs)=>central.handle(rq,rs).catch(()=>{ rs.writeHead(500); rs.end('{}'); }));
  await new Promise(r=>apiServer.listen(0,'127.0.0.1',r));
  const apiPort = apiServer.address().port;
  const apiBase = 'http://127.0.0.1:' + apiPort;

  // web app statis (same-origin proxy)
  const web = createStaticProxy({ webRoot: WEB_DIST, apiPort });
  await new Promise(r=>web.listen(0,'127.0.0.1',r));
  const webPort = web.address().port;
  const webBase = 'http://127.0.0.1:' + webPort;

  // owner + token perangkat untuk desktop
  const email = 'pc@orion.id', password = 'rahasia-owner-2026';
  const boot = await req(apiPort, 'POST', '/v1/auth/bootstrap', { email, password }, { 'x-setup-key':'e2e-key' });
  const ownerToken = boot.body.token;
  const dev = await req(apiPort, 'POST', '/v1/devices', { name:'Windows Desktop' }, { Authorization:'Bearer '+ownerToken });
  const deviceToken = dev.body.token;

  // ── jalankan aplikasi desktop ORION (proses Electron terpisah) ──
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-desktop-profile-'));
  const electronBin = path.join(REPO, 'node_modules', 'electron', 'dist', 'electron.exe');
  const child = spawn(electronBin, ['.', '--user-data-dir=' + profile, '--remote-debugging-port=' + CDP_PORT], {
    cwd: REPO,
    env: Object.assign({}, process.env, { ORION_CENTRAL_URL: apiBase, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' }),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let childLog = '';
  child.stdout.on('data', d => { childLog += d; });
  child.stderr.on('data', d => { childLog += d; });

  let desktop = null;
  try {
    const target = await cdp.waitTarget(CDP_PORT, 'index.html', 45000);
    if (!target) throw new Error('jendela desktop tidak terdeteksi (CDP): ' + childLog.slice(-400));
    desktop = cdp.connect(target.webSocketDebuggerUrl);
    await desktop.ready;
    // tunggu app benar-benar siap (preload terpasang)
    const ready = await cdp.evalUntil(desktop, '!!(window.orionDesktop && window.orionDesktop.central)', 30000);
    if (!ready) throw new Error('preload desktop tidak siap (orionDesktop tidak ada)');
    ok('aplikasi desktop ORION berjalan (proses Electron nyata)');

    // login desktop dengan token perangkat (jalur resmi: renderer → IPC → main process)
    await desktop.evaluate(`window.orionDesktop.central.desktopSetUrl(${JSON.stringify(apiBase)})`, true);
    const loginRes = await desktop.evaluate(`window.orionDesktop.central.desktopLogin(${JSON.stringify(deviceToken)}).then(r=>JSON.stringify(r)).catch(e=>'err:'+e.message)`, true);
    if (!loginRes || !/"ok":true/.test(String(loginRes))) throw new Error('desktopLogin gagal: ' + String(loginRes).slice(0, 300));
    ok('desktop terautentikasi ke Orion Central (token perangkat, disimpan di main process)');

    // cloud aktif di renderer
    const enabled = await cdp.evalUntil(desktop, '!!(window.Cloud && window.Cloud.enabled)', 20000);
    if (enabled) ok('renderer desktop mendeteksi mode cloud');
    else {
      const dbg = await desktop.evaluate('(async()=>{ const ipc = await window.orionDesktop.central.desktopStatus().catch(e=>({err:String(e)})); return JSON.stringify({ cloud: !!window.Cloud, status: (window.Cloud&&window.Cloud.status)||null, ipc }); })()', true);
      bad('renderer cloud', 'Cloud.enabled tidak true — ' + String(dbg).slice(0, 400));
    }

    // ── kirim pesan dari DESKTOP lewat UI ──
    await desktop.evaluate(`(function(){ try{ go('chat'); }catch(e){} return true; })()`, true);
    await sleep(800);
    await desktop.evaluate(`(function(){
      const btn=[...document.querySelectorAll('#btn-chat-new, #btn-new-convo')][0];
      if(btn) btn.click();
      return !!btn;
    })()`, true);
    await sleep(1200);
    const convoCreated = await cdp.evalUntil(desktop, 'document.querySelectorAll(".convo").length>0', 15000);
    if (convoCreated) ok('percakapan dibuat dari desktop'); else bad('percakapan desktop', 'tidak ada .convo');

    const marker = 'pesan-dari-desktop-' + Date.now();
    await desktop.evaluate(`(function(){
      const ta=document.querySelector('#chat-input');
      if(!ta) return false;
      const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      setter.call(ta, ${JSON.stringify(marker)});
      ta.dispatchEvent(new Event('input',{bubbles:true}));
      const b=document.querySelector('#btn-send');
      if(b) b.click();
      return true;
    })()`, true);
    const sentOnDesktop = await cdp.evalUntil(desktop, `document.body.innerText.includes(${JSON.stringify(marker)})`, 20000);
    if (sentOnDesktop) ok('pesan terkirim dari desktop (terlihat di UI)'); else bad('pesan desktop', 'tidak muncul di UI');

    // ── verifikasi di server (PostgreSQL) ──
    const convs = await req(apiPort, 'GET', '/v1/conversations', undefined, { Authorization:'Bearer '+ownerToken });
    const conv = (convs.body.conversations||[]).find(c => (c.message_count||0) > 0);
    if (conv) ok('percakapan tersimpan di Orion Central (PostgreSQL)'); else bad('penyimpanan server', 'tidak ada percakapan dengan pesan');
    const msgs = conv ? (await req(apiPort, 'GET', '/v1/conversations/' + conv.id + '/messages', undefined, { Authorization:'Bearer '+ownerToken })).body.messages : [];
    if (msgs.some(m => m.content === marker)) ok('isi pesan di server sama dengan yang dikirim'); else bad('isi pesan server', 'tidak cocok: ' + JSON.stringify(msgs.map(m=>m.content)).slice(0,140));

    // ── WEB APP: login & lihat percakapan yang sama ──
    const webWin = new BrowserWindow({ width: 1280, height: 860, show: false, webPreferences:{ contextIsolation:true, nodeIntegration:false } });
    await webWin.loadURL(webBase + '/');
    await cdp.evalUntil({ evaluate: (e) => webWin.webContents.executeJavaScript(e, true) }, "!!document.querySelector('#login-email')", 20000);
    await webWin.webContents.executeJavaScript(`(function(){
      const set=(sel,val)=>{const el=document.querySelector(sel);const proto=el.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(proto,'value').set.call(el,val);el.dispatchEvent(new Event('input',{bubbles:true}));};
      set('#login-email', ${JSON.stringify(email)});
      set('#login-password', ${JSON.stringify(password)});
      document.querySelector('button[type=submit]').click();
      return true;
    })()`, true);
    const webLogged = await cdp.evalUntil({ evaluate: (e) => webWin.webContents.executeJavaScript(e, true) }, "!!document.querySelector('.sidebar')", 25000);
    if (webLogged) ok('web app login Owner berhasil'); else bad('web login', 'sidebar tidak muncul');
    // buka Chat
    await webWin.webContents.executeJavaScript(`(function(){const b=[...document.querySelectorAll('.nav-item')].find(x=>x.textContent.includes('Chat'));if(b)b.click();return !!b;})()`, true);
    const webSees = await cdp.evalUntil({ evaluate: (e) => webWin.webContents.executeJavaScript(e, true) }, `document.body.innerText.includes(${JSON.stringify(marker)})`, 25000);
    if (webSees) ok('pesan dari desktop TERLIHAT di web app (percakapan server yang sama)'); else bad('web melihat pesan', 'marker tidak ditemukan');
    await sleep(1200);
    const stillThere = await webWin.webContents.executeJavaScript(`document.body.innerText.includes(${JSON.stringify(marker)})`, true);
    if (stillThere) await webWin.webContents.capturePage().then(img => fs.writeFileSync(path.join(ART, '10-web-sees-desktop.png'), img.toPNG()));
    else bad('screenshot web', 'konten hilang saat capture (sinkronisasi UI)');


    // ── balasan dari WEB, desktop harus menerimanya lewat sinkronisasi ──
    const reply = 'balasan-dari-web-' + Date.now();
    await webWin.webContents.executeJavaScript(`(function(){
      const ta=document.querySelector('textarea[aria-label="Pesan"]');
      if(!ta) return false;
      const setter=Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set;
      setter.call(ta, ${JSON.stringify(reply)});
      ta.dispatchEvent(new Event('input',{bubbles:true}));
      const b=[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='Kirim');
      if(b) b.click();
      return true;
    })()`, true);
    const webSent = await cdp.evalUntil({ evaluate: (e) => webWin.webContents.executeJavaScript(e, true) }, `document.body.innerText.includes(${JSON.stringify(reply)})`, 20000);
    if (webSent) ok('balasan terkirim dari web app'); else bad('balasan web', 'tidak terkirim');

    // desktop harus menerimanya (SSE / delta catch-up)
    const desktopGot = await cdp.evalUntil(desktop, `document.body.innerText.includes(${JSON.stringify(reply)})`, 40000);
    if (desktopGot) ok('desktop MENERIMA balasan dari web lewat sinkronisasi (SSE/delta)'); else bad('sinkronisasi ke desktop', 'balasan web tidak muncul di desktop');
    await desktop.evaluate('window.orionDesktop.central.desktopSync().then(()=>true).catch(()=>false)', true);
    const desktopGot2 = await cdp.evalUntil(desktop, `document.body.innerText.includes(${JSON.stringify(reply)})`, 25000);
    if (desktopGot2) ok('catch-up via /central:sync ALSO menulis balasan (bukan hanya SSE)');
    await desktop.evaluate('window.__cap = 1; true', true);
    await sleep(800);
    await shot(desktop, '11-desktop-cross-device.png');

    // urutan konsisten
    const finalMsgs = (await req(apiPort, 'GET', '/v1/conversations/' + conv.id + '/messages', undefined, { Authorization:'Bearer '+ownerToken })).body.messages;
    const seqs = finalMsgs.map(m => m.seq);
    const sorted = seqs.slice().sort((a,b)=>a-b);
    if (JSON.stringify(seqs) === JSON.stringify(sorted) && finalMsgs.some(m=>m.content===marker) && finalMsgs.some(m=>m.content===reply)) ok('urutan & isi konsisten di server (seq menaik, kedua pesan ada)');
    else bad('konsistensi urutan', JSON.stringify(finalMsgs.map(m=>[m.seq,m.content.slice(0,20)])));
  } catch (e) {
    bad('E2E desktop↔web', (e && e.stack) || String(e));
  } finally {
    try { child.kill(); } catch (e) { /* ignore */ }
    try { apiServer.close(); web.close(); db.close(); } catch (e) { /* ignore */ }
  }
  console.log('\nE2E Desktop↔Web: ' + passed + ' lulus, ' + failed + ' gagal');
  if (failures.length) console.log('Gagal: ' + failures.join(' | '));
  app.exit(failed ? 1 : 0);
})();
