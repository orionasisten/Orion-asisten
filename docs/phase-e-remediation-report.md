# Phase E1-R — Remediation Report (R1–R5)

**Tanggal laporan:** 23 Oktober 2026  
**Periode audit:** 22–23 Oktober 2026  
**Repo:** `C:\Users\DIGIUM\Documents\Orion`  
**Status akhir:** **R1–R5 selesai; E2/E3 belum siap karena lingkungan Windows / tanpa admin / tanpa CI.** Tidak ada deployment.

---

## 1. Ruang lingkup remediaton

- R1 (auth/session/replay/revoke/logout/SSE)
- R2 (push token bound device / event identity 011 / server-side policy)
- R3 (respond boundary 503 / audit role/scope)
- R4 (budget CASE / delta SQL filter / outbox persistence / rate limit redesign / desktop confirmation)
- R5 (mobile URL normalization / pairing server verification / hydration / pairing status)

Tidak menyentuh: E2 Android native, E3 deployment/CI, load test, backup restore end-to-end.

---

## 2. Sebelum vs Setelah (ringkasan)

| R | Sebelum (audit) | Setelah (bukti) |
|---|---|---|
| R1 | Refresh setelah access kedaluwarsa 401; replay tidak terdeteksi; logout tidak mencabut; SSE tetap terbuka setelah revoke; cookie login menerima deviceId arbitrer | Refresh via cookie setelah kedaluwarsa 200; replay 401 + revoke; logout `DELETE /v1/sessions/current` + cookie bersih; SSE berhenti; cookie login validasi device aktif | Phase A 22/22, Phase B 16/16, probe PASS |
| R2 | Push token bisa direbut owner lain; tidak dicabut saat device rev; event ID global, squatting | Push token device-bound; revoke cascade; event identity `(owner_id, id)` via 011; server-side role/scope/memory policy | Phase D 17/17, probe PASS |
| R3 | `/respond` bisa melewati budget/approval; tidak ada batas inference | `/v1/conversations/:id/respond` 503 `INFERENCE_WORKER_UNAVAILABLE`; batas server-side; audit role/scope | Phase B, audit checks |
| R4 | `reconcileBudget` `MAX` gagal PG; delta filter JS salah; outbox gagal dihapus; rate limit hanya IP (early block) | `CASE`/`GREATEST` sesuai DB; delta SQL filter + `hasMore` benar; outbox `markFailed`/`retryFailed`; rate limit per owner/IP setelah auth (early rate dihapus) | Postgres 81/81, probe PASS |
| R5 | URL pairing diabaikan; hydration balapan; pairing status tidak ditampilkan | `setApiBaseUrl` dipanggil saat pairing; hidrasi sebelum refresh; status pairing ditampilkan; URL divalidasi https non-local | Mobile 15/15, typecheck OK |

---

## 3. Bukti regresi (suit + probe)

- `npm test` (desktop): exit 0; 270+ lulus; hanya `test-webtools` performance lingkungan (tidak regresi kontrak).
- `npm run test:postgres`: exit 0; 81/81.
- `npm run test:phaseA / phaseB / phaseD`: Phase A 22/22, Phase B 16/16, Phase D 17/17.
- `node scripts/audit-phaseE-probes.js`: 13/14 PASS, 1 INFO (`push-tokens-response-minimal` — respons minimals sesuai kontrak); semua R1-R5 probe PASS setelah edit.
- `npm run build` (web): OK; bundle 186.49 kB.
- `cd mobile && npm test`: 15/15.
- `cd mobile && npm run typecheck`: OK.
- `cd web && npm test`: OK; 20 tes / 3 file.

---

## 4. Perubahan source utama (tanpa merusak kontrak API)

- `src/central/app.js`: auth/logout/refresh middleware, rate limit redesign (hapus early IP block), budget validation (`budgetLimit >= 0`, `maxExecutions >= 0`), `/v1/conversations/:id/respond` 503, SSE close on revoke, cookie session device check, event identity query.
- `src/central/auth/tokens.js`: replay detection, revocation, dummy hash unknown login.
- `src/central/conversations.js`: session refresh/revoke, device revocation cascade.
- `src/central/policy/scope.js`: server-side `canAccessMemory`, role checks.
- `mobile/src/state/session.tsx`, `client.ts`: URL normalization + hydration + pairing status.
- `scripts/test-phaseA-multidevice.js`, `test-phaseD-mobile.js`: regresi tambahan.
- Migrasi `011`: event identity `(owner_id, id)`; SQLite/PG rebuilt.

---

## 5. Risiko sisa yang harus dicatat sebelum deploy

- Rate limit masih in-memory; harus diganti shared store jika multi-instance.
- E2 Android native belum bisa di-build/test karena Windows MAX_PATH dan tidak ada emulator/perangkat.
- `test-webtools` performance bisa lambat di mesin rendah; bukan regresi keamanan.
- Backup restore belum diuji end-to-end.
- Tidak ada real secret yang dimasukkan; semua token di test menggunakan dummy/hash.

---

## 6. Kesimpulan kesiapan

- **R1–R5: Selesai, terbukti, tidak ada regresi kontrak API.**
- **Tidak ada deployment / publikasi / pengubahan DNS / kredensial baru.**
- **E2 Android: Diblokir oleh lingkungan, tidak dilakukan tanpa admin/WSL.**
- **E3 (deploy/CI): Belum siap karena tidak ada kredensial pipeline.**
- **Rekomendasi:** sebelum deploy produksi, selesaikan rate limit shared, uji restore backup, dan verifikasi E2 native di lingkungan yang mendukung (Linux/macOS + emulator).
