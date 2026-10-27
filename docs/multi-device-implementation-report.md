# Orion Multi-Device — Implementation Report (Phase A + B + C + D)

Tanggal: 22 Okt 2026.
- **Phase A** — API contract & fondasi multi-perangkat (selesai).
- **Phase B** — Web App responsif & Owner Control Center (selesai).
- **Phase C** — Desktop ↔ Orion Central (selesai).
- **Phase D** — Mobile Android & iOS (selesai **dengan batasan**; push nyata & iOS build terblokir).

## 1. Ringkasan fitur

### Backend (Phase B — tambahan minimal di atas Phase A)
- **Login Owner** (email + password) → sesi cookie `HttpOnly` (access + refresh) + cookie CSRF
  (double-submit). Password disimpan sebagai **hash scrypt + salt**, tidak pernah plaintext.
- **Rotasi refresh token** dengan **deteksi replay** (token lama dipakai lagi → seluruh sesi dicabut).
- **CORS allowlist** eksplisit (`CENTRAL_CORS_ORIGINS`), tanpa wildcard, `Vary: Origin`,
  preflight `OPTIONS`; `SameSite` dipilih otomatis (Strict untuk same-origin, None + Secure untuk lintas-origin).
- **CSRF**: request yang mengubah state via cookie wajib `X-CSRF-Token` cocok dengan cookie `orion_csrf`.
- **Inferensi server** (`POST /v1/conversations/:id/respond`) memakai provider OpenAI-compatible
  **sungguhan** (`CENTRAL_PROVIDER_*`). Tanpa provider → `503 PROVIDER_NOT_CONFIGURED`
  (**tidak ada respons AI palsu**).
- `POST /v1/auth/change-password`, `POST /v1/auth/set-initial-password`, `GET /v1/session`.
- Perbaikan: **cookie lama tidak lagi memblokir endpoint login** (bug ditemukan E2E).

### Web App (`web/`) — React 18 + TypeScript + Vite, tanpa framework berat
Halaman: **Login**, **Dashboard**, **Chat**, **Mission Control**, **Approval Center**,
**Memory Viewer**, **Perangkat & Sesi**, **Pengaturan & Status Koneksi**.
- Identitas visual Orion identik dengan desktop (`--gold #F5B82E`, `--bg #07090D`, `--teal #39E0CE`,
  Space Grotesk / Inter / JetBrains Mono).
- Responsif: sidebar (desktop), collapse (<1000px), **bottom-nav mobile** (≤760px).
- Chat memakai **Orion Central sebagai sumber data** (bukan localStorage): daftar percakapan,
  riwayat, pagination, **optimistic UI dengan rollback**, **idempotency key** per draft.
- Realtime: **SSE** (`/v1/stream`) + **catch-up berbasis cursor** (`/v1/sync/changes`) saat reconnect,
  backoff eksponensial, polling cadangan 30 detik. SSE bukan sumber kebenaran.
- PWA: `manifest.webmanifest` + ikon PNG 192/512 (dihasilkan lokal) + offline screen yang jujur.

## 2. File dibuat / diubah
**Baru**: `web/` (package.json, vite.config.ts, tsconfig.json, index.html, public/*, src/**, tests/**),
`src/central/webauth.js`, `src/central/db/migrations/009_owner_password.sql`,
`scripts/test-phaseB-webauth.js`, `scripts/e2e-web.js`, `scripts/make-web-icons.js`,
`docs/multi-device-implementation-report.md` (file ini).

**Diubah**: `src/central/app.js` (login, sesi cookie, CSRF, CORS, inferensi, `/v1/session`),
`src/central/config.js` (CORS origins, provider, login limits), `src/central/server.js` (provider),
`src/central/client.js` (metode klien), `package.json` (script web/e2e), `.gitignore`,
`scripts/test-postgres-all.js` (suite Phase B), `scripts/pg-harness.js` (mode `--run-electron`).

## 3. Keputusan arsitektur
1. **Cookie, bukan localStorage** — refresh token hanya di cookie `HttpOnly`; access token disimpan
   di memori browser (dikirim otomatis via cookie sesi). Tidak ada token di URL/log.
2. **Same-origin reverse proxy direkomendasikan** (Cloudflare Pages Functions / proxy) → cookie
   `SameSite=Strict` bekerja tanpa CORS. Lintas-origin tetap didukung (CORS allowlist + `SameSite=None;
   Secure` + CSRF) — bukan penurunan keamanan.
3. **CSRF double-submit** untuk cookie auth; bearer token (desktop/mobile) tidak perlu CSRF.
4. **Inferensi di server**, bukan di browser — kunci provider tidak pernah masuk frontend.
5. **Tanpa respons AI palsu** — provider belum dikonfigurasi → 503 + pesan jujur di UI.
6. **Stack**: React + TS + Vite (permintaan master prompt), tanpa state-management library besar;
   fetching terpusat di `api/client.ts` dengan normalisasi error.

## 4. Tes yang benar-benar dijalankan
| Perintah | Hasil |
|---|---|
| `npm test` (desktop/backend + scan rahasia) | exit 0 — **265 lulus, 0 gagal**, 0 temuan rahasia (205 berkas) |
| `npm run test:postgres` (5 suite, **PostgreSQL 17.10 nyata**) | **67 lulus, 0 gagal** (20 + 8 + 9 + 15 + 12) |
| `npm run web:test` (vitest + jsdom) | **20 lulus, 0 gagal** (3 file) |
| `npm run web:typecheck` | **exit 0** (tsc) |
| `npm run web:build` | **exit 0** — `dist/` 186 kB JS (57 kB gzip), 8.9 kB CSS |
| `npm run e2e:web` (Chromium Electron + backend + PG nyata) | **16 lulus, 0 gagal** + 11 screenshot |
| `npm run smoke` (desktop) | PASS |
| `npm run verify:release` | 15/15 PASS |

Cakupan E2E browser: login Owner (cookie), sesi server aktif, token HttpOnly, keenam halaman
ter-render, buat percakapan, kirim pesan (**terverifikasi ada di PostgreSQL**), layout mobile
(390px) & tablet (820px), logout kembali ke login.

## 5. Hasil security audit
| Area | Status |
|---|---|
| Password Owner | hash scrypt+salt, tak pernah plaintext/log |
| Refresh token | hanya cookie HttpOnly; rotasi; **replay → sesi dicabut** |
| CSRF | double-submit header wajib untuk state-changing via cookie (diuji 403) |
| CORS | allowlist; origin asing tanpa header CORS; `*` + credentials tidak pernah dipakai |
| Cookie | `HttpOnly` (access/refresh), `Secure` hanya saat HTTPS, `SameSite` otomatis |
| Stale cookie memblokir login | **DITEMUKAN & DIPERBAIKI** (bug nyata) |
| XSS | payload pesan disimpan sebagai **data** (tidak dieksekusi server) |
| Otorisasi | owner dari server; IDOR → 404; data privat tidak bocor lintas scope |
| Secret di frontend | tidak ada; scan build output = 0 temuan |

## 6. Build artifacts
- Web: `web/dist/` (statis, siap Cloudflare Pages) — `index.html`, JS 186 kB, CSS 8.9 kB, ikon PWA.
- Desktop: installer + portable dibangun ulang (lihat `release/SHA256SUMS.txt`).

## 7. Cara menjalankan Web App
```bash
# 1) backend (SQLite cukup untuk coba; PostgreSQL untuk produksi)
CENTRAL_DB_DRIVER=postgres DATABASE_URL=postgresql://... \
CENTRAL_SETUP_KEY=<32+ karakter> CENTRAL_CORS_ORIGINS=http://localhost:5173 \
  node src/central/server.js

# 2) frontend (dev, proxy same-origin ke backend)
npm run web:install
ORION_API_URL=http://127.0.0.1:8787 npm run web:dev    # http://localhost:5173

# 3) produksi
npm run web:build     # unggah web/dist ke Cloudflare Pages
```

## 8. Status deployment (benar-benar terverifikasi)
| Target | Status |
|---|---|
| Web App (build lokal) | **TERBUKTI** — build sukses, 20 unit test, 16 E2E browser lulus |
| Cloudflare Pages | **BELUM DIJALANKAN** — butuh akun/otorisasi |
| Railway (backend) | **BELUM DIJALANKAN** — butuh kredensial; kesiapan teknis tervalidasi (Phase 5.1) |
| Android | **ADA (Phase D)** — aplikasi Expo/RN + APK release (lihat `docs/phase-d-testing.md`) |
| iOS | **BLOCKED untuk build** — kode siap (Expo), tetapi IPA butuh macOS + Xcode |

## 9. Known limitations
- **PWA di iOS**: background execution & push terbatas (bukan PWA-native).
- **SSE**: `EventSource` mengirim cookie otomatis; bila API lintas-origin, perlu `withCredentials`
  + CORS allowlist. Reconnect tetap bounced lewat cursor delta feed.
- **Refresh token** disimpan per-sesi di cookie; logout mengosongkan cookie.
- **Provider AI di server** harus dikonfigurasi lewat env (belum ada UI pengaturan provider).
- **Belum ada** push notification, attachment, streaming token, dan offline write (outbox sisi web).
- **Rate limiter** server masih in-memory per instance.
- E2E memakai Chromium milik Electron (bukan Playwright/Chrome penuh) — tidak ada unduhan browser.
- iOS/Android: lihat `docs/phase-d-known-limitations.md` (emulator, perangkat fisik, push nyata, signing).

## 9b. Fase D (mobile) — ringkasan

Mobile (React Native 0.88 + Expo SDK 58 + TypeScript) berada di folder `mobile/`.

- Pairing lewat **device token** (bukan cookie web) → disimpan di `expo-secure-store`
  (Keychain iOS / EncryptedSharedPreferences Android), tidak pernah di AsyncStorage/log/URL.
- Chat: server = sumber kebenaran. Outbox persisten (AsyncStorage, tanpa secret), idempotency key
  stabil (`clientMessageId`), delta catch-up lewat `/v1/sync/changes`, polling 12 detik saat foreground.
- Mission Control, Approval Center (keputusan hanya lewat endpoint resmi server),
  Device Management (cabut perangkat), Settings + status sinkronisasi.
- Push: `expo-notifications`; **tanpa kredensial provider → mode pengembangan** yang dilaporkan jujur.
  Endpoint push token baru: migrasi `010_push_tokens` + `POST /v1/push/register`, `/v1/push/revoke`,
  `GET /v1/push/tokens`.
- Bukti: 13 unit (jest) + 13 integrasi PostgreSQL + typecheck bersih + APK native
  (lihat `docs/phase-d-testing.md`).
- Bug yang ditemukan & diperbaiki selama Phase D: (a) handler push memakai helper route yang salah
  (`handle` → `router.post`), (b) `const now = now()` (temporal dead zone) → 500, (c) satu entri
  outbox rusak memblokir seluruh antrean → sekarang ditandai `failed` dan antrean lanjut,
  (d) `app.json` merujuk ikon notifikasi yang tidak ada → prebuild gagal.


## 10. Rekomendasi & prasyarat Phase C
**Phase C — integrasi desktop** (prasyarat: backend & web stabil ✓):
1. Pindahkan `State.convos` renderer → Orion Central (dengan migrasi percakapan lokal memakai
   endpoint import yang sudah ada).
2. Desktop memakai kontrak yang sama: `/v1/conversations`, sesi/device token, delta feed + SSE.
3. Indikator cloud/local di desktop; reconnect & retry; token hanya di main process (tetap).
4. regresi: `npm test` + `npm run smoke` + `verify:release` harus tetap hijau.

**Prasyarat non-teknis untuk produksi**: kredensial Railway + Cloudflare, domain HTTPS,
`CENTRAL_SETUP_KEY` & `CENTRAL_PROVIDER_API_KEY` di secret manager, dan keputusan apakah
frontend memakai same-origin proxy (disarankan) atau cross-origin + CORS.
