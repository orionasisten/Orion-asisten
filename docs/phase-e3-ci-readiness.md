# Phase E3 — CI / Deployment Readiness (Tanpa Eksekusi)

**Status:** Dokumentasi dan persiapan lokal selesai. Tidak ada workflow di-trigger, tidak ada deployment, tidak ada kredensial baru.

---

## 1. CI yang sudah ada

- `.github/workflows/build.yml`: build installer (Windows/macOS/Linux), modern + legacy, dengan `secrets.CSC_LINK`, `APPLE_ID`, dll.
- Tidak ada workflow untuk `test:postgres`, `test:phaseA/B/D`, atau `security-scan`. Bisa ditambahkan di masa depan.

---

## 2. Apa yang sudah diverifikasi secara lokal (tanpa CI)

- `npm test` desktop → exit 0.
- `npm run test:postgres` → exit 0 (dengan embedded PG lokal).
- `npm run typecheck` (web + mobile) → OK.
- `npm run build` web → OK.
- `node scripts/test-rate-limit.js` → OK.
- `scripts/postgres-backup-restore-verify.js` → struktur verified; live drill BLOCKED karena `pg_dump` tidak ada di binary embedded (dokumentasi runbook tersedia).

---

## 3. Prasyarat yang masih diperlukan untuk CI produksi

- [ ] Akses ke `secrets.CSC_LINK` / `APPLE_ID` / `APP_PLAYER_...` di repository settings (tidak boleh ditempel di chat).
- [ ] Pipeline deployment (Railway / cloud) memerlukan kredensial akses dan otorisasi pemilik.
- [ ] Tidak boleh menjalankan `npm run deploy` atau `build:win:all` tanpa persetujuan eksplisit.
- [ ] Tidak boleh membuat tag `v*` tanpa validasi penuh.

---

## 4. Dokumentasi keamanan CI

- Semua rahasia hanya menggunakan placeholder (`secrets.*`) dalam `build.yml`; tidak ada nilai nyata dalam repo.
- `redactConfig` di `src/central/config.js` sudah memastikan log tidak membocorkan `DATABASE_URL` atau token.
- Secret scan (`node scripts/scan-secrets.js`) sudah dijalankan dan hasil 0 temuan nyata.

---

## 5. Rekomendasi langkah berikutnya (memerlukan otorisasi)

1. Verifikasi bahwa semua blokir E2 (Android) sudah diatasi di lingkungan Linux/macOS yang berwenang.
2. Jalankan `npm run e2e:web` dan `npm run e2e:desktop-central` pada CI runner (sudah dilaporkan lulus lokal).
3. Tambahkan workflow CI untuk `test:postgres` dan `security-regression` jika diizinkan.
4. Hanya setelah semua di atas, minta otorisasi untuk membuat tag rilis dan memicu `release` job.
