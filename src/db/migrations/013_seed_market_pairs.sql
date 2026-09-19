-- 013_seed_market_pairs.sql
-- NovaBit Exchange — Seed default trading pairs
--
-- The SQLite dev adapter seeds 6 trading pairs; the PostgreSQL migration set
-- never did, so /market/pairs returned an empty list on a fresh PG database and
-- order inserts referencing trading_pairs(symbol) would fail. This seed mirrors
-- the dev set and is idempotent (ON CONFLICT DO NOTHING).
BEGIN;
INSERT INTO trading_pairs (base_asset, quote_asset, symbol) VALUES
    ('BTC',  'USDT', 'BTCUSDT'),
    ('ETH',  'USDT', 'ETHUSDT'),
    ('SOL',  'USDT', 'SOLUSDT'),
    ('ADA',  'USDT', 'ADAUSDT'),
    ('AVAX', 'USDT', 'AVAXUSDT')
ON CONFLICT (symbol) DO NOTHING;
COMMIT;