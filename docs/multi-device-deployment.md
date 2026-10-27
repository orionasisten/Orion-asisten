# Orion Multi-Device — Deployment Guide

Status: Phase A (API siap). Web (Phase B) & mobile (Phase D) **belum ada**; panduan di bawah
disiapkan agar tidak ada yang perlu ditebak nanti. **Tidak ada deployment yang sudah dijalankan.**

## 1. Backend — Railway

Ikuti `docs/phase-5-deployment.md` (lengkap & teruji secara lokal). Ringkasan:

| Service | Nilai |
|---|---|
| Build | `npm ci` |
| Start | `node src/central/server.js` |
| Health | `GET /v1/health` · Readiness `GET /v1/ready` |
| Port | `PORT` dari platform (otomatis dipakai) → bind `0.0.0.0` |
| Database | Railway PostgreSQL → `DATABASE_URL` |
| Wajib | `CENTRAL_SETUP_KEY` (≥32 karakter, random) |
| TLS | Railway menyediakan HTTPS; untuk DB gunakan `sslmode=verify-full` |

Migrasi berjalan otomatis saat start, dikunci **advisory lock** agar aman saat multi-instance.

## 2. CORS (untuk web app — Phase B)

Server saat ini **belum punya** daftar origin CORS. Phase B harus menambahkannya secara eksplisit
(bukan `*`), misalnya:
```
CENTRAL_CORS_ORIGINS=https://orion.pages.dev,https://orion.Owner-domain
```
Header yang perlu: `Access-Control-Allow-Origin` (hanya origin tepercaya),
`Access-Control-Allow-Credentials: true` (kalau memakai cookie sesi), `Vary: Origin`.
**CORS bukan pengganti autentikasi** — endpoint tetap wajib token/sesi.

## 3. Model sesi untuk web (Phase B) — rekomendasi

- `POST /v1/sessions` (dengan bearer token perangkat) → `accessToken` + `refreshToken`.
- **Simpan refresh token di cookie `HttpOnly; Secure; SameSite=Strict`** (web) — **jangan** di
  `localStorage` (bisa dibaca skrip mana pun).
- `accessToken` disimpan **di memori** saja (dihilang saat tab ditutup) atau cookie `HttpOnly`
  short-lived; **jangan** di `localStorage`.
- `POST /v1/sessions/refresh` saat access token kedaluwarsa; refresh token **rotasi** (token lama
  langsung tidak berlaku; pemakaian ulang = replay → sesi dicabut).
- Logout → `DELETE /v1/sessions/:id` (dan cabut device bila perangkat hilang).

> Catatan: `SameSite=Strict` mencegah cookie pada navigasi lintas situs; bila web dan API berada di
> domain berbeda, gunakan `SameSite=None; Secure` **hanya** dengan CORS ketat + header CSRF untuk
> operasi yang mengubah state.

## 4. Web App — Cloudflare Pages (Phase B — SUDAH ADA)

Web App ada di `web/` (React + TypeScript + Vite). Build → `web/dist` (statis, siap Pages).

### Same-origin proxy (DISARANKAN)
Agar cookie sesi `SameSite=Strict` bekerja tanpa CORS, sajikan web & API pada **origin yang sama**
lewat proxy (Cloudflare Pages **Functions** → Railway, atau reverse proxy di depan keduanya):

```
Browser  ──HTTPS──▶  Cloudflare Pages (web/dist + /api/* → Functions)
                              │  /api/* di-proxy ke https://orion-central.up.railway.app/v1/*
                              ▼
                        Orion Central (Railway) ──▶ PostgreSQL
```
Di frontend, `VITE_API_URL` **kosong** → semua request ke `/v1` (same-origin). Untuk proxy
Pages Functions, set `VITE_API_URL=/api` bila path di-prefix.

### Lintas-origin (alternatif)
- `CENTRAL_CORS_ORIGINS=https://orion.pages.dev` di server (allowlist, tanpa wildcard).
- Cookie otomatis `SameSite=None; Secure` (cross-site terdeteksi) + `X-CSRF-Token` wajib.
- WAJIB HTTPS (cookie `Secure` tidak akan terkirim via HTTP).

### Environment variables
| Nama | Letak | Keterangan |
|---|---|---|
| `VITE_API_URL` | build web | Kosong = same-origin; `https://…` = lintas-origin |
| `CENTRAL_CORS_ORIGINS` | server | daftar origin web (dipisah koma) |
| `CENTRAL_SETUP_KEY` | server | kunci bootstrap owner |
| `CENTRAL_SETUP_PASSWORD` | server | (opsional) password awal owner saat bootstrap |
| `CENTRAL_PROVIDER_BASE/MODEL/API_KEY` | server | provider AI untuk inferensi chat dari server |

### Verifikasi setelah deploy
```bash
curl -s https://<api>/v1/health          # {"status":"ok"}
curl -s https://<api>/v1/ready           # {"status":"ready","migrations":N}
# login → cookie HttpOnly; lalu:
curl -s -c jar -X POST https://<api>/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"owner@…","password":"…"}' -o /dev/null -w '%{http_code}\n'   # 200
curl -s -b jar https://<api>/v1/session    # owner info
```
Lalu cek di browser: login → dashboard → chat (pesan tersimpan di PostgreSQL) → SSE terpasang
(devtools → Network → EventStream) → approve satu persetujuan → logout.

## 5. Android (Phase D)

- React Native + Expo (evaluasi Phase D) — satu basis kode dengan iOS.
- Build Android: `npx expo prebuild` → `npx expo run:android` (atau EAS build) → menghasilkan APK/AAB.
- Play Store: Butuh keystore, upload key, privacy disclosure, data safety form, target SDK, dan
  review akun developer. **Belum ada build native yang dijalankan.**
- Push: FCM (Android) / APNs (iOS) → notifikasi hasil misi & permintaan approval.

## 6. iOS (Phase D)

- **iOS tidak bisa dibangun di Windows** — butuh macOS + Xcode (atau layanan build seperti
  EAS Build / Codemagic / GitHub Actions `macos-latest`).
- `npx expo run:ios` (macOS) atau EAS Build → `.ipa` (TestFlight) → App Store Connect.
- Review: privacy nutrition label, IDFA (hindari), permission strings (mikrofon), akun dev.
- **Tidak ada build iOS yang dijalankan** (lingkungan ini Windows).

## 7. Domain & TLS
- Desktop/mobile → API: `https://orion-central.up.railway.app` (TLS otomatis).
- Web → API: CORS allowlist (§2) + cookie sesi aman.
- Cloudflare Pages: custom domain + HTTPS otomatis; opsional Cloudflare Access/Zero Trust untuk
  lapisan tambahan (bukan pengganti auth API).

## 8. Operasional
- **Backup**: `pg_dump` harian (Railway: snapshot) → simpan terenkripsi di lokasi terpisah.
- **Restore**: `pg_restore --clean` (urutan FK ditangani `pg_restore`; untuk restore logis lihat
  `scripts/test-phase5-postgres.js`).
- **Rollback aplikasi**: jalankan versi server sebelumnya; migrasi bersifat additive (tidak
  menghapus kolom) sehingga downgrade aman.
- **Rotasi token**: `POST /v1/auth/token/:id/rotate` (lama langsung mati).
- **Pencabutan perangkat**: `DELETE /v1/devices/:id` → token + sesi device mati.
- **Inciden**: `GET /v1/audit` (owner-scoped) untuk melihat tindakan sensitif.

## 9. Status deployment saat ini
| Target | Status |
|---|---|
| Railway (backend) | **BELUM DIJALANKAN** — tidak ada kredensial. Kesiapan teknis tervalidasi (port/binding, advisory lock, readiness, shutdown, TLS config). |
| Cloudflare Pages (web) | **BELUM ADA** — Phase B |
| Google Play (Android) | **BELUM ADA** — Phase D |
| App Store (iOS) | **BELUM ADA** — Phase D + butuh macOS/Xcode |
