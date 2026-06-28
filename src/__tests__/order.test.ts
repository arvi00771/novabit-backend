/**
 * Unit tests for Order & Market schemas.
 */

import { describe, it, expect } from 'vitest';

describe('Order Schemas - CreateOrder', () => {
  it('should accept valid limit order', async () => {
    const { CreateOrderSchema } = await import('../schemas/order.js');

    const result = CreateOrderSchema.parse({
      pair: 'btcusdt',
      side: 'BUY',
      type: 'LIMIT',
      price: '50000.00',
      quantity: '0.1',
    });

    expect(result.pair).toBe('BTCUSDT'); // uppercased
    expect(result.side).toBe('BUY');
    expect(result.type).toBe('LIMIT');
    expect(result.price).toBe('50000.00');
    expect(result.quantity).toBe('0.1');
    expect(result.time_in_force).toBe('GTC'); // default
  });

  it('should accept market order without price', async () => {
    const { CreateOrderSchema } = await import('../schemas/order.js');

    const result = CreateOrderSchema.parse({
      pair: 'BTCUSDT',
      side: 'SELL',
      type: 'MARKET',
      quantity: '1.5',
    });

    expect(result.type).toBe('MARKET');
    expect(result.price).toBeUndefined();
  });

  it('should accept market buy with only quote_quantity', async () => {
    const { CreateOrderSchema } = await import('../schemas/order.js');

    const result = CreateOrderSchema.parse({
      pair: 'ETHUSDT',
      side: 'BUY',
      type: 'MARKET',
      quote_quantity: '1000',
    });

    expect(result.quote_quantity).toBe('1000');
    expect(result.quantity).toBeUndefined();
  });

  it('should reject market order with neither quantity nor quote_quantity', async () => {
    const { CreateOrderSchema } = await import('../schemas/order.js');

    expect(() =>
      CreateOrderSchema.parse({
        pair: 'BTCUSDT',
        side: 'BUY',
        type: 'MARKET',
      }),
    ).toThrow();
  });

  it('should accept stop-limit order', async () => {
    const { CreateOrderSchema } = await import('../schemas/order.js');

    const result = CreateOrderSchema.parse({
      pair: 'BTCUSDT',
      side: 'SELL',
      type: 'STOP_LIMIT',
      price: '49000',
      stop_price: '49500',
      quantity: '0.5',
    });

    expect(result.type).toBe('STOP_LIMIT');
    expect(result.stop_price).toBe('49500');
  });

  it('should reject invalid trading pair format', async () => {
    const { CreateOrderSchema } = await import('../schemas/order.js');

    expect(() =>
      CreateOrderSchema.parse({
        pair: 'invalid!',
        side: 'BUY',
        type: 'LIMIT',
        price: '100',
        quantity: '1',
      }),
    ).toThrow();
  });

  it('should reject invalid side', async () => {
    const { CreateOrderSchema } = await import('../schemas/order.js');

    expect(() =>
      CreateOrderSchema.parse({
        pair: 'BTCUSDT',
        side: 'INVALID',
        type: 'LIMIT',
        price: '100',
        quantity: '1',
      }),
    ).toThrow();
  });

  it('should reject invalid quantity format', async () => {
    const { CreateOrderSchema } = await import('../schemas/order.js');

    expect(() =>
      CreateOrderSchema.parse({
        pair: 'BTCUSDT',
        side: 'BUY',
        type: 'LIMIT',
        price: '100',
        quantity: 'not-a-number',
      }),
    ).toThrow();
  });
});

describe('Order Schemas - ListOrders', () => {
  it('should apply default pagination', async () => {
    const { ListOrdersSchema } = await import('../schemas/order.js');

    const result = ListOrdersSchema.parse({});
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(0);
  });

  it('should accept filters', async () => {
    const { ListOrdersSchema } = await import('../schemas/order.js');

    const result = ListOrdersSchema.parse({
      pair: 'BTCUSDT',
      status: 'OPEN',
      side: 'BUY',
      limit: 10,
    });

    expect(result.pair).toBe('BTCUSDT');
    expect(result.status).toBe('OPEN');
    expect(result.side).toBe('BUY');
    expect(result.limit).toBe(10);
  });
});

describe('Order Schemas - Order Book', () => {
  it('should apply default depth', async () => {
    const { OrderBookSchema } = await import('../schemas/order.js');

    const result = OrderBookSchema.parse({ pair: 'BTCUSDT' });
    expect(result.depth).toBe(20);
  });

  it('should cap depth at 100', async () => {
    const { OrderBookSchema } = await import('../schemas/order.js');

    expect(() =>
      OrderBookSchema.parse({ pair: 'BTCUSDT', depth: 200 }),
    ).toThrow();
  });
});

describe('Order Schemas - Recent Trades', () => {
  it('should apply default limit', async () => {
    const { RecentTradesSchema } = await import('../schemas/order.js');

    const result = RecentTradesSchema.parse({ pair: 'BTCUSDT' });
    expect(result.limit).toBe(50);
  });
});