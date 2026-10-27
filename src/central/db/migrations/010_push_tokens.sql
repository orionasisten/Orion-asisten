-- 010_push_tokens.sql — token push per perangkat (untuk notifikasi mobile).
-- Token push BUKAN rahasia: hanya identifier perangkat notifikasi, terikat owner + device.
CREATE TABLE IF NOT EXISTS push_tokens (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  device_id     TEXT,
  platform      TEXT NOT NULL,          -- android | ios
  token         TEXT NOT NULL UNIQUE,   -- token FCM/APNs
  status        TEXT NOT NULL DEFAULT 'active',
  last_seen_at  TEXT,
  revoked_at    TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_owner ON push_tokens(owner_id, status);
CREATE INDEX IF NOT EXISTS idx_push_device ON push_tokens(device_id, status);
