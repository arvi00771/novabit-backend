-- 006_create_password_resets.sql
-- NovaBit Exchange — Password Reset Token table

BEGIN;

CREATE TABLE IF NOT EXISTS password_resets (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      VARCHAR(255) NOT NULL,
    expires_at      TIMESTAMPTZ NOT NULL,
    used_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_password_resets_token_hash ON password_resets (token_hash);
CREATE INDEX idx_password_resets_user_id ON password_resets (user_id);
CREATE INDEX idx_password_resets_expires ON password_resets (expires_at);

COMMIT;