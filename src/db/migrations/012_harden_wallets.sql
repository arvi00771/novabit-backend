-- 012_harden_wallets.sql
-- NovaBit Exchange — Security constraints on wallets (balance integrity)
--
-- Originally shipped as `006_harden_wallets.sql`, but that version collided with
-- `006_create_password_resets.sql`, so the runner silently skipped it on every
-- environment ("already applied"). No environment ever received these
-- constraints. This corrective migration re-ships them under a unique version
-- and is idempotent, so re-running on a DB that already has the constraints is
-- a no-op.
BEGIN;
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_balance_non_negative'
          AND conrelid = 'wallets'::regclass
    ) THEN
        ALTER TABLE wallets ADD CONSTRAINT check_balance_non_negative CHECK (balance >= 0);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_locked_balance_non_negative'
          AND conrelid = 'wallets'::regclass
    ) THEN
        ALTER TABLE wallets ADD CONSTRAINT check_locked_balance_non_negative CHECK (locked_balance >= 0);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'check_balance_ge_locked'
          AND conrelid = 'wallets'::regclass
    ) THEN
        ALTER TABLE wallets ADD CONSTRAINT check_balance_ge_locked CHECK (balance >= locked_balance);
    END IF;
END $$;
COMMIT;