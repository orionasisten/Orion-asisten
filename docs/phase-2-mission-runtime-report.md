# Phase 2 — Durable Local Mission Runtime Report

Tanggal: 21 Okt 2026.

## State machine

- Mission states: queued, planning, running, waiting_approval, paused, recovering, completed, failed, cancelled.
- Task states: pending, ready, running, waiting_approval, succeeded, failed, retry_wait, cancelled, outcome_unknown.
- Transisi divalidasi di `src/missions/state-machine.js` (trusted runtime code, bukan renderer).

## Persistence

- Store: `src/missions/store.js` — JSON atomik (`missions.json`) di `userData/missions`, survive upgrade.
- Runtime: `src/missions/runtime.js` — create/get/list, transition, task lifecycle, dependency validation + cycle detection, approval fingerprint, recovery, retry, cancel, idempotency key.
- IPC: `src/bridge.js` `mission:*` handlers + `src/preload.js` `orionDesktop.missions`.
- UI: section "Runtime Misi Durable (Phase 2)" di Mission Control + modal pembuatan misi durable.

## Recovery

- Saat konstruksi runtime, misi running/recovering/waiting_approval diubah ke recovering; task running → outcome_unknown (ambiguous); misi tanpa unknown → paused.

## Approval

- Approval terikat fingerprint (action, resource, params, scope); expired & mismatch ditolak; surviving restart via store.

## Tests

- `scripts/test-mission-runtime.js`: 22 lulus, 0 gagal.
- `npm test`: PASS (termasuk 22 baru).

## Remaining risks

- Budget enforcement penuh (hard budget) belum diimplementasikan di runtime (field ada, enforcement minimal) — BLOCKED/PARTIAL.
- Parallel task execution & timeout enforcement: PARTIAL (state machine mendukung, executor belum).
- UI approval per misi durable: minimal (list + pause/resume/cancel); approval detail UI belum.
- Database migration formal (SQLite) belum; JSON store v1 cukup untuk fase lokal.

## Verdict

Phase 2 core runtime: **PASS** (state machine, persistence, recovery, approval fingerprint, retry, cancel, idempotency, 22 tests).
UI integration: **PARTIAL** (daftar + buat + pause/resume/cancel).
Budget/parallel/timeout enforcement: **PARTIAL** (fase lanjutan).
