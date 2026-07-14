/**
 * NovaBit Exchange — API Routes Index
 *
 * Registers all route modules on the Fastify instance.
 */

import { FastifyInstance } from 'fastify';

export default async function registerRoutes(fastify: FastifyInstance) {
  // Health check routes
  await fastify.register(import('./health.js'), { prefix: '/api/v1' });

  // Auth routes — register, login, 2FA, tokens
  await fastify.register(import('./auth.js'), { prefix: '/api/v1' });

  // Wallet & transaction routes — balances, deposits, withdrawals
  await fastify.register(import('./wallet.js'), { prefix: '/api/v1' });

  // Order routes — create, cancel, list orders
  await fastify.register(import('./orders.js'), { prefix: '/api/v1' });

  // Market data routes — order book, trades, tickers (public)
  await fastify.register(import('./market.js'), { prefix: '/api/v1' });

  // Admin routes — withdrawal queue, user management
  await fastify.register(import('./admin.js'), { prefix: '/api/v1' });

  // Staking routes — products, stakes, rewards
  await fastify.register(import('./staking.js'), { prefix: '/api/v1' });

  // KYC routes — compliance verification
  await fastify.register(import('./kyc.js'), { prefix: '/api/v1' });
}