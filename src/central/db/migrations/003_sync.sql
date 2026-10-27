-- 003_sync.sql — event log (idempoten), cursor sinkronisasi, outbox server-side.
-- events.id menjadi CURSOR server (monoton, sumber kebenaran urutan).
CREATE TABLE IF NOT EXISTS events (
  id              TEXT PRIMARY KEY,
  cursor          INTEGER NOT NULL,
  owner_id        TEXT NOT NULL,
  device_id       TEXT,
  device_seq      INTEGER,
  type            TEXT NOT NULL,
  schema_version  INTEGER NOT NULL DEFAULT 1,
  payload         TEXT NOT NULL DEFAULT '{}',
  client_created_at TEXT,
  received_at     TEXT NOT NULL,
  metadata        TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_eventid ON events(id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_cursor ON events(cursor);
CREATE INDEX IF NOT EXISTS idx_events_owner_cursor ON events(owner_id, cursor);
-- Idempotensi per perangkat: (owner, device, device_seq) unik.
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_device_seq ON events(owner_id, device_id, device_seq);

CREATE TABLE IF NOT EXISTS sync_cursors (
  owner_id      TEXT NOT NULL,
  device_id     TEXT NOT NULL,
  last_cursor   INTEGER NOT NULL DEFAULT 0,
  last_pushed_at TEXT,
  updated_at    TEXT NOT NULL,
  PRIMARY KEY (owner_id, device_id)
);

CREATE TABLE IF NOT EXISTS event_conflicts (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  event_id      TEXT NOT NULL,
  conflict_type TEXT NOT NULL,
  resolution    TEXT NOT NULL,
  detail        TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conflicts_owner ON event_conflicts(owner_id, created_at);

-- Counter monoton untuk cursor event (sumber kebenaran urutan di server).
CREATE TABLE IF NOT EXISTS id_counters (
  name          TEXT PRIMARY KEY,
  value         INTEGER NOT NULL DEFAULT 0
);
INSERT INTO id_counters (name, value) SELECT 'event_cursor', 0 WHERE NOT EXISTS (SELECT 1 FROM id_counters WHERE name = 'event_cursor');
