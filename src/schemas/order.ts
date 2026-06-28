/**
 * NovaBit Exchange — Order & Trading Schemas
 */

import { z } from 'zod';

// ── Create Order ─────────────────────────────
export const CreateOrderSchema = z.object({
  pair: z.string().regex(/^[A-Za-z]{5,20}$/, 'Invalid trading pair (e.g. BTCUSDT)').toUpperCase(),
  side: z.enum(['BUY', 'SELL']),
  type: z.enum(['LIMIT', 'MARKET', 'STOP_LIMIT', 'STOP_MARKET']),
  price: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  stop_price: z.string().regex(/^\d+(\.\d+)?$/).optional(),
  quantity: z.string().regex(/^\d+(\.\d+)?$/, 'Must be a valid number').optional(),
  quote_quantity: z.string().regex(/^\d+(\.\d+)?$/).optional(), // for MARKET BUY
  time_in_force: z.enum(['GTC', 'IOC', 'FOK', 'GTD']).optional().default('GTC'),
  client_order_id: z.string().max(64).optional(),
}).superRefine((data, ctx) => {
  // For MARKET orders, require either quantity or quote_quantity
  if (data.type === 'MARKET' && !data.quantity && !data.quote_quantity) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Market orders require either quantity or quote_quantity',
      path: ['quantity'],
    });
  }
  // For non-MARKET orders (LIMIT, STOP_*), require quantity
  if (data.type !== 'MARKET' && !data.quantity) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Limit and stop orders require quantity',
      path: ['quantity'],
    });
  }
  // LIMIT and STOP_LIMIT orders require a price
  if ((data.type === 'LIMIT' || data.type === 'STOP_LIMIT') && !data.price) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Limit orders require a price',
      path: ['price'],
    });
  }
  // STOP orders require stop_price
  if ((data.type === 'STOP_LIMIT' || data.type === 'STOP_MARKET') && !data.stop_price) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Stop orders require stop_price',
      path: ['stop_price'],
    });
  }
});
export type CreateOrderInput = z.infer<typeof CreateOrderSchema>;

// ── Cancel Order ─────────────────────────────
export const CancelOrderSchema = z.object({
  order_id: z.string().uuid(),
});
export type CancelOrderInput = z.infer<typeof CancelOrderSchema>;

// ── List Orders ──────────────────────────────
export const ListOrdersSchema = z.object({
  pair: z.string().optional(),
  status: z.string().optional(),
  side: z.enum(['BUY', 'SELL']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListOrdersInput = z.infer<typeof ListOrdersSchema>;

// ── Order Book Query ─────────────────────────
export const OrderBookSchema = z.object({
  pair: z.string().min(1),
  depth: z.coerce.number().int().min(1).max(100).default(20),
});
export type OrderBookInput = z.infer<typeof OrderBookSchema>;

// ── Recent Trades Query ──────────────────────
export const RecentTradesSchema = z.object({
  pair: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type RecentTradesInput = z.infer<typeof RecentTradesSchema>;

// ── Response Types ───────────────────────────
export interface OrderResponse {
  id: string;
  user_id: string;
  pair: string;
  side: string;
  type: string;
  status: string;
  price: string | null;
  stop_price: string | null;
  quantity: string;
  filled_quantity: string;
  remaining_quantity: string;
  quote_quantity: string | null;
  filled_quote_quantity: string;
  fee_asset: string | null;
  fee_amount: string;
  time_in_force: string;
  client_order_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface TradeResponse {
  id: string;
  pair: string;
  price: string;
  quantity: string;
  quote_quantity: string;
  taker_side: string;
  buyer_order_id: string;
  seller_order_id: string;
  trade_time: string;
}

export interface OrderBookLevel {
  price: string;
  quantity: string;
  total: string;
  order_count: number;
}

export interface OrderBookResponse {
  pair: string;
  bids: OrderBookLevel[];
  asks: OrderBookLevel[];
  timestamp: number;
}

export interface TickerResponse {
  pair: string;
  last_price: string;
  volume_24h: string;
  high_24h: string;
  low_24h: string;
  change_24h: string;
  change_percent_24h: string;
  timestamp: number;
}