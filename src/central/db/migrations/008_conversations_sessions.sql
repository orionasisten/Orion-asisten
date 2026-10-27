-- 008_conversations_sessions.sql — percakapan lintas perangkat + sesi browser.
--
-- Percakapan & pesan disimpan di SERVER (sebelumnya hanya localStorage renderer),
-- sehingga riwayat bisa dilanjutkan dari desktop, web, dan mobile.
CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL,
  title           TEXT,
  status          TEXT NOT NULL DEFAULT 'active',
  pinned          INTEGER NOT NULL DEFAULT 0,
  client_key      TEXT,
  created_device_id TEXT,
  last_message_at TEXT,
  last_seq        INTEGER NOT NULL DEFAULT 0,
  message_count   INTEGER NOT NULL DEFAULT 0,
  deleted_at      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  metadata        TEXT
);
CREATE INDEX IF NOT EXISTS idx_conv_owner ON conversations(owner_id, updated_at);
-- Idempotensi pembuatan percakapan dari klien (client_key per owner).
CREATE UNIQUE INDEX IF NOT EXISTS idx_conv_client_key ON conversations(owner_id, client_key);

CREATE TABLE IF NOT EXISTS messages (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL,
  conversation_id   TEXT NOT NULL,
  seq               INTEGER NOT NULL,
  role              TEXT NOT NULL,
  content           TEXT NOT NULL,
  client_message_id TEXT,
  device_id         TEXT,
  created_at        TEXT NOT NULL,
  metadata          TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, seq);
-- Idempotensi pesan: client_message_id unik per owner (anti-duplikasi lintas retry).
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_client_id ON messages(owner_id, client_message_id);
-- Satu conversation hanya boleh punya satu seq per nomor.
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_conv_seq ON messages(conversation_id, seq);

-- Sesi browser (web/PWA): access token + refresh token (hanya hash yang disimpan).
CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL,
  device_id           TEXT,
  access_token_hash   TEXT NOT NULL UNIQUE,
  refresh_token_hash  TEXT NOT NULL UNIQUE,
  prev_refresh_token_hash TEXT,
  status              TEXT NOT NULL DEFAULT 'active',
  user_agent          TEXT,
  created_at          TEXT NOT NULL,
  access_expires_at   TEXT NOT NULL,
  refresh_expires_at  TEXT NOT NULL,
  revoked_at          TEXT,
  last_used_at        TEXT,
  rotated_at          TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_owner ON sessions(owner_id, status);
