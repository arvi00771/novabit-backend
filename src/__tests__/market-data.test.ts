/**
 * Tests for the Kline/candlestick endpoint and WebSocket real-time feed.
 */

import { describe, it, expect } from 'vitest';

describe('Kline Schemas - Query Validation', () => {
  it('should accept valid kline query with defaults', async () => {
    const { KlineQuerySchema } = await import('../schemas/market.js');

    const result = KlineQuerySchema.parse({ symbol: 'BTCUSDT' });
    expect(result.symbol).toBe('BTCUSDT');
    expect(result.interval).toBe('1h');
    expect(result.limit).toBe(200);
  });

  it('should accept all valid intervals', async () => {
    const { KlineQuerySchema } = await import('../schemas/market.js');

    const intervals = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M'];
    for (const interval of intervals) {
      const result = KlineQuerySchema.parse({ symbol: 'BTCUSDT', interval });
      expect(result.interval).toBe(interval);
    }
  });

  it('should reject invalid interval', async () => {
    const { KlineQuerySchema } = await import('../schemas/market.js');

    expect(() =>
      KlineQuerySchema.parse({ symbol: 'BTCUSDT', interval: '2h' }),
    ).toThrow();
  });

  it('should reject limit over 1000', async () => {
    const { KlineQuerySchema } = await import('../schemas/market.js');

    expect(() =>
      KlineQuerySchema.parse({ symbol: 'BTCUSDT', limit: 2000 }),
    ).toThrow();
  });

  it('should reject negative limit', async () => {
    const { KlineQuerySchema } = await import('../schemas/market.js');

    expect(() =>
      KlineQuerySchema.parse({ symbol: 'BTCUSDT', limit: -1 }),
    ).toThrow();
  });
});

describe('Kline Service - Mock Data Generation', () => {
  it('should generate correct number of klines', async () => {
    const { MarketDataService } = await import('../services/market-data.js');

    const service = new MarketDataService();
    const klines = await service.getKlines('BTCUSDT', '1h', 100);

    expect(klines.length).toBe(100);
  });

  it('should generate klines with correct structure', async () => {
    const { MarketDataService } = await import('../services/market-data.js');

    const service = new MarketDataService();
    const klines = await service.getKlines('ETHUSDT', '1h', 5);

    for (const k of klines) {
      expect(k).toHaveProperty('time');
      expect(k).toHaveProperty('open');
      expect(k).toHaveProperty('high');
      expect(k).toHaveProperty('low');
      expect(k).toHaveProperty('close');
      expect(k).toHaveProperty('volume');
      expect(typeof k.time).toBe('number');
      expect(typeof k.open).toBe('string');
      expect(typeof k.close).toBe('string');
    }
  });

  it('should generate klines in chronological order', async () => {
    const { MarketDataService } = await import('../services/market-data.js');

    const service = new MarketDataService();
    const klines = await service.getKlines('BTCUSDT', '1h', 10);

    for (let i = 1; i < klines.length; i++) {
      expect(klines[i].time).toBeGreaterThan(klines[i - 1].time);
    }
  });

  it('should return different prices for different pairs', async () => {
    const { MarketDataService } = await import('../services/market-data.js');

    const service = new MarketDataService();
    const btcKlines = await service.getKlines('BTCUSDT', '1h', 1);
    const ethKlines = await service.getKlines('ETHUSDT', '1h', 1);

    expect(btcKlines[0].open).not.toBe(ethKlines[0].open);
  });
});

describe('Kline Service - Interval Mapping', () => {
  it('should have correct interval seconds mapping', async () => {
    const { INTERVAL_MAP } = await import('../schemas/market.js');

    expect(INTERVAL_MAP['1m']).toBe('1m');
    expect(INTERVAL_MAP['1h']).toBe('1h');
    expect(INTERVAL_MAP['1d']).toBe('1d');
    expect(INTERVAL_MAP['1w']).toBe('1w');
    expect(INTERVAL_MAP['1M']).toBe('1M');
  });
});

describe('WebSocket Schemas - Message Validation', () => {
  it('should accept valid subscribe message', async () => {
    const { WSMessageSchema } = await import('../schemas/market.js');

    const result = WSMessageSchema.parse({
      type: 'subscribe',
      pair: 'BTCUSDT',
    });

    expect(result.type).toBe('subscribe');
    expect(result.pair).toBe('BTCUSDT');
  });

  it('should accept valid unsubscribe message', async () => {
    const { WSMessageSchema } = await import('../schemas/market.js');

    const result = WSMessageSchema.parse({
      type: 'unsubscribe',
      pair: 'ETHUSDT',
    });

    expect(result.type).toBe('unsubscribe');
    expect(result.pair).toBe('ETHUSDT');
  });

  it('should reject invalid message type', async () => {
    const { WSMessageSchema } = await import('../schemas/market.js');

    expect(() =>
      WSMessageSchema.parse({ type: 'invalid', pair: 'BTCUSDT' }),
    ).toThrow();
  });

  it('should reject empty pair', async () => {
    const { WSMessageSchema } = await import('../schemas/market.js');

    expect(() =>
      WSMessageSchema.parse({ type: 'subscribe', pair: '' }),
    ).toThrow();
  });
});

describe('Market Routes - Existence', () => {
  it('should have kline routes in market.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const marketPath = join(__dirname, '..', 'routes', 'market.ts');
    const content = readFileSync(marketPath, 'utf-8');

    expect(content).toContain('klines');
    expect(content).toContain('MarketDataService');
  });

  it('should have WebSocket route file', async () => {
    const { accessSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const wsPath = join(__dirname, '..', 'routes', 'ws.ts');

    expect(() => accessSync(wsPath)).not.toThrow();
  });

  it('should have WS routes registered in index', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const indexPath = join(__dirname, '..', 'routes', 'index.ts');
    const content = readFileSync(indexPath, 'utf-8');

    expect(content).toContain('ws.js');
  });
});