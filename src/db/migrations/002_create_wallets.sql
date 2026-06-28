-- 002_create_wallets.sql
-- NovaBit Exchange — Wallet & Balance tables

BEGIN;

-- ── Wallets ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallets (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset           VARCHAR(10) NOT NULL,  -- 'BTC', 'ETH', 'USDT', 'SOL', etc.
    wallet_type     VARCHAR(20) NOT NULL DEFAULT 'SPOT'
                    CHECK (wallet_type IN ('SPOT', 'TRADING', 'COLD', 'WITHDRAWAL')),
    balance         DECIMAL(40, 8) NOT NULL DEFAULT 0,
    locked_balance  DECIMAL(40, 8) NOT NULL DEFAULT 0,
    address         VARCHAR(255),  -- blockchain deposit address for this wallet
    address_derivation_path VARCHAR(255),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Ensure one wallet per user/asset/type
    UNIQUE (user_id, asset, wallet_type)
);

CREATE INDEX idx_wallets_user_id ON wallets (user_id);
CREATE INDEX idx_wallets_asset ON wallets (asset);
CREATE INDEX idx_wallets_user_asset ON wallets (user_id, asset);
CREATE INDEX idx_wallets_wallet_type ON wallets (wallet_type);

-- ── Available balance view (computed) ─────────────
-- Available = balance - locked_balance
-- This is a convenience view; actual queries should check this constraint in app logic

-- ── Trigger: update updated_at ──────────────────
CREATE TRIGGER trg_wallets_updated_at
    BEFORE UPDATE ON wallets
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ── Wallet deposit addresses ─────────────────────
CREATE TABLE IF NOT EXISTS deposit_addresses (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    wallet_id       UUID NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset           VARCHAR(10) NOT NULL,
    address         VARCHAR(255) NOT NULL,
    network         VARCHAR(20) NOT NULL,  -- 'BTC', 'ETH_ERC20', 'SOL', 'TRX_TRC20'
    memo             VARCHAR(255),
    derivation_path VARCHAR(255),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_deposit_addresses_wallet_id ON deposit_addresses (wallet_id);
CREATE INDEX idx_deposit_addresses_address ON deposit_addresses (address);

COMMIT;