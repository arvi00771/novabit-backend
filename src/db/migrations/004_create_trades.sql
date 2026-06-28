-- 004_create_trades.sql
-- NovaBit Exchange — Trade Execution & Matching tables

BEGIN;

-- ── Trades ──────────────────────────────────────
-- Each row represents one fill event (a match between a buy and sell order).
-- A single order may span multiple trades (partial fills).

CREATE TABLE IF NOT EXISTS trades (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    pair                VARCHAR(20) NOT NULL REFERENCES trading_pairs(symbol),

    -- Matched orders
    buyer_order_id      UUID NOT NULL REFERENCES orders(id),
    seller_order_id     UUID NOT NULL REFERENCES orders(id),

    -- Users involved
    buyer_user_id       UUID NOT NULL REFERENCES users(id),
    seller_user_id      UUID NOT NULL REFERENCES users(id),

    -- Fill details
    price               DECIMAL(40, 8) NOT NULL,
    quantity            DECIMAL(40, 8) NOT NULL,
    quote_quantity      DECIMAL(40, 8) NOT NULL,  -- price * quantity

    -- Fees
    buyer_fee           DECIMAL(40, 8) NOT NULL DEFAULT 0,
    seller_fee          DECIMAL(40, 8) NOT NULL DEFAULT 0,
    fee_asset           VARCHAR(10) NOT NULL,

    -- Market metadata
    taker_side          VARCHAR(4) NOT NULL CHECK (taker_side IN ('BUY', 'SELL')),

    -- Timestamp
    trade_time          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Core indexes for trade history lookup
CREATE INDEX idx_trades_pair ON trades (pair);
CREATE INDEX idx_trades_pair_time ON trades (pair, trade_time DESC);
CREATE INDEX idx_trades_buyer_order ON trades (buyer_order_id);
CREATE INDEX idx_trades_seller_order ON trades (seller_order_id);
CREATE INDEX idx_trades_buyer_user ON trades (buyer_user_id);
CREATE INDEX idx_trades_seller_user ON trades (seller_user_id);
CREATE INDEX idx_trades_trade_time ON trades (trade_time DESC);

-- ── Candlesticks / OHLCV (materialized for charting) ──
-- Updated by the matching engine after each trade.
-- For high volume, consider TimescaleDB or a separate time-series store.

CREATE TABLE IF NOT EXISTS candles (
    id              BIGSERIAL,
    pair            VARCHAR(20) NOT NULL REFERENCES trading_pairs(symbol),
    interval        VARCHAR(5) NOT NULL CHECK (interval IN ('1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w')),
    open_time       TIMESTAMPTZ NOT NULL,
    close_time      TIMESTAMPTZ NOT NULL,
    open_price      DECIMAL(40, 8) NOT NULL,
    high_price      DECIMAL(40, 8) NOT NULL,
    low_price       DECIMAL(40, 8) NOT NULL,
    close_price     DECIMAL(40, 8) NOT NULL,
    volume          DECIMAL(40, 8) NOT NULL,
    quote_volume    DECIMAL(40, 8) NOT NULL,
    trade_count     INTEGER NOT NULL DEFAULT 0,
    is_closed       BOOLEAN NOT NULL DEFAULT FALSE,
    PRIMARY KEY (pair, interval, open_time)
);

CREATE INDEX idx_candles_pair_interval_time ON candles (pair, interval, open_time DESC);
CREATE INDEX idx_candles_open_time ON candles (open_time);

-- ── Recent Trades (for REST API) ────────────────
CREATE VIEW recent_trades AS
SELECT * FROM trades
ORDER BY trade_time DESC;

COMMIT;