# Phase 4 — Implementation Plan (Trustworthy Memory & Versioned Skills)

## Scope
Two core areas:
- **A. Trustworthy memory with provenance & access control** (new `src/memory/*`)
- **B. Versioned skills with evaluation, activation, rollback** (new `src/skills/*`)

Plus IPC/preload/UI integration, tests, docs. Keep local-first; no cloud/paid API deps.

## Files to create
- `src/memory/store.js` — atomic JSON file store under userData/memory
- `src/memory/service.js` — provenance service (create/update/supersede/delete/search/access control)
- `src/memory/tests.js` — memory tests
- `src/skills/registry.js` — immutable skill version registry + lifecycle
- `src/skills/evaluator.js` — deterministic offline evaluation harness
- `src/skills/tests.js` — skill versioning/evaluation tests
- `docs/phase-4-implementation-report.md`

## Files to modify
- `src/bridge.js` — IPC handlers `memory:*`, `skill-version:*`
- `src/preload.js` — expose `orionDesktop.memory.*` and `orionDesktop.skillVersion.*`
- `source/Orion_v_4_0.html` — minimal UI (memory provenance view, skill version view)
- `package.json` — add phase-4 tests to `npm test`
- `docs/phase-4-implementation-plan.md` (this file)

## Design decisions
- Memory uses file-based JSON store (main process accessible via IPC), NOT renderer localStorage only, so main process can enforce access control.
- Memory records: SHA-256 integrity hash, provenance fields (origin/sourceRef/excerpt), status active|superseded|archived|deleted, redact secrets.
- Agent inference never promoted to verified fact automatically.
- Skill versions: content hash (SKILL.md + manifest), semantic version, immutable after registration, evaluation report bound to exact hash, activation pointer atomic, rollback preserves prior active version.
- No OS sandboxing claimed; skills run with main process privileges — documented honestly.
- Evaluation: manifest/schema validation, capability check, permission-policy check, secret leakage check, dependency availability, contract tests — all offline/mock.

## Baseline
- `npm test` currently passes 176 tests. Must remain green after Phase 4.

## Acceptance tests (executed, not just designed)
- Memory provenance survives restart; forged provenance rejected; inference not fact; conflict not silently overwritten; unauthorized scope rejected; secrets redacted; corrupted persistence handled; insufficient evidence reported; IPC can't forge owner/trust/permissions.
- Skill duplicate version rejected; content mutation invalidates hash; invalid manifest rejected; disallowed permission rejected; evaluation binds to exact hash; failed/stale eval prevents activation; atomic activation; rollback restores prior version; failed rollback keeps active; quarantined can't execute; dependency failure prevents activation; secrets not in reports/errors.

## Known limitations / UNVERIFIED
- OS-level sandboxing NOT implemented (documented honestly).
- Native dialog E2E / Windows 10 / code signing — BLOCKED (existing constraint).
