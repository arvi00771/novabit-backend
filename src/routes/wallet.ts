/**
 * NovaBit Exchange — Wallet & Transaction Routes
 *
 * GET    /api/v1/wallets              — List all wallets (balances)
 * GET    /api/v1/wallets/:asset       — Get specific wallet
 * GET    /api/v1/wallets/deposit/address/:asset  — Get deposit address
 * POST   /api/v1/wallets/withdraw     — Submit withdrawal
 * GET    /api/v1/wallets/withdrawals  — List withdrawal history
 * GET    /api/v1/transactions         — List transaction history
 * POST   /api/v1/wallets/withdraw/:id/cancel — Cancel pending withdrawal
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { WalletService } from '../services/wallet.js';
import { DepositService } from '../services/deposit.js';
import { getDb } from '../db/index.js';
import { AppError } from '../middleware/error-handler.js';
import {
  CreateWithdrawalSchema,
  TransactionQuerySchema,
  WithdrawalQuerySchema,
} from '../schemas/wallet.js';

export default async function walletRoutes(fastify: FastifyInstance) {
  const walletService = new WalletService(getDb());
  const depositService = new DepositService(getDb());

  // Require auth on all wallet routes
  fastify.addHook('preHandler', fastify.authenticate);

  // ── GET /wallets — List all wallets ─────────
  fastify.get('/wallets', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = (request.user as any).id;
    const wallets = await walletService.listWallets(userId);

    return reply.send({
      success: true,
      data: wallets,
      timestamp: Date.now(),
    });
  });

  // ── GET /wallets/:asset — Get specific wallet ──
  fastify.get('/wallets/:asset', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = (request.user as any).id;
    const { asset } = request.params as { asset: string };
    const wallet = await walletService.getWallet(userId, asset);

    return reply.send({
      success: true,
      data: wallet,
      timestamp: Date.now(),
    });
  });

  // ── GET /wallets/deposit/:asset — Enhanced deposit info ──
  fastify.get(
    '/wallets/deposit/:asset',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request.user as any).id;
      const { asset } = request.params as { asset: string };
      const network = (request.query as any)?.network;

      const depositInfo = await depositService.getDepositInfo(userId, asset, network);

      return reply.send({
        success: true,
        data: depositInfo,
        timestamp: Date.now(),
      });
    },
  );

  // ── GET /wallets/coins — List supported coins ──
  fastify.get('/wallets/coins', async (_request: FastifyRequest, reply: FastifyReply) => {
    const coins = await depositService.listSupportedCoins();

    return reply.send({
      success: true,
      data: coins,
      timestamp: Date.now(),
    });
  });

  // ── GET /wallets/coins/:asset — Coin info ──
  fastify.get('/wallets/coins/:asset', async (request: FastifyRequest, reply: FastifyReply) => {
    const { asset } = request.params as { asset: string };
    const coin = await depositService.getCoinInfo(asset);

    return reply.send({
      success: true,
      data: coin,
      timestamp: Date.now(),
    });
  });

  // ── GET /wallets/deposit/address/:asset — Get deposit address ──
  fastify.get(
    '/wallets/deposit/address/:asset',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request.user as any).id;
      const { asset } = request.params as { asset: string };
      const network = (request.query as any)?.network || asset.toUpperCase();

      const depositInfo = await walletService.getDepositAddress(userId, asset, network);

      return reply.send({
        success: true,
        data: depositInfo,
        timestamp: Date.now(),
      });
    },
  );

  // ── POST /wallets/withdraw — Submit withdrawal ──
  fastify.post('/wallets/withdraw', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = (request.user as any).id;
    const input = CreateWithdrawalSchema.parse(request.body);

    const result = await walletService.createWithdrawal(userId, input, request.ip);

    return reply.status(201).send({
      success: true,
      data: result,
      timestamp: Date.now(),
    });
  });

  // ── GET /wallets/withdrawals — List withdrawal history ──
  fastify.get('/wallets/withdrawals', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = (request.user as any).id;
    const query = WithdrawalQuerySchema.parse(request.query);

    const result = await walletService.listWithdrawals(userId, query);

    return reply.send({
      success: true,
      data: result.withdrawals,
      meta: {
        total: result.total,
        limit: query.limit,
        offset: query.offset,
      },
      timestamp: Date.now(),
    });
  });

  // ── POST /wallets/withdraw/:id/cancel — Cancel pending withdrawal ──
  fastify.post(
    '/wallets/withdraw/:id/cancel',
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request.user as any).id;
      const { id } = request.params as { id: string };

      // Find the withdrawal
      const withdrawal = await getDb().query(
        `SELECT id, status, wallet_id, amount FROM withdrawals
         WHERE id = $1 AND user_id = $2`,
        [id, userId],
      );

      if (withdrawal.rows.length === 0) {
        throw new AppError(404, 'WITHDRAWAL_NOT_FOUND', 'Withdrawal not found');
      }

      const wd = withdrawal.rows[0];
      if (wd.status !== 'PENDING') {
        throw new AppError(400, 'CANNOT_CANCEL', `Cannot cancel withdrawal with status '${wd.status}'`);
      }

      // Release locked balance
      await getDb().query(
        `UPDATE wallets SET locked_balance = locked_balance - $1 WHERE id = $2`,
        [wd.amount, wd.wallet_id],
      );

      // Update withdrawal status
      await getDb().query(
        `UPDATE withdrawals SET status = 'CANCELED' WHERE id = $1`,
        [id],
      );

      return reply.send({
        success: true,
        data: { message: 'Withdrawal cancelled successfully' },
        timestamp: Date.now(),
      });
    },
  );

  // ── GET /transactions — List transaction history ──
  fastify.get('/transactions', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = (request.user as any).id;
    const query = TransactionQuerySchema.parse(request.query);

    const result = await walletService.listTransactions(userId, query);

    return reply.send({
      success: true,
      data: result.transactions,
      meta: {
        total: result.total,
        limit: query.limit,
        offset: query.offset,
      },
      timestamp: Date.now(),
    });
  });
}