/**
 * NovaBit Exchange — Market Data Routes
 *
 * GET /api/v1/market/pairs           — List all trading pairs
 * GET /api/v1/market/orderbook/:pair — Get order book snapshot
 * GET /api/v1/market/trades/:pair    — Get recent trades
 * GET /api/v1/market/ticker/:pair    — Get 24hr ticker
 *
 * These are public (no auth required) for frontend display.
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { MatchingEngine } from '../services/matching-engine.js';
import { getDb } from '../db/index.js';
import { OrderBookSchema, RecentTradesSchema } from '../schemas/order.js';

export default async function marketRoutes(fastify: FastifyInstance) {
  const engine = new MatchingEngine(getDb(), fastify.customMetrics);

  // ── GET /market/pairs — List trading pairs ──
  fastify.get('/market/pairs', async (_request: FastifyRequest, reply: FastifyReply) => {
    const pairs = await engine.listPairs();

    return reply.send({
      success: true,
      data: pairs,
      timestamp: Date.now(),
    });
  });

  // ── GET /market/orderbook/:pair — Order book ──
  fastify.get(
    '/market/orderbook/:pair',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { pair } = request.params as { pair: string };
      const query = OrderBookSchema.parse({ ...(request.query as Record<string, unknown>), pair });

      const orderBook = await engine.getOrderBook(pair, query.depth);

      return reply.send({
        success: true,
        data: orderBook,
        timestamp: Date.now(),
      });
    },
  );

  // ── GET /market/trades/:pair — Recent trades ──
  fastify.get(
    '/market/trades/:pair',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { pair } = request.params as { pair: string };
      const query = RecentTradesSchema.parse({ ...(request.query as Record<string, unknown>), pair });

      const trades = await engine.getRecentTrades(pair, query.limit);

      return reply.send({
        success: true,
        data: trades,
        timestamp: Date.now(),
      });
    },
  );

  // ── GET /market/ticker/:pair — 24hr ticker ──
  fastify.get(
    '/market/ticker/:pair',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { pair } = request.params as { pair: string };

      const ticker = await engine.getTicker(pair);

      return reply.send({
        success: true,
        data: ticker,
        timestamp: Date.now(),
      });
    },
  );
}