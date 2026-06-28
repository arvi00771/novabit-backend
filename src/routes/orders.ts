/**
 * NovaBit Exchange — Order Routes
 *
 * POST   /api/v1/orders          — Create limit/market/stop order
 * DELETE /api/v1/orders/:id      — Cancel order
 * GET    /api/v1/orders          — List user orders
 * GET    /api/v1/orders/:id      — Get order details
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { MatchingEngine } from '../services/matching-engine.js';
import { getDb } from '../db/index.js';
import { CreateOrderSchema, ListOrdersSchema } from '../schemas/order.js';

export default async function orderRoutes(fastify: FastifyInstance) {
  const engine = new MatchingEngine(getDb(), fastify.customMetrics);

  // Require auth on all order routes
  fastify.addHook('preHandler', fastify.authenticate);

  // ── POST /orders — Create order ────────────
  fastify.post(
    '/orders',
    {
      config: {
        rateLimit: {
          max: 50,
          timeWindow: 60 * 1000,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request.user as any).id;
      const input = CreateOrderSchema.parse(request.body);

      const order = await engine.createOrder(userId, input);

      return reply.status(201).send({
        success: true,
        data: order,
        timestamp: Date.now(),
      });
    },
  );

  // ── DELETE /orders/:id — Cancel order ─────
  fastify.delete(
    '/orders/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request.user as any).id;
      const { id } = request.params as { id: string };

      await engine.cancelOrder(userId, id);

      return reply.send({
        success: true,
        data: { message: 'Order cancelled successfully' },
        timestamp: Date.now(),
      });
    },
  );

  // ── GET /orders — List user orders ────────
  fastify.get(
    '/orders',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request.user as any).id;
      const query = ListOrdersSchema.parse(request.query);

      const result = await engine.listOrders(userId, query);

      return reply.send({
        success: true,
        data: result.orders,
        meta: {
          total: result.total,
          limit: query.limit,
          offset: query.offset,
        },
        timestamp: Date.now(),
      });
    },
  );

  // ── GET /orders/:id — Get order details ──
  fastify.get(
    '/orders/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request.user as any).id;
      const { id } = request.params as { id: string };

      const order = await engine.getOrder(id, userId);

      return reply.send({
        success: true,
        data: order,
        timestamp: Date.now(),
      });
    },
  );
}