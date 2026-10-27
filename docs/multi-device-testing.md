# Orion Multi-Device — Testing

Status: Phase A. Tanggal: 22 Okt 2026.

## 1. Pemisahan lapisan tes

| Lapisan | Perintah | DB | Hasil |
|---|---|---|---|
| Unit + integrasi SQLite | `npm test` | SQLite (SQL nyata) | **265 lulus, 0 gagal** |
| Integrasi PostgreSQL nyata | `npm run test:postgres` | **PostgreSQL 17.10** | **52 lulus, 0 gagal** |
| E2E desktop (Electron) | `npm run smoke` | — | **PASS** (`ok:true`, 12 probe) |
| Rilis Windows | `npm run verify:release` | — | **15/15 PASS** |
| Scan rahasia | bagian dari `npm test` | — | **0 temuan nyata** |

Total integrasi PostgreSQL (Phase 5.1 + Phase A): 20 + 8 + 9 + 15 = **52 tes**.

## 2. Rincian suite PostgreSQL
| Suite | Tes | Isi |
|---|---|---|
| `test-phase5-postgres.js` | 20 | migrasi, checksum, rollback transaksi, unique, FK, auth, isolasi owner, event dedup, cursor, konkurensi worker, lease, backoff/dead-letter, outcome_unknown, budget/approval, migrasi Phase 4, API, backup/restore |
| `test-phase5-desktop-central.js` | 8 | desktop tanpa Central, outbox tahan restart, retry tanpa duplikasi, token mati, LWW ditolak, konflik tercatat, 0 secret, import memori/skill |
| `test-phase5-railway.js` | 9 | port/binding platform, validasi config, redaksi, mode SSL, readiness 503 + timeout, health bersih, advisory lock, shutdown, start gagal cepat |
| `test-phaseA-multidevice.js` | 15 | percakapan CRUD, idempotensi, seq server, lintas perangkat, pagination, 409 konflik, isolasi owner, validasi input, sesi browser (rotasi/replay/revoke), revoke device, delta feed, SSE, regresi endpoint lama |

## 3. Skenario E2E lintas perangkat (Phase A — yang sudah teruji)
| # | Skenario | Status | Bukti |
|---|---|---|---|
| 1 | Pesan dari perangkat A, dilanjutkan di perangkat B | **TERUJI** | test "riwayat yang sama bisa dilanjutkan dari perangkat lain" (device token berbeda, urutan seq sama) |
| 3 | Approval dari perangkat berbeda | **TERUJI** (server-side) | approval server-authoritative; perangkat lain membaca via `/v1/approvals` |
| 4 | Jaringan putus di tengah sinkronisasi → sambung lagi | **TERUJI** | test "kegagalan jaringan → dipulihkan tanpa duplikasi" (outbox tidak ditandai synced saat gagal; retry idempoten) |
| 6 | Cabut satu perangkat → aksesnya ditolak | **TERUJI** | test "pencabutan device → sesi & token device ikut mati" |
| 9 | Event sama dua kali → tidak ada duplikasi | **TERUJI** | test idempotensi pesan & event; `duplicate:true` |
| 10 | Perangkat tanpa izin tidak bisa baca data Owner | **TERUJI** | test "isolasi owner" (404) |
| 2 | Misi dari web → pantau dari Android | **TERUJI** (API) | API misi & delta feed lintas perangkat; **UI web/mobile belum ada (Phase B/D)** |
| 5 | Restart backend → misi & approval konsisten | **TERUJI** | transisi & approval persistent (PostgreSQL), recovery queue |
| 7 | Tugas lokal gagal jelas saat desktop offline | **BELUM** | butuh integrasi desktop (Phase C) |
| 8 | Misi cloud tetap jalan saat desktop ditutup | **BELUM** | butuh worker cloud (Phase 3/5 lanjutan) |

> Tidak ada klaim E2E lintas perangkat yang belum dijalankan.

## 4. Adversarial & keamanan (Phase A)
| Kasus | Hasil |
|---|---|
| Percakapan owner lain diakses | 404 (tidak membocorkan keberadaan) |
| `clientKey` sama → dua percakapan? | Ditolak (unique index) |
| `clientMessageId` sama → dua pesan? | Ditolak (unique index) |
| Update percakapan dengan versi lama | **409**, data tidak ditimpa |
| Refresh token dipakai ulang | `401 REFRESH_REPLAY_DETECTED`, sesi dicabut |
| Device dicabut | token + sesi device mati (401) |
| Token bocor di respons/audit/error | tidak ada (diuji) |
| Payload > batas | 413 |
| Role pesan tak dikenal | 400 |
| SSE tanpa token | 401 |
| Payload event berisi `owner_id` | ditolak (`CLIENT_SCOPE_FIELD_FORBIDDEN`) |

## 5. Yang belum diuji / belum tersedia
- **Web App & mobile app**: belum ada (Phase B/D) — tidak ada klaim build store.
- **Browser nyata**: belum ada uji DOM browser (belum ada web app).
- **Push notification**: belum ada.
- **Railway/Cloudflare deploy**: belum dijalankan (tidak ada kredensial) — **UNVERIFIED**.
- **TLS end-to-end**: tidak diuji di environment ini (Railway menyediakan TLS) — **UNVERIFIED**.
- **Beban/load test**: belum dilakukan; rate limiter in-memory per instance.
- **Windows 10 native & code signing**: **BLOCKED** (seperti fase sebelumnya).

## 6. Cara mengulang
```bash
npm test                       # 265 tes (SQLite + unit)
npm install --no-save embedded-postgres@17.10.0-beta.17
npm install-scripts approve @embedded-postgres/windows-x64
npm rebuild @embedded-postgres/windows-x64
npm run test:postgres          # 52 tes di PostgreSQL 17.10 nyata
npm run smoke                  # E2E Electron
npm run verify:release         # rilis Windows 15/15
```
Tanpa PostgreSQL → suite integrasi **DILEWATI (exit 2)**, bukan diklaim lulus.
