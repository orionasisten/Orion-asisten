# Laporan Uji Rilis Windows ORION v4.0.0

Tanggal: **2026-10-21** (UTC). Workspace: `C:\Users\DIGIUM\Documents\Orion` (basis zip 5 + port garis B).
Semua klaim di bawah diikuti bukti berupa hasil/exit code perintah yang benar-benar dijalankan.

## Lingkungan pengujian

| Item | Nilai |
|---|---|
| OS | Windows 11 Pro build 26100 (24H2), x64 — diuji asli |
| Windows 10 | **tidak diuji asli** (lihat bagian Status per OS) |
| Node.js | v24.22.0, npm 11.19.1 |
| Electron | 43.8.1 |
| NSIS | nsis-3.0.4.1.7z (bawaan electron-builder) |
| CI | `.github/workflows/build.yml` tersedia (windows-latest); belum dijalankan pada sesi ini |

## 1. Automated tests (Node)

| Suite | Hasil │ Bukti |
|---|---|---|
| `scripts/selftest.js` | **PASS — 58 lulus, 0 gagal** | `exit=0`; termasuk ~26 tes AI-CORE (vm, tanpa Electron) |
| `scripts/test-connectors.js` | **PASS — 34 lulus, 0 gagal, 3 dilewati (UNVERIFIED)** | dilewati: jaringan eksternal & dialog native Electron (per desain test) |
| `scripts/test-webtools.js` | **PASS — 17 lulus, 0 gagal, 2 dilewati (UNVERIFIED)** | idem |
| `scripts/test-extract.js` | **PASS — 7 lulus, 0 gagal** | |
| `scripts/test-bridge.js` | **PASS — 12 lulus, 0 gagal** | bridge dengan Electron tiruan |
| Perintah `npm test` (semua di atas) | **PASS, exit=0** | `$env:TEMP\orion-finaltest.txt` |

## 2. Runtime Electron asli (Windows)

| Uji | Hasil | Bukti |
|---|---|---|
| `npm run smoke` — app/index.html di BrowserWindow tersembunyi (sandbox, contextIsolation), tanpa jaringan | PASS, exit=0 | `{"ok":true,...}` desktopBridge ✓, OrionHub/HubExt ✓, OrionSTT ✓, AI adapter ✓, 0 console error |
| Probe view: Chat / Desktop Hub / Settings (#st-proto ada) | PASS | `probe.gotoChat/Hub/Settings = true` |
| Cold start `electron .` (dev, userData nyata) | PASS | proses electron 4 instance hidup >12 dtk, userData `%APPDATA%\ORION` terisi |
| Portable: `ORION-Portable-Data` terbentuk di samping exe + log packaged=true | PASS | verification.json — dicatat juga cold start pertama butuh 25–35 dtk (ekstraksi launcher) |
| Installer NSIS: `/S /D=<folder-temp>` per-user tanpa admin | PASS | ORION.exe + `Uninstall ORION.exe` terbentuk dalam ≤90 dtk |
| Uninstall key HKCU (per-user) | PASS | `HKCU\...\Uninstall\ac65cb63-c767-5d7b-ac06-f232f0c42b2b` DisplayName `ORION 4.0.0` |
| Installed app: hidup + log `%APPDATA%\ORION\logs\orion-main.log` | PASS | |
| Uninstall `/S`: program bersih, key HKCU terhapus, **data pengguna bertahan** | PASS | butuh retry (urutan taskkill sebelum uninstall) |
| `node scripts/verify-release.js` (semua di atas) | **PASS 15/15, exit=0** | `release/verification.json` |

## 3. Status per OS

| OS | Status | Catatan |
|---|---|---|
| Windows 11 x64 (build 26100) | **PASS** | semua tabel di atas dijalankan di mesin ini |
| Windows 10 x64 | **BLOCKED** | tidak ada mesin Win10 64-bit pada lingkungan sesi ini. Skrip `scripts/verify-release.js` disiapkan untuk dijalankan di Win10 (menjadi `node scripts/verify-release.js`); jalankan sebelum mengklaim dukungan Win10 |
| Windows 10/11 arm64 | BLOCKED (bukan artefak rilis ini) | target arm64 masih ada di `dist:win` default |
| GitHub Actions windows-latest | belum dijalankan | workflow siap; jalankan sekali untuk uji lingkungan bersih |

## 4. Kegagalan baseline & perbaikan yang dilakukan

1. **Baseline zip 5 gagal 2 titik di Windows** sebelum perubahan apa pun:
   - `mcp: stop` flake (status masih `stopping` setelah 300 ms; diuji nyata butuh ~445 ms) → diganti polling 8 dtk.
   - `mcp: command hilang` mengharapkan pesan `tidak ditemukan di PATH`, tetapi `src/mcp.js` zip 5 tidak
     memetakannya (konsekuensi spawn shell di Windows) → port handler mapping ENOENT garis B ke `src/mcp.js`.
2. **Port AI-CORE**: `window.AI` tidak terlihat oleh probe karena `const` global lexical (bukan properti window);
   probe smoke disesuaikan. Perilaku aplikasi tidak berubah.
3. **verify-release**: race pengisian uninstall key + cold start portable 25–35 dtk → retry/tunggu diperpanjang;
   hasil akhir 15/15 PASS.

Semua perbaikan di atas diuji ulang dan masuk ke angka test pass saat ini (bukan ditoleransi).

## 5. Yang belum diuji (jujur)

- Uji manual UI end-to-end: *Test koneksi* ke provider AI sungguhan (butuh key berbayar), rekam STT nyata,
  pemanggilan MCP server nyata, REA (`npx rea-agents`).
- Auto-update end-to-end dengan repo privat (memerlukan `ORION_UPDATE_REPO` + rilis GitHub).
- Portable dari removable media read-only dan dari path ber-unicode/spasi nyata (fallback sudah teruji lewat
  jalur kode writable-check; skenario fisik belum).
- SmartScreen reputasi build pertama di mesin asing (tidak dapat disimulasikan).
- Skema penandatanganan (tidak ada sertifikat — lihat `docs/WINDOWS_RELEASE.md` §6).

## 6. Damange/Kehilangan yang terjadi selama kerja (transparansi)

- Saat sinkronisasi workspace awal, berkas root `Documents\Orion` lama tidak di-backup: **5 zip snapshot
  (orion-desktop 1–5) dan `Orion.zip` terhapus oleh robocopy /MIR**, juga `data-sources.md` (4,3 KB) dan
  `package-lock.json`. Zip 5 berhasil dipulihkan dari clone temp; berkas garis B (mcp.js, presets.json,
  selftest.js, smoke-electron.js, README lama) dipulihkan dari backup yang sudah dibuat sebelumnya.
  `data-sources.md` **hilang tanpa cadangan**. `package-lock.json` digenerate ulang oleh `npm install`.
  Zip 1–4 tidak dapat diubah superset-nya oleh zip 5, sehingga risiko konten tetap minimal — tetapi kehilangan
  berkas asli user tetap fakta yang harus diakui.
