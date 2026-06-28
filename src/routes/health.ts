/**
 * NovaBit Exchange — Health Check Routes
 *
 * Provides monitoring endpoints for uptime and dependency health.
 */

import { FastifyInstance } from 'fastify';
import { getDb, getRedis } from '../db/index.js';

export default async function healthRoutes(fastify: FastifyInstance) {
  // ── Basic health check ─────────────────────
  fastify.get('/health', async (_request, _reply) => {
    return {
      success: true,
      data: {
        status: 'ok',
        uptime: process.uptime(),
        timestamp: Date.now(),
      },
    };
  });

  // ── Full dependency health check ───────────
  fastify.get('/health/ready', async (_request, reply) => {
    const checks: Record<string, string> = {};

    // PostgreSQL
    try {
      const db = getDb();
      await db.query('SELECT 1');
      checks.postgresql = 'ok';
    } catch {
      checks.postgresql = 'error';
    }

    // Redis
    try {
      const redis = getRedis();
      await redis.ping();
      checks.redis = 'ok';
    } catch {
      checks.redis = 'error';
    }

    const allOk = Object.values(checks).every((s) => s === 'ok');

    const statusCode = allOk ? 200 : 503;
    return reply.status(statusCode).send({
      success: allOk,
      data: {
        status: allOk ? 'ok' : 'degraded',
        checks,
        uptime: process.uptime(),
        timestamp: Date.now(),
      },
    });
  });
}