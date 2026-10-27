-- only: sqlite
-- 011_events_scope_sqlite.sql — event id unik PER OWNER, bukan global.
--
-- Sebelumnya events.id adalah PRIMARY KEY global sehingga Owner B bisa "menahan"
-- eventId yang akan dipakai Owner A. Idempotensi harus (owner_id, id).
-- SQLite membutuhkan rebuild tabel untuk mengubah primary key.
CREATE TABLE events_new (
  id              TEXT NOT NULL,
  cursor          INTEGER NOT NULL,
  owner_id        TEXT NOT NULL,
  device_id       TEXT,
  device_seq      INTEGER,
  type            TEXT NOT NULL,
  schema_version  INTEGER NOT NULL DEFAULT 1,
  payload         TEXT NOT NULL DEFAULT '{}',
  client_created_at TEXT,
  received_at     TEXT NOT NULL,
  metadata        TEXT,
  PRIMARY KEY (owner_id, id)
);
INSERT INTO events_new (id, cursor, owner_id, device_id, device_seq, type, schema_version, payload, client_created_at, received_at, metadata)
SELECT id, cursor, owner_id, device_id, device_seq, type, schema_version, payload, client_created_at, received_at, metadata FROM events;
DROP TABLE events;
ALTER TABLE events_new RENAME TO events;
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_cursor ON events(cursor);
CREATE INDEX IF NOT EXISTS idx_events_owner_cursor ON events(owner_id, cursor);
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_device_seq ON events(owner_id, device_id, device_seq);
