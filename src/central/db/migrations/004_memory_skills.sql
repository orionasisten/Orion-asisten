-- 004_memory_skills.sql — metadata memori & skill (Phase 4) dengan preservasi provenance.
-- Kolom provenance Phase 4 dipertahankan apa adanya (tidak disederhanakan).
CREATE TABLE IF NOT EXISTS memory_records (
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL,
  schema_version      INTEGER NOT NULL,
  type                TEXT NOT NULL,
  content             TEXT NOT NULL,
  origin              TEXT NOT NULL,
  source_ref          TEXT,
  excerpt             TEXT,
  created             TEXT NOT NULL,
  updated             TEXT NOT NULL,
  confidence          REAL,
  verification_status TEXT NOT NULL,
  rec_owner           TEXT,
  scope               TEXT NOT NULL DEFAULT 'global',
  mission_id          TEXT,
  sensitivity         TEXT NOT NULL DEFAULT 'internal',
  status              TEXT NOT NULL DEFAULT 'active',
  content_version     INTEGER NOT NULL DEFAULT 1,
  integrity_hash      TEXT,
  expiry              TEXT,
  superseded_reason   TEXT,
  superseded_by       TEXT,
  deleted_at          TEXT,
  conflict_with       TEXT,
  metadata            TEXT
);
CREATE INDEX IF NOT EXISTS idx_memory_owner ON memory_records(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_records(owner_id, scope);

CREATE TABLE IF NOT EXISTS memory_versions (
  id              TEXT PRIMARY KEY,
  record_id       TEXT NOT NULL,
  owner_id        TEXT NOT NULL,
  content_version INTEGER NOT NULL,
  content         TEXT NOT NULL,
  verification_status TEXT NOT NULL,
  integrity_hash  TEXT,
  reason          TEXT,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_memver_record ON memory_versions(record_id);

CREATE TABLE IF NOT EXISTS skill_versions (
  version_id      TEXT PRIMARY KEY,
  skill_id        TEXT NOT NULL,
  owner_id        TEXT NOT NULL,
  version         TEXT NOT NULL,
  content_hash    TEXT NOT NULL,
  manifest        TEXT NOT NULL,
  body            TEXT,
  state           TEXT NOT NULL DEFAULT 'registered',
  created         TEXT NOT NULL,
  created_by      TEXT,
  evaluation      TEXT,
  lifecycle       TEXT NOT NULL DEFAULT '[]',
  quarantined     INTEGER NOT NULL DEFAULT 0,
  quarantine_reason TEXT,
  metadata        TEXT
);
CREATE INDEX IF NOT EXISTS idx_skillver_owner ON skill_versions(owner_id, skill_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_skillver_unique ON skill_versions(owner_id, skill_id, version);

CREATE TABLE IF NOT EXISTS skill_evaluations (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL,
  version_id        TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  evaluator_version TEXT NOT NULL,
  test_suite_version TEXT NOT NULL,
  result            TEXT NOT NULL,
  failures          TEXT,
  limitations       TEXT,
  details           TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skilleval_version ON skill_evaluations(version_id);

CREATE TABLE IF NOT EXISTS skill_active_pointer (
  owner_id    TEXT NOT NULL,
  skill_id    TEXT NOT NULL,
  version_id  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT,
  PRIMARY KEY (owner_id, skill_id)
);

CREATE TABLE IF NOT EXISTS skill_lifecycle_audit (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  version_id  TEXT NOT NULL,
  skill_id    TEXT NOT NULL,
  action      TEXT NOT NULL,
  from_state  TEXT,
  to_state    TEXT,
  reason      TEXT,
  actor       TEXT,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_skillaudit_owner ON skill_lifecycle_audit(owner_id, created_at);
