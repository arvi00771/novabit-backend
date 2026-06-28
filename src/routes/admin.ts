/**
 * NovaBit Exchange — Admin Routes
 *
 * GET    /api/v1/admin/withdrawals              — List pending withdrawal requests
 * POST   /api/v1/admin/withdrawals/:id/approve  — Approve withdrawal
 * POST   /api/v1/admin/withdrawals/:id/reject   — Reject withdrawal
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { DepositService } from '../services/deposit.js';
import { getDb } from '../db/index.js';
import { requireRole } from '../middleware/auth-guard.js';
import { z } from 'zod';

const RejectSchema = z.object({
  reason: z.string().max(500).optional(),
});

export default async function adminRoutes(fastify: FastifyInstance) {
  const depositService = new DepositService(getDb());

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
}