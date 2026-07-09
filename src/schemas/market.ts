/**
 * NovaBit Exchange — Market Data Schemas (Klines)
 */

import { z } from 'zod';

// ── Kline interval mapping ─────────────────────
export const KlineInterval = z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w', '1M']);
export type KlineInterval = z.infer<typeof KlineInterval>;

export const INTERVAL_MAP: Record<string, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
  '1w': '1w',
  '1M': '1M',
};

// ── Kline query schema ─────────────────────────
export const KlineQuerySchema = z.object({
  symbol: z.string().regex(/^[A-Za-z0-9]{5,20}$/, 'Invalid symbol (e.g. BTCUSDT)').optional(),
  interval: KlineInterval.default('1h'),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export type KlineQuery = z.infer<typeof KlineQuerySchema>;

// ── Kline response type ────────────────────────
export interface KlineData {
  time: number;       // Unix timestamp in seconds
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
}

// ── WebSocket message types ────────────────────
export const WSSubscribeSchema = z.object({
  type: z.literal('subscribe'),
  pair: z.string().regex(/^[A-Za-z0-9]{5,20}$/),
});

export const WSUnsubscribeSchema = z.object({
  type: z.literal('unsubscribe'),
  pair: z.string().regex(/^[A-Za-z0-9]{5,20}$/),
});

export const WSMessageSchema = z.discriminatedUnion('type', [
  WSSubscribeSchema,
  WSUnsubscribeSchema,
]);

export type WSMessage = z.infer<typeof WSMessageSchema>;

export interface WSOrderBookSnapshot {
  type: 'orderbook';
  pair: string;
  bids: Array<{ price: string; quantity: string }>;
  asks: Array<{ price: string; quantity: string }>;
  timestamp: number;
}

export interface WSTradeEvent {
  type: 'trade';
  pair: string;
  price: string;
  quantity: string;
  side: 'BUY' | 'SELL';
  trade_id: string;
  timestamp: number;
}

export interface WSTickerUpdate {
  type: 'ticker';
  pair: string;
  last_price: string;
  volume_24h: string;
  high_24h: string;
  low_24h: string;
  change_24h: string;
  change_percent_24h: string;
  timestamp: number;
}

export type WSMessageOut = WSOrderBookSnapshot | WSTradeEvent | WSTickerUpdate;