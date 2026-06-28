/**
 * Basic validation tests for the NovaBit Exchange backend setup.
 */

import { describe, it, expect } from 'vitest';

describe('Configuration', () => {
  it('should load config from environment variables', async () => {
    // Store original env values and set test values
    const orig = { ...process.env };
    process.env.NODE_ENV = 'development';
    process.env.HOST = '0.0.0.0';
    process.env.PORT = '3000';
    process.env.LOG_LEVEL = 'info';

    // Dynamic import to get fresh module
    const mod = await import('../config/index.js');
    expect(mod.config.NODE_ENV).toBe('development');
    expect(mod.config.HOST).toBe('0.0.0.0');
    expect(mod.config.PORT).toBe(3000);
    expect(mod.config.LOG_LEVEL).toBe('info');

    // Restore
    Object.assign(process.env, orig);
  });
});

describe('Types & Schemas', () => {
  it('should validate order sides', async () => {
    const { OrderSide } = await import('../schemas/types.js');

    expect(OrderSide.parse('BUY')).toBe('BUY');
    expect(OrderSide.parse('SELL')).toBe('SELL');
    expect(() => OrderSide.parse('INVALID')).toThrow();
  });

  it('should validate order types', async () => {
    const { OrderType } = await import('../schemas/types.js');

    expect(OrderType.parse('LIMIT')).toBe('LIMIT');
    expect(OrderType.parse('MARKET')).toBe('MARKET');
    expect(() => OrderType.parse('INVALID')).toThrow();
  });

  it('should validate create order schema', async () => {
    const { CreateOrderSchema } = await import('../schemas/types.js');

    const valid = CreateOrderSchema.parse({
      pair: 'BTCUSDT',
      side: 'BUY',
      order_type: 'LIMIT',
      price: '50000.00',
      quantity: '0.1',
    });

    expect(valid.pair).toBe('BTCUSDT');
    expect(valid.price).toBe('50000.00');
  });

  it('should reject invalid order input', async () => {
    const { CreateOrderSchema } = await import('../schemas/types.js');

    expect(() =>
      CreateOrderSchema.parse({
        pair: 'BTCUSDT',
        side: 'INVALID',
        order_type: 'LIMIT',
        quantity: '0.1',
      }),
    ).toThrow();
  });
});

describe('Error Handler', () => {
  it('should create AppError with correct properties', async () => {
    const { AppError } = await import('../middleware/error-handler.js');

    const error = new AppError(404, 'NOT_FOUND', 'User not found');
    expect(error.statusCode).toBe(404);
    expect(error.code).toBe('NOT_FOUND');
    expect(error.message).toBe('User not found');
    expect(error.name).toBe('AppError');
  });
});

describe('Auth Guard', () => {
  it('should create requireRole middleware', async () => {
    const { requireRole } = await import('../middleware/auth-guard.js');

    const middleware = requireRole('ADMIN');
    expect(middleware).toBeInstanceOf(Function);
  });
});

describe('Migration Runner', () => {
  it('should have all migration files in order', async () => {
    const { readdirSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const migrationsDir = join(__dirname, '..', 'db', 'migrations');
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    expect(files.length).toBeGreaterThanOrEqual(5);
    expect(files[0]).toMatch(/^001_/);
    expect(files[1]).toMatch(/^002_/);
    expect(files[2]).toMatch(/^003_/);
    expect(files[3]).toMatch(/^004_/);
    expect(files[4]).toMatch(/^005_/);
  });
});

describe('Docker Compose', () => {
  it('should exist with required services', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const composePath = join(__dirname, '..', '..', 'docker-compose.yml');
    const content = readFileSync(composePath, 'utf-8');

    expect(content).toContain('postgres:');
    expect(content).toContain('redis:');
  });
});