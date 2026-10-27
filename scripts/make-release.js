'use strict';
/* Finalisasi release: salin artefak final ke release/, hitung SHA-256 dari HASIL SALINAN,
 * tulis SHA256SUMS.txt dan release-manifest.json.
 *   node scripts/make-release.js
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const distDir = path.join(root, 'dist', 'modern');
const relDir = path.join(root, 'release');
const ver = pkg.version;

const wanted = [
  `ORION-Setup-${ver}-x64.exe`,
  `ORION-Portable-${ver}-x64.exe`,
  `ORION-${ver}-x64.zip`, /* distr per pasangan updater; ikut bila ada */
  `ORION-${ver}-x64.zip.blockmap`,
  'latest.yml'
].filter(Boolean);

if (!fs.existsSync(relDir)) fs.mkdirSync(relDir, { recursive: true });
const files = [];
for (const name of wanted) {
  const src = path.join(distDir, name);
  if (!fs.existsSync(src)) { console.log('  (lompatan, tidak ada di dist: ' + name + ')'); continue; }
  const dst = path.join(relDir, name);
  fs.copyFileSync(src, dst);
  const buf = fs.readFileSync(dst);
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  files.push({ name, sizeBytes: buf.length, sha256 });
}

const shaSums = files.map(f => `${f.sha256}  ${f.name}`).join('\n');
fs.writeFileSync(path.join(relDir, 'SHA256SUMS.txt'), shaSums + '\n');

let commit = null;
try { execFile('git', ['-C', root, 'rev-parse', 'HEAD'], { timeout: 5000 }, (e, so) => { commit = e ? null : String(so).trim(); writeManifest(); }); }
catch (e) { writeManifest(); }
function writeManifest() {
  let verification = null;
  try { verification = JSON.parse(fs.readFileSync(path.join(relDir, 'verification.json'), 'utf8')); } catch (e) { /* belum dijalankan */ }
  const manifest = {
    product: pkg.productName || 'ORION',
    description: 'ORION — AI Strategic Partner / Sovereign Intelligence OS (desktop)',
    version: ver,
    commit: commit,
    platform: 'win32',
    architecture: 'x64',
    buildTimestampUTC: new Date().toISOString(),
    artifacts: files,
    codeSigning: { signed: false, note: 'Tidak ada sertifikat code-signing tersedia — exe tidak bertanda tangan; SmartScreen akan memberi peringatan (lebih dulu: klik More info → Run anyway).' },
    validation: verification ? {
      startedAtUTC: verification.startedAtUTC,
      platform: verification.platform,
      allPass: verification.ok,
      checks: verification.checks
    } : { runVerificationFirst: 'node scripts/verify-release.js' },
    notes: [
      'Checksum dihitung dari file salinan final di release/ (bukan file sementara).',
      'Pembaruan otomatis: hanya installer NSIS modern yang ikut latest.yml; portable tidak auto-update.',
      'Portable menyimpan data di ORION-Portable-Data di samping .exe bila folder dapat ditulisi (fallback: %APPDATA%\\ORION).'
    ]
  };
  fs.writeFileSync(path.join(relDir, 'release-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  console.log('release/finalisasi selesai: ' + files.map(f => f.name).join(', '));
}
