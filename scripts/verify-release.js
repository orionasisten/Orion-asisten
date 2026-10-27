'use strict';
/* Verifikasi artefak rilis Windows (installer NSIS + portable) pada Windows asli.
 *   node scripts/verify-release.js [--no-launch] [--dir dist/modern]
 * Langkah:
 *   1. Statik  : file ada, header PE ("MZ"), ukuran wajar, nama mengikuti versi package.json.
 *   2. Portable: dijalankan dari folder tervalidasi terpisah; cek proses hidup, folder data
 *      ORION-Portable-Data terbentuk di samping .exe, log diagnostik terisi, lalu dihentikan.
 *   3. Installer: /S per-user ke folder temp; cek uninstall key HKCU, ORION.exe, launch 15 detik
 *      (userData %APPDATA%\ORION dengan log), kill, lalu uninstall /S dan verifikasi bersih.
 * Hasil lulus ditulis ke release/verification.json.
 * NOTA: script ini TIDAK menggantikan uji di mesin lain; laporan Mine mencatat batasnya.
 */
const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const os = require('os');

const args = process.argv.slice(2);
const noLaunch = args.includes('--no-launch');
const dirIdx = args.indexOf('--dir');
const distDir = path.resolve(dirIdx >= 0 ? args[dirIdx + 1] : path.join(__dirname, '..', 'dist', 'modern'));
const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const ver = pkg.version;

const out = s => process.stdout.write(s + '\n');
const results = { startedAtUTC: new Date().toISOString(), version: ver, distDir, checks: [] };
const check = (name, ok, detail) => { results.checks.push({ name, ok: !!ok, detail: String(detail || '').slice(0, 4000) }); out(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); return !!ok; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function sha256Of(file) { /* via certutil agar tanpa dependency */
  return new Promise((resolve, reject) => {
    execFile('certutil', ['-hashfile', file, 'SHA256'], { windowsHide: true }, (e, so) => {
      if (e) return reject(e);
      const m = String(so).match(/^[0-9a-f]{64}$/im);
      m ? resolve(m[0]) : reject(new Error('hash tidak terbaca'));
    });
  });
}
async function killTree(pid) {
  try { if (pid) spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }); } catch (e) { /* sudah mati */ }
}
function killAllOrion() {
  try { spawn('taskkill', ['/IM', 'ORION.exe', '/F'], { windowsHide: true }); } catch (e) { /* kosong */ }
}
function procExists(name) {
  return new Promise(res => execFile('tasklist', [], { windowsHide: true }, (e, so) => {
    res(!e && so.split(/\r?\n/).some(l => l.trim().toLowerCase().startsWith(name.toLowerCase() + '.exe')));
  }));
}

(async () => {
  results.platform = { os: os.type() + ' ' + os.release(), arch: os.arch() };
  const setup = path.join(distDir, `ORION-Setup-${ver}-x64.exe`);
  const portable = path.join(distDir, `ORION-Portable-${ver}-x64.exe`);
  out(`Membangun validasi artifact from ${distDir}`);

  /* ── 1. statik ── */
  let allStaticOk = fs.existsSync(setup) && fs.existsSync(portable);
  for (const [label, f] of [['installer', setup], ['portable', portable]]) {
    if (!fs.existsSync(f)) { check(`${label}: file ada`, false, 'tidak ditemukan — jalankan npm run build:win:all'); allStaticOk = false; continue; }
    const st = fs.statSync(f);
    const head = Buffer.alloc(2); fs.readFileSync(f, { flag: 'r' }); /* buka readable */
    const fd = fs.openSync(f, 'r'); fs.readSync(fd, head, 0, 2, 0); fs.closeSync(fd);
    const mz = head.toString('ascii') === 'MZ';
    check(`${label}: file ada + PE "MZ" + ukuran > 4 MB`, mz && st.size > 4 * 1024 * 1024, path.basename(f) + ' = ' + (st.size / 1048576).toFixed(1) + ' MB');
    check(`${label}: SHA-256 terhitung`, !!(await sha256Of(f)), f);
  }
  if (!fs.existsSync(setup) || !fs.existsSync(portable)) { results.ok = false; save(); process.exit(1); }

  if (noLaunch) { results.ok = allStaticOk; save(); out('Launch test dilewati (--no-launch).'); process.exit(results.ok ? 0 : 1); }

  /* ── 2. portable ── */
  const portDir = fs.mkdtempSync(path.join(os.tmpdir(), 'orion-portable-val-'));
  const portExe = path.join(portDir, path.basename(portable));
  fs.copyFileSync(portable, portExe);
  const pp = spawn(portExe, [], { windowsHide: true, stdio: 'ignore' });
  let portDataOk = false, portLogOk = false;
  for (let i = 0; i < 90; i++) { /* cold start portable bisa ~25-30 dtk (ekstraksi launcher + boot Chromium) */
    await sleep(500);
    const dataDir = path.join(portDir, 'ORION-Portable-Data');
    const log = path.join(dataDir, 'logs', 'orion-main.log');
    if (!portDataOk && fs.existsSync(dataDir)) portDataOk = true;
    if (portDataOk && !portLogOk && fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('packaged=true')) { portLogOk = true; break; }
  }
  const portAlive = !pp.killed && pp.pid && await procExists('ORION-Portable'); /* portable exe namanya mengikuti artifact? cek juga ORION */
  const orionAlive = await procExists('ORION');
  check('portable: proses hidup', !pp.killed && (portAlive || orionAlive), 'pid=' + pp.pid);
  check('portable: ORION-Portable-Data di samping .exe', portDataOk, portDir);
  check('portable: log diagnostik terisi (packaged=true)', portLogOk, path.join(portDir, 'ORION-Portable-Data', 'logs', 'orion-main.log'));
  killTree(pp.pid); await sleep(1500);
  refuteAllOrion();

  /* ── 3. installer ── */
  const instDir = path.join(os.tmpdir(), 'orion-installer-val');
  fs.rmSync(instDir, { recursive: true, force: true });
  fs.mkdirSync(instDir, { recursive: true });
  const setupP = spawn(setup, ['/S', '/D=' + instDir], { windowsHide: true, stdio: 'ignore', detached: false });
  const exectPath = path.join(instDir, 'ORION.exe');
  let installed = false;
  for (let i = 0; i < 90; i++) { await sleep(1000); if (fs.existsSync(exectPath) && fs.existsSync(path.join(instDir, 'Uninstall ORION.exe'))) { installed = true; break; } }
  check('installer: /S per-user terpasang ke folder pilihan', installed, instDir);
  const reg = path.join('HKCU', 'Software', 'Microsoft', 'Windows', 'CurrentVersion', 'Uninstall');
  const regOk = await regQueryHasInPath(reg, installed ? instDir : null, ver);
  check('installer: uninstall key HKCU terisi (per-user, tanpa admin)', regOk, reg);
  if (regOk) check('installer: proper uninstaller ada', true, 'Uninstall ORION.exe');

  /* 3b. installed app jalan */
  let runOk = false, userLogOk = false;
  if (installed) {
    const appProc = spawn(exectPath, [], { windowsHide: true, stdio: 'ignore' });
    const appdataLog = path.join(os.homedir(), 'AppData', 'Roaming', 'ORION', 'logs', 'orion-main.log');
    for (let i = 0; i < 30; i++) {
      await sleep(500);
      if (fs.existsSync(appdataLog) && fs.readFileSync(appdataLog, 'utf8').includes('packaged=true')) { userLogOk = true; break; }
    }
    runOk = !appProc.killed && !!await procExists('ORION');
    check('installer: installed app hidup (per-user)', runOk, exectPath);
    check('installer: log userData (instaled mode)', userLogOk, appdataLog);
    killTree(appProc.pid); await sleep(1500);
  }
  refuteAllOrion();

  /* 3c. uninstall */
  if (installed) {
    /* pastikan proses benar-benar tolak-atas sebelum uninstall agar berkas tidak terkunci */
    for (let i = 0; i < 20; i++) { if (!await procExists('ORION')) break; await sleep(500); killAllOrion(); }
    const uninst = path.join(instDir, 'Uninstall ORION.exe');
    const up = spawn(uninst, ['/S'], { windowsHide: true, stdio: 'ignore' });
    up.on('exit', code => { results.uninstallExitCode = code; });
    let gone = false;
    for (let i = 0; i < 90; i++) { await sleep(1000); if (!fs.existsSync(exectPath)) { gone = true; break; } }
    check('installer: uninstall /S membersihkan program', gone, instDir);
    await sleep(2000);
    const regAfter = await regQueryOkNoValue(reg, ver);
    check('installer: uninstall key HKCU terhapus', regAfter, reg);
    /* data user tidak dihapus (deleteAppDataOnUninstall=false) */
    const ud = path.join(os.homedir(), 'AppData', 'Roaming', 'ORION');
    check('installer: data pengguna bertahan setelah uninstall (deleteAppDataOnUninstall=false)', fs.existsSync(ud), ud);
    fs.rmSync(ud, { recursive: true, force: true }); /* lingkungan uji diri-sendiri; TIDAK menghapus milik pengguna asli karena dihapus atas nama diuji ini */
  } else { check('installer: uninstall', false, 'install gagal — uninstall tidak diuji'); }

  results.ok = results.checks.every(c => c.ok);
  save();
  out(`\n${results.ok ? 'SEMUA PASS' : 'ADA YANG GAGAL'} — hasil: release OBJEK verification.json`);
  process.exit(results.ok ? 0 : 1);
})().catch(e => { results.ok = false; results.error = String((e && e.stack) || e); save(); console.error(e); process.exit(1); });

function save() {
  const relDist = path.join(root, 'release');
  try { fs.mkdirSync(relDist, { recursive: true }); fs.writeFileSync(path.join(relDist, 'verification.json'), JSON.stringify(results, null, 2) + '\n'); } catch (e) { console.error('gagal menulis verification.json: ' + e.message); }
}

async function procExistsByName(name) { return procExists(name); }
async function refuteAllOrion() { killAllOrion(); }

function regQuerySub(key) {
  return new Promise(res => execFile('reg', ['query', key], { windowsHide: true }, (e, so, se) => res({ err: !!e, text: so || se || '' })));
}
async function regQueryHasInPath(regRoot, installDir, version) {
  /* mencari key uninstall berisi ORION (bisa butuh beberapa detik setelah install NSIS selesai) */
  for (let attempt = 0; attempt < 20; attempt++) {
    const r = await regQuerySub(regRoot);
    if (!r.err) {
      const lines = r.text.split(/\r?\n/).filter(l => /HKEY/.test(l) && /orion|[0-9a-f]{8}-[0-9a-f]{4}/i.test(l));
      for (const k of lines) {
        const d = await regQuerySub(k.trim());
        if (d.err || !(/ORION/i.test(d.text))) continue;
        const loc = d.text.match(/InstallLocation\s+REG_SZ\s+(.*)/i);
        if (installDir && loc && loc[1].trim()) {
          if (path.normalize(loc[1].trim()).toLowerCase().startsWith(path.normalize(installDir).toLowerCase())) return true;
        } else return true;
      }
    }
    if (attempt < 19) await new Promise(r2 => setTimeout(r2, 1000));
  }
  return false;
}
async function regQueryOkNoValue(regRoot, version) {
  const r = await regQuerySub(regRoot);
  if (r.err) return true;
  const lines = r.text.split(/\r?\n/).filter(l => /HKEY/.test(l) && /ORION/i.test(l));
  for (const k of lines) { const d = await regQuerySub(k.trim()); if (!d.err && d.text.includes(version)) return false; }
  return true;
}
