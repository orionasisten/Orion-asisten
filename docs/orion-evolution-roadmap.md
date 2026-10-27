# ORION Evolution Roadmap

## Phase 0 — Baseline (selesai sebagian)

- Audit codebase & fitur: `docs/audit-blueprint-v1.1.md`.
- Jalankan test suite: `docs/orion-evolution-test-report.md`.
- Inspeksi Windows build: `docs/WINDOWS_RELEASE.md`, `docs/WINDOWS_TEST_REPORT.md`.
- Identifikasi source-of-truth: `source/Orion_v_4_0.html`, `app-src/*`, `src/*`.
- Competitive benchmark: `docs/competitive-benchmark.md`.
- Prioritized backlog: `docs/orion-backlog.md`.

## Phase 1 — Reliability & security

- Fix confirmed defects (zoom, console logging, boot watchdog).
- Improve test coverage (smoke zoom, console capture).
- Validate Electron packaging (Windows installer/portable).
- Verify permission enforcement (connector tests).
- Secrets & user data safety (safeStorage, redaction).

## Phase 2 — Mission runtime

- Implement persistent task lifecycle (lokal dulu, lalu backend).
- Checkpoint, idempotency, recovery, budget accounting.
- Durable approvals.
- Integrasi UI.

## Phase 3 — Agent orchestration

- Capability-based adapters.
- Multi-agent & isolated workspaces.
- Controlled parallel execution.
- Provider routing & fallback.

## Phase 4 — Memory & learning

- Cross-session retrieval.
- Provenance & isolation.
- Staged skill improvement.
- Evaluasi & regresi.

## Phase 5 — Central backend

- Desktop ↔ Orion Central.
- PostgreSQL, queue workers, event sync, notifikasi.
- Definisi perilaku offline/cloud-only.

## Phase 6 — Browser, voice, business workflows

- Verified browser/computer-use.
- Voice improvement.
- Reusable product-building workflows.
- Validasi satu workflow E2E.

## Phase 7 — Mobile & release maturity

- **Phase D (mobile Android/iOS) — SELESAI di repo ini**: klien React Native + Expo (SDK 58 / RN 0.88)
  dengan pairing device token (secure store), chat lintas perangkat (server = sumber kebenaran),
  Mission Control, Approval Center, Device Management, serta push notification (mode pengembangan
  aman tanpa kredensial provider). Endpoint push token ditambahkan (migrasi `010_push_tokens`).
  Lihat `docs/phase-d-*.md`.
- **Belum selesai / terblokir**: IPA iOS (butuh macOS + Xcode), emulator/perangkat fisik
  (virtualisasi dinonaktifkan di mesin build), EAS Build & submit ke store (butuh akun + signing),
  push notification nyata (butuh kredensial FCM/APNs).
- Release validation desktop tetap berjalan (installer + portable, 15/15).

## Ringkasan status implementasi (per 22 Okt 2026)
| Fase | Status | Bukti |
|---|---|---|
| Phase 0–1 (baseline & reliability) | Selesai | 265 tes regresi hijau |
| Phase 2 (mission runtime durable) | Selesai | 22 tes integrasi |
| Phase 3 (budget/routing/executor) | Selesai | 20 tes + 6 hardening |
| Phase 3.1 (security audit) | Selesai | laporan audit + 6 tes |
| Phase 4 (memory provenance & skill versioning) | Selesai | 34 tes |
| Phase 5 (Orion Central) | Selesai | 55 tes integrasi PostgreSQL |
| Phase 5.1 (PostgreSQL nyata & Railway readiness) | Selesai | 79 tes integrasi PG + readiness |
| Phase A (multi-device API) | Selesai | 15 tes |
| Phase B (Web App) | Selesai | 20 unit + 16 E2E browser |
| Phase C (Desktop ↔ Central) | Selesai | 11 integrasi + 13 E2E lintas perangkat |
| **Phase D (mobile)** | **Selesai (dengan batasan)** | 13 unit + 13 integrasi + typecheck + APK native |
| Push notification nyata | **BLOCKED** | butuh kredensial FCM/APNs (mode dev aman) |
| iOS build/distribusi | **BLOCKED** | butuh macOS/Xcode + akun developer |

Penyesuaian urutan hanya bila bukti repo menuntut dependensi.
