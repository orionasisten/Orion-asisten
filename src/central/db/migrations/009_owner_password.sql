-- 009_owner_password.sql — kredensial login Owner untuk web (hash scrypt, tanpa plaintext).
--
-- Kolom nullable: owner yang belum pernah menyetel password tidak bisa login lewat web
-- (tetap bisa lewat device token).
ALTER TABLE owners ADD COLUMN password_hash TEXT;
ALTER TABLE owners ADD COLUMN password_updated_at TEXT;
