# Phase D — Build & Run (Android / iOS)

Tanggal: 22 Okt 2026. Semua perintah dijalankan dari root repo (`C:\Users\DIGIUM\Documents\Orion`)
kecuali disebutkan lain.

## 1. Prasyarat

| Kebutuhan | Versi yang dipakai | Catatan |
|---|---|---|
| Node.js | 24.22.0 | `npm` 11.x |
| JDK | **17** (Temurin 17.0.20.1) | AGP 9 menolak JDK < 17. `JAVA_HOME` wajib |
| Android SDK | platform 34/35, build-tools, platform-tools | `ANDROID_HOME` wajib |
| Android NDK | 27.1.12297006 | dipasang otomatis oleh Gradle saat build pertama |
| Xcode + CocoaPods | macOS saja | untuk iOS; **tidak tersedia** di lingkungan Windows ini |

PowerShell di Windows memblokir `npm.ps1` (ExecutionPolicy) → gunakan `npm.cmd`, `npx.cmd`,
dan `gradlew.bat`.

## 2. Install & konfigurasi

```powershell
cd mobile
npm.cmd install
Copy-Item .env.example .env      # lalu isi EXPO_PUBLIC_ORION_API_URL
```

`EXPO_PUBLIC_ORION_API_URL` = URL Orion Central **tanpa** trailing slash:
- dev lokal: `http://10.0.2.2:8787` (emulator Android) atau `http://<IP-LAN>:8787` (perangkat fisik —
  `127.0.0.1` tidak bisa dipakai dari ponsel)
- produksi: `https://<domain-central>`

Tidak ada token/secret di `.env`. Token perangkat didapat saat pairing (§4).

## 3. Menjalankan (development)

```powershell
cd mobile
npm.cmd run start          # Metro; pindai QR dengan Expo Go / dev build
npm.cmd run android        # buka di emulator/perangkat Android yang terhubung
npm.cmd run ios            # hanya di macOS
```

Alternatif tanpa Metro (verifikasi cepat bahwa bundel JS valid):

```powershell
cd mobile
npm.cmd run bundle         # expo export --platform android --output-dir dist
```

## 4. Pairing perangkat (sekali per perangkat)

1. Buka **Web App → Perangkat → “+ Token perangkat”**, beri nama (mis. `Pixel Owner`).
2. Salin token yang ditampilkan **sekali**.
3. Di aplikasi mobile: isi **URL Orion Central** + **token** → **Hubungkan**.
4. Token disimpan di `expo-secure-store`. Verifikasi berhasil bila tab Chat memuat percakapan.

Mencabut: **Web App → Perangkat → Cabut**, atau dari mobile **Perangkat → Cabut akses**.
Setelah dicabut, semua request token itu → `401` (diuji otomatis).

## 5. Build APK Android (lokal)

```powershell
$env:JAVA_HOME = "C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot"
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME

cd mobile
npx.cmd expo prebuild --platform android --no-install
cd android
.\gradlew.bat assembleRelease
```

Hasil: `mobile/android/app/build/outputs/apk/release/app-release.apk`.

Catatan penting:
- Build pertama mengunduh Gradle 9.4.1 + AGP + NDK (~3–5 GB) dan bisa memakan puluhan menit.
- **Windows: batas path 260 karakter.** Codegen New Architecture membuat path objek lebih panjang dari
  260 sehingga `ninja` gagal (`Filename longer than 260 characters`). Mesin pengembangan ini tidak
  bisa mengaktifkan `LongPathsEnabled` (butuh admin) dan tidak punya WSL/Docker. Pilihan:
  1. EAS Build: `npx eas-cli build --platform android --profile preview` (disarankan).
  2. CI Linux (GitHub Actions `ubuntu-latest`) → `./gradlew assembleRelease`.
  3. Windows dengan long path aktif (admin):
     `reg add HKLM\SYSTEM\CurrentControlSet\Control\FileSystem /v LongPathsEnabled /t REG_DWORD /d 1 /f`
     lalu reboot dan taruh project di path pendek (mis. `C:\b\m`).
  4. macOS/Linux lokal di `~/b/m`.
- Template Expo menandatangani release dengan **debug keystore**. Untuk distribusi sah, buat
  keystore sendiri dan isi `signingConfigs.release` (file keystore **tidak** di-commit).
- `mobile/android/` dan `mobile/ios/` adalah hasil generate (`prebuild`) dan sudah masuk `.gitignore`.
- Bundel JS (tanpa build native) bisa diverifikasi dengan `npm.cmd run bundle` → menghasilkan
  `dist/_expo/static/js/android/index-*.hbc` (Hermes). Ini **bukan** APK.

## 6. Build iOS (BLOCKED di lingkungan ini)

```bash
cd mobile
npx expo prebuild --platform ios
cd ios && pod install
xcodebuild -workspace ORION.xcworkspace -scheme ORION -configuration Release
```

Butuh macOS + Xcode + akun Apple Developer. **Tidak dijalankan** pada fase ini dan tidak diklaim.

## 7. EAS Build (cloud)

`mobile/eas.json` sudah berisi profil `development` (APK + dev client), `preview` (APK internal),
dan `production` (AAB + IPA). Untuk menjalankannya:

```bash
cd mobile
npx eas-cli login
npx eas-cli build --platform android --profile preview
npx eas-cli build --platform ios --profile production   # butuh akun Apple
```

Butuh akun Expo/EAS dan kredensial signing. **Belum dijalankan** (tidak ada akun/kredensial).

## 8. Push notification

Tanpa `EXPO_PUBLIC_EAS_PROJECT_ID`, aplikasi berjalan dalam **mode pengembangan**: tombol
“Aktifkan notifikasi” akan melaporkan bahwa push nyata belum aktif — tidak ada klaim palsu.

Untuk push nyata:
1. Buat project EAS, tautkan (`npx eas-cli init`).
2. Isi `EXPO_PUBLIC_EAS_PROJECT_ID` di `.env` / profil EAS.
3. Android: unggah kredensial FCM (`google-services.json` lewat EAS credentials).
4. iOS: unggah APNs key (EAS credentials).
5. Build ulang — token akan didaftarkan ke `POST /v1/push/register`.

Server menyimpan token di tabel `push_tokens` (migrasi `010`), terikat owner + device.
**Pengiriman push dari server belum diimplementasikan** (lihat `docs/phase-d-known-limitations.md`).

## 9. Checklist verifikasi cepat

```powershell
cd mobile
npm.cmd run typecheck      # harus exit 0
npm.cmd test               # 13 unit test
cd ..
npm.cmd run test:phaseD    # 13 integrasi mobile ↔ Central (PostgreSQL nyata)
npm.cmd test               # regresi backend (265)
npm.cmd run test:postgres  # 7 suite integrasi PostgreSQL
```
