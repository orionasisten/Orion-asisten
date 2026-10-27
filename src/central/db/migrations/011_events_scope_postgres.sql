-- only: postgres
-- 011_events_scope_postgres.sql — event id unik PER OWNER, bukan global.
-- Mencegah cross-owner eventId squatting/deduplication.
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_pkey;
ALTER TABLE events ADD PRIMARY KEY (owner_id, id);
DROP INDEX IF EXISTS idx_events_eventid;
