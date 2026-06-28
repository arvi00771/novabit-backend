-- 006_harden_wallets.sql
-- Add security constraints to wallets table to prevent negative balances

BEGIN;

ALTER TABLE wallets
ADD CONSTRAINT check_balance_non_negative CHECK (balance >= 0),
ADD CONSTRAINT check_locked_balance_non_negative CHECK (locked_balance >= 0),
ADD CONSTRAINT check_balance_ge_locked CHECK (balance >= locked_balance);

COMMIT;
