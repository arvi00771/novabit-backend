import { DatabaseSync } from 'node:sqlite';
import type pg from 'pg';
import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type { Redis as RedisType } from 'ioredis';
import { EventEmitter } from 'events';
import { config } from '../config/index.js';
import bcrypt from 'bcryptjs';

// ── SQLite in-memory DB ──────────────────────────
let sqlite: DatabaseSync | null = null;

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
    side            TEXT NOT NULL,
    order_type      TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'PENDING',
    price           TEXT,
    stop_price      TEXT,
    quantity        TEXT NOT NULL,
    filled_quantity TEXT NOT NULL DEFAULT '0',
    filled_cost     TEXT NOT NULL DEFAULT '0',
    fee             TEXT NOT NULL DEFAULT '0',
    fee_asset       TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trades (
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    order_id        TEXT NOT NULL,
    maker_order_id  TEXT,
    pair            TEXT NOT NULL,
    side            TEXT NOT NULL,
    price           TEXT NOT NULL,
    quantity        TEXT NOT NULL,
    fee             TEXT NOT NULL DEFAULT '0',
    fee_asset       TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
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
    id              TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(4))) || '-' || lower(hex(randomblob(2))) || '-4' || substr(lower(hex(randomblob(2))),2) || '-a' || substr(lower(hex(randomblob(2))),2) || '-' || lower(hex(randomblob(6)))),
    symbol          TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    network         TEXT NOT NULL,
    decimals        INTEGER NOT NULL DEFAULT 18,
    is_active       INTEGER NOT NULL DEFAULT 1,
    min_deposit     TEXT NOT NULL DEFAULT '0',
    min_withdrawal  TEXT NOT NULL DEFAULT '0',
    withdrawal_fee  TEXT NOT NULL DEFAULT '0',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
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
    resource        TEXT,
    resource_id     TEXT,
    details         TEXT,
    ip_address      TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_wallets_user ON wallets (user_id);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders (user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders (status);
CREATE INDEX IF NOT EXISTS idx_trades_order ON trades (order_id);
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

INSERT OR IGNORE INTO supported_coins (id, symbol, name, network, decimals)
VALUES ('coin_btc', 'BTC', 'Bitcoin', 'BITCOIN', 8);

INSERT OR IGNORE INTO supported_coins (id, symbol, name, network, decimals)
VALUES ('coin_eth', 'ETH', 'Ethereum', 'ETHEREUM', 18);

INSERT OR IGNORE INTO supported_coins (id, symbol, name, network, decimals)
VALUES ('coin_usdt', 'USDT', 'Tether', 'ETHEREUM', 6);

INSERT OR IGNORE INTO supported_coins (id, symbol, name, network, decimals)
VALUES ('coin_sol', 'SOL', 'Solana', 'SOLANA', 9);

INSERT OR IGNORE INTO supported_coins (id, symbol, name, network, decimals)
VALUES ('coin_ada', 'ADA', 'Cardano', 'CARDANO', 6);

INSERT OR IGNORE INTO supported_coins (id, symbol, name, network, decimals)
VALUES ('coin_avax', 'AVAX', 'Avalanche', 'AVALANCHE', 18);
`;

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

class SqlitePool extends EventEmitter {
  query(sql: string, params?: any[]): Promise<any> {
    try {
      const db = getSqlite();
      let s = sql;

      // Translate PG functions to SQLite
      s = s.replace(/\bNOW\(\)\s*\+\s*INTERVAL\s*'(\d+)\s*minutes'/gi, "datetime('now', '+$1 minutes')");
      s = s.replace(/\bNOW\(\)/gi, "datetime('now')");
      // Strip PG ON CONFLICT — SQLite handles it but we just remove for simplicity
      s = s.replace(/\bON\s+CONFLICT\s*\([^)]+\)\s*DO\s+NOTHING/gi, '');

      // Convert $1..$N → ? placeholders and fix param types
      if (params && params.length > 0) {
        s = s.replace(/\$\d+/g, '?');
        // Convert Date objects to ISO strings for SQLite
        params = params.map((p: any) => p instanceof Date ? p.toISOString() : p);
      }

      const isSelect = /^\s*SELECT/i.test(s);
      if (isSelect) {
        const stmt = db.prepare(s);
        const rows = params ? stmt.all(...params) : stmt.all();
        return Promise.resolve({ rows: fixDates(rows), rowCount: rows.length });
      }

      // For INSERT/UPDATE/DELETE — SQLite supports RETURNING natively since 3.35
      const stmt = db.prepare(s);
      const rows = params ? stmt.all(...params) : stmt.all();
      if (rows.length > 0) {
        return Promise.resolve({ rows: fixDates(rows), rowCount: rows.length });
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
export function createPostgresPool(): SqlitePool {
  console.log('[DB] Using in-memory node:sqlite database');
  return new SqlitePool();
}

export function createRedisClient(): RedisType {
  if (!config.REDIS_URL) {
    console.warn('[Redis] No REDIS_URL, using mock');
    const m = new EventEmitter() as unknown as RedisType;
    (m as any).ping = async () => 'PONG';
    (m as any).quit = async () => 'OK';
    (m as any).on = () => m;
    return m;
  }
  const c = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy: (t: number) => t > 5 ? null : Math.min(t * 200, 2000),
  });
  c.on('error', (e: Error) => console.error('[Redis]', e.message));
  return c;
}

let _pg: SqlitePool | null = null;
let _rd: RedisType | null = null;

export function getDb(): pg.Pool {
  if (!_pg) _pg = createPostgresPool();
  // The in-memory development adapter implements the query/connect surface used
  // by application services while production services are typed against pg.Pool.
  return _pg as unknown as pg.Pool;
}

export function getRedis(): RedisType {
  if (!_rd) _rd = createRedisClient();
  return _rd;
}

export async function closeConnections(): Promise<void> {
  if (_pg) { await _pg.end(); _pg = null; }
  if (_rd) { await _rd.quit(); _rd = null; }
}
