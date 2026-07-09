/**
 * NovaBit Exchange — Admin Routes
 *
 * GET    /api/v1/admin/withdrawals              — List pending withdrawal requests
 * POST   /api/v1/admin/withdrawals/:id/approve  — Approve withdrawal
 * POST   /api/v1/admin/withdrawals/:id/reject   — Reject withdrawal
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { DepositService } from '../services/deposit.js';
import { StakingService } from '../services/staking.js';
import { KYCService } from '../services/kyc.js';
import { AuditService } from '../services/audit.js';
import { getDb } from '../db/index.js';
import { requireRole } from '../middleware/auth-guard.js';
import { z } from 'zod';
import {
  CreateStakingProductSchema,
  UpdateStakingProductSchema,
} from '../schemas/staking.js';
import {
  KYCRejectSchema,
} from '../schemas/kyc.js';

const RejectSchema = z.object({
  reason: z.string().max(500).optional(),
});

export default async function adminRoutes(fastify: FastifyInstance) {
  const depositService = new DepositService(getDb());
  const stakingService = new StakingService(getDb());
  const kycService = new KYCService(getDb());
  const auditService = new AuditService(getDb());

  // Require auth + ADMIN role on all admin routes
  fastify.addHook('preHandler', fastify.authenticate);
  fastify.addHook('preHandler', requireRole('ADMIN'));

  // ── GET /admin/withdrawals — Pending queue ──
  fastify.get('/admin/withdrawals', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { limit?: string; offset?: string; status?: string };
    const limit = Math.min(parseInt(query.limit || '20', 10), 100);
    const offset = parseInt(query.offset || '0', 10);

    const result = await depositService.listPendingWithdrawals({ limit, offset, status: query.status });

    return reply.send({
      success: true,
      data: result.withdrawals,
      meta: { total: result.total, limit, offset },
      timestamp: Date.now(),
    });
  });

  // ── POST /admin/withdrawals/:id/approve ─────
  fastify.post(
    '/admin/withdrawals/:id/approve',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const adminId = (request.user as any).id;
      const { id } = request.params as { id: string };

      await depositService.approveWithdrawal(id, adminId);

      return reply.send({
        success: true,
        data: { message: 'Withdrawal approved and queued for processing' },
        timestamp: Date.now(),
      });
    },
  );

  // ── POST /admin/withdrawals/:id/reject ──────
  fastify.post(
    '/admin/withdrawals/:id/reject',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const adminId = (request.user as any).id;
      const { id } = request.params as { id: string };
      const body = RejectSchema.parse(request.body || {});

      await depositService.rejectWithdrawal(id, adminId, body.reason);

      return reply.send({
        success: true,
        data: { message: 'Withdrawal rejected and funds released' },
        timestamp: Date.now(),
      });
    },
  );

  // ══════════════════════════════════════════════
  // ADMIN STAKING ENDPOINTS
  // ══════════════════════════════════════════════

  // ── GET /admin/staking/summary — Staking overview ──
  fastify.get('/admin/staking/summary', async (_request: FastifyRequest, reply: FastifyReply) => {
    const summary = await stakingService.getAdminSummary();

    return reply.send({
      success: true,
      data: summary,
      timestamp: Date.now(),
    });
  });

  // ── POST /admin/staking/products — Create product ──
  fastify.post('/admin/staking/products', async (request: FastifyRequest, reply: FastifyReply) => {
    const input = CreateStakingProductSchema.parse(request.body);
    const product = await stakingService.createProduct(input);

    return reply.status(201).send({
      success: true,
      data: product,
      timestamp: Date.now(),
    });
  });

  // ── PUT /admin/staking/products/:id — Update product ──
  fastify.put(
    '/admin/staking/products/:id',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { id } = request.params as { id: string };
      const input = UpdateStakingProductSchema.parse(request.body);
      const product = await stakingService.updateProduct(id, input);

      return reply.send({
        success: true,
        data: product,
        timestamp: Date.now(),
      });
    },
  );

  // ── POST /admin/staking/distribute — Trigger reward distribution ──
  fastify.post('/admin/staking/distribute', async (_request: FastifyRequest, reply: FastifyReply) => {
    const result = await stakingService.distributeRewards();

    return reply.send({
      success: true,
      data: result,
      timestamp: Date.now(),
    });
  });

  // ══════════════════════════════════════════════
  // ADMIN KYC ENDPOINTS
  // ══════════════════════════════════════════════

  // ── GET /admin/kyc/pending — List pending KYC submissions ──
  fastify.get('/admin/kyc/pending', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { limit?: string; offset?: string };
    const limit = Math.min(parseInt(query.limit || '20', 10), 100);
    const offset = parseInt(query.offset || '0', 10);

    const result = await kycService.listPendingKYC({ limit, offset });

    return reply.send({
      success: true,
      data: result.submissions,
      meta: { total: result.total, limit, offset },
      timestamp: Date.now(),
    });
  });

  // ── POST /admin/kyc/:userId/approve — Approve KYC ──
  fastify.post(
    '/admin/kyc/:userId/approve',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const adminId = (request.user as any).id;
      const { userId } = request.params as { userId: string };

      const result = await kycService.approveKYC(userId, adminId);

      // Audit log
      await auditService.logKYCApproval(userId, adminId, request.ip);

      return reply.send({
        success: true,
        data: result,
        timestamp: Date.now(),
      });
    },
  );

  // ── POST /admin/kyc/:userId/reject — Reject KYC ──
  fastify.post(
    '/admin/kyc/:userId/reject',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const adminId = (request.user as any).id;
      const { userId } = request.params as { userId: string };
      const body = KYCRejectSchema.parse(request.body);

      const result = await kycService.rejectKYC(userId, adminId, body.reason);

      // Audit log
      await auditService.logKYCRejection(userId, adminId, body.reason, request.ip);

      return reply.send({
        success: true,
        data: result,
        timestamp: Date.now(),
      });
    },
  );
}