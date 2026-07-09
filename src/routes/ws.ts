/**
 * NovaBit Exchange — WebSocket Real-Time Feed
 *
 * WS /ws — Real-time order book, trade, and ticker streaming.
 *
 * Messages from client:
 *   { type: 'subscribe', pair: 'BTCUSDT' }
 *   { type: 'unsubscribe', pair: 'BTCUSDT' }
 *
 * Messages to client:
 *   { type: 'orderbook', pair, bids, asks, timestamp }
 *   { type: 'trade', pair, price, quantity, side, trade_id, timestamp }
 *   { type: 'ticker', pair, last_price, volume_24h, high_24h, low_24h, change_24h, change_percent_24h, timestamp }
 */

import { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { MatchingEngine } from '../services/matching-engine.js';
import { getDb } from '../db/index.js';

interface Subscriber {
  ws: WebSocket;
  pairs: Set<string>;
  intervals: {
    orderbook: ReturnType<typeof setInterval> | null;
    ticker: ReturnType<typeof setInterval> | null;
  };
}

export default async function wsRoutes(fastify: FastifyInstance) {
  const engine = new MatchingEngine(getDb(), fastify.customMetrics);
  const subscribers = new Map<WebSocket, Subscriber>();

  fastify.get('/ws', { websocket: true }, (socket, _request) => {
    const subscriber: Subscriber = {
      ws: socket,
      pairs: new Set(),
      intervals: { orderbook: null, ticker: null },
    };

    subscribers.set(socket, subscriber);

    // ── Handle incoming messages ────────────────
    socket.on('message', async (rawData: Buffer | string) => {
      try {
        const msg = JSON.parse(rawData.toString());

        if (msg.type === 'subscribe' && msg.pair) {
          const pair = msg.pair.toUpperCase();
          subscriber.pairs.add(pair);

          // Start sending data if this is the first subscription
          if (subscriber.pairs.size === 1) {
            startStreaming(subscriber, engine);
          }

          socket.send(JSON.stringify({
            type: 'subscribed',
            pair,
            message: `Subscribed to ${pair}`,
            timestamp: Date.now(),
          }));
        } else if (msg.type === 'unsubscribe' && msg.pair) {
          const pair = msg.pair.toUpperCase();
          subscriber.pairs.delete(pair);

          socket.send(JSON.stringify({
            type: 'unsubscribed',
            pair,
            message: `Unsubscribed from ${pair}`,
            timestamp: Date.now(),
          }));

          // Stop streaming if no subscriptions remain
          if (subscriber.pairs.size === 0) {
            stopStreaming(subscriber);
          }
        }
      } catch {
        socket.send(JSON.stringify({
          type: 'error',
          message: 'Invalid message format. Use { type: "subscribe", pair: "BTCUSDT" }',
          timestamp: Date.now(),
        }));
      }
    });

    // ── Handle disconnect ───────────────────────
    socket.on('close', () => {
      stopStreaming(subscriber);
      subscribers.delete(socket);
    });
  });
}

/**
 * Start streaming orderbook, trades, and ticker data for subscribed pairs.
 */
function startStreaming(subscriber: Subscriber, engine: MatchingEngine) {
  const { ws, pairs } = subscriber;

  // Stream orderbook snapshots every 500ms
  subscriber.intervals.orderbook = setInterval(async () => {
    if (ws.readyState !== ws.OPEN) {
      stopStreaming(subscriber);
      return;
    }

    for (const pair of pairs) {
      try {
        const orderbook = await engine.getOrderBook(pair, 10);
        ws.send(JSON.stringify({
          type: 'orderbook',
          pair,
          bids: orderbook.bids.map((b) => ({ price: b.price, quantity: b.quantity })),
          asks: orderbook.asks.map((a) => ({ price: a.price, quantity: a.quantity })),
          timestamp: Date.now(),
        }));
      } catch {
        // Order book not available yet — skip
      }
    }
  }, 500);

  // Stream ticker updates every 1s
  subscriber.intervals.ticker = setInterval(async () => {
    if (ws.readyState !== ws.OPEN) {
      stopStreaming(subscriber);
      return;
    }

    for (const pair of pairs) {
      try {
        const ticker = await engine.getTicker(pair);
        ws.send(JSON.stringify({
          type: 'ticker',
          pair,
          last_price: ticker.last_price,
          volume_24h: ticker.volume_24h,
          high_24h: ticker.high_24h,
          low_24h: ticker.low_24h,
          change_24h: ticker.change_24h,
          change_percent_24h: ticker.change_percent_24h,
          timestamp: Date.now(),
        }));
      } catch {
        // Ticker not available yet — skip
      }
    }
  }, 1000);
}

/**
 * Stop streaming for a subscriber.
 */
function stopStreaming(subscriber: Subscriber) {
  if (subscriber.intervals.orderbook) {
    clearInterval(subscriber.intervals.orderbook);
    subscriber.intervals.orderbook = null;
  }
  if (subscriber.intervals.ticker) {
    clearInterval(subscriber.intervals.ticker);
    subscriber.intervals.ticker = null;
  }
}