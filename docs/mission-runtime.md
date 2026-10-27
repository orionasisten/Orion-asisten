# ORION Mission Runtime Specification

Dokumen ini menspesifikasikan runtime misi yang tahan lama. Implementasi saat ini hanya memakai `localStorage`/array di `source/Orion_v_4_0.html`; dokumen ini adalah target yang harus diimplementasikan bertahap (Phase 2).

## Entitas (adaptasi nama dari skema existing)

Jangan duplikasi tabel bila struktur setara sudah ada. Pemetaan:

| Entitas konseptual | Struktur existing yang terdekat | Catatan |
|---|---|---|
| `missions` | `State.missions` (array localStorage) | Perlu migrasi ke DB durable |
| `mission_tasks` | Belum ada | Task graph granular |
| `mission_dependencies` | Belum ada | Dependency antar task |
| `mission_events` | `State.log` (array) | Perlu append-only + ordering |
| `mission_checkpoints` | Belum ada | Checkpoint durable |
| `approvals` | Dialog persetujuan (transien) | Perlu durable + binding param |
| `agent_runs` | Belum ada | Catatan eksekusi agent |
| `agent_profiles` | Skill/plugin registry | Perlu profil kapabilitas |
| `tool_invocations` | Audit connector (append-only) | Perlu cakupan semua tool |
| `budget_ledger` | Belum ada | Anggaran per misi/provider |
| `artifacts` | Knowledge Hub (lokal) | Perlu tracking artefak misi |
| `memory_records` | Memory Brain (lokal) | Perlu provenance/scope |
| `skill_versions` | Skill folder | Perlu versioning |
| `audit_events` | `State.log` + audit chain connector | Perlu tamper-evident global |

## Lifecycle misi

State utama: `draft → planned → running → waiting_approval → running → completed | failed | cancelled`.

Transisi harus eksplisit dan dicatat di `mission_events` dengan timestamp, aktor (user/agent/sistem), dan idempotency key.

## Aturan transaksi

1. Jangan tahan transaksi DB selama panggilan model atau operasi browser.
2. Tulis checkpoint sebelum dan sesudah operasi eksternal.
3. Gunakan idempotency key untuk setiap side effect tak-idempoten (publish, deploy, pembayaran, pengiriman).
4. Retry hanya boleh dilakukan jika checkpoint menunjukkan operasi belum selesai; jika selesai, kembalikan hasil tersimpan.

## Kemampuan yang harus dimiliki misi

1. Persist setelah dibuat.
2. Menghasilkan rencana dengan task & dependency.
3. Mengeksekusi task terotorisasi.
4. Pause saat approval diperlukan.
5. Resume setelah approval.
6. Bertahan dari restart backend/worker.
7. Retry kegagalan transien dengan aman.
8. Tidak menduplikasi side effect tak-idempoten setelah recovery.
9. Berhenti saat dibatalkan atau batas anggaran/izin terlampaui.
10. Mencatat penggunaan aktual dan output.
11. Memverifikasi kriteria selesai.
12. Menghasilkan laporan akhir yang dapat diperiksa.

## Idempotency & recovery

- Setiap `agent_run` dan `tool_invocation` memiliki `idempotency_key`.
- Operasi eksternal menyimpan `provider_receipt`/status verifikasi.
- Setelah restart, worker membaca checkpoint terakhir dan melanjutkan dari task yang belum selesai; task yang sudah `completed` tidak diulang.
- Jika status tidak pasti (mis. timeout tanpa receipt), masuk state `needs_reconciliation` dan jalankan reconciler sebelum retry.

## Approval

- Approval terikat pada aksi, resource, scope, dan parameter relevan.
- Jika parameter berubah, approval lama tidak boleh dipakai (fingerprint).
- Approval pending harus bertahan restart.

## Budget

- `budget_ledger` mencatat estimasi dan penggunaan aktual per misi dan per provider.
- Mode no-spend/restricted-budget harus didukung.
- Budget habis → misi pause dengan status `budget_exceeded`, bukan diam-diam lanjut.

## Completion verification

- Kriteria selesai didefinisikan di awal (input contract + expected artifacts).
- Verifikasi memeriksa artefak, tes, log, dan receipt.
- Jangan tandai `completed` hanya karena status field.

## Catatan implementasi bertahap

Fase 2: implementasi lokal (single-user) dengan state machine + checkpoint di `localStorage`/file, lalu migrasi ke backend. Jangan rewrite massal. Tes minimal: mission survive restart, approval survive restart, retry tidak duplikasi operasi.
