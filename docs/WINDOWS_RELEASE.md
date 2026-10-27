# Rilis Windows ORION — 4.0.0 (profil modern)

Dokumen ini menjelaskan cara kerja packaging ORION di Windows, perbedaan **installed** vs **portable**,
kebijakan penyimpanan data, prosedur build/upgrade/uninstall, dan status code signing.

## 1. Arsitektur packaging

- Packager: **electron-builder 26** (`electron-builder.config.js`), satu packager untuk semua target.
- Runtime: **Electron 43** (profil `modern`). Profil `legacy` (Electron 22) hanya untuk OS jadul yang
  sudah *end-of-life*, dan **bukan** profil rilis Windows ini.
- Aplikasi di-pack ke **app.asar** (`src/**`, `app/**`, `package.json`). Skill/plugin bundel serta preset
  connector berada sebagai **extraResources** (`resources/` → `<install>\resources\`), di luar asar.
- Entry point: `src/main.js` (main + mode portable + logging) dan `src/preload.js`
  (`contextIsolation + sandbox`, renderer tanpa Node).
- CORS shim, dialog persetujuan native, dan penyimpanan secret (safeStorage/DPAPI) tetap di main process.
- Output di `dist/modern/`:
  - `ORION-Setup-<version>-x64.exe` — NSIS `oneClick:false`, `perMachine:false` (per-user, tanpa admin).
  - `ORION-Portable-<version>-x64.exe` — portable tunggal.
  - `ORION-<version>-x64.zip` + `.blockmap` + `latest.yml` (untuk auto-update via GitHub Releases).

Nama target per-perintah diarahkan lewat env `ORION_TARGET` (`installer` / `portable`) yang dibaca
`electron-builder.config.js`, sehingga `dist:win` (semua target) dan script build baru tetap satu sumber konfigurasi.

## 2. Perbedaan installed vs portable

| Aspek | Installed (NSIS) | Portable |
|---|---|---|
| Shortcut | Start Menu + Desktop | tidak (dibuat manual bila perlu) |
| Uninstall | `Uninstall ORION.exe` + entry HKCU | hapus folder eksenya |
| Data | `%APPDATA%\ORION` (userData) | `<folder exe>\ORION-Portable-Data` bila dapat ditulisi |
| Auto-update | ya, via `latest.yml` (lihat README) | tidak (unduh manual versi baru) |
| Hak admin | tidak perlu | tidak perlu |
| Upgrade data | tidak dihapus (`deleteAppDataOnUninstall:false`) | data ikut folder exe |

## 3. Kebijakan penyimpanan portable

Mode portable dideteksi lewat `PORTABLE_EXECUTABLE_DIR` yang di-set oleh launcher electron-builder;
logika ada di bagian atas `src/main.js` (`portableInfo`) dan **harus** dieksekusi sebelum modul lain
membaca `userData`:

- `ORION-Portable-Data/` berisi:
  - `orion-desktop.json` — konfigurasi + **secret terenkripsi** (safeStorage/DPAPI);
  - `skills/`, `plugins/`, `connectors/` — data pengguna;
  - `logs/orion-main.log` (rotasi ke `.1.log`, maks 2 MB) — log diagnostik main process, **tanpa secret**;
  - `sessions/`, `crashes/` — data runtime Chromium.
- Tes tulis: jika folder berisi exe tidak dapat ditulisi (flashdisk read-only, folder terlindung),
  ORION **fallback** ke `%APPDATA%\ORION` dan menampilkan pesan peringatan yang jelas saat pertama dibuka.
- Kredensial tidak pernah ditulis plaintext — portable memakai safeStorage OS yang sama dengan installed.
- Backup/restore: salin `ORION-Portable-Data` utuh saat aplikasi tertutup.

## 4. Build commands

```bash
npm ci                        # install dependency sesuai lockfile
npm test                      # 58 + 34 + 17 + 7 + 12 test (selftest, connectors, webtools, extract, bridge)
npm run smoke                 # smoke di Electron asli (renderer + bridge + adapter AI, tanpa jaringan)

npm run build:win:installer   # -> dist/modern/ORION-Setup-<version>-x64.exe
npm run build:win:portable    # -> dist/modern/ORION-Portable-<version>-x64.exe
npm run build:win:all         # keduanya + npm test + verify:release + release:finalize

node scripts/verify-release.js     # uji runtime kedua exe (install /S, launch, uninstall, log)
node scripts/make-release.js       # salin artefak final ke release/ + SHA256SUMS.txt + manifest
```

Output final untuk distribusi ada di `release/`: dua `.exe`, `SHA256SUMS.txt`, `release-manifest.json`,
dan `verification.json` (bukti uji runtime). Checksum dihitung dari salinan final, bukan file sementara.

## 5. Troubleshooting

| Gejala | Sebab / solusi |
|---|---|
| SmartScreen "Windows protected your PC" | exe tidak bertanda tangan (§6). More info → Run anyway; verifikasi dulu SHA-256 `SHA256SUMS.txt`. |
| Portable tidak menyimpan di folder exe | folder tidak dapat ditulisi; ORION fallback ke `%APPDATA%` dengan dialog; gunakan folder yang dapat ditulisi. |
| Dua proses ORION di Task Manager saat portable | normal: launcher portable + child Electron. |
| MCP server gagal start di Windows | pesan `"tidak ditemukan di PATH"` berarti binary tidak tersedia (Node/uv belum dipasang) — bukan bug aplikasi. |
| Cold start portable 20–35 dtk | ekstraksi launcher pertama + boot Chromium; bukan kegagalan. |
| App tidak hidup sama sekali | baca log `logs/orion-main.log` (installed: `%APPDATA%\ORION\logs\`; portable: dalam `ORION-Portable-Data\logs\`). |
| `app/index.html` tidak dibuat | jalankan `npm run prepare:app` (otomatis di semua script build). |

## 6. Status code signing

**TIDAK bertanda tangan.** Belum ada sertifikat code-signing. Jangan klaim signed. SmartScreen akan
memberi peringatan pada komputer yang belum pernah menjalankan build ini. Bila nanti ada sertifikat:
set secret `CSC_LINK` + `CSC_KEY_PASSWORD` (workflow CI sudah menyiapkan slot envnya).

## 7. Upgrade & uninstall

- **Upgrade installed**: jalankan `ORION-Setup-<versi-baru>-x64.exe`. Biner diganti per-user,
  `%APPDATA%\ORION` tidak disentuh (data aman), shortcut diperbarui otomatis.
- **Upgrade portable**: timpa `.exe` dengan yang baru; folder `ORION-Portable-Data/` tetap.
- **Uninstall tanpa kehilangan data**: buat backup dulu (Export di Settings atau salin `ORION-Portable-Data`),
  lalu uninstall dari Start Menu / `Uninstall ORION.exe`. Data `%APPDATA%\ORION` tidak dihapus otomatis
  (`deleteAppDataOnUninstall:false`); hapus manual hanya jika memang dimaksud.

## 8. Kompatibilitas

| Target | Status |
|---|---|
| Windows 11 x64 (build 26100 / 24H2) | **diuji asli** — installer, portable, smoke, uninstall (lihat `docs/WINDOWS_TEST_REPORT.md`) |
| Windows 10 x64 | **belum diuji asli** lingkungan ini. Runtime Electron 43/Chromium mendukung Win10 (1809+); verifikasi di mesin Win10 atau CI sebelum memperluas klaim. |
| Windows 11/10 arm64 | tidak menjadi artefak rilis ini (target arm64 hanya di `dist:win` default). |

## Port dari garis B (16 Okt)

Blok **ORION-AI-CORE** (adapter AI dual-protokol openai/gemini), presets protocol-aware + entri
`gemini-native`, tes AI berbasis vm + smoke baru, dan handler ENOENT Windows di `src/mcp.js` — semuanya
porting dari snapshot garis B (`legacy-line-b/`) ke codebase zip 5, lantas diuji (`scripts/selftest.js`, `npm run smoke`).
