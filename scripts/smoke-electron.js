'use strict';
/* Uji nyala (startup smoke test) di Electron asli:
 *   npm run smoke
 * (atau: node_modules/.bin/electron scripts/smoke-electron.js)
 *
 * Memuat app/index.html di jendela tersembunyi dengan konfigurasi keamanan yang sama seperti
 * src/main.js, mendaftarkan jembatan IPC seperti aplikasi sungguhan, lalu memeriksa:
 *   - Desktop bridge (window.orionDesktop) terpasang,
 *   - Desktop Hub & API Hub (window.OrionHub/OrionHubExt) hidup,
 *   - adapter AI (ORION-AI-CORE) terpasang, kontrak inti benar, tanpa jaringan,
 *   - Settings memuat pemilih protokol, view hub dapat dirender,
 *   - TIDAK ada error console (level >= 2) selama boot.
 *
 * TIDAK memanggil jaringan dan TIDAK memakai API key decode — getter key disuntik kosong.
 * Folder data dialihkan ke direktori sementara agar konfigurasi ORION milik pengguna tidak tersentuh.
 */
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const INDEX = path.join(__dirname, '..', 'app', 'index.html');
const TIMEOUT_MS = 45000;
const out = o => process.stdout.write(JSON.stringify(o, null, 0) + '\n');

app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'orion-smoke-')));
app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  if (!fs.existsSync(INDEX)) {
    out({ ok: false, error: 'app/index.html belum dibuat — jalankan npm run prepare:app' });
    app.exit(1); return;
  }
  const win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'src', 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, spellcheck: false, webSecurity: true
    }
  });
  const errors = [];
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(String(message).slice(0, 300)); });
  win.webContents.on('render-process-gone', (_e, d) => { out({ ok: false, error: 'renderer gone: ' + JSON.stringify(d) }); app.exit(1); });

  try {
    require('../src/bridge').register({
      ipcMain, app, dialog, shell, safeStorage, getWindow: () => win, updater: { check: () => { } }
    });
  } catch (e) {
    out({ ok: false, error: 'gagal mendaftarkan bridge: ' + String((e && e.message) || e) });
    app.exit(1); return;
  }

  const timer = setTimeout(() => { out({ ok: false, error: 'timeout memuat renderer', errors }); app.exit(1); }, TIMEOUT_MS);
  let code = 0;
  try {
    await win.loadFile(INDEX);
    await new Promise(r => setTimeout(r, 1200)); // biarkan boot + Desktop Hub selesai
    const probe = await win.webContents.executeJavaScript(`(() => {
      const r = {};
      try {
        r.desktopBridge = !!(window.orionDesktop && window.orionDesktop.isDesktop);
        r.hubInstalled = typeof window.OrionHub === 'object';
        r.hubExt = typeof window.OrionHubExt === 'object';
        r.stt = !!(window.OrionSTT && OrionSTT.PRESETS);
        /* adapter AI (ORION-AI-CORE): const top-level = global lexical binding, tidak di window */
        r.ai = (() => {
          try {
            if (typeof AI !== 'object' || !AI) return { present: false };
            return {
            present: true,
            chatType: typeof AI.chat,
            readyType: typeof AI.ready,
            testType: typeof AI.test,
            endpointType: typeof AI.endpoint,
            buildEndpointType: typeof (AI.buildEndpoint || AI.endpoint),
            validateModelType: typeof AI.validateModel,
            statusType: typeof AI.status,
            headersType: typeof AI.headers,
            protocolType: typeof AI.protocol,
            /* kontrak inti tanpa jaringan */
            readyBeforeConfig: AI.ready(),
            geminiRouterModel: (() => { const v = AI.validateModel('google/gemini-3.5-flash-lite', 'gemini'); return { ok: v.ok, reason: v.reason || null, suggest: v.suggest || null }; })()
          };
          } catch (e) { return { present: 'error', error: e.message }; }
        })();
        r.endpointNoConfig = (() => { try { return AI.endpoint('generate') || ''; } catch (e) { return '' } })();
        /* Settings memuat pemilih protokol (st-proto) */
        r.gotoSettings = (() => { try { go('settings'); return !!document.querySelector('#st-proto'); } catch (e) { return 'error: ' + e.message; } })();
        r.gotoHub = (() => { try { go('hub'); return !!document.querySelector('#hub-wrap'); } catch (e) { return 'error: ' + e.message; } })();
        r.gotoChat = (() => { try { go('chat'); return !!document.querySelector('#chat-root'); } catch (e) { return 'error: ' + e.message; } })();
  r.gotoSchedule = (() => { try { go('schedule'); return !!document.querySelector('#schedule-wrap .card'); } catch (e) { return 'error: ' + e.message; } })();
  r.gotoSettings2 = (() => { try { go('settings'); return !!document.querySelector('#set-nav [data-setcat="model"]'); } catch (e) { return 'error: ' + e.message; } })();
        r.gotoMemory = (() => { try { go('memory'); return !!document.querySelector('#memory-provenance-wrap'); } catch (e) { return 'error: ' + e.message; } })();
        r.gotoMemory2 = (() => { try { go('memory'); return !!document.querySelector('#memory-list'); } catch (e) { return 'error: ' + e.message; } })();
        r.hubSkillVersions = (() => { try { go('hub'); return !!(window.OrionHub && document.querySelector('#hub-wrap')); } catch (e) { return 'error: ' + e.message; } })();
        r.centralCard = (() => { try { go('settings'); return !!document.querySelector('#central-card') || !!document.querySelector('[data-cat="central"]'); } catch (e) { return 'error: ' + e.message; } })();
        r.bodyZoom = (() => { try { const z = parseFloat(getComputedStyle(document.body).zoom || '1'); return isFinite(z) ? z : -1; } catch (e) { return -1; } })();
        r.bootGone = !document.querySelector('#boot');
      } catch (e) { r.fatal = e.message; }
      return r;
    })()`);
    clearTimeout(timer);
    /* cek ulang overlay boot setelah window animasinya berakhir (boot ±2,4 dtk) */
    let bootGoneLate = probe.bootGone;
    if (!bootGoneLate) {
      await new Promise(r => setTimeout(r, 4000));
      bootGoneLate = await win.webContents.executeJavaScript("!document.querySelector('#boot')");
    }
    const bad = [];
    if (!probe.desktopBridge) bad.push('orionDesktop tidak terpasang');
    if (!probe.hubInstalled) bad.push('OrionHub tidak terpasang');
    if (!probe.stt) bad.push('OrionSTT tidak terpasang');
    if (!probe.ai || !probe.ai.present) bad.push('adapter AI (window.AI) tidak terpasang');
    else {
      if (probe.ai.chatType !== 'function') bad.push('AI.chat hilang');
      if (probe.ai.readyType !== 'function' || probe.ai.testType !== 'function') bad.push('AI.ready/test hilang');
      if (probe.ai.validateModelType !== 'function') bad.push('AI.validateModel hilang');
      if (probe.ai.geminiRouterModel.ok !== false) bad.push('validasi model router gemini tidak menolak');
    }
    if (probe.gotoSettings !== true) bad.push('Settings tanpa pemilih protokol: ' + probe.gotoSettings);
    if (probe.gotoHub !== true) bad.push('view Desktop Hub gagal: ' + probe.gotoHub);
    if (probe.gotoChat !== true) bad.push('view Chat gagal: ' + probe.gotoChat);
  if (probe.gotoSchedule !== true) bad.push('view Schedule gagal: ' + probe.gotoSchedule);
  if (probe.gotoSettings2 !== true) bad.push('kategori Settings gagal: ' + probe.gotoSettings2);
    if (probe.gotoMemory !== true) bad.push('view Memory Brain gagal: ' + probe.gotoMemory);
    if (probe.gotoMemory2 !== true) bad.push('daftar memori gagal: ' + probe.gotoMemory2);
    if (probe.hubSkillVersions !== true) bad.push('Desktop Hub gagal: ' + probe.hubSkillVersions);
    if (probe.centralCard !== true) bad.push('kategori Orion Central gagal: ' + probe.centralCard);
    if (!(probe.bodyZoom >= 0.79 && probe.bodyZoom <= 1.31)) bad.push('skala body abnormal saat boot: ' + probe.bodyZoom + ' (UI bisa menyusut jadi "layar kosong")');
    if (!bootGoneLate) bad.push('overlay boot masih terpasang setelah animasi boot (init mungkin gagal)');
    if (errors.length) bad.push('console errors: ' + errors.slice(0, 5).join(' || '));
    if (bad.length) { out({ ok: false, error: bad.join('; '), probe, consoleErrors: errors.slice(0, 10) }); code = 1; }
    else { out({ ok: true, probe: Object.assign({}, probe, { ai: undefined, mcp: '' }) }); code = 0; }
  } catch (e) {
    clearTimeout(timer);
    out({ ok: false, error: String((e && e.message) || e), errors: errors.slice(0, 10) });
    code = 1;
  }
  app.exit(code);
});
