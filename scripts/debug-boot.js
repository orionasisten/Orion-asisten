'use strict';
/* Potret boot renderer untuk analisis; memakai userData sama seperti nonportable agar data pengguna asli ikut. */
const { app, BrowserWindow } = require('electron');
const path = require('path');
const INDEX = path.join(__dirname, '..', 'app', 'index.html');
app.whenReady().then(() => {
  const win = new BrowserWindow({
    width: 1280, height: 800, show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'src', 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false }
  });
  win.webContents.on('console-message', (e, level, msg) => { console.log('CONSOLE L' + level + ': ' + String(msg).slice(0, 600)); });
  win.webContents.on('did-fail-load', (e, code, desc, url) => console.log('FAIL-LOAD ' + code + ' ' + desc + ' ' + url));
  win.webContents.on('did-finish-load', () => console.log('FINISH-LOAD'));
  win.loadFile(INDEX);
  setTimeout(async () => {
    try {
      const d = await win.webContents.executeJavaScript('JSON.stringify((function(){' +
        'var boot=document.querySelector("#boot");' +
        'return {bootStill: !!boot,' +
        'bootText: boot ? (boot.textContent||"").slice(0,200) : null,' +
        'shell: !!document.querySelector("#shell"),' +
        'navItems: document.querySelectorAll("#nav-list li[data-view]").length,' +
        'bodyTags: [].slice.call(document.body.children,0,12).map(function(x){return x.id||x.tagName;}),' +
        'firstErr: (window.__orionLastError||null),' +
        'htmlLen: String(document.body.innerHTML||"").length};})())', true);
      console.log('DOM ' + d);
    } catch (e) { console.log('EXEC-ERR ' + e.message); }
    console.log('DONE');
    app.exit(0);
  }, 9000);
});
