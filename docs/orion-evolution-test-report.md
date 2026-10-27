# ORION Evolution Test Report

Tanggal: 21 Okt 2026. Lingkungan: Windows 11, Node.js 24, Electron 43.8.1, npm 11.19.

## Baseline tests

Perintah: `npm test` (selftest + connectors + webtools + extract + bridge).

Hasil: **exit code 0**. Ringkasan:
- `scripts/selftest.js`: **58 pengujian lulus** (termasuk 26 tes AI-CORE vm).
- API Connector Hub: **34 lulus, 0 gagal, 3 dilewati** (total 37).
- Alat web: **17 lulus, 0 gagal, 2 dilewati** (total 19).
- Ekstraksi lampiran: **7 lulus, 0 gagal** (total 7).
- Bridge (Electron tiruan): **12 lulus, 0 gagal** (total 12).
- Total: **128 tes lulus, 0 gagal**, 5 dilewati (eksternal/native, sesuai desain).

## Smoke test (Electron asli)

Perintah: `npm run smoke` (`electron scripts/smoke-electron.js`).

Hasil: `{"ok":true}` — Desktop bridge, Hub, HubExt, STT, AI adapter, Settings, Chat, Schedule, kategori Settings, bodyZoom=1, boot overlay hilang, 0 console error.

## Verifikasi rilis (Windows)

Perintah: `npm run verify:release` (npm test + `scripts/verify-release.js`).

Hasil: **15/15 PASS**:
- Portable: proses hidup, `ORION-Portable-Data` di samping .exe, log diagnostik `packaged=true`.
- Installer: `/S` per-user tanpa admin, uninstall key HKCU terisi, app hidup, log userData, uninstall `/S` membersihkan program, data pengguna bertahan (`deleteAppDataOnUninstall=false`).

## Build

- `npm run build:win:installer` — PASS.
- `npm run build:win:portable` — PASS.
- `npm run release:finalize` — PASS (`release/` berisi 2 exe + SHA256SUMS.txt + release-manifest.json + verification.json).

## Security findings (ringkas)

- SSRF guard: PASS (blokir privat/loopback/link-local/metadata/mapped/NAT64/6to4).
- Path traversal/symlink: PASS.
- Secret redaction: PASS.
- Approval fingerprint: PASS (parameter berubah → approval baru).
- Audit chain hash: PASS (deteksi manipulasi).
- Prompt injection: data diperlakukan sebagai DATA, berlabel, terbatas.

## Remaining blockers

- Windows 10 x64 native test: BLOCKED (tidak ada mesin Win10 di lingkungan; jalankan `node scripts/verify-release.js` di Win10/CI windows-latest).
- Code signing: BLOCKED (tidak ada sertifikat; slot `CSC_LINK`/`CSC_KEY_PASSWORD` siap di CI).
- Backend central, mobile, browser/computer-use: MISSING (fase berikutnya).
- Native dialog tests: UNVERIFIED (Electron tidak dapat dijalankan di sandbox CI; smoke lokal PASS).

## Catatan regresi yang ditemukan & diperbaiki selama evolusi

- Zoom UI bug (skala 1.3%) → layar "kosong" → diperbaiki dengan guard persen 80–130.
- Overlay boot nyangkut → watchdog 15 dtk.
- Console renderer tidak tercatat → dicatat ke log main process.
- Smoke test diperkuat dengan bodyZoom & bootGone.

## Kesimpulan

Baseline stabil: 128 tes Node + smoke Electron + 15/15 verifikasi runtime lulus. Rilis Windows siap (installer + portable + checksum + manifest). Gap besar berikutnya adalah durability/orkestrasi (backend, mission runtime, routing, memory, browser/computer-use) sesuai roadmap.
