-- 007_create_supported_coins.sql
-- NovaBit Exchange — Supported Coins & Network Configuration

BEGIN;

CREATE TABLE IF NOT EXISTS supported_coins (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    asset                   VARCHAR(10) NOT NULL UNIQUE,
    name                    VARCHAR(100) NOT NULL,
    network                 VARCHAR(20) NOT NULL,
    is_active               BOOLEAN NOT NULL DEFAULT TRUE,
    min_deposit_amount      DECIMAL(40, 8) NOT NULL DEFAULT 0,
    min_withdrawal_amount   DECIMAL(40, 8) NOT NULL DEFAULT 0,
    withdrawal_fee          DECIMAL(40, 8) NOT NULL DEFAULT 0,
    withdrawal_fee_type     VARCHAR(10) NOT NULL DEFAULT 'FIXED' CHECK (withdrawal_fee_type IN ('FIXED', 'PERCENT')),
    required_confirmations  INTEGER NOT NULL DEFAULT 1,
    deposit_enabled         BOOLEAN NOT NULL DEFAULT TRUE,
    withdrawal_enabled      BOOLEAN NOT NULL DEFAULT TRUE,
    withdrawal_requires_2fa BOOLEAN NOT NULL DEFAULT TRUE,
    min_confirmations       INTEGER NOT NULL DEFAULT 1,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_supported_coins_asset ON supported_coins (asset);

-- Insert default supported coins
INSERT INTO supported_coins (asset, name, network, min_deposit_amount, min_withdrawal_amount, withdrawal_fee, required_confirmations)
VALUES
    ('BTC', 'Bitcoin', 'BTC', 0.0001, 0.001, 0.0005, 2),
    ('ETH', 'Ethereum', 'ETH_ERC20', 0.001, 0.01, 0.01, 12),
    ('USDT', 'Tether', 'ERC20', 1, 5, 1, 12),
    ('USDC', 'USD Coin', 'ERC20', 1, 5, 1, 12),
    ('SOL', 'Solana', 'SOL', 0.01, 0.1, 0.01, 1),
    ('ADA', 'Cardano', 'ADA', 1, 5, 0.5, 2),
    ('XRP', 'Ripple', 'XRP', 1, 5, 0.25, 2),
    ('DOT', 'Polkadot', 'DOT', 0.1, 1, 0.1, 2);

CREATE TRIGGER trg_supported_coins_updated_at
    BEFORE UPDATE ON supported_coins
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

COMMIT;