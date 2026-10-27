# Android Phase E2 — Build Readiness Runbook

**Status:** BLOCKED di lingkungan Windows saat ini. Tidak ada build APK/AAB atau tes emulator yang dilakukan.

---

## 1. Diagnosa blokir (bukti)

- Windows `MAX_PATH` (260 karakter) membatasi jalur file build native (`mobile/android/app/.cxx/...`).
- Tidak ada akses admin / WSL untuk mengaktifkan VM atau mengurangi batasan.
- Emulator Android tidak tersedia (`Virtualization Enabled In Firmware: No`).
- Tidak ada perangkat fisik Android untuk smoke test.
- `eas.json` / `package-lock.json` tersedia; build web dan mobile frontend (`npm test`, typecheck, web build) berhasil.

---

## 2. Pemeriksaan yang aman dan berhasil (tanpa hak akses admin)

- `cd mobile && npm test -- --ci` → 15/15 lulus.
- `cd mobile && npm run typecheck` → OK.
- `cd web && npm test` → 20/3 file OK.
- `cd web && npm run build` → OK (bundle 186 kB).
- `node scripts/test-phaseD-mobile.js` (PG) → 17/17 lulus; pairing, push, delta, outbox terverifikasi.

---

## 3. Prasyarat yang harus dipenuhi sebelum E2 dapat dilanjutkan (daftar autorisasi)

- [ ] Lingkungan Linux/macOS atau WSL aktif dengan hak admin.
- [ ] Android SDK / NDK dan Java (JDK 17+) terpasang sesuai `mobile/android`.
- [ ] `MAX_PATH` dinonaktifkan atau build dilakukan di jalur pendek (`/tmp/build`).
- [ ] Emulator Android atau perangkat fisik tersedia.
- [ ] Tidak ada build dengan kredensial produksi di dalam kode.

---

## 4. Perintah build (dokumentasi saja — jangan jalankan tanpa otorisasi)

```bash
# Di lingkungan Linux/macOS dengan akses admin
cd mobile
npx expo prebuild --platform android   # atau eas build jika EAS tersedia
# Atau manual gradlew setelah prebuild
cd android && ./gradlew assembleRelease
```

---

## 5. Keamanan sebelum distribusi Android

- Pastikan `app.json` tidak menyertakan URL staging atau token real di `extra`.
- Pastikan `src/state/session.tsx` menggunakan `setApiBaseUrl()` dari URL yang diverifikasi server (R5).
- Pastikan push token terikat perangkat dan dicabut saat device revoked (R2).
- Pastikan `android/app/src/main/AndroidManifest.xml` tidak meminta izin berlebihan.

---

## 6. Konfirmasi E2 belum selesai

- Tidak ada `build/app.apk`, `build/app.aab`, atau `release/*.apk` yang dihasilkan oleh sesi ini.
- Tidak ada penandatanganan atau pengunggahan ke Play Store / App Store.
- Dokumentasi ini hanya menyatakan kesiapan frontend dan kontrak backend; build native masih memerlukan lingkungan dan otorisasi terpisah.
