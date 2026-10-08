import { DatabaseSync } from 'node:sqlite';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type { Redis as RedisType } from 'ioredis';
import { EventEmitter } from 'events';
import { config } from '../config/index.js';
import { createInMemoryRedis } from './in-memory-redis.js';
import bcrypt from 'bcryptjs';

// ── Persistence backend selection ─────────────────
// The exchange runs on PostgreSQL in any real deployment (DATABASE_URL set).
// The in-memory SQLite adapter is a dev/test-only fallback so the app can boot
// with zero external dependencies — it is explicitly refused in production by
// the config gate (see src/config/index.ts) because an exchange must never run
// against an ephemeral database.
export const isSqlite = config.DATABASE_URL.trim().length === 0;
if (!isSqlite) {
  console.log(`[DB] Using PostgreSQL: ${config.DATABASE_URL.split('@').pop()?.split('?')[0] ?? ''}`);
} else {
  console.log('[DB] No DATABASE_URL set — using in-memory SQLite (dev/test only)');
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    email           TEXT NOT NULL UNIQUE,
    password_hash   TEXT NOT NULL,
    full_name       TEXT,
    role            TEXT NOT NULL DEFAULT 'USER',
    kyc_status      TEXT NOT NULL DEFAULT 'UNVERIFIED',
    kyc_verified_at TEXT,
    kyc_data        TEXT,
    totp_secret     TEXT,
    is_2fa_enabled  INTEGER NOT NULL DEFAULT 0,
    recovery_codes  TEXT,
    is_withdrawal_whitelist_enabled INTEGER NOT NULL DEFAULT 0,
    withdrawal_whitelist TEXT DEFAULT '[]',
    is_active       INTEGER NOT NULL DEFAULT 1,
    last_login_at   TEXT,
    failed_login_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until    TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL,
    device_info     TEXT,
    ip_address      TEXT,
    expires_at      TEXT NOT NULL,
    revoked_at      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS api_keys (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label           TEXT NOT NULL,
    api_key         TEXT NOT NULL UNIQUE,
    api_secret_hash TEXT NOT NULL,
    permissions     TEXT NOT NULL DEFAULT '["READ"]',
    is_active       INTEGER NOT NULL DEFAULT 1,
    last_used_at    TEXT,
    expires_at      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS withdrawal_addresses (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset           TEXT NOT NULL,
    address         TEXT NOT NULL,
    label           TEXT,
    memo            TEXT,
    is_approved     INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS wallets (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset           TEXT NOT NULL,
    wallet_type     TEXT NOT NULL DEFAULT 'SPOT',
    balance         TEXT NOT NULL DEFAULT '0',
    locked_balance  TEXT NOT NULL DEFAULT '0',
    address         TEXT,
    address_derivation_path TEXT,
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (user_id, asset, wallet_type)
);

CREATE TABLE IF NOT EXISTS deposit_addresses (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    wallet_id       TEXT NOT NULL REFERENCES wallets(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    asset           TEXT NOT NULL,
    address         TEXT NOT NULL,
    network         TEXT NOT NULL,
    memo            TEXT,
    derivation_path TEXT,
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trading_pairs (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    base_asset      TEXT NOT NULL,
    quote_asset     TEXT NOT NULL,
    symbol          TEXT NOT NULL UNIQUE,
    is_active       INTEGER NOT NULL DEFAULT 1,
    base_precision  INTEGER NOT NULL DEFAULT 8,
    quote_precision INTEGER NOT NULL DEFAULT 2,
    min_base_amount TEXT NOT NULL DEFAULT '0.000001',
    min_quote_amount TEXT NOT NULL DEFAULT '0.01',
    maker_fee_rate  TEXT NOT NULL DEFAULT '0.0010',
    taker_fee_rate  TEXT NOT NULL DEFAULT '0.0020',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pair            TEXT NOT NULL,
    side            TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
    order_type      TEXT NOT NULL CHECK (order_type IN ('LIMIT', 'MARKET', 'STOP_LIMIT', 'STOP_MARKET')),
    status          TEXT NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'OPEN', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'REJECTED', 'EXPIRED')),
    price           TEXT,
    stop_price      TEXT,
    quantity        TEXT NOT NULL,
    filled_quantity TEXT NOT NULL DEFAULT '0',
    quote_quantity  TEXT,
    filled_quote_quantity TEXT NOT NULL DEFAULT '0',
    fee_asset       TEXT,
    fee_amount      TEXT NOT NULL DEFAULT '0',
    fee_currency    TEXT,
    client_order_id TEXT,
    is_maker        INTEGER,
    time_in_force   TEXT DEFAULT 'GTC' CHECK (time_in_force IN ('GTC', 'IOC', 'FOK', 'GTD')),
    expires_at      TEXT,
    reject_reason   TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trades (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    pair            TEXT NOT NULL,
    buyer_order_id  TEXT NOT NULL,
    seller_order_id TEXT NOT NULL,
    buyer_user_id   TEXT NOT NULL,
    seller_user_id  TEXT NOT NULL,
    price           TEXT NOT NULL,
    quantity        TEXT NOT NULL,
    quote_quantity  TEXT NOT NULL,
    buyer_fee       TEXT NOT NULL DEFAULT '0',
    seller_fee      TEXT NOT NULL DEFAULT '0',
    fee_asset       TEXT NOT NULL,
    taker_side      TEXT NOT NULL CHECK (taker_side IN ('BUY', 'SELL')),
    trade_time      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    user_id         TEXT NOT NULL REFERENCES users(id),
    wallet_id       TEXT REFERENCES wallets(id),
    type            TEXT NOT NULL,
    asset           TEXT NOT NULL,
    amount          TEXT NOT NULL,
    fee             TEXT NOT NULL DEFAULT '0',
    tx_hash         TEXT,
    destination_address TEXT,
    source_address  TEXT,
    reference_id    TEXT,
    reference_type  TEXT,
    memo            TEXT,
    status          TEXT NOT NULL DEFAULT 'PENDING',
    confirmed_at    TEXT,
    failed_reason   TEXT,
    reviewed_by     TEXT REFERENCES users(id),
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS deposits (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    user_id         TEXT NOT NULL REFERENCES users(id),
    wallet_id       TEXT NOT NULL REFERENCES wallets(id),
    transaction_id  TEXT REFERENCES transactions(id),
    asset           TEXT NOT NULL,
    amount          TEXT NOT NULL,
    network         TEXT NOT NULL,
    tx_hash         TEXT NOT NULL,
    from_address    TEXT,
    confirmations   INTEGER NOT NULL DEFAULT 0,
    required_confirmations INTEGER NOT NULL DEFAULT 1,
    status          TEXT NOT NULL DEFAULT 'PENDING',
    completed_at    TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (tx_hash, network)
);

CREATE TABLE IF NOT EXISTS withdrawals (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    user_id         TEXT NOT NULL REFERENCES users(id),
    wallet_id       TEXT NOT NULL REFERENCES wallets(id),
    transaction_id  TEXT REFERENCES transactions(id),
    asset           TEXT NOT NULL,
    amount          TEXT NOT NULL,
    fee             TEXT NOT NULL DEFAULT '0',
    network         TEXT NOT NULL,
    to_address      TEXT NOT NULL,
    memo            TEXT,
    tx_hash         TEXT,
    status          TEXT NOT NULL DEFAULT 'PENDING',
    requires_2fa    INTEGER NOT NULL DEFAULT 1,
    requires_admin_approval INTEGER NOT NULL DEFAULT 0,
    approved_by     TEXT REFERENCES users(id),
    approval_note   TEXT,
    reviewed_at     TEXT,
    completed_at    TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kyc_documents (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_type   TEXT NOT NULL,
    file_path       TEXT NOT NULL,
    file_hash       TEXT NOT NULL,
    file_size       INTEGER NOT NULL DEFAULT 0,
    mime_type       TEXT NOT NULL DEFAULT 'image/jpeg',
    status          TEXT NOT NULL DEFAULT 'PENDING',
    rejection_reason TEXT,
    reviewed_at     TEXT,
    reviewed_by     TEXT REFERENCES users(id),
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS password_resets (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash      TEXT NOT NULL,
    expires_at      TEXT NOT NULL,
    used_at         TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS supported_coins (
    id                      TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    asset                   TEXT NOT NULL UNIQUE,
    name                    TEXT NOT NULL,
    network                 TEXT NOT NULL,
    is_active               INTEGER NOT NULL DEFAULT 1,
    min_deposit_amount      TEXT NOT NULL DEFAULT '0',
    min_withdrawal_amount   TEXT NOT NULL DEFAULT '0',
    withdrawal_fee          TEXT NOT NULL DEFAULT '0',
    withdrawal_fee_type     TEXT NOT NULL DEFAULT 'FIXED' CHECK (withdrawal_fee_type IN ('FIXED', 'PERCENT')),
    required_confirmations  INTEGER NOT NULL DEFAULT 1,
    deposit_enabled         INTEGER NOT NULL DEFAULT 1,
    withdrawal_enabled      INTEGER NOT NULL DEFAULT 1,
    withdrawal_requires_2fa INTEGER NOT NULL DEFAULT 1,
    min_confirmations       INTEGER NOT NULL DEFAULT 1,
    created_at              TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at              TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS staking_positions (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    user_id         TEXT NOT NULL REFERENCES users(id),
    wallet_id       TEXT NOT NULL REFERENCES wallets(id),
    asset           TEXT NOT NULL,
    amount          TEXT NOT NULL,
    apy             TEXT NOT NULL,
    start_date      TEXT NOT NULL DEFAULT (datetime('now')),
    end_date        TEXT,
    status          TEXT NOT NULL DEFAULT 'ACTIVE',
    rewards_earned  TEXT NOT NULL DEFAULT '0',
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    user_id         TEXT REFERENCES users(id),
    action          TEXT NOT NULL,
    entity_type     TEXT,
    entity_id       TEXT,
    old_value       TEXT,
    new_value       TEXT,
    ip_address      TEXT,
    user_agent      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets (user_id);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
CREATE INDEX IF NOT EXISTS idx_orders_pair_status ON orders (pair, status);
CREATE INDEX IF NOT EXISTS idx_trades_pair ON trades (pair);
CREATE INDEX IF NOT EXISTS idx_trades_trade_time ON trades (trade_time);
CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions (user_id);
CREATE INDEX IF NOT EXISTS idx_kyc_docs_user ON kyc_documents (user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs (user_id);
`;

const SEED = `
INSERT OR IGNORE INTO trading_pairs (id, base_asset, quote_asset, symbol) 
VALUES ('pair_btcusdt', 'BTC', 'USDT', 'BTCUSDT');

INSERT OR IGNORE INTO trading_pairs (id, base_asset, quote_asset, symbol) 
VALUES ('pair_ethusdt', 'ETH', 'USDT', 'ETHUSDT');

INSERT OR IGNORE INTO trading_pairs (id, base_asset, quote_asset, symbol) 
VALUES ('pair_solusdt', 'SOL', 'USDT', 'SOLUSDT');

INSERT OR IGNORE INTO trading_pairs (id, base_asset, quote_asset, symbol) 
VALUES ('pair_adausdt', 'ADA', 'USDT', 'ADAUSDT');

INSERT OR IGNORE INTO trading_pairs (id, base_asset, quote_asset, symbol) 
VALUES ('pair_avaxusdt', 'AVAX', 'USDT', 'AVAXUSDT');

INSERT OR IGNORE INTO supported_coins
    (id, asset, name, network, min_deposit_amount, min_withdrawal_amount, withdrawal_fee, required_confirmations)
VALUES
    ('coin_btc',  'BTC',  'Bitcoin',  'BTC',       0.0001, 0.001, 0.0005, 2),
    ('coin_eth',  'ETH',  'Ethereum', 'ETH_ERC20', 0.001,  0.01,  0.01,   12),
    ('coin_usdt', 'USDT', 'Tether',   'ERC20',     1,      5,     1,      12),
    ('coin_usdc', 'USDC', 'USD Coin', 'ERC20',     1,      5,     1,      12),
    ('coin_sol',  'SOL',  'Solana',   'SOL',       0.01,   0.1,   0.01,   1),
    ('coin_ada',  'ADA',  'Cardano',  'ADA',       1,      5,     0.5,    2),
    ('coin_xrp',  'XRP',  'Ripple',   'XRP',       1,      5,     0.25,   2),
    ('coin_dot',  'DOT',  'Polkadot', 'DOT',       0.1,    1,     0.1,    2);
`;

let sqlite: DatabaseSync | null = null;

function getSqlite(): DatabaseSync {
  if (!sqlite) {
    sqlite = new DatabaseSync(':memory:');
    console.log('[DB] Creating SQLite schema...');
    sqlite.exec(SCHEMA);
    console.log('[DB] Schema created. Seeding data...');
    sqlite.exec(SEED);
    console.log('[DB] Seed data inserted.');
    seedTestUser(sqlite);
  }
  return sqlite;
}

function seedTestUser(db: DatabaseSync) {
  const existing = db.prepare("SELECT id FROM users WHERE email = 'arvi00772@gmail.com'").all();
  if (existing.length > 0) return;

  const id = randomUUID();
  const hash = bcrypt.hashSync('Test1234!', 10);
  const now = new Date().toISOString();

  db.prepare(`INSERT INTO users (id, email, password_hash, full_name, role, kyc_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(id, 'arvi00772@gmail.com', hash, 'Arvi Test', 'ADMIN', 'UNVERIFIED', now, now);

  // Create wallets with some balance
  const btcWalletId = randomUUID();
  const ethWalletId = randomUUID();
  const usdtWalletId = randomUUID();

  db.prepare(`INSERT INTO wallets (id, user_id, asset, balance, created_at, updated_at)
    VALUES (?, ?, 'BTC', '5.0', ?, ?)`).run(btcWalletId, id, now, now);
  db.prepare(`INSERT INTO wallets (id, user_id, asset, balance, created_at, updated_at)
    VALUES (?, ?, 'ETH', '100.0', ?, ?)`).run(ethWalletId, id, now, now);
  db.prepare(`INSERT INTO wallets (id, user_id, asset, balance, created_at, updated_at)
    VALUES (?, ?, 'USDT', '500000.0', ?, ?)`).run(usdtWalletId, id, now, now);

  console.log('[DB] Test user seeded: arvi00772@gmail.com / Test1234!');
}

// ── PG-compatible query interface ────────────────

function fixDates(rows: any[]): any[] {
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      const v = row[key];
      if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(v)) {
        try { row[key] = new Date(v); } catch { /* keep string */ }
      }
    }
  }
  return rows;
}

// ── PostgreSQL → SQLite statement translation ────
/**
 * Coerce a parameter into a value node:sqlite can bind.
 * PostgreSQL accepts Date and boolean parameters; SQLite only understands
 * null, number, bigint, string and Uint8Array.
 */
export function toSqliteBindable(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 1 : 0;
  return value;
}
// The application is written against PostgreSQL and the SQLite adapter must
// accept the very same statements, without the PostgreSQL code path changing
// behaviour. Anything PostgreSQL-specific that SQLite cannot parse is rewritten
// here; everything else is passed through untouched.
export function translateSqlForSqlite(sql: string): string {
  let s = sql;

  // 1. Row-level locks. SQLite has no FOR UPDATE/FOR SHARE (it serialises
  //    writers), so the locking clause is simply dropped. PostgreSQL keeps it —
  //    this only ever runs on the SQLite adapter.
  s = s.replace(/\s+FOR\s+(?:UPDATE|SHARE|NO\s+KEY\s+UPDATE)(?:\s+OF\s+[\w".]+)?(?:\s+(?:NOWAIT|SKIP\s+LOCKED))?/gi, '');

  // 2. NOW() [+-] INTERVAL 'N unit(s)' → datetime('now', '[+-]N units')
  //    Covers every duration form used by the codebase (minutes, hours, days …),
  //    not just the single `+ N minutes` form the adapter used to special-case.
  s = s.replace(
    /\bNOW\(\)\s*([+-])\s*INTERVAL\s*'(\d+)\s*(SECOND|MINUTE|HOUR|DAY|WEEK|MONTH|YEAR)S?'/gi,
    (_match, sign: string, amount: string, unit: string) =>
      `datetime('now', '${sign}${amount} ${unit.toLowerCase()}s')`,
  );

  // 3. Bare NOW() → datetime('now')
  s = s.replace(/\bNOW\(\)/gi, "datetime('now')");

  // 4. GREATEST/LEAST → SQLite's scalar MAX/MIN (same semantics for >= 2 args).
  s = s.replace(/\bGREATEST\s*\(/gi, 'MAX(');
  s = s.replace(/\bLEAST\s*\(/gi, 'MIN(');

  // 5. ILIKE → LIKE (SQLite's LIKE is already case-insensitive for ASCII).
  s = s.replace(/\bILIKE\b/gi, 'LIKE');

  // 6. ON CONFLICT … DO NOTHING is redundant for the idempotent inserts we run
  //    in the dev adapter.
  s = s.replace(/\bON\s+CONFLICT\s*\([^)]+\)\s*DO\s+NOTHING/gi, '');

  return s;
}

class SqlitePool extends EventEmitter {
  query(sql: string, params?: any[]): Promise<any> {
    try {
      const db = getSqlite();
      let s = translateSqlForSqlite(sql);

      // Convert $1..$N → ? placeholders.
      //
      // The PostgreSQL driver lets a statement reference the same parameter
      // more than once (e.g. `... WHERE pair = $1 ... AND pair = $1`), while
      // SQLite only has positional `?` — so each occurrence gets its own
      // placeholder and the bound values are ordered accordingly. Without this
      // expansion a repeated $1 silently binds as NULL and the query returns
      // empty results instead of erroring.
      const usesPlaceholders = /\$\d+/.test(s);
      const bound: unknown[] = [];
      if (usesPlaceholders) {
        s = s.replace(/\$(\d+)/g, (_match, index: string) => {
          bound.push(toSqliteBindable((params ?? [])[Number(index) - 1]));
          return '?';
        });
      }

      const isSelect = /^\s*(SELECT|WITH|PRAGMA)/i.test(s);
      if (isSelect) {
        const stmt = db.prepare(s);
        const rows = usesPlaceholders ? stmt.all(...(bound as any[])) : stmt.all();
        return Promise.resolve({ rows: fixDates(rows as any[]), rowCount: rows.length });
      }

      // For INSERT/UPDATE/DELETE — SQLite supports RETURNING natively since 3.35
      const stmt = db.prepare(s);
      const rows = usesPlaceholders ? stmt.all(...(bound as any[])) : stmt.all();
      if (rows.length > 0) {
        return Promise.resolve({ rows: fixDates(rows as any[]), rowCount: rows.length });
      }
      return Promise.resolve({ rows: [], rowCount: 1 });
    } catch (err: any) {
      return Promise.reject(err);
    }
  }
  connect() {
    return Promise.resolve({ query: this.query.bind(this), release: () => {} });
  }
  end() { sqlite?.close(); sqlite = null; return Promise.resolve(); }
}

// ── Public API ──────────────────────────────────
let _realPg: pg.Pool | null = null;

/**
 * Create the application's database pool.
 *
 * - When DATABASE_URL is configured (non-empty): a real PostgreSQL pool.
 * - When empty (dev/test): the in-memory SQLite adapter.
 *
 * Production is guaranteed to take the PostgreSQL branch because the config
 * gate (src/config/index.ts) refuses to start when DATABASE_URL is unset.
 */
export function createPostgresPool(): pg.Pool {
  if (isSqlite) {
    console.log('[DB] Using in-memory node:sqlite database (dev/test only)');
    return new SqlitePool() as unknown as pg.Pool;
  }
  _realPg = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  _realPg.on('error', (err) => {
    console.error('[DB] Unexpected PostgreSQL pool error:', err.message);
  });
  return _realPg;
}

export function createRedisClient(): RedisType {
  if (!config.REDIS_URL) {
    console.warn(
      '[Redis] No REDIS_URL — using the in-process Redis stand-in (dev/test only). ' +
        'Order books live in this process only; production requires a real Redis.',
    );
    return createInMemoryRedis() as unknown as RedisType;
  }
  const c = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy: (t: number) => t > 5 ? null : Math.min(t * 200, 2000),
  });
  c.on('error', (e: Error) => console.error('[Redis]', e.message));
  return c;
}

let _pg: pg.Pool | null = null;
let _rd: RedisType | null = null;

export function getDb(): pg.Pool {
  if (!_pg) _pg = createPostgresPool();
  return _pg as unknown as pg.Pool;
}

export function getRedis(): RedisType {
  if (!_rd) _rd = createRedisClient();
  return _rd;
}

export async function closeConnections(): Promise<void> {
  if (_pg) {
    if (isSqlite) {
      await (_pg as unknown as SqlitePool).end();
    } else {
      await _realPg?.end();
    }
    _pg = null;
    _realPg = null;
  }
  if (_rd) { await _rd.quit(); _rd = null; }
}
