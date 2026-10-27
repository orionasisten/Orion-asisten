# Phase 5.1 — Real PostgreSQL Validation & Railway Readiness: Laporan

Tanggal: 22 Okt 2026.

## 0. Baseline (diverifikasi, bukan asumsi)
- `npm test` sebelum perubahan → **exit 0, 220 lulus, 0 gagal** (regresi Phase 2/3/4/5 + scan rahasia 0 temuan).
- Tidak ada Docker/Podman/PostgreSQL terpasang di mesin ini. PostgreSQL nyata diperoleh dari
  **binari PostgreSQL asli** (`@embedded-postgres/windows-x64` → PostgreSQL **17.10**, kompilasi msvc-19.44.3,
  `on x86_64-windows`) yang dijalankan sebagai server di cluster sementara.

## 1. Lingkungan pengujian
| Komponen | Nilai |
|---|---|
| PostgreSQL | **17.10** (x86_64-windows, msvc-19.44.3) — server sungguhan, bukan mock |
| Node.js | v24.22.0 |
| npm | 11.19 |
| Electron | 43.8.1 |
| Driver | `pg` 8.13.0 (**sama persis dengan produksi**), `pg` audit bersih |
| Port DB | port bebas acak per instance, database baru per tes (isolasi penuh) |
| SSL | server test tanpa SSL → memaksa SSL adalah **bug** (diperbaiki) |

## 2. Perintah yang dijalankan & hasil aktual
| Perintah | Jenis | Hasil |
|---|---|---|
| `npm test` (baseline) | unit + integrasi SQLite | exit 0 — **220 lulus, 0 gagal** |
| `node scripts/pg-harness.js --run scripts/test-phase5-postgres.js` | **integrasi PostgreSQL nyata** | **20 lulus, 0 gagal** |
| `node scripts/pg-harness.js --run scripts/test-phase5-desktop-central.js` | **integrasi Desktop↔Central (PG nyata)** | **8 lulus, 0 gagal** |
| `node scripts/pg-harness.js --run scripts/test-phase5-railway.js` | **Railway/operasional (PG nyata)** | **9 lulus, 0 gagal** |
| `node scripts/test-postgres-all.js` | gabungan 3 suite PG | **37 lulus, 0 gagal** |
| `npm test` (setelah perubahan) | unit + integrasi SQLite | exit 0 — **265 lulus, 0 gagal**, 0 temuan rahasia |
| `npm run smoke` | E2E Electron | **PASS** `ok:true` (12 probe) |
| `npm run verify:release` | rilis Windows | **15/15 PASS** |
| `npm run build:win:installer` + `:portable` | build | exit 0 |
| `npm run release:finalize` | finalisasi | exit 0 |

Pemisahan tegas sesuai permintaan:
- **Tes unit**: 265 (Node, tanpa DB eksternal) — termasuk 45 integrasi SQLite.
- **Tes integrasi SQLite**: 45 (SQL nyata, transaksi nyata, constraint nyata — **bukan mock**).
- **Tes integrasi PostgreSQL nyata**: 29 (20 + 9) — driver `pg`, server PG 17.10 sungguhan.
- **Tes end-to-end desktop**: smoke Electron (12 probe) + 8 integrasi Desktop↔Central di atas PostgreSQL nyata.
- **Tes deployment Railway**: **BELUM DIJALANKAN** (tidak ada kredensial Railway). Yang divalidasi =
  kesiapan teknis (port/binding, advisory lock, readiness, shutdown, validasi config) — bukan deploy nyata.

## 3. Masalah yang ditemukan & diperbaiki
| # | Masalah (ditemukan oleh) | Dampak | Perbaikan |
|---|---|---|---|
| 1 | `pg` driver **memaksa** `ssl:{rejectUnauthorized:true}` → "server does not support SSL connections" | Server PostgreSQL lokal/internal tak bisa diakses sama sekali | Driver tidak lagi memaksa SSL; mengikuti `sslmode=` di connection string. Opsi eksplisit `CENTRAL_PG_SSL=verify-full` (verifikasi CA penuh) untuk produksi |
| 2 | `MAX(a,b)` 2-argumen di `sync_cursors` upsert | **Error PostgreSQL** (`function max(integer,integer) does not exist`) — sinkronisasi cursor gagal total | Diganti ekspresi `CASE WHEN ... THEN ... ELSE ... END` yang portabel SQLite+PG |
| 3 | Kolom tidak ter-kualifikasi dalam `ON CONFLICT ... DO UPDATE` | **Ambiguous column** di PostgreSQL | Dikualifikasi (`sync_cursors.last_cursor`) |
| 4 | **Race condition queue**: 5 worker konkuren → hanya 4 job ter-claim (MVCC PostgreSQL memilih baris yang sama) | Job bisa "terkunci" tanpa pernah diklaim (starvasi) | Subquery claim memakai **`FOR UPDATE SKIP LOCKED`** (pola kanonik PostgreSQL); SQLite tetap pakai transaksi `BEGIN IMMEDIATE` |
| 5 | `owners.email` **tidak** punya UNIQUE constraint | Race condition bootstrap owner (cek aplikasi bisa dilewati) | Migrasi `006_owner_email_unique.sql` → unique index |
| 6 | Skema **tanpa FOREIGN KEY** | Rows yatim bisa terjadi (mis. task tanpa mission) | Migrasi `007_foreign_keys.sql` (PostgreSQL) — 25 constraint FK; runner migrasi kini sadar-dialect (`-- only: postgres`) |
| 7 | Directive dialect tidak dibaca (cek `opts.dialect` bukan variabel `dialect`) | Migrasi PG-only dieksekusi di SQLite → **SQLite suite tumbang (40 gagal)** | Diperbaiki; suite SQLite kembali 45/45 |
| 8 | `PORT` platform (Railway) **tidak** dibaca; host default `127.0.0.1` | Server **tidak bisa terjangkau** dari luar container di Railway | `CENTRAL_PORT` → fallback ke `PORT`; bila `PORT` platform terdeteksi, host default `0.0.0.0` |
| 9 | Migrasi bisa dijalankan **bersamaan** oleh banyak instance | DDL balRace saat start bersamaan | Advisory lock global PostgreSQL (`pg_advisory_lock`) di sekitar migrasi — diuji 3 migrasi paralel |
| 10 | `/v1/ready` bisa **menggantung** tak terbatas bila DB macet | Health check platform timeout | Readiness diberi **timeout 3 detik** → 503 `DEPENDENCY_UNAVAILABLE` |
| 11 | Shutdown **tidak menutup pool DB** | Kebocoran koneksi & proses menggantung saat deploy | `shutdown()` menutup HTTP server **dan** pool; start gagal juga menutup pool |
| 12 | Start gagal tidak menutup pool / risking retry loop tak terbatas | Proses menggantung, resource bocor | Start gagal → tutup pool → keluar dengan pesan jelas (diuji: < 5 detik) |
| 13 | **Gap fungsional**: migrasi memori/skill hanya mengirim *event* — data tidak pernah masuk tabel yang bisa dikueri | "Migrasi Phase 4" tidak benar-benar mengimpor data | Ditambah endpoint `POST /v1/memory/import`, `POST /v1/skills/import`, `POST /v1/memory/rollback-import`; desktop sekarang memanggilnya |
| 14 | `CENTRAL_PORT=0` ditolak validasi | Server tidak bisa memakai port ephemeral (tes) | Port 0 diizinkan ("pilih port bebas") |
| 15 | Restore logis mengabaikan urutan FK | Restore gagal (FK violation) | Restore memakai topological-sort dari `information_schema` (bukti di tes) |

## 4. Ringkasan validasi per kapabilitas (semua **dijalankan**)
| Kapabilitas | Bukti | Hasil |
|---|---|---|
| DB kosong → semua migrasi | 7 migrasi terpasang di PG 17.10 | PASS |
| Migrasi berulang aman | `applied=0`, jumlah versi tetap | PASS |
| Checksum berubah terdeteksi | `CHECKSUM_MISMATCH` | PASS |
| Transaksi gagal → rollback atomik | insert pertama hilang setelah error | PASS |
| Unique constraint | `owners.email` duplikat ditolak | PASS |
| Foreign key | task tanpa mission ditolak | PASS |
| Event duplikat | 1 event setelah 2× upload | PASS |
| Cursor tidak melewatkan event | 7 event diambil 3+3+1, lalu 0 | PASS |
| 2 worker bersamaan | 5 job → 5 klaim **berbeda** (sebelum fix: hanya 4) | PASS (setelah fix) |
| Lease kedaluwarsa dipulihkan | job kembali `queued` lalu diklaim ulang | PASS |
| Retry/backoff/dead-letter | backoff menahan klaim; attempt ke-2 → dead_letter | PASS |
| `outcome_unknown` | → dead_letter, **tidak** auto-retry | PASS |
| Owner A ≠ Owner B | SELECT & UPDATE ter-scope 0 baris | PASS |
| Token expiry/revocation/rotation | 401/salah/expired/revoked/rotated | PASS |
| Konflik bukan LWW | approval.decision, memory.verification, skill.active ditolak (conflict tercatat) | PASS |
| Migrasi data Phase 4 | ID, provenance, hash, versi, soft-delete, riwayat versi terjaga | PASS |
| Backup & restore | ekspor/import logis ke DB baru, isi & hash identik | PASS |
| Desktop↔Central | outbox tahan restart, retry tanpa duplikasi, token mati, konflik jelas, 0 secret | PASS (8/8) |
| Railway readiness | port/binding, advisory lock, readiness timeout, shutdown, validasi config | PASS (9/9) |

## 5. Cara mengulang tes dari database kosong
```bash
npm install --no-save embedded-postgres@17.10.0-beta.17
npm install-scripts approve @embedded-postgres/windows-x64
npm rebuild @embedded-postgres/windows-x64
npm run test:postgres          # 3 suite PostgreSQL nyata (37 tes)
```
Manual per suite:
```bash
node scripts/pg-harness.js --run scripts/test-phase5-postgres.js
node scripts/pg-harness.js --run scripts/test-phase5-desktop-central.js
node scripts/pg-harness.js --run scripts/test-phase5-railway.js
```
Terhadap PostgreSQL eksternal (mis. Railway staging):
```bash
DATABASE_URL="postgresql://..." node scripts/test-phase5-postgres.js
```
Tanpa PostgreSQL → suite **DILEWATI (exit 2)**, bukan diklaim lulus.

## 6. Bukti backup/restore
Dieksekusi di `scripts/test-phase5-postgres.js` (fungsi "backup & restore PostgreSQL nyata"):
ekspor seluruh tabel ke memori → database baru dibuat → `TRUNCATE` target → restore dengan urutan
topologis berbasis FK → diverifikasi: `memory_records` kembali dengan `integrity_hash` & `source_ref`
identik, `owners` utuh. `pg_dump`/`pg_restore` **tidak tersedia** di paket binari yang dipakai, sehingga
prosedur logis ini yang diuji (dokumentasi deployment Covers keduanya).

## 7. Status deployment
- **Railway deploy: BELUM DIJALANKAN** — tidak ada kredensial Railway. Tidak ada klaim deploy berhasil.
- Kesiapan teknis yang **terbukti**: port `PORT` + bind `0.0.0.0`, advisory lock migrasi, readiness
  503 dengan timeout, shutdown menutup pool, `DATABASE_URL` & `CENTRAL_SETUP_KEY` hanya dari env,
  `.env` di-gitignore, scan rahasia repo 0 temuan, TLS production via `sslmode=verify-full`.
- Perintah deploy persis ada di `docs/phase-5-deployment.md`.

## 8. Batasan tersisa & risiko produksi
- **Rate limiter in-memory per instance** — bukan proteksi lintas instance; didokumentasikan. Untuk
  multi-instance: pindahkan ke Redis/Postgres.
- **FOREIGN KEY hanya di PostgreSQL**; driver SQLite (dev) tidak menegakkannya (SQLite tak mendukung
  `ALTER TABLE ADD CONSTRAINT`). Integritas owner tetap dijaga di level aplikasi.
- **PostgreSQL < 12 belum diuji** — hanya 17.10 yang diverifikasi.
- `pg_dump` tidak tersedia di paket uji → jalur restore logis yang diuji, bukan `pg_restore`.
- Tidak ada OS-level sandboxing untuk job worker; skill pihak ketiga tidak dieksekusi server.
- **Deploy & TLS Railway nyata: UNVERIFIED** (tidak dijalankan).
- Native dialog E2E: **UNVERIFIED**; Windows 10 native: **BLOCKED**; code signing: **BLOCKED**.

## 9. File dibuat/diubah
**Baru**: `scripts/pg-harness.js`, `scripts/test-phase5-postgres.js`,
`scripts/test-phase5-desktop-central.js`, `scripts/test-phase5-railway.js`,
`scripts/test-postgres-all.js`, `src/central/db/migrations/006_owner_email_unique.sql`,
`src/central/db/migrations/007_foreign_keys.sql`, `docs/phase-5.1-postgres-validation-report.md`.

**Diubah**: `src/central/db/pg-driver.js` (TLS, advisory lock), `src/central/db/migrate.js` (dialect),
`src/central/db/index.js`, `src/central/config.js` (PORT/host/PG_SSL/port 0), `src/central/app.js`
(readiness timeout, endpoint import), `src/central/server.js` (shutdown, kegagalan start),
`src/central/sync/events.js` (CASE portabel), `src/central/queue/queue.js` (SKIP LOCKED),
`src/central/client.js` (import API), `src/bridge.js` (migrasi → endpoint import),
`docs/phase-5-deployment.md`, `package.json` (script `test:postgres` dkk).

## 10. Artefak build (SHA-256 dihitung ulang dari berkas)
- `release/ORION-Setup-4.0.0-x64.exe` — `78ea27bcf6cd9cd8ad756d70bb7d84b6a970da6c2ccdc7f4d6839875f0c2b8e5`
- `release/ORION-Portable-4.0.0-x64.exe` — `84b39ef93a10e82665d41efa739759a84fd584bd0c52ebaa4185fc733b0e5481`
- `release/verification.json` — 15/15 PASS.

## 11. Rekomendasi
Lanjut ke staging Railway (butuh kredensial): deploy, jalankan `npm run test:postgres` terhadap
`DATABASE_URL` staging, lakukan bootstrap owner, uji migrasi memori/skill dari desktop, lalu
verifikasi backup/restore `pg_dump` di environment staging. Setelah itu — dan hanya setelah itu —
lanjut ke Phase 6.
