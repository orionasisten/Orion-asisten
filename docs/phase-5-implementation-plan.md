# Phase 5 — Orion Central: Implementation Plan

Tanggal: 22 Okt 2026.

## Baseline (verified, bukan asumsi)
- `npm test` → **220 lulus, 0 gagal** (58 selftest + 34 connectors + 17 webtools + 7 extract + 22 bridge
  + 22 mission + 20 phase3 + 6 hardening + 34 phase4).
- Node v24.22.0, npm 11.19, Electron 43.8.1.
- Dependency runtime saat ini: hanya `electron-updater`. `pg@8.13.0` ditambahkan sebagai
  **optionalDependency** (khusus server Central; audit `pg` = bersih). 8 advisory moderate yang ada
  seluruhnya di `electron-builder` (devDependency), bukan di runtime aplikasi.
- Tidak ada PostgreSQL server di lingkungan ini → **integrasi PostgreSQL nyata = BLOCKED/UNVERIFIED**.
  `node:sqlite` (SQLite 3.53.4, bawaan Node 24) dipakai sebagai driver uji lokal dengan **SQL yang
  sama persis** dan **transaksi/unique constraint sungguhan** — bukan mock.

## Keputusan arsitektur
1. **Portable SQL tunggal** untuk SQLite & PostgreSQL:
   - ID: `TEXT PRIMARY KEY` (UUID dari app) — identik di kedua DB.
   - Timestamp: `TEXT` ISO-8601 UTC (leksikografis sortable) — konsisten di kedua DB.
   - Boolean: `INTEGER` 0/1. JSON: `TEXT`. Uang: `INTEGER` minor unit (konsisten Phase 3).
   - Placeholder `?` → dikonversi driver PG ke `$1..$n` (dokumentasi di `src/central/db/sql.js`).
2. **Queue berbasis PostgreSQL** (tanpa Redis): tabel `jobs`, claim atomik `UPDATE ... WHERE id=(SELECT
   ... FOR UPDATE SKIP LOCKED) RETURNING *` (SQLite: `BEGIN IMMEDIATE` + subquery tanpa SKIP LOCKED).
   Tidak ada dua sistem queue tumpang tindih.
3. **Auth**: self-managed bearer token milik server (hash SHA-256 di penyimpanan, expiry + revocation + rotation),
   dengan interface `auth/provider` agar IdP eksternal bisa menggantikan. Owner ID **dari server**,
   bukan dari payload klien. Desktop memakai device token, bukan API key statis.
4. **Default-deny** di semua handler: tanpa owner scope valid → 403.
5. **Event sync**: event_id unik (idempotensi), cursor server (`events.id` monoton), outbox desktop
   berbasis file (restart-safe), tandai synced hanya setelah server konfirmasi commit.
   **Bukan last-write-wins** untuk approval / verification status / active skill pointer / budget.
6. **Migration Phase 4 → Central**: pertahankan ID, provenance, hash, status soft-delete, riwayat versi.
   Idempoten, dry-run, laporan jumlah + checksum, sumber data tidak dihapus, rollback terdokumentasi.

## Subfase
- **5A** — config, driver DB (SQLite+PG), migrasi terversi, health/readiness, skeleton server.
- **5B** — auth token, owner/device scope, policy, audit.
- **5C** — event outbox/inbox, cursor, sinkronisasi idempoten.
- **5D** — durable queue, orkestrasi misi cloud, boundary budget & approval.
- **5E** — migrasi memori/skill dengan preservasi provenance.
- **5F** — tes pemulihan, backup/restore, dokumentasi deploy, rilis.

## Yang TIDAK dikerjakan di fase ini
- Menjalankan perintah desktop lokal dari server (dilarang).
- Redis / layanan tambahan.
- Klien mobile (Phase 7).
- Sandbox OS (tetap tidak ada; jujur didokumentasikan).
