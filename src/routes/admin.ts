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

  // ══════════════════════════════════════════════
  // ADMIN DASHBOARD & USER MANAGEMENT
  // ══════════════════════════════════════════════

  // ── GET /admin/dashboard — Stats overview ────
  fastify.get('/admin/dashboard', async (_request: FastifyRequest, reply: FastifyReply) => {
    const db = getDb();

    const [
      totalUsers,
      verifiedUsers,
      pendingKyc,
      deposits24h,
      withdrawals24h,
      tradingVolume24h,
      activeUsers24h,
      pendingWithdrawals,
      totalStaked,
      totalStakers,
    ] = await Promise.all([
      db.query(`SELECT COUNT(*) as count FROM users`),
      db.query(`SELECT COUNT(*) as count FROM users WHERE kyc_status = 'VERIFIED'`),
      db.query(`SELECT COUNT(*) as count FROM users WHERE kyc_status = 'PENDING'`),
      db.query(
        `SELECT COALESCE(SUM(amount), 0) as total FROM deposits
         WHERE status = 'COMPLETED' AND created_at > NOW() - INTERVAL '24 hours'`,
      ),
      db.query(
        `SELECT COALESCE(SUM(amount), 0) as total FROM withdrawals
         WHERE status IN ('COMPLETED', 'APPROVED') AND created_at > NOW() - INTERVAL '24 hours'`,
      ),
      db.query(
        `SELECT COALESCE(SUM(quote_quantity), 0) as total FROM trades
         WHERE trade_time > NOW() - INTERVAL '24 hours'`,
      ),
      db.query(
        `SELECT COUNT(DISTINCT u.id) as count FROM users u
         WHERE u.last_login_at > NOW() - INTERVAL '24 hours'
            OR u.id IN (SELECT DISTINCT user_id FROM trades WHERE trade_time > NOW() - INTERVAL '24 hours')`,
      ),
      db.query(`SELECT COUNT(*) as count FROM withdrawals WHERE status = 'PENDING'`),
      db.query(
        `SELECT COALESCE(SUM(amount), 0) as total FROM stakes WHERE status = 'ACTIVE'`,
      ),
      db.query(
        `SELECT COUNT(DISTINCT user_id) as count FROM stakes WHERE status = 'ACTIVE'`,
      ),
    ]);

    return reply.send({
      success: true,
      data: {
        total_users: parseInt(totalUsers.rows[0].count, 10),
        verified_users: parseInt(verifiedUsers.rows[0].count, 10),
        pending_kyc: parseInt(pendingKyc.rows[0].count, 10),
        total_deposits_24h: String(deposits24h.rows[0].total),
        total_withdrawals_24h: String(withdrawals24h.rows[0].total),
        total_trading_volume_24h: String(tradingVolume24h.rows[0].total),
        active_users_24h: parseInt(activeUsers24h.rows[0].count, 10),
        pending_withdrawals: parseInt(pendingWithdrawals.rows[0].count, 10),
        total_staked: String(totalStaked.rows[0].total),
        total_stakers: parseInt(totalStakers.rows[0].count, 10),
      },
      timestamp: Date.now(),
    });
  });

  // ── GET /admin/users — List users ────────────
  fastify.get('/admin/users', async (request: FastifyRequest, reply: FastifyReply) => {
    const query = request.query as { limit?: string; offset?: string; search?: string };
    const limit = Math.min(parseInt(query.limit || '20', 10), 100);
    const offset = parseInt(query.offset || '0', 10);
    const search = query.search || '';

    const db = getDb();

    let countQuery: string;
    let dataQuery: string;
    const params: unknown[] = [];

    if (search) {
      countQuery = `SELECT COUNT(*) FROM users WHERE email ILIKE $1`;
      dataQuery = `
        SELECT id, email, role, kyc_status, is_active, is_2fa_enabled,
               last_login_at, created_at
        FROM users
        WHERE email ILIKE $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `;
      params.push(`%${search}%`, limit, offset);
    } else {
      countQuery = `SELECT COUNT(*) FROM users`;
      dataQuery = `
        SELECT id, email, role, kyc_status, is_active, is_2fa_enabled,
               last_login_at, created_at
        FROM users
        ORDER BY created_at DESC
        LIMIT $1 OFFSET $2
      `;
      params.push(limit, offset);
    }

    const countResult = await db.query(countQuery, search ? [`%${search}%`] : []);
    const total = parseInt(countResult.rows[0].count, 10);

    const usersResult = await db.query(dataQuery, params);

    return reply.send({
      success: true,
      data: usersResult.rows.map((r: Record<string, unknown>) => ({
        id: r.id,
        email: r.email,
        role: r.role,
        kyc_status: r.kyc_status,
        is_active: r.is_active,
        is_2fa_enabled: r.is_2fa_enabled,
        last_login_at: r.last_login_at ? (r.last_login_at as Date).toISOString() : null,
        created_at: (r.created_at as Date).toISOString(),
      })),
      meta: { total, limit, offset, search },
      timestamp: Date.now(),
    });
  });

  // ── POST /admin/users/:userId/toggle-active ──
  fastify.post(
    '/admin/users/:userId/toggle-active',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { userId } = request.params as { userId: string };

      const db = getDb();
      const userResult = await db.query(
        `SELECT id, is_active FROM users WHERE id = $1`,
        [userId],
      );

      if (userResult.rows.length === 0) {
        return reply.status(404).send({
          success: false,
          error: { code: 'USER_NOT_FOUND', message: 'User not found' },
          timestamp: Date.now(),
        });
      }

      const currentStatus = userResult.rows[0].is_active;
      await db.query(
        `UPDATE users SET is_active = $1, updated_at = NOW() WHERE id = $2`,
        [!currentStatus, userId],
      );

      return reply.send({
        success: true,
        data: {
          user_id: userId,
          is_active: !currentStatus,
          message: `User ${!currentStatus ? 'enabled' : 'disabled'} successfully`,
        },
        timestamp: Date.now(),
      });
    },
  );
}