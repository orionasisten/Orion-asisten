'use strict';
/**
 * Pembaruan aplikasi lewat GitHub Releases (electron-updater).
 *  - Aktif hanya pada app terpasang, profil "modern", dan bila build dibuat dengan ORION_UPDATE_REPO.
 *  - Tidak pernah mengunduh/memasang diam-diam: selalu bertanya dulu.
 *  - Profil "legacy" (Electron 22) dan portable: pembaruan manual lewat halaman rilis.
 * Dependensi disuntikkan (pkg, updaterLib, isPackaged) agar logikanya bisa diuji tanpa Electron.
 */
function setup(o) {
  const pkg = o.pkg || require('../package.json');
  const repo = pkg.orionRepo || '';
  const profile = pkg.orionProfile || 'modern';
  const url = repo ? `https://github.com/${repo}/releases/latest` : '';
  const packaged = o.isPackaged !== undefined ? o.isPackaged : o.app.isPackaged;
  const ver = () => (o.app.getVersion ? o.app.getVersion() : '?');

  let au = null;
  if (packaged && repo && profile === 'modern') {
    try { au = o.updaterLib || require('electron-updater').autoUpdater; } catch (e) { au = null; }
  }

  let manual = false, busy = false;
  const win = () => (o.getWindow ? o.getWindow() : null);
  const box = opts => o.dialog.showMessageBox(win() || undefined, Object.assign({ type: 'info', noLink: true, title: 'ORION — Pembaruan', defaultId: 0, cancelId: 0 }, opts));
  const progress = v => { const w = win(); if (w && !w.isDestroyed()) w.setProgressBar(v); };

  if (au) {
    au.autoDownload = false;
    au.autoInstallOnAppQuit = false;
    au.on('update-available', async info => {
      const r = await box({ message: `ORION ${info.version} tersedia. Unduh sekarang?`, detail: 'Versi terpasang: ' + ver(), buttons: ['Nanti', 'Unduh'] });
      if (r.response === 1) {
        try { await au.downloadUpdate(); } catch (e) { busy = false; progress(-1); }
      } else busy = false;
    });
    au.on('update-not-available', async () => {
      busy = false;
      if (manual) await box({ message: 'ORION sudah versi terbaru.', detail: 'Versi terpasang: ' + ver() });
      manual = false;
    });
    au.on('download-progress', p => progress(Math.max(0, Math.min(1, (p.percent || 0) / 100))));
    au.on('update-downloaded', async info => {
      progress(-1);
      const r = await box({ message: `ORION ${info.version} siap dipasang.`, detail: 'Aplikasi akan ditutup lalu dibuka kembali.', buttons: ['Nanti', 'Mulai ulang sekarang'] });
      busy = false;
      if (r.response === 1) au.quitAndInstall();
    });
    au.on('error', async e => {
      busy = false; progress(-1);
      const wasManual = manual; manual = false;
      console.error('[updater]', e && e.message);
      if (!wasManual) return; // pemeriksaan otomatis gagal: diam saja
      const r = await box({
        type: 'warning', message: 'Pembaruan otomatis gagal.',
        detail: String((e && e.message) || e).slice(0, 400) + '\n\nAnda bisa mengunduh versi terbaru secara manual.',
        buttons: ['Tutup', 'Buka halaman rilis']
      });
      if (r.response === 1) o.shell.openExternal(url);
    });
  }

  async function check(isManual) {
    manual = !!isManual;
    if (!repo) {
      if (isManual) await box({ message: 'Pembaruan otomatis belum dikonfigurasi.', detail: 'Build ini dibuat tanpa ORION_UPDATE_REPO (format owner/repo GitHub).' });
      return;
    }
    if (!au) {
      if (isManual) {
        const r = await box({
          message: 'Pembaruan manual',
          detail: profile === 'legacy' ? 'Profil legacy tidak memakai pembaruan otomatis. Unduh versi terbaru dari halaman rilis.' : 'Pembaruan otomatis hanya aktif pada aplikasi yang terpasang. Buka halaman rilis?',
          buttons: ['Tutup', 'Buka halaman rilis']
        });
        if (r.response === 1) o.shell.openExternal(url);
      }
      return;
    }
    if (busy) { if (isManual) await box({ message: 'Pemeriksaan pembaruan sedang berjalan.' }); return; }
    busy = true;
    try { await au.checkForUpdates(); } catch (e) { busy = false; /* event 'error' menangani pesan */ }
  }

  return { check, enabled: !!au, repo, profile };
}

module.exports = { setup };
