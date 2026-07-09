/**
 * NovaBit Exchange — Staking Routes
 *
 * GET    /api/v1/staking/products              — List available staking products
 * GET    /api/v1/staking/products/:id          — Single product details
 * POST   /api/v1/staking/stake                 — Stake an amount
 * POST   /api/v1/staking/unstake               — Request unstake
 * GET    /api/v1/staking/positions             — User's active stakes
 * GET    /api/v1/staking/rewards               — User's reward history
 * POST   /api/v1/staking/rewards/claim         — Claim pending rewards
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { StakingService } from '../services/staking.js';
import { getDb } from '../db/index.js';
import {
  StakeInputSchema,
  UnstakeInputSchema,
  ClaimRewardsInputSchema,
} from '../schemas/staking.js';

export default async function stakingRoutes(fastify: FastifyInstance) {
  const stakingService = new StakingService(getDb());

  // Require auth on all staking routes
  fastify.addHook('preHandler', fastify.authenticate);

  // ── GET /staking/products — List products ──────
  fastify.get('/staking/products', async (_request: FastifyRequest, reply: FastifyReply) => {
    const products = await stakingService.listProducts();

    return reply.send({
      success: true,
      data: products,
      timestamp: Date.now(),
    });
  });

  // ── GET /staking/products/:id — Single product ──
  fastify.get(
    '/staking/products/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const product = await stakingService.getProduct(id);

      return reply.send({
        success: true,
        data: product,
        timestamp: Date.now(),
      });
    },
  );

  // ── POST /staking/stake — Stake an amount ──────
  fastify.post('/staking/stake', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = (request.user as any).id;
    const input = StakeInputSchema.parse(request.body);

    const stake = await stakingService.stake(userId, input);

    return reply.status(201).send({
      success: true,
      data: stake,
      timestamp: Date.now(),
    });
  });

  // ── POST /staking/unstake — Request unstake ────
  fastify.post('/staking/unstake', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = (request.user as any).id;
    const input = UnstakeInputSchema.parse(request.body);

    const result = await stakingService.unstake(userId, input.stake_id);

    return reply.send({
      success: true,
      data: result,
      timestamp: Date.now(),
    });
  });

  // ── GET /staking/positions — User's stakes ─────
  fastify.get('/staking/positions', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = (request.user as any).id;
    const positions = await stakingService.listPositions(userId);

    return reply.send({
      success: true,
      data: positions,
      timestamp: Date.now(),
    });
  });

  // ── GET /staking/rewards — Reward history ───────
  fastify.get('/staking/rewards', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = (request.user as any).id;
    const rewards = await stakingService.listRewards(userId);

    return reply.send({
      success: true,
      data: rewards,
      timestamp: Date.now(),
    });
  });

  // ── POST /staking/rewards/claim — Claim rewards ─
  fastify.post('/staking/rewards/claim', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = (request.user as any).id;
    const input = ClaimRewardsInputSchema.parse(request.body);

    const result = await stakingService.claimRewards(userId, input);

    return reply.send({
      success: true,
      data: result,
      timestamp: Date.now(),
    });
  });
}