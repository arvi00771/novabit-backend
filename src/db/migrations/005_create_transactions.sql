-- 005_create_transactions.sql
-- NovaBit Exchange — Financial Transactions & Audit Trail

BEGIN;

-- ── Transactions (ledger) ───────────────────────
-- Every financial movement in the system creates a transaction record.
-- This table serves as the immutable audit trail.

CREATE TABLE IF NOT EXISTS transactions (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    wallet_id             UUID REFERENCES wallets(id),

    type                  VARCHAR(20) NOT NULL
                          CHECK (type IN (
                              'DEPOSIT', 'WITHDRAWAL',
                              'TRADE_BUY', 'TRADE_SELL',
                              'FEE', 'TRANSFER', 'REFUND'
                          )),

    status                VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING', 'CONFIRMED', 'FAILED', 'CANCELED')),

    -- Financial details
    asset                 VARCHAR(10) NOT NULL,
    amount                DECIMAL(40, 8) NOT NULL,
    fee                   DECIMAL(40, 8) NOT NULL DEFAULT 0,

    -- Blockchain / external references
    tx_hash               VARCHAR(255),      -- blockchain transaction hash
    destination_address   VARCHAR(255),
    source_address        VARCHAR(255),

    -- Internal references
    reference_id          VARCHAR(64),       -- links to order_id or external reference
    reference_type        VARCHAR(20),       -- 'ORDER', 'WITHDRAWAL_REQUEST', etc.

    -- User notes
    memo                  TEXT,

    -- Audit
    confirmed_at          TIMESTAMPTZ,
    failed_reason         TEXT,
    reviewed_by           UUID REFERENCES users(id),  -- admin who reviewed (for flagged txns)
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Core indexes
CREATE INDEX idx_transactions_user_id ON transactions (user_id);
CREATE INDEX idx_transactions_wallet_id ON transactions (wallet_id);
CREATE INDEX idx_transactions_type ON transactions (type);
CREATE INDEX idx_transactions_status ON transactions (status);
CREATE INDEX idx_transactions_asset ON transactions (asset);
CREATE INDEX idx_transactions_reference ON transactions (reference_id);
CREATE INDEX idx_transactions_tx_hash ON transactions (tx_hash);
CREATE INDEX idx_transactions_created_at ON transactions (created_at DESC);
CREATE INDEX idx_transactions_user_created ON transactions (user_id, created_at DESC);

-- ── Deposit tracking ──────────────────────────────
CREATE TABLE IF NOT EXISTS deposits (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id               UUID NOT NULL REFERENCES users(id),
    wallet_id             UUID NOT NULL REFERENCES wallets(id),
    transaction_id        UUID REFERENCES transactions(id),
    asset                 VARCHAR(10) NOT NULL,
    amount                DECIMAL(40, 8) NOT NULL,
    network               VARCHAR(20) NOT NULL,
    tx_hash               VARCHAR(255) NOT NULL,
    from_address          VARCHAR(255),
    confirmations         INTEGER NOT NULL DEFAULT 0,
    required_confirmations INTEGER NOT NULL DEFAULT 1,
    status                VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING', 'CONFIRMING', 'COMPLETED', 'FAILED')),
    completed_at          TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE (tx_hash, network)  -- prevent double-processing
);

CREATE INDEX idx_deposits_user_id ON deposits (user_id);
CREATE INDEX idx_deposits_status ON deposits (status);
CREATE INDEX idx_deposits_tx_hash ON deposits (tx_hash);
CREATE INDEX idx_deposits_created_at ON deposits (created_at DESC);

-- ── Withdrawal requests ───────────────────────────
CREATE TABLE IF NOT EXISTS withdrawals (
    id                    UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id               UUID NOT NULL REFERENCES users(id),
    wallet_id             UUID NOT NULL REFERENCES wallets(id),
    transaction_id        UUID REFERENCES transactions(id),
    asset                 VARCHAR(10) NOT NULL,
    amount                DECIMAL(40, 8) NOT NULL,
    fee                   DECIMAL(40, 8) NOT NULL DEFAULT 0,
    network               VARCHAR(20) NOT NULL,
    to_address            VARCHAR(255) NOT NULL,
    memo                   VARCHAR(255),
    tx_hash               VARCHAR(255),
    status                VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN (
                              'PENDING', 'APPROVED', 'SIGNING',
                              'SENDING', 'COMPLETED', 'FAILED', 'CANCELED'
                          )),
    -- Security
    requires_2fa          BOOLEAN NOT NULL DEFAULT TRUE,
    requires_admin_approval BOOLEAN NOT NULL DEFAULT FALSE,
    approved_by           UUID REFERENCES users(id),
    approval_note         TEXT,
    reviewed_at           TIMESTAMPTZ,
    completed_at          TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_withdrawals_user_id ON withdrawals (user_id);
CREATE INDEX idx_withdrawals_status ON withdrawals (status);
CREATE INDEX idx_withdrawals_created_at ON withdrawals (created_at DESC);
CREATE INDEX idx_withdrawals_tx_hash ON withdrawals (tx_hash);

-- Triggers
CREATE TRIGGER trg_transactions_updated_at
    BEFORE UPDATE ON transactions
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_deposits_updated_at
    BEFORE UPDATE ON deposits
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_withdrawals_updated_at
    BEFORE UPDATE ON withdrawals
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

COMMIT;