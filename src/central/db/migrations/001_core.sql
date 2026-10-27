-- 001_core.sql — identitas owner, device, token, audit.
-- Dialect-portable: TEXT id, TEXT timestamp (ISO-8601 UTC), INTEGER boolean, TEXT JSON.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     TEXT PRIMARY KEY,
  checksum    TEXT NOT NULL,
  applied_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS owners (
  id            TEXT PRIMARY KEY,
  email         TEXT,
  display_name  TEXT,
  role          TEXT NOT NULL DEFAULT 'owner',
  status        TEXT NOT NULL DEFAULT 'active',
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL,
  name           TEXT,
  platform       TEXT,
  status         TEXT NOT NULL DEFAULT 'active',
  revoked_at     TEXT,
  last_seen_at   TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_devices_owner ON devices(owner_id);

-- Token bearer dikelola server: HANYA hash yang disimpan (SHA-256), token plaintext
-- hanyashown sekali saat issuance. expiry + revocation + rotation.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  device_id     TEXT,
  token_hash    TEXT NOT NULL UNIQUE,
  label         TEXT,
  scopes        TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'active',
  issued_at     TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  rotated_from  TEXT,
  last_used_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_tokens_owner ON auth_tokens(owner_id);
CREATE INDEX IF NOT EXISTS idx_tokens_device ON auth_tokens(device_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  device_id     TEXT,
  actor         TEXT NOT NULL,
  action        TEXT NOT NULL,
  target_type   TEXT,
  target_id     TEXT,
  outcome       TEXT NOT NULL DEFAULT 'ok',
  reason        TEXT,
  metadata      TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_owner ON audit_log(owner_id, created_at);
