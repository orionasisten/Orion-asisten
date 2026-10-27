'use strict';
const { app, BrowserWindow, Menu, shell, session, dialog, ipcMain, safeStorage, systemPreferences } = require('electron');
const path = require('path');
const fs = require('fs');
const bridge = require('./bridge');
const { setup: setupUpdater } = require('./updater');
const { MissionRuntime } = require('./missions/runtime');
const { MissionStore } = require('./missions/store');

app.setAppUserModelId('id.digium.orion');

/* ── Mode portable (lihat docs/WINDOWS_RELEASE.md §Perbedaan installed dan portable):
 * Saat dijalankan dari target "portable" electron-builder, PORTABLE_EXECUTABLE_DIR berisi
 * direktori tempat .exe diletakkan. Data mengikuti folder itu (ORION-Portable-Data) BILA
 * folder tersebut dapat ditulisi; kalau tidak (flashdisk read-only, folder terlindung),
 * fallback ke userData standar dan beri tahu pengguna secara jelas saat app siap.
 * setPath HARUS dipanggil di sini — sebelum modul/data apa pun membaca userData. */
let portableInfo = null; // { dir, fallback: 'default'|'writable-check-failed' }
try {
  const exeRoot = process.env.PORTABLE_EXECUTABLE_DIR;
  if (exeRoot) {
    const dir = path.join(exeRoot, 'ORION-Portable-Data');
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, '.tulis-tes');
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    app.setPath('userData', dir);
    app.setPath('sessionData', path.join(dir, 'sessions'));
    app.setPath('crashDumps', path.join(dir, 'crashes'));
    portableInfo = { dir, fallback: null };
  }
} catch (e) {
  portableInfo = { dir: null, fallback: ' penyimpanan portable tidak dapat ditulisi (' + String((e && e.code) || e.message) + '), data dipakai di direktori pengguna standar' };
}

/* ── Log diagnostik main process: userData/logs/orion-main.log (maks 2 MB, rotasi ke .1).
 * Hanya peristiwa lifecycle & error startup; TANPA API key/token/isi kredensial. */
let LOG = '';
function logLine(tag, msg) {
  try {
    if (!LOG) {
      LOG = path.join(app.getPath('userData'), 'logs', 'orion-main.log');
      fs.mkdirSync(path.dirname(LOG), { recursive: true });
      try { const st = fs.statSync(LOG); if (st.size > 2 * 1024 * 1024) fs.renameSync(LOG, LOG.replace(/\.log$/, '.1.log')); } catch (x) { /* belum ada */ }
    }
    fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${tag} ${String(msg).replace(/\s+/g, ' ').slice(0, 2000)}\n`);
  } catch (e) { /* kegagalan log tidak boleh menghentikan aplikasi */ }
}
process.on('uncaughtException', e => { logLine('fatal', (e && e.stack) || e || 'unknown'); dialog.showErrorBox('ORION', 'Terjadi kesalahan internal yang tidak tertangani.\nAplikasi ditutup.\n\nLog: ' + (LOG || '(log belum tersedia)') + '\n\n' + String((e && e.message) || e).slice(0, 500)); app.exit(1); });

let win = null;
let updater = null;
const INDEX = path.join(__dirname, '..', 'app', 'index.html');
const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

function loadWinState() {
  try { return JSON.parse(fs.readFileSync(stateFile(), 'utf8')); } catch (e) { return {}; }
}
function saveWinState() {
  if (!win || win.isDestroyed()) return;
  try {
    const b = win.getNormalBounds();
    fs.writeFileSync(stateFile(), JSON.stringify({ width: b.width, height: b.height, max: win.isMaximized() }));
  } catch (e) { /* abaikan */ }
}

// Aplikasi ini memuat HTML lokal; semua endpoint AI/provider dipanggil dari renderer.
// Provider sering tidak mengirim header CORS untuk origin file://, jadi header ditambahkan
// HANYA untuk request yang berasal dari jendela ORION sendiri.
function installCorsShim() {
  const filter = { urls: ['http://*/*', 'https://*/*'] };
  session.defaultSession.webRequest.onHeadersReceived(filter, (details, cb) => {
    if (!win || details.webContentsId !== win.webContents.id) return cb({});
    const h = {};
    Object.keys(details.responseHeaders || {}).forEach(k => {
      if (!/^access-control-/i.test(k)) h[k] = details.responseHeaders[k];
    });
    h['Access-Control-Allow-Origin'] = ['*'];
    // Catatan: wildcard '*' TIDAK mencakup Authorization, jadi harus dicantumkan eksplisit.
    h['Access-Control-Allow-Headers'] = ['Authorization, Content-Type, Accept, X-Requested-With, x-api-key, api-key, x-goog-api-key, anthropic-version, anthropic-dangerous-direct-browser-access, OpenAI-Organization, OpenAI-Beta, HTTP-Referer, X-Title, *'];
    h['Access-Control-Allow-Methods'] = ['GET, POST, PUT, PATCH, DELETE, OPTIONS'];
    const out = { responseHeaders: h };
    if (details.method === 'OPTIONS') out.statusLine = 'HTTP/1.1 200 OK';
    cb(out);
  });
}

function installPermissions() {
  const allowed = new Set(['media', 'clipboard-sanitized-write', 'notifications', 'fullscreen']);
  session.defaultSession.setPermissionCheckHandler((wc, permission) => allowed.has(permission));
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    if (!allowed.has(permission)) return cb(false);
    if (permission === 'media' && process.platform === 'darwin' && systemPreferences.askForMediaAccess) {
      systemPreferences.askForMediaAccess('microphone').then(cb, () => cb(false));
      return;
    }
    cb(true);
  });
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const send = m => () => { if (win) win.webContents.send('orion:menu', m); };
  const tpl = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'Berkas',
      submenu: [
        { label: 'Desktop Hub', accelerator: 'CmdOrCtrl+Shift+H', click: send('go-hub') },
        { label: 'Pilih Workspace…', accelerator: 'CmdOrCtrl+Shift+O', click: send('choose-workspace') },
        { type: 'separator' },
        { label: 'Buka Folder Data', click: () => shell.openPath(app.getPath('userData')) },
        { label: 'Buka Folder Skills', click: send('open-skills') },
        { label: 'Buka Folder Plugins', click: send('open-plugins') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit', label: 'Keluar' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: 'Bantuan',
      submenu: [
        { label: 'Periksa Pembaruan…', click: () => { if (updater) updater.check(true); } },
        { label: 'Tentang ORION', click: () => app.showAboutPanel() }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(tpl));
}

function createWindow() {
  if (!fs.existsSync(INDEX)) {
    logLine('startup', 'app/index.html tidak ditemukan: ' + INDEX);
    dialog.showErrorBox('ORION', 'Berkas app/index.html belum dibuat.\nJalankan: npm run prepare:app');
    app.quit();
    return;
  }
  const st = loadWinState();
  win = new BrowserWindow({
    width: st.width || 1440,
    height: st.height || 900,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#07090D',
    title: 'ORION',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
      webSecurity: true
    }
  });
  if (st.max) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('close', saveWinState);
  win.on('closed', () => { win = null; });

  /* Diagnostik renderer → log main process (tanpa isi data sensitif; render sudah tidak punya secret). */
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    // level: 0=verbose 1=info 2=warning 3=error
    if (level < 2) return;
    logLine('console', 'L' + level + ' ' + String(message || '').slice(0, 500) + ' @' + String(sourceId || '').replace(/^file:\/\/[^/]*\//, '') + ':' + (line || ''));
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => logLine('load', 'did-fail-load ' + code + ' ' + desc + ' ' + (url || '')));
  win.webContents.on('render-process-gone', (_e, d) => {
    logLine('renderer', 'render-process-gone ' + JSON.stringify({ reason: d.reason, exitCode: d.exitCode }));
    try {
      dialog.showMessageBox(win || undefined, { type: 'error', title: 'ORION', message: 'Bagian tampilan ORION berhenti mendadak (' + d.reason + ').',
        detail: 'Coba jalankan ulang aplikasi. Bila berulang, laporkan berkas log:\n' + LOG + '\n(kode keluar: ' + d.exitCode + ')' });
    } catch (x) { /* window mungkin sudah hilang */ }
  });

  // Link eksternal dibuka di browser sistem; navigasi keluar dari app diblokir.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  win.loadFile(INDEX);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    let missionRuntime = null;
    try {
      const missionDir = path.join(app.getPath('userData'), 'missions');
      missionRuntime = new MissionRuntime(new MissionStore(missionDir));
      logLine('mission', 'runtime ready dir=' + missionDir);
    } catch (e) { logLine('mission', 'runtime init failed: ' + String((e && e.message) || e)); }
    if (portableInfo) logLine('portable', 'dir=' + (portableInfo.dir || '(fallback)') + (portableInfo.fallback ? ' fallback:' + portableInfo.fallback : ''));
    logLine('startup', 'ORION v' + app.getVersion() + ' electron=' + process.versions.electron + ' packaged=' + app.isPackaged + ' userData=' + app.getPath('userData'));
    if (portableInfo && portableInfo.fallback) {
      dialog.showMessageBox({ type: 'warning', title: 'ORION — mode portable',
        message: 'Folder berisi ORION tidak dapat ditulisi, jadi data simpanan menggunakan lokasi standar:',
        detail: app.getPath('userData') + '\n\n' + portableInfo.fallback.trim() + '.\nSimpanan portable tidak ikut berpindah bersama berkas .exe ini.' });
    }
    app.setAboutPanelOptions({ applicationName: 'ORION', applicationVersion: app.getVersion(), copyright: '© DIGIUM' });
    installCorsShim();
    installPermissions();
    updater = setupUpdater({ app, dialog, shell, getWindow: () => win });
    bridge.register({ ipcMain, app, dialog, shell, safeStorage, getWindow: () => win, updater, missionRuntime });
    buildMenu();
    createWindow();
    setTimeout(() => { updater.check(false); }, 15000); // pemeriksaan senyap; hanya bertanya bila ada versi baru
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

