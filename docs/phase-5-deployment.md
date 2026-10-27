# Orion Central — Deployment, Backup & Recovery

Dokumen operasional untuk menjalankan backend terpusat Orion. Desktop **tetap berfungsi penuh tanpa
server** — Central bersifat opsional (hybrid local + cloud).

## 1. Menjalankan lokal (dev)

```bash
npm install
# salin .env.example -> .env lalu isi CENTRAL_SETUP_KEY (min. 32 karakter acak)
CENTRAL_ENV_FILE=.env node src/central/server.js
```

Output:
```
Orion Central listen di http://127.0.0.1:8787 (driver=sqlite)
```

- Driver `sqlite` → file `orion-central.db` di folder kerja (tanpa layanan eksternal).
- Migrasi otomatis dijalankan saat start (terversi + checksum).
- Bootstrap owner pertama (WAJIB, hanya sekali):

```bash
curl -X POST http://127.0.0.1:8787/v1/auth/bootstrap \
  -H 'Content-Type: application/json' \
  -H "x-setup-key: $CENTRAL_SETUP_KEY" \
  -d '{"email":"owner@digium.com","displayName":"Orion Owner"}'
```
Respons memuat `token` (plaintext, **hanya ditampilkan sekali**) dan `ownerId`.

## 2. Deploy ke Railway

1. **Buat service** Railway → Deploy from GitHub repo.
2. **Variable** (Settings → Variables) — WAJIB:
   | Key | Nilai |
   |---|---|
   | `CENTRAL_DB_DRIVER` | `postgres` |
   | `DATABASE_URL` | dari plugin PostgreSQL Railway (format `postgresql://…?sslmode=require`) |
   | `CENTRAL_SETUP_KEY` | string acak ≥32 karakter (simpan di secret manager) |
   | `CENTRAL_HOST` | `0.0.0.0` |
   | `CENTRAL_PORT` |Railway menyediakan `PORT` → gunakan `process.env.PORT` |
   | `CENTRAL_TOKEN_TTL_HOURS` | `720` |
3. **Start command**: `node src/central/server.js`
4. Tambahkan **PostgreSQL plugin** → `DATABASE_URL` terisi otomatis.
5. Railway menyediakan TLS otomatis untuk domain `*.up.railway.app`.
6. Setelah up: jalankan bootstrap sekali dari laptop (butuh `CENTRAL_SETUP_KEY`).

> **Port & binding (diperbaiki di Phase 5.1):** server memakai `CENTRAL_PORT` bila diset; bila tidak,
> otomatis memakai `PORT` yang disediakan platform. Bila `PORT` platform terdeteksi, host default
> menjadi `0.0.0.0` (wajib di dalam container — `127.0.0.1` hanya loopback).
> **Tidak perlu set `CENTRAL_PORT` di Railway.**

## 3. Environment variables

| Variabel | Default | Keterangan |
|---|---|---|
| `CENTRAL_HOST` | `127.0.0.1` | bind address server |
| `CENTRAL_PORT` | `8787` | port HTTP |
| `CENTRAL_DB_DRIVER` | `sqlite` | `sqlite` atau `postgres` |
| `CENTRAL_DB_FILE` | `orion-central.db` | hanya untuk sqlite |
| `DATABASE_URL` | — | **wajib** untuk postgres |
| `CENTRAL_SETUP_KEY` | — | **wajib** di produksi; tanpa ini bootstrap menolak semua permintaan |
| `CENTRAL_TOKEN_TTL_HOURS` | `720` | masa berlaku token |
| `CENTRAL_RATE_LIMIT_PER_MIN` | `120` | rate limit per IP |
| `CENTRAL_MAX_BODY_BYTES` | `1048576` | batas ukuran body |
| `CENTRAL_PG_SSL` | — | `disable` / `require` / `verify-full`. Kosong = mengikuti `sslmode=` di `DATABASE_URL`. **Produksi: `verify-full`** (verifikasi CA penuh) |
| `CENTRAL_PG_POOL_MAX` | `10` | jumlah koneksi pool PostgreSQL |
| `CENTRAL_ENV_FILE` | — | path file `.env` opsional |
| `ORION_CENTRAL_URL` | — | URL Central sisi desktop |

**Tidak ada secret di repo.** `.env.example` hanya berisi placeholder. `CENTRAL_SETUP_KEY`,
`DATABASE_URL`, dan token harus berasal dari secret manager Railway.

## 4. Menghubungkan desktop ke Central

1. Settings → **Orion Central** → **Konfigurasi** → tempel token akses.
2. Token disimpan di **main process** (memori, hilang saat app ditutup) — tidak pernah masuk renderer
   atau localStorage.
3. **Sinkronkan sekarang** mengirim event outbox dan menampilkan status (terhubung / tertunda / galat).
4. **Migrasi data lokal (dry-run)** menghitung berapa record memori & skill yang akan diimpor beserta
   checksum — tanpa menulis apa pun.
5. **Migrasi data lokal (jalankan)** mengunggah metadata ke `POST /v1/memory/import` &
   `POST /v1/skills/import` — server memvalidasi & menerapkan (provenance dipertahankan, secret
   diredact, idempoten, konflik dilaporkan). `POST /v1/memory/rollback-import` membatalkan hasil impor.

## 5. Backup & restore

### Backup (PostgreSQL)
```bash
pg_dump "$DATABASE_URL" --format=custom --file orion-central-$(date +%F-%H%M).dump
```
Atau lewat Railway: snapshot database dari dashboard.

### Backup (SQLite)
```bash
cp orion-central.db orion-central-$(date +%F-%H%M).db
```
Jalankan saat server berhenti, atau pakai `.backup` API SQLite.

### Restore
```bash
pg_restore --clean --if-exists --dbname "$DATABASE_URL" orion-central-2026-10-22.dump
```
> Restore menghapus data yang ada (`--clean`). Lakukan dry-run di DB terpisah bila perlu.
> Migrasi tabel `schema_migrations` ikut direstore; setelah restore jalankan
> `node src/central/server.js` — migrasi akan dilewati bila versi sudah tercatat.

> **Penting (Phase 5.1):** constraint FOREIGN KEY aktif di PostgreSQL. Restore **wajib** mengikuti
> urutan ketergantungan (tabel induk sebelum anak). `pg_restore` menangani ini otomatis, tetapi
> **restore logis via API** (seperti pada `scripts/test-phase5-postgres.js`) harus melakukan
> topological-sort berdasarkan `information_schema` — contoh lengkap ada di file tes tersebut.

### Restore logis (tanpa `pg_dump`)
`pg_dump` tidak disertakan pada paket binari PostgreSQL yang dipakai untuk pengujian. Untuk database
kecil, ekspor/import logis via `pg` client bisa dipakai — contoh lengkap & teruji ada di
`scripts/test-phase5-postgres.js` (fungsi backup & restore, termasuk pengurutan FK).

### Koordinasi migrasi multi-instance (Phase 5.1)
Migrasi dijalankan di bawah **PostgreSQL advisory lock** global, sehingga beberapa instance Railway
yang start bersamaan tidak menjalankan DDL bersamaan. Terbukti tes
`scripts/test-phase5-railway.js` (3 migrasi paralel → aman, tanpa versi tercatat dobel).

### Backup registry lokal (desktop)
`Desktop Hub → Skills → Skill Berversi → Cadangkan registry` menulis ke
`<userData>/backups/skills/`.

## 6. Rollback

### Rollback migrasi data lokal → Central
Data sumber (file lokal) **tidak pernah dihapus**. Untuk membatalkan hasil migrasi di server:
```js
const { rollbackMigration } = require('./src/central/migrate/migrate-local');
await rollbackMigration(db, ownerId);  // menghapus baris hasil migrasi, sumber utuh
```

### Rollback versi aplikasi
Installer Windows: jalankan Setup versi sebelumnya → installer menimpa berkas (data pengguna di
`%APPDATA%\ORION` **tidak** dihapus karena `deleteAppDataOnUninstall=false`).

## 7. Rotasi & pencabutan kredensial

- **Token**: `POST /v1/auth/token/{id}/rotate` → token lama dicabut, token baru diterbitkan.
  Klien harus menyimpan token baru (token lama langsung mati).
- **Device**: `DELETE /v1/devices/{id}` → device dicabut **dan semua token device ikut dicabut**.
- **Setup key**: ganti `CENTRAL_SETUP_KEY` di Railway lalu restart → bootstrap lama tidak berlaku lagi.
  (Owner & token yang sudah terbit TIDAK ikut mati — putar token bila key bocor.)

## 8. Respons insiden

| Situasi | Tindakan |
|---|---|
| Token bocor | `POST /v1/auth/token/{id}/rotate` (atau `DELETE` untuk mencabut) + audit log |
| Device hilang/dicuri | `DELETE /v1/devices/{id}` → token device mati seketika |
| Setup key bocor | Ganti `CENTRAL_SETUP_KEY`, restart, rotasi semua token |
| Anomali data | `GET /v1/audit` (owner-scoped) untuk melihat tindakan sensitif |
| DB suspect | Restore backup, lalu jalankan migrasi (otomatis idempoten) |

## 9. Batasan yang diketahui

- **Integrasi PostgreSQL belum terverifikasi di lingkungan build ini** (tidak ada server PostgreSQL).
  Skema SQL portabel & driver `pg` tersedia, tetapi tes integrasi PostgreSQL nyata
  **BLOCKED** — jalankan `CENTRAL_DB_DRIVER=postgres npm test` (atau skrip migrasi) di environment
  dengan PostgreSQL sebelum production.
- Rate limiter bersifat in-memory per instance → untuk multi-instance, butuh store bersama
  (Redis/Postgres) — **belum diimplementasikan** (dokumentasikan bila skalakan multi-instance).
- Tidak ada OS-level sandboxing: job worker berjalan dengan hak proses server. Skill dari pihak
  ketiga **tidak** dieksekusi oleh server; server hanya menyimpan metadata & evaluasi.
- Server **tidak** menjalankan perintah di komputer pengguna; eksekusi lokal tetap di desktop.
