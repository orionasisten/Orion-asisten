-- 002_missions.sql — misi, task, approval, budget (server-authoritative).
CREATE TABLE IF NOT EXISTS missions (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL,
  device_id       TEXT,
  title           TEXT NOT NULL,
  goal            TEXT,
  state           TEXT NOT NULL DEFAULT 'queued',
  plan            TEXT,
  budget_limit    INTEGER,
  budget_spent    INTEGER NOT NULL DEFAULT 0,
  budget_reserved INTEGER NOT NULL DEFAULT 0,
  budget_currency TEXT NOT NULL DEFAULT 'unit',
  max_executions  INTEGER NOT NULL DEFAULT 100,
  executions      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  completed_at    TEXT,
  metadata        TEXT
);
CREATE INDEX IF NOT EXISTS idx_missions_owner ON missions(owner_id, created_at);

CREATE TABLE IF NOT EXISTS mission_tasks (
  id                TEXT PRIMARY KEY,
  mission_id        TEXT NOT NULL,
  owner_id          TEXT NOT NULL,
  title             TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'pending',
  deps              TEXT NOT NULL DEFAULT '[]',
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 2,
  timeout_ms        INTEGER NOT NULL DEFAULT 60000,
  result            TEXT,
  last_error        TEXT,
  idempotency_key   TEXT,
  started_at        TEXT,
  completed_at      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_mission ON mission_tasks(mission_id);

CREATE TABLE IF NOT EXISTS approvals (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  mission_id    TEXT,
  task_id       TEXT,
  action        TEXT NOT NULL,
  resource      TEXT NOT NULL,
  params        TEXT NOT NULL DEFAULT '{}',
  scope         TEXT NOT NULL DEFAULT 'mission',
  fingerprint   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  decision      TEXT,
  decided_by    TEXT,
  decided_at    TEXT,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_approvals_owner ON approvals(owner_id, status);
-- Idempotensi: satu fingerprint = satu approval aktif per owner.
CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_fingerprint ON approvals(owner_id, fingerprint, status);

CREATE TABLE IF NOT EXISTS budget_ledger (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  mission_id    TEXT NOT NULL,
  reservation   TEXT NOT NULL,
  estimate_minor INTEGER NOT NULL DEFAULT 0,
  actual_minor  INTEGER,
  status        TEXT NOT NULL DEFAULT 'reserved',
  provider      TEXT,
  model         TEXT,
  metadata      TEXT,
  created_at    TEXT NOT NULL,
  reconciled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_ledger_mission ON budget_ledger(mission_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_reservation ON budget_ledger(reservation);
