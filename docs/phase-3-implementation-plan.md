# Phase 3 Implementation Plan

## Discovered architecture
- Runtime: `src/missions/runtime.js` (JSON store, state machine, approval, recovery).
- State machine: `src/missions/state-machine.js`.
- Store: `src/missions/store.js`.
- IPC: `src/bridge.js` mission:* handlers; preload `orionDesktop.missions`.
- UI: Mission Control durable section in `source/Orion_v_4_0.html`.
- AI adapter: `source/Orion_v_4_0.html` (ORION-AI-CORE), provider settings single provider.
- Connectors: `src/connectors/*` policy/SSRF/audit.

## Plan
1. Budget module `src/missions/budget.js` (integer minor units, reserve/reconcile/release, concurrency map).
2. Adapter contract `src/missions/adapters.js` (capability metadata + OpenAI-compatible adapter).
3. Router `src/missions/router.js` (deterministic selection, fallback eligibility).
4. Executor `src/missions/executor.js` (bounded concurrency, workspace isolation, timeout, idempotency, recovery).
5. Integrate runtime: task budget reservation, routing, execution, audit events, usage accounting.
6. IPC/UI: budget display, routing summary, errors.
7. Tests: budget/routing/parallel/workspace/timeout/audit.
8. Build release.

## Risk analysis
- Hard budget without provider usage data: use conservative reservation + unknown policy (block/require approval).
- Workspace isolation: validate paths against trusted root; no arbitrary absolute paths.
- No cloud deps; local/offline.

## Acceptance tests
- budget reservation atomic, no over-spend, retry/fallback counted.
- capability enforcement, fallback only transient.
- concurrency limits, dependency order, workspace traversal rejection.
- timeout/outcome_unknown handling.
- tests pass, smoke pass, release build.
