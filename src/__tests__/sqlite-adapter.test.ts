/**
 * Regression tests for the dev/test in-memory adapters.
 *
 * The exchange's SQLite adapter and its Redis stand-in exist so the app can run
 * (and be exercised end to end) without PostgreSQL/Redis. Both had gaps that
 * turned core endpoints into 500s on the dev backend:
 *
 *   1. SQLite could not parse `FOR UPDATE` / `NOW() - INTERVAL '24 hours'`.
 *   2. The SQLite schema for `orders`, `trades`, `supported_coins` and the
 *      staking tables (`stakes`/`staking_products`/`staking_rewards`) had
 *      drifted from the migrations, so inserts/selects hit "no such column".
 *   3. Reused `$1` placeholders were all collapsed onto one `?`, silently
 *      binding NULL and returning empty aggregates.
 *   4. The Redis "mock" only had ping/quit, so every order-book call threw
 *      `this.redis.zadd is not a function`.
 *
 * These tests exercise the exact request paths that were broken: placing orders,
 * reading the ticker, the order book and the supported-coin list.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

// ── Translation unit tests ───────────────────────

describe('SQLite adapter — PostgreSQL statement translation', () => {
  it('strips FOR UPDATE / FOR SHARE row locks but leaves the rest intact', async () => {
    const { translateSqlForSqlite } = await import('../db/index.js');

    const out = translateSqlForSqlite(
      `SELECT id, balance FROM wallets WHERE user_id = $1 AND asset = $2 LIMIT 1 FOR UPDATE`,
    );
    expect(out).not.toMatch(/FOR\s+UPDATE/i);
    expect(out).toContain('FROM wallets WHERE user_id = $1 AND asset = $2 LIMIT 1');

    expect(translateSqlForSqlite('SELECT 1 FROM orders FOR SHARE NOWAIT')).not.toMatch(/FOR SHARE/i);
  });

  it('translates NOW() with +/- INTERVAL in minutes, hours and days', async () => {
    const { translateSqlForSqlite } = await import('../db/index.js');

    expect(translateSqlForSqlite(`WHERE trade_time > NOW() - INTERVAL '24 hours'`)).toBe(
      `WHERE trade_time > datetime('now', '-24 hours')`,
    );
    expect(translateSqlForSqlite(`THEN NOW() + INTERVAL '30 minutes'`)).toBe(
      `THEN datetime('now', '+30 minutes')`,
    );
    expect(translateSqlForSqlite(`AND created_at > NOW() - INTERVAL '7 days'`)).toBe(
      `AND created_at > datetime('now', '-7 days')`,
    );
    // bare NOW() still works
    expect(translateSqlForSqlite('SET updated_at = NOW()')).toBe(`SET updated_at = datetime('now')`);
  });

  it('translates GREATEST/LEAST and ILIKE', async () => {
    const { translateSqlForSqlite } = await import('../db/index.js');

    expect(translateSqlForSqlite('SET locked_balance = GREATEST(locked_balance - $1, 0)')).toContain(
      'MAX(locked_balance - $1, 0)',
    );
    expect(translateSqlForSqlite('SET x = LEAST(a, b)')).toContain('MIN(a, b)');
    expect(translateSqlForSqlite('SELECT * FROM users WHERE email ILIKE $1')).toContain('email LIKE $1');
  });

  it('coerces PostgreSQL-only parameter types into SQLite-bindable values', async () => {
    const { toSqliteBindable } = await import('../db/index.js');

    expect(toSqliteBindable(true)).toBe(1);
    expect(toSqliteBindable(false)).toBe(0);
    expect(toSqliteBindable(undefined)).toBeNull();
    expect(toSqliteBindable(new Date('2026-01-02T03:04:05.000Z'))).toBe('2026-01-02T03:04:05.000Z');
    expect(toSqliteBindable('BTC')).toBe('BTC');
  });
});

// ── Redis stand-in unit tests ────────────────────

describe('in-memory Redis stand-in', () => {
  it('behaves like a sorted set for the order book', async () => {
    const { createInMemoryRedis } = await import('../db/in-memory-redis.js');
    const redis = createInMemoryRedis();
    const key = 'orderbook:BTCUSDT:bids';

    await redis.zadd(key, '50000', 'order-a');
    await redis.zadd(key, '49000', 'order-b');
    await redis.zadd(key, '51000', 'order-c');

    // ascending by score
    expect(await redis.zrange(key, 0, -1)).toEqual(['order-b', 'order-a', 'order-c']);
    // descending by score (best bid first)
    expect(await redis.zrevrange(key, 0, -1, 'WITHSCORES')).toEqual([
      'order-c', '51000',
      'order-a', '50000',
      'order-b', '49000',
    ]);
    // range by score, as getOrderBook uses it
    expect(await redis.zrangebyscore(key, '-inf', '+inf', 'WITHSCORES', 'LIMIT', 0, 2)).toEqual([
      'order-b', '49000',
      'order-a', '50000',
    ]);

    await redis.zrem(key, 'order-a');
    expect(await redis.zrange(key, 0, -1)).toEqual(['order-b', 'order-c']);
    expect(await redis.zrange('missing:key', 0, -1)).toEqual([]);
  });

  it('stores order metadata hashes and answers ping', async () => {
    const { createInMemoryRedis } = await import('../db/in-memory-redis.js');
    const redis = createInMemoryRedis();

    expect(await redis.ping()).toBe('PONG');
    await redis.hset('order:1', { pair: 'BTCUSDT', remaining: '0.5' });
    await redis.hset('order:1', 'remaining', '0.25');
    expect(await redis.hget('order:1', 'remaining')).toBe('0.25');
    expect(await redis.hgetall('order:1')).toEqual({ pair: 'BTCUSDT', remaining: '0.25' });
    await redis.del('order:1');
    expect(await redis.hgetall('order:1')).toEqual({});
  });
});

// ── End-to-end endpoint tests (real adapter, no mocks) ──

describe('dev backend endpoints against the in-memory adapters', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const { buildApp } = await import('../app.js');
    app = await buildApp();
    await app.ready();

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: 'arvi00772@gmail.com', password: 'Test1234!' },
    });
    expect(login.statusCode).toBe(200);
    const body = login.json();
    token = body.data?.token ?? body.data?.access_token;
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThan(20);
  }, 60_000);

  const auth = () => ({ authorization: `Bearer ${token}` });

  it('GET /wallets/coins lists the migration-007 coins (no "no such column: asset")', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/wallets/coins', headers: auth() });

    expect(res.statusCode).toBe(200);
    const coins = res.json().data as Record<string, unknown>[];
    expect(coins.length).toBe(8);
    for (const coin of coins) {
      expect(typeof coin.asset).toBe('string');
      expect(coin.withdrawal_fee_type).toBe('FIXED');
      expect(coin.min_deposit_amount).toBeDefined();
    }
    expect(coins.map((c) => c.asset)).toEqual(
      expect.arrayContaining(['BTC', 'ETH', 'USDT', 'USDC', 'SOL', 'ADA', 'XRP', 'DOT']),
    );
  });

  it('GET /market/ticker/:pair returns a ticker instead of an INTERVAL syntax error', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/market/ticker/BTCUSDT' });

    expect(res.statusCode).toBe(200);
    const ticker = res.json().data;
    expect(ticker.pair).toBe('BTCUSDT');
    expect(ticker).toHaveProperty('last_price');
    expect(ticker).toHaveProperty('volume_24h');
  });

  it('POST /orders accepts a LIMIT BUY (no "near FOR: syntax error")', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: auth(),
      payload: { pair: 'BTCUSDT', side: 'BUY', type: 'LIMIT', price: '50000.00', quantity: '0.001' },
    });

    expect(res.statusCode).toBe(201);
    const order = res.json().data;
    expect(order.status).toBe('OPEN');
    expect(order.side).toBe('BUY');
    expect(order.price).toBe('50000.00');
    // balance was locked against the quote wallet
    const wallets = await app.inject({ method: 'GET', url: '/api/v1/wallets', headers: auth() });
    const usdt = (wallets.json().data as Record<string, any>[]).find((w) => w.asset === 'USDT');
    expect(Number(usdt.locked_balance)).toBeGreaterThan(0);
  });

  it('POST /orders accepts a MARKET SELL and fills it against the resting bid', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/orders',
      headers: auth(),
      payload: { pair: 'BTCUSDT', side: 'SELL', type: 'MARKET', quantity: '0.001' },
    });

    expect(res.statusCode).toBe(201);
    const order = res.json().data;
    expect(order.side).toBe('SELL');
    expect(order.type).toBe('MARKET');
    expect(order.status).toBe('FILLED');
    expect(Number(order.filled_quantity)).toBeCloseTo(0.001, 8);
  });

  it('GET /market/ticker/:pair aggregates trades (repeated $1 binding regression)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/market/ticker/BTCUSDT' });

    expect(res.statusCode).toBe(200);
    const ticker = res.json().data;
    // A traded pair must report its 24h volume/high/low — a collapsed repeated
    // $1 placeholder would silently return 0/0/0 here.
    expect(Number(ticker.volume_24h)).toBeGreaterThan(0);
    expect(Number(ticker.high_24h)).toBeGreaterThan(0);
    expect(Number(ticker.low_24h)).toBeGreaterThan(0);
  });

  it('GET /market/orderbook/:pair works against the in-memory order book', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/market/orderbook/BTCUSDT?depth=5' });

    expect(res.statusCode).toBe(200);
    const book = res.json().data;
    expect(book.pair).toBe('BTCUSDT');
    expect(Array.isArray(book.bids)).toBe(true);
    expect(Array.isArray(book.asks)).toBe(true);
  });

  it('GET /market/trades/:pair returns the executed trade', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/market/trades/BTCUSDT' });

    expect(res.statusCode).toBe(200);
    const trades = res.json().data as Record<string, unknown>[];
    expect(trades.length).toBeGreaterThan(0);
    expect(trades[0]).toHaveProperty('trade_time');
    expect(trades[0]).toHaveProperty('quote_quantity');
  });

  it('GET /wallets/deposit/address/:asset uses the supported_coins min amount', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/wallets/deposit/address/BTC',
      headers: auth(),
    });

    expect(res.statusCode).toBe(200);
    const info = res.json().data;
    expect(info.asset).toBe('BTC');
    expect(info.min_deposit_amount).toBe('0.0001');
    expect(typeof info.address).toBe('string');
  });

  // ── Staking (migration 008: staking_products / stakes / staking_rewards) ──
  it('GET /staking/products returns the seeded migration-008 products', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/staking/products', headers: auth() });

    expect(res.statusCode).toBe(200);
    const products = res.json().data as Record<string, unknown>[];
    expect(products.length).toBe(6);
    expect(products.map((p) => p.asset)).toEqual(
      expect.arrayContaining(['ETH', 'SOL', 'ADA', 'DOT', 'AVAX', 'USDT']),
    );
    expect(typeof products[0].id).toBe('string');
  });

  it('stake → positions → unstake works end to end on the dev schema', async () => {
    const { getDb } = await import('../db/index.js');
    const db = getDb();
    const email = 'arvi00772@gmail.com';

    // Fund an ETH spot wallet so the stake can be covered.
    await db.query(
      `DELETE FROM wallets WHERE asset = 'ETH' AND user_id = (SELECT id FROM users WHERE email = $1)`,
      [email],
    );
    await db.query(
      `INSERT INTO wallets (id, user_id, asset, wallet_type, balance, locked_balance, is_active)
       VALUES ('w_test_eth', (SELECT id FROM users WHERE email = $1), 'ETH', 'SPOT', '5', '0', 1)`,
      [email],
    );

    const products = (
      await app.inject({ method: 'GET', url: '/api/v1/staking/products', headers: auth() })
    ).json().data as Record<string, unknown>[];
    const ethFlexible = products.find((p) => p.asset === 'ETH' && p.lock_period_days === 0);
    expect(ethFlexible).toBeDefined();

    const stake = await app.inject({
      method: 'POST',
      url: '/api/v1/staking/stake',
      headers: auth(),
      payload: { product_id: ethFlexible!.id, amount: '1' },
    });
    expect(stake.statusCode).toBe(201);
    const stakeBody = stake.json().data;
    expect(stakeBody.status).toBe('ACTIVE');
    expect(stakeBody.asset).toBe('ETH');
    expect(stakeBody.apy_at_stake).toBe('4.5');

    // The stake locks the balance and shows up in the position list.
    const positions = await app.inject({
      method: 'GET',
      url: '/api/v1/staking/positions',
      headers: auth(),
    });
    expect(positions.statusCode).toBe(200);
    const positionList = positions.json().data as Record<string, unknown>[];
    expect(positionList.some((p) => p.id === stakeBody.id && p.status === 'ACTIVE')).toBe(true);

    // Flexible stake: unstaking completes immediately and releases the balance.
    const unstake = await app.inject({
      method: 'POST',
      url: '/api/v1/staking/unstake',
      headers: auth(),
      payload: { stake_id: stakeBody.id },
    });
    expect(unstake.statusCode).toBe(200);
    expect(unstake.json().data.status).toBe('COMPLETED');

    const after = (
      await app.inject({ method: 'GET', url: '/api/v1/staking/positions', headers: auth() })
    ).json().data as Record<string, unknown>[];
    expect(after.find((p) => p.id === stakeBody.id)?.status).toBe('COMPLETED');

    // Reward history endpoint uses the staking_rewards table.
    const rewards = await app.inject({
      method: 'GET',
      url: '/api/v1/staking/rewards',
      headers: auth(),
    });
    expect(rewards.statusCode).toBe(200);
    expect(Array.isArray(rewards.json().data)).toBe(true);
  });
});
