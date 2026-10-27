-- 006_owner_email_unique.sql — uniqueness email owner (anti-duplikasi & race condition pada bootstrap).
-- Email boleh NULL (owner tanpa email), tetapi nilai yang ada harus unik.
CREATE UNIQUE INDEX IF NOT EXISTS idx_owners_email ON owners(email);
