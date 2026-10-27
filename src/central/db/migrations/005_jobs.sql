-- 005_jobs.sql — durable queue (PostgreSQL-based, tanpa Redis) + idempotency + dead-letter.
CREATE TABLE IF NOT EXISTS jobs (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL,
  mission_id      TEXT,
  kind            TEXT NOT NULL,
  payload         TEXT NOT NULL DEFAULT '{}',
  state           TEXT NOT NULL DEFAULT 'queued',
  priority        INTEGER NOT NULL DEFAULT 100,
  attempts        INTEGER NOT NULL DEFAULT 0,
  max_attempts    INTEGER NOT NULL DEFAULT 5,
  idempotency_key TEXT,
  worker_id       TEXT,
  lease_expires_at TEXT,
  heartbeat_at    TEXT,
  available_at    TEXT NOT NULL,
  last_error      TEXT,
  result          TEXT,
  dead_letter     TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_claim ON jobs(state, available_at, priority);
CREATE INDEX IF NOT EXISTS idx_jobs_owner ON jobs(owner_id, state);
-- Idempotensi: satu job per (owner, idempotency_key) bila key diisi.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_idempotency ON jobs(owner_id, idempotency_key);

CREATE TABLE IF NOT EXISTS job_attempts (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL,
  owner_id      TEXT NOT NULL,
  attempt       INTEGER NOT NULL,
  worker_id     TEXT,
  outcome       TEXT NOT NULL,
  error         TEXT,
  started_at    TEXT NOT NULL,
  finished_at   TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobattempts_job ON job_attempts(job_id);
