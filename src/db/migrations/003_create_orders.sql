-- 003_create_orders.sql
-- NovaBit Exchange — Order Book & Order Management tables

BEGIN;

-- ── Trading Pairs ───────────────────────────────
CREATE TABLE IF NOT EXISTS trading_pairs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    base_asset      VARCHAR(10) NOT NULL,   -- e.g. 'BTC'
    quote_asset     VARCHAR(10) NOT NULL,   -- e.g. 'USDT'
    symbol          VARCHAR(20) NOT NULL UNIQUE, -- e.g. 'BTCUSDT'
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    base_precision  INTEGER NOT NULL DEFAULT 8,
    quote_precision INTEGER NOT NULL DEFAULT 2,
    min_base_amount DECIMAL(40, 8) NOT NULL DEFAULT 0.000001,
    min_quote_amount DECIMAL(40, 8) NOT NULL DEFAULT 0.01,
    maker_fee_rate  DECIMAL(6, 4) NOT NULL DEFAULT 0.0010,  -- 0.10%
    taker_fee_rate  DECIMAL(6, 4) NOT NULL DEFAULT 0.0020,  -- 0.20%
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_trading_pairs_symbol ON trading_pairs (symbol);

-- ── Orders ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS orders (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pair                VARCHAR(20) NOT NULL REFERENCES trading_pairs(symbol),
    side                VARCHAR(4) NOT NULL CHECK (side IN ('BUY', 'SELL')),
    order_type          VARCHAR(12) NOT NULL CHECK (order_type IN ('LIMIT', 'MARKET', 'STOP_LIMIT', 'STOP_MARKET')),
    status              VARCHAR(20) NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED')),

    -- Price fields
    price               DECIMAL(40, 8),   -- NULL for MARKET orders
    stop_price          DECIMAL(40, 8),   -- NULL for non-stop orders

    -- Quantity
    quantity            DECIMAL(40, 8) NOT NULL,
    filled_quantity     DECIMAL(40, 8) NOT NULL DEFAULT 0,
    quote_quantity      DECIMAL(40, 8),   -- amount in quote currency (for MARKET buys)
    filled_quote_quantity DECIMAL(40, 8) NOT NULL DEFAULT 0,

    -- Fee
    fee_asset           VARCHAR(10),
    fee_amount          DECIMAL(40, 8) NOT NULL DEFAULT 0,
    fee_currency        VARCHAR(10),

    -- Metadata
    client_order_id     VARCHAR(64),
    is_maker            BOOLEAN,  -- set at match time
    time_in_force       VARCHAR(10) DEFAULT 'GTC' CHECK (time_in_force IN ('GTC', 'IOC', 'FOK', 'GTD')),
    expires_at          TIMESTAMPTZ,  -- for GTD orders

    -- Audit
    reject_reason       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Critical indexes for order book and query performance
CREATE INDEX idx_orders_user_id ON orders (user_id);
CREATE INDEX idx_orders_pair ON orders (pair);
CREATE INDEX idx_orders_status ON orders (status);
CREATE INDEX idx_orders_pair_status ON orders (pair, status);
CREATE INDEX idx_orders_created_at ON orders (created_at);
CREATE INDEX idx_orders_client_order_id ON orders (user_id, client_order_id);
CREATE INDEX idx_orders_side_price ON orders (pair, side, price, created_at)
    WHERE status IN ('OPEN', 'PARTIALLY_FILLED');

-- ── Order History (archival, partitioned later) ──
-- The orders table serves as both active and history for now.
-- As volume grows, we'll archive filled/canceled orders older than N days
-- to an `orders_archive` table.

CREATE TRIGGER trg_orders_updated_at
    BEFORE UPDATE ON orders
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

COMMIT;