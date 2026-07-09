-- 008_create_staking.sql
-- NovaBit Exchange — Staking System (Soft Staking Model)

BEGIN;

-- ── Staking Products ─────────────────────────────
CREATE TABLE IF NOT EXISTS staking_products (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    asset           VARCHAR(10) NOT NULL,
    name            VARCHAR(100) NOT NULL,
    apy             DECIMAL(10, 4) NOT NULL DEFAULT 0,  -- e.g. 5.5000 for 5.5%
    min_stake       DECIMAL(40, 8) NOT NULL DEFAULT 0,
    lock_period_days INTEGER NOT NULL DEFAULT 0,  -- 0 = flexible, 30/60/90 = locked
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (asset, lock_period_days)
);

CREATE INDEX idx_staking_products_asset ON staking_products (asset);
CREATE INDEX idx_staking_products_active ON staking_products (is_active);

-- ── Stakes (user positions) ──────────────────────
CREATE TABLE IF NOT EXISTS stakes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    product_id      UUID NOT NULL REFERENCES staking_products(id) ON DELETE RESTRICT,
    asset           VARCHAR(10) NOT NULL,
    amount          DECIMAL(40, 8) NOT NULL DEFAULT 0,
    apy_at_stake    DECIMAL(10, 4) NOT NULL,  -- APY when they staked
    status          VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'
                    CHECK (status IN ('ACTIVE', 'UNSTAKING', 'COMPLETED', 'CANCELED')),
    start_date      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    end_date        TIMESTAMPTZ,  -- for locked stakes: start_date + lock_period_days
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_stakes_user_id ON stakes (user_id);
CREATE INDEX idx_stakes_product_id ON stakes (product_id);
CREATE INDEX idx_stakes_status ON stakes (status);
CREATE INDEX idx_stakes_user_status ON stakes (user_id, status);

-- ── Staking Rewards ──────────────────────────────
CREATE TABLE IF NOT EXISTS staking_rewards (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    stake_id        UUID NOT NULL REFERENCES stakes(id) ON DELETE CASCADE,
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset           VARCHAR(10) NOT NULL,
    amount          DECIMAL(40, 8) NOT NULL DEFAULT 0,
    period_start    TIMESTAMPTZ NOT NULL,
    period_end      TIMESTAMPTZ NOT NULL,
    status          VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'PAID')),
    paid_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_staking_rewards_stake_id ON staking_rewards (stake_id);
CREATE INDEX idx_staking_rewards_user_id ON staking_rewards (user_id);
CREATE INDEX idx_staking_rewards_status ON staking_rewards (status);

-- ── Triggers ─────────────────────────────────────
CREATE TRIGGER trg_staking_products_updated_at
    BEFORE UPDATE ON staking_products
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_stakes_updated_at
    BEFORE UPDATE ON stakes
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- ── Seed Data: Default Staking Products ──────────
INSERT INTO staking_products (asset, name, apy, min_stake, lock_period_days) VALUES
    ('ETH', 'ETH Flexible Staking',   4.5000, 0.1,   0),
    ('SOL', 'SOL Flexible Staking',   6.0000, 1,     0),
    ('ADA', 'ADA Flexible Staking',   3.5000, 50,    0),
    ('DOT', 'DOT 28-Day Staking',     8.0000, 10,    28),
    ('AVAX', 'AVAX 14-Day Staking',   7.0000, 1,     14),
    ('USDT', 'USDT Flexible Staking', 3.0000, 100,   0)
ON CONFLICT (asset, lock_period_days) DO NOTHING;

COMMIT;