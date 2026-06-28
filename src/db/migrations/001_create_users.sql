-- 001_create_users.sql
-- NovaBit Exchange — Users & Authentication tables

BEGIN;

-- Extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Users ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    role            VARCHAR(20) NOT NULL DEFAULT 'USER'
                    CHECK (role IN ('USER', 'VIP', 'ADMIN', 'SUPER_ADMIN')),

    -- KYC
    kyc_status      VARCHAR(20) NOT NULL DEFAULT 'UNVERIFIED'
                    CHECK (kyc_status IN ('UNVERIFIED', 'PENDING', 'VERIFIED', 'REJECTED')),
    kyc_verified_at TIMESTAMPTZ,
    kyc_data        JSONB,  -- store KYC document metadata

    -- 2FA
    totp_secret     VARCHAR(64),   -- encrypted TOTP secret (null if not enabled)
    is_2fa_enabled  BOOLEAN NOT NULL DEFAULT FALSE,
    recovery_codes  TEXT[],        -- hashed recovery codes

    -- Security
    is_withdrawal_whitelist_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    withdrawal_whitelist            JSONB DEFAULT '[]'::jsonb,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,

    -- Activity tracking
    last_login_at   TIMESTAMPTZ,
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    TIMESTAMPTZ,

    -- Timestamps
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_users_email ON users (email);
CREATE INDEX idx_users_kyc_status ON users (kyc_status);
CREATE INDEX idx_users_created_at ON users (created_at);

-- ── Refresh Tokens ──────────────────────────────
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      VARCHAR(255) NOT NULL,
    device_info     VARCHAR(255),
    ip_address      INET,
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_refresh_tokens_user_id ON refresh_tokens (user_id);
CREATE INDEX idx_refresh_tokens_token_hash ON refresh_tokens (token_hash);

-- ── API Keys (for programmatic trading) ─────────
CREATE TABLE IF NOT EXISTS api_keys (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label           VARCHAR(100) NOT NULL,
    api_key         VARCHAR(128) NOT NULL UNIQUE,
    api_secret_hash VARCHAR(255) NOT NULL,
    permissions     JSONB NOT NULL DEFAULT '["READ"]'::jsonb,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    last_used_at    TIMESTAMPTZ,
    expires_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_api_keys_user_id ON api_keys (user_id);
CREATE INDEX idx_api_keys_api_key ON api_keys (api_key);

-- ── Withdrawal Address Whitelist ────────────────
CREATE TABLE IF NOT EXISTS withdrawal_addresses (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset           VARCHAR(10) NOT NULL,
    address         VARCHAR(255) NOT NULL,
    label           VARCHAR(100),
    memo             VARCHAR(255),
    is_approved     BOOLEAN NOT NULL DEFAULT FALSE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_withdrawal_addresses_user_id ON withdrawal_addresses (user_id);

-- ── Auto-update updated_at trigger ──────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

COMMIT;