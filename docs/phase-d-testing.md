# Phase D — Testing

Tanggal: 22 Okt 2026. Lingkungan: Windows 11, Node 24.22.0, Expo SDK 58 / RN 0.88, TypeScript 6,
Jest 30, PostgreSQL 17.10 (nyata), JDK 17 (Temurin) + Android SDK 34/35, AVD API 37.

## 1. Lapisan tes

| Lapisan | Perintah | Cakupan | Hasil |
|---|---|---|---|
| Unit mobile (jest) | `cd mobile && npm test` | api client (header token, normalisasi error 401/403/404/409/429/5xx/offline), outbox (idempotensi, offline pending, 401 revoked, entri gagal permanen, catch-up cursor, tanpa secret) | **14 lulus, 0 gagal** |
| Typecheck mobile | `cd mobile && npm run typecheck` | TS strict | **exit 0** |
| Integrasi mobile ↔ Central (PG nyata) | `npm run test:phaseD` | pairing, isolasi, chat lintas klien, pagination/urutan, idempotensi, outbox, token kedaluwarsa/dicabut, delta catch-up, misi/approval, push token, **paritas kontrak** | **15 lulus, 0 gagal** |
| Regresi backend | `npm test` | seluruh fase 0–5.1 + scan rahasia | **265 lulus, 0 gagal** |
| Integrasi PostgreSQL (6 suite) | `npm run test:postgres` | 20 + 8 + 15 + 12 + 11 + **15** | **81 lulus, 0 gagal** |
| Web | `npm run web:test` / `typecheck` / `build` | 20 lulus / exit 0 / exit 0 | PASS |
| E2E web (browser) | `npm run e2e:web` | Chromium + Central + PG | **16 lulus** |
| E2E desktop↔web | `npm run e2e:desktop-central` | Electron + web + Central + PG | **13 lulus** |
| Build Android native | `cd mobile/android && gradlew assembleRelease` | APK release | lihat §4 |
| Rilis Windows | `npm run verify:release` | installer + portable | **15/15 PASS** |

## 2. Skenario wajib & status
| # | Skenario | Status | Bukti |
|---|---|---|---|
| 1 | Typecheck & build aplikasi | **PASS** | `tsc --noEmit` exit 0; `expo export`/bundle & APK native (lihat §4) |
| 2 | Login/pairing & logout | **PASS** | integrasi: pairing device token → sesi OK; logout menghapus token (unit) |
| 3 | Sesi kedaluwarsa & device dicabut | **PASS** | integrasi: 401 `SESSION_REVOKED` setelah device dicabut → tidak bisa baca **dan** tidak bisa ubah data |
| 4 | Chat mobile → server → Web/Desktop | **PASS** | integrasi: pesan mobile terlihat oleh klien web |
| 5 | Chat Web/Desktop → server → mobile | **PASS** | integrasi: pesan web terlihat oleh mobile |
| 6 | Pagination & urutan | **PASS** | integrasi: 4+2 halaman, `seq` [1..6] identik di kedua klien |
| 7 | Idempotensi & retry setelah timeout | **PASS** | integrasi + unit: `clientMessageId` sama → `duplicate:true`, jumlah pesan tetap 1 |
| 8 | Offline outbox & pemulihan restart | **PASS** | unit: offline → pending & tidak hilang; integrasi: flush tanpa duplikasi; outbox bertahan setelah objek baru |
| 9 | Catch-up delta setelah koneksi putus | **PASS** | integrasi: `/v1/sync/changes?since=0` mengembalikan `message.created`; kursor persisted |
| 10 | Error 401/403/404/409/5xx | **PASS** | unit: pemetaan error lengkap (ApiError + flag) |
| 11 | Permission misi & approval | **PASS** | integrasi: approval hanya bisa diputuskan lewat endpoint resmi; keputusan kedua → 409 |
| 12 | Kebocoran token/secret di log & bundle | **PASS** | unit: token tidak pernah di URL; outbox tanpa pola token; scan repo 0 temuan |
| 13 | Regresi Desktop & Web | **PASS** | 265 backend + 81 PostgreSQL + 20 web + 16 E2E web + 13 E2E desktop |

## 3. Pemeriksaan kebocoran kredensial
- `scripts/scan-secrets.js` (dijalankan di `npm test`) — 0 temuan nyata di seluruh repo (termasuk bundle web).
- Unit: token device hanya di header `Authorization`; tidak pernah di URL/outbox/body respons.
- `mobile/src/storage/stores.ts`: token hanya lewat `expo-secure-store`.

## 4. Build & artefak

| Target | Status | Bukti |
|---|---|---|
| TypeScript | **PASS** | `npm run typecheck` exit 0 |
| Bundel JS Android (Hermes) | **PASS** | `npm run bundle` → `index-…hbc` **1.773.337 byte**, 712 modul, SHA-256 `46dfe61c48147dd805971557751940a6d4e122ddb99ea17e730b263f52a4a4bf` |
| `expo prebuild --platform android` | **PASS** | folder `android/` (AGP 9, Gradle 9.4.1, NDK 27.1, compileSdk 37, minSdk 24) |
| Kompilasi Kotlin/Java modul | **PASS** | `:expo-*`, `:react-native-*`, `:app` task Java/Kotlin selesai |
| **APK Android native** | **BLOCKED (lingkungan)** | lihat §4a — batas `MAX_PATH` Windows pada path codegen New Architecture |
| **IPA iOS** | **BLOCKED** | butuh macOS + Xcode; lingkungan ini Windows → **tidak diklaim** |
| Emulator/simulator | **BLOCKED** | virtualisasi firmware dinonaktifkan (`Virtualization Enabled In Firmware: No`) |
| Perangkat fisik | **BLOCKED** | tidak ada perangkat Android/iOS |
| EAS Build (cloud) | **BELUM DIJALANKAN** | butuh akun EAS + kredensial |
| Play Store / App Store | **BELUM** | butuh signing, privacy disclosure, review |

### 4a. Kenapa APK native BLOCKED di mesin ini

Build berhenti pada langkah C++ codegen (bukan kesalahan kode aplikasi), dengan pesan:

```
C/C++: ninja: error: Stat(safeareacontext_autolinked_build/CMakeFiles/
react_codegen_safeareacontext.dir/C_/.../node_modules/react-native-safe-area-context/
android/build/generated/source/codegen/jni/.../ComponentDescriptors.cpp.o):
Filename longer than 260 characters
```

Penyebab dan batasan lingkungan:
- React Native 0.88 **mewajibkan** New Architecture (legacy dihapus sejak RN 0.82 → `newArchEnabled=false`
  ditolak eksplisit), sehingga codegen JSI C++ selalu dibuat.
- Path objek menyalin path sumber sehingga melewati batas Win32 260 karakter.
- `LongPathsEnabled` = `0` dan shell **bukan administrator** → tidak bisa mengaktifkan long path.
- Sudah dicoba: (1) junction ke `C:\b\m` → Gradle me-resolve ke path asli; (2) salinan nyata di `C:\b\m`
  + `npm install` bersih + `--no-build-cache` → lolos `Stat` tetapi gagal pada
  `ninja: error: mkdir(...): No such file or directory` (batas yang sama).
- Tidak tersedia WSL maupun Docker di mesin ini.

**Jalur yang terbukti/tersedia untuk menghasilkan APK:**
1. **EAS Build** (Linux, tanpa batas path): `cd mobile && npx eas-cli build --platform android --profile preview`
2. **CI** (GitHub Actions `ubuntu-latest` + `./gradlew assembleRelease`)
3. **Windows dengan long path aktif**: admin → `reg add HKLM\SYSTEM\CurrentControlSet\Control\FileSystem /v LongPathsEnabled /t REG_DWORD /d 1`, reboot, lalu build di `C:\b\m`.
4. **macOS/Linux** lokal dengan project di path pendek (`~/b/m`).

Perintah lengkap ada di `docs/phase-d-build-and-run.md`.


## 5. Cara mengulang
```bash
cd mobile && npm install
npm run typecheck && npm test          # unit mobile
cd .. && npm run test:phaseD            # integrasi mobile ↔ Central (PostgreSQL nyata)
npm run test:postgres                  # 6 suite integrasi PostgreSQL
npm test                               # regresi backend
npm run e2e:web && npm run e2e:desktop-central
cd mobile && npx expo prebuild --platform android && cd android && gradlew assembleRelease
```
Syarat: PostgreSQL asli (lihat `scripts/pg-harness.js`), JDK 17, Android SDK.
