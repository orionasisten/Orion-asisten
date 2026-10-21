'use strict';
/* Uji nyala (startup smoke test) di Electron asli:
 *   npm run smoke
 *   (atau: node_modules/.bin/electron scripts/smoke-electron.js)
 *
 * Memuat app/index.html di jendela tersembunyi dengan konfigurasi keamanan yang sama seperti
 * src/main.js, mendaftarkan jembatan IPC seperti aplikasi sungguhan, lalu memeriksa bahwa
 * adapter AI benar-benar terpasang dan berperilaku benar di renderer Electron.
 *
 * TIDAK memanggil jaringan dan TIDAK memakai API key — jadi ini BUKAN bukti integrasi provider nyata.
 * Folder data dialihkan ke direktori sementara agar konfigurasi ORION milik pengguna tidak tersentuh.
 */
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const INDEX = path.join(__dirname, '..', 'app', 'index.html');
const TIMEOUT_MS = 30000;
const out = o => process.stdout.write(JSON.stringify(o) + '\n');

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
  win.webContents.on('console-message', (_e, level, message) => { if (level >= 2) errors.push(message); });
  win.webContents.on('render-process-gone', (_e, d) => { out({ ok: false, error: 'renderer gone: ' + JSON.stringify(d) }); app.exit(1); });

  try {
    require('../src/bridge').register({
      ipcMain, app, dialog, shell, safeStorage, getWindow: () => win, updater: { check: () => { } }
    });
  } catch (e) {
    out({ ok: false, error: 'gagal mendaftarkan bridge: ' + String((e && e.message) || e) });
    app.exit(1); return;
  }

  const timer = setTimeout(() => { out({ ok: false, error: 'timeout memuat renderer' }); app.exit(1); }, TIMEOUT_MS);
  let code = 0;
  try {
    await win.loadFile(INDEX);
    await new Promise(r => setTimeout(r, 800)); // biarkan boot + Desktop Hub selesai
    const probe = await win.webContents.executeJavaScript(`(() => {
      const p = State.settings.provider;
      const bad = AI.validateModel('google/gemini-3.5-flash-lite', 'gemini');
      const G = 'https://generativelanguage.googleapis.com/v1beta';
      return {
        desktopBridge: !!(window.orionDesktop && window.orionDesktop.isDesktop),
        hubInstalled: typeof window.OrionHub === 'object',
        adapterPresent: typeof AI === 'object' && typeof AI.chat === 'function',
        adapterMethodTypes: {
          endpoint: typeof AI.endpoint, chip: typeof AI.chip, test: typeof AI.test,
          discoverModels: typeof AI.discoverModels, buildEndpoint: typeof AI.buildEndpoint,
          validateModel: typeof AI.validateModel, status: typeof AI.status, headers: typeof AI.headers
        },
        protocolStored: p.protocol,
        protocolDetected: AI.detectProtocol(p.base),
        configuredEndpoint: AI.endpoint('generate'),
        authHeaderNames: Object.keys(AI.authHeaders(p.protocol, 'DUMMY-KEY-FOR-TEST')),
        chip: AI.chip(),
        statusState: AI.status().state,
        ready: AI.ready(),
        migrationNotes: (AI.migration && AI.migration.notes) || [],
        geminiNativeFromCompatBase: AI.buildEndpoint('gemini', G + '/openai', 'models/gemini-2.5-flash', 'generate'),
        openaiRouterEndpoint: AI.buildEndpoint('openai', 'https://openrouter.ai/api/v1', 'google/gemini-3.5-flash-lite', 'generate'),
        rootCauseScenario: { ok: bad.ok, reason: bad.reason, suggest: bad.suggest },
        settingsHasProtocolSelect: (() => { go('settings'); return !!document.querySelector('#st-proto'); })(),
        hubConnectorsRenderable: (() => { try { go('hub'); return !!document.querySelector('#hub-wrap'); } catch (e) { return 'error: ' + e.message; } })()
      };
    })()`);
    clearTimeout(timer);
    out({ ok: true, probe, consoleErrors: errors.slice(0, 10) });
  } catch (e) {
    clearTimeout(timer);
    out({ ok: false, error: String((e && e.message) || e) });
    code = 1;
  }
  app.exit(code);
}).catch(e => { out({ ok: false, error: String((e && e.message) || e) }); app.exit(1); });
