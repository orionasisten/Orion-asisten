# Phase 5 — Orion Central: Implementation Report

Tanggal: 22 Okt 2026.

## 1. File dibuat / diubah & alasannya

### Dibuat — server (`src/central/`)
| File | Alasan |
|---|---|
| `config.js` | Konfigurasi dari environment + validasi + redaksi secret saat log. Tanpa secret default. |
| `db/sql.js` | Konversi placeholder `?` → `$n` (PostgreSQL) tanpa merusak literal string. |
| `db/sqlite-driver.js` | Driver **SQLite node:sqlite** untuk dev/tes: SQL nyata, transaksi nyata, unique constraint nyata (bukan mock). |
| `db/pg-driver.js` | Driver **PostgreSQL (`pg`)** untuk produksi. `require('pg')` lazy → desktop tidak memakainya. |
| `db/index.js` | Factory driver. |
| `db/migrate.js` | Runner migrasi terversi + checksum (deteksi tampering) + idempoten + dry-run. |
| `db/migrations/001_core.sql` | owners, devices, auth_tokens, audit_log, schema_migrations. |
| `db/migrations/002_missions.sql` | missions, mission_tasks, approvals, budget_ledger. |
| `db/migrations/003_sync.sql` | events (idempoten + cursor), sync_cursors, event_conflicts, id_counters. |
| `db/migrations/004_memory_skills.sql` | memory_records, memory_versions, skill_versions, skill_evaluations, skill_active_pointer, skill_lifecycle_audit. |
| `db/migrations/005_jobs.sql` | jobs (queue durable), job_attempts. |
| `auth/tokens.js` | Token bearer server-side: hash SHA-256 di storage, expiry, revocation, rotation. |
| `policy/scope.js` | Default-deny, owner scoping, scope/sensitivity (aturan Phase 4), kebijakan konflik per tipe record. |
| `audit.js` | Audit trail append-only + scrub secret. |
| `api/router.js` | Router HTTP minimal (node:http), routing berversi, error tanpa stack trace. |
| `app.js` | API v1 lengkap (health, ready, auth, devices, tokens, missions, approvals, events, memory, skills, jobs, audit). |
| `sync/events.js` | Upload/pull event, idempotensi, cursor server, validasi payload, kebijakan konflik. |
| `queue/queue.js` | Queue durable: claim atomik, lease + heartbeat, retry/backoff, dead-letter, idempotency key. |
| `mission/orchestrator.js` | Boundary server: reservasi budget, rekonsiliasi, validasi approval, penjadwalan job misi. |
| `skills/service.js` | Registrasi versi skill immutable + aktivasi (hash + evaluasi + policy + audit) + karantina. |
| `migrate/migrate-local.js` | Migrasi Phase 4 → Central dengan preservasi provenance penuh; dry-run, idempoten, rollback. |
| `server.js` | Bootstrap server + graceful shutdown. |
| `client.js` | Klien HTTP sisi desktop (token di main process, tidak pernah di renderer). |
| `outbox.js` | Outbox event desktop berbasis file (tahan restart). |

### Diubah
| File | Perubahan |
|---|---|
| `src/bridge.js` | 9 handler IPC baru (`central:*`) + integrasi outbox/klien/migrasi lokal. |
| `src/preload.js` | `orionDesktop.central.*` (status, token, enqueue, sync, pull, migrate). |
| `source/Orion_v_4_0.html` | Kategori Settings baru **"Orion Central"** (status sinkron, configure token, sinkron manual, migrasi dry-run) + ikon `i-globe`. |
| `electron-builder.config.js` | Exclude `pg*` dari paket desktop (server-only, reviewed: asar 2.1 MB, `pg-pool` absen). |
| `package.json` | `pg` sebagai **optionalDependency**; `npm test` menambah `test-phase5.js`. |
| `scripts/test-bridge.js` | +5 tes IPC Central. |
| `scripts/smoke-electron.js` | +1 probe UI (`centralCard`). |
| `.env.example` | **Baru** — placeholder saja, tanpa nilai rahasia. |

## 2. Arsitektur yang benar-benar diimplementasikan
Desktop (lokal, offline-capable) ↔ **Orion Central** (opsional) via HTTP/HTTPS + bearer token.
- Desktop: runtime & workspace lokal tetap; outbox event tahan restart; token hanya di main process.
- Central: default-deny, owner-scoped, PostgreSQL (produksi) / SQLite (dev), queue berbasis DB.
- Tidak ada dua sistem queue; tidak ada service tambahan (Redis) — queue = PostgreSQL.

## 3. Migrasi database & cara menjalankannya
- 5 berkas migrasi terversi di `src/central/db/migrations/`, dijalankan **otomatis** saat server start
  (`node src/central/server.js`), atau manual: `migrate(db, {})` / `migrate(db, {dryRun:true})`.
- Checksum SHA-256 tiap migrasi disimpan → berkas yang berubah setelah diterapkan **ditolak**.
- Skema **portable** (TEXT id/timestamp, INTEGER boolean, TEXT JSON, INTEGER minor-unit uang) agar
  SQL identik jalan di SQLite & PostgreSQL.

## 4. Environment variables
Lihat `docs/phase-5-deployment.md` §3. Wajib di produksi: `CENTRAL_DB_DRIVER=postgres`,
`DATABASE_URL`, `CENTRAL_SETUP_KEY` (≥32 karakter). `CENTRAL_SETUP_KEY` **wajib** — tanpa itu
`/v1/auth/bootstrap` menolak semua permintaan (default-deny).

## 5. Model autentikasi & threat boundary
- **Self-managed bearer token** (server): hanya SHA-256 hash yang disimpan; expiry (default 720 j),
  revocation, rotation; device-scoped; device dicabut → token mati seketika.
- **Owner ID selalu dari token**, tidak pernah dari payload klien. Endpoint yang menerima
  `owner_id`/`role`/`permissions` di payload **ditolak** (`CLIENT_SCOPE_FIELD_FORBIDDEN`).
- **Default-deny**: semua endpoint kecuali `/v1/health`, `/v1/ready`, `/v1/auth/bootstrap` butuh
  token valid; tanpa token → 401.
- Threat boundary: renderer tidak pernah memegang token; log tidak memuat bearer token
  (diuji); error tidak membocorkan stack trace (diuji).
- Skema ini untuk deployment privat satu-owner. Untuk IdP eksternal, ganti
  `src/central/auth/tokens.js` (interface: issueToken/verifyToken/revokeToken) — **belum ada
  integrasi IdP eksternal yang aktif** (tidak diklaim).

## 6. Kontrak sinkronisasi
- **Event**: `eventId` unik (idempotensi), `deviceSeq` unik per (owner, device), `cursor` server
  monoton, `schemaVersion`, payload ≤64 KB, timestamp divalidasi.
- **Pull**: `GET /v1/events?after=<cursor>&limit=N` → `{events, cursor, hasMore}`.
- **Upload**: `POST /v1/events` → `{accepted, duplicates, rejected, conflicts, errors, cursor}`.
- **Outbox desktop**: JSONL append-only di `<userData>/central-outbox`; ditandai synced **hanya**
  setelah server mengonfirmasi commit; restart tidak menghilangkan event (diuji).
- **Kebijakan konflik (bukan LWW)**: `approval.decision`, `memory.verification`, `skill.active`,
  `budget.spent`, `mission.state` = server-authoritative (event klien dicatat sebagai conflict &
  ditolak); `memory.upsert`/`skill.register` = merge-append (versi baru, isi lama tak ditimpa).

## 7. Hasil setiap tes (angka aktual)
| Perintah | Hasil |
|---|---|
| `npm test` (baseline **sebelum** edit) | exit 0 — **220 lulus**, 0 gagal |
| `node scripts/test-phase5.js` | **45 lulus, 0 gagal** |
| `node scripts/test-bridge.js` | **27 lulus, 0 gagal** (5 tes Central baru) |
| `npm test` (setelah edit) | exit 0 — **265 lulus, 0 gagal** |
| `npm run smoke` | **PASS** `ok:true` (`centralCard:true`) |
| `npm run build:win:installer` / `:portable` | exit 0 |
| `npm run verify:release` | **SEMUA PASS (15/15)** |
| `npm run release:finalize` | exit 0 |

Rincian Phase 5 (45 tes): migrasi DB (5), auth & isolasi (6), sinkronisasi (6), queue & budget (7),
migrasi memori/skill (6), API HTTP nyata (12), regresi Phase 2 (1), outbox (1), klien HTTP (2).

## 8. Tes yang gagal / tidak dijalankan / hanya dimock
- **Integrasi PostgreSQL nyata: BLOCKED / TIDAK DIJALANKAN.** Tidak ada server PostgreSQL di
  lingkungan ini. Tes memakai **SQLite node:sqlite dengan SQL, transaksi, dan unique constraint
  sungguhan** (bukan mock) — tetapi **tidak boleh diklaim sebagai tes PostgreSQL**.
 - Tindakan yang diperlukan: jalankan `CENTRAL_DB_DRIVER=postgres` + `DATABASE_URL` →
  `node scripts/test-phase5.js` di environment ber-PostgreSQL.
- **Driver `pg`**: dimuat & terinstal (audit bersih), tetapi belum pernah mengeksekusi query ke
  PostgreSQL nyata.
- **Deploy Railway**: TIDAK dijalankan (tidak ada kredensial Railway). Deployment didokumentasikan.
- **TLS**: tidak diuji end-to-end (Railway menyediakan TLS di sisi platform).
- **Rate limiter multi-instance**: in-memory per instance — belum diuji lintas instance.
- Native dialog E2E: **UNVERIFIED**; Windows 10 native: **BLOCKED**; code signing: **BLOCKED**.

## 9. Batasan keamanan yang tersisa
- Rate limiter in-memory (single instance) — perlu store bersama bila diskalakan.
- Tidak ada OS-level sandboxing untuk job worker (skill pihak ketiga **tidak** dieksekusi server).
- `pg` sengaja tidak ada di paket desktop → server harus dijalankan dari repo dengan `npm install`.
- Self-managed token cocok untuk 1 owner; multi-tenant butuh IdP eksternal + rotation tooling.

## 10. Build artifacts (SHA-256 dihitung dari berkas, build terakhir)
- `release/ORION-Setup-4.0.0-x64.exe` — `761f4d23632edda3a83064b748f10314830f0dfca9d9dfc35759f85152856bd9`
- `release/ORION-Portable-4.0.0-x64.exe` — `86fcaf273eb86d0623edddf89b289157afbfbd62aa09baa24c5df31ac2564d74`
- `release/SHA256SUMS.txt`, `release-manifest.json`, `verification.json` (15/15 PASS).
- Pemindaian rahasia repo (`scripts/scan-secrets.js`, dijalankan di `npm test`): **0 temuan nyata**,
  5 placeholder/fixture aman.

## 11. Rekomendasi fase berikutnya
Phase 6 — Browser/computer-use terverifikasi + workflow produk digital end-to-end, **lalu** validasi
Phase 5 di environment PostgreSQL nyata sebelum production. Kriteria lanjutan (sesuai master prompt):
autentikasi, isolasi data, sinkronisasi idempoten, pemulihan queue, dan preservasi provenance
sudah punya bukti tes di atas; yang tersisa adalah verifikasi PostgreSQL + Railway.
