-- 011_align_recovery_codes_text.sql
-- NovaBit Exchange — Align recovery_codes column type for PostgreSQL
--
-- The AuthService stores hashed 2FA recovery codes as a JSON-stringified array
-- (JSON.stringify(hashedCodes)). The original 001 migration declared the column
-- as TEXT[], which PostgreSQL would reject for a malformed array literal
-- (ambiguous / missing array syntax). This migration aligns the column to
-- plain TEXT so the production write path is valid on real PostgreSQL.
BEGIN;
ALTER TABLE users ALTER COLUMN recovery_codes TYPE TEXT;
COMMIT;