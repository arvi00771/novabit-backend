/**
 * NovaBit Exchange — Database Connection Module
 *
 * Provides configured PostgreSQL and Redis clients.
 * PostgreSQL uses @fastify/postgres for connection pooling.
 * Redis uses ioredis for caching, sessions, and order book pub/sub.
 */

import pg from 'pg';
import { Redis } from 'ioredis';
import type { Redis as RedisType } from 'ioredis';
import { config } from '../config/index.js';

// ── PostgreSQL Pool ─────────────────────────────
export function createPostgresPool(): pg.Pool {
  const pool = new pg.Pool({
    connectionString: config.DATABASE_URL,
    max: 20,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });

  pool.on('error', (err: Error) => {
    console.error('[DB] Unexpected pool error:', err);
  });

  return pool;
}

// ── Redis Client ────────────────────────────────
export function createRedisClient(): RedisType {
  const client = new Redis(config.REDIS_URL, {
    maxRetriesPerRequest: 3,
    retryStrategy(times: number) {
      if (times > 5) return null; // give up
      return Math.min(times * 200, 2000);
    },
    enableReadyCheck: true,
    lazyConnect: false,
  });

  client.on('error', (err: Error) => {
    console.error('[Redis] Error:', err.message);
  });

  client.on('connect', () => {
    console.log('[Redis] Connected');
  });

  return client;
}

// ── Singleton instances ─────────────────────────
let pgPool: pg.Pool | null = null;
let redisClient: RedisType | null = null;

export function getDb(): pg.Pool {
  if (!pgPool) pgPool = createPostgresPool();
  return pgPool;
}

export function getRedis(): RedisType {
  if (!redisClient) redisClient = createRedisClient();
  return redisClient;
}

export async function closeConnections(): Promise<void> {
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
  }
  if (redisClient) {
    await redisClient.quit();
    redisClient = null;
  }
}