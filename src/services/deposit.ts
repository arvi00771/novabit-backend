/**
 * NovaBit Exchange — Crypto Deposit & Withdrawal System
 *
 * Enhances the existing wallet system with:
 * - Deposit info (address + min amount + confirmations)
 * - Supported coins metadata
 * - Admin withdrawal approval queue
 * - Mock blockchain watcher (auto-confirms deposits)
 */

import pg from 'pg';
import crypto from 'node:crypto';
import { AppError } from '../middleware/error-handler.js';
import {
  DepositInfoResponse,
  SupportedCoinResponse,
} from '../schemas/wallet.js';

export class DepositService {
  constructor(private db: pg.Pool) {}

  // ── Get deposit info for an asset ────────────
  async getDepositInfo(userId: string, asset: string, network?: string): Promise<DepositInfoResponse> {
    const assetUpper = asset.toUpperCase();
    const networkVal = network || assetUpper;

    // Get coin metadata
    const coinResult = await this.db.query(
      `SELECT name, min_deposit_amount, required_confirmations, deposit_enabled
       FROM supported_coins WHERE asset = $1 AND is_active = TRUE LIMIT 1`,
      [assetUpper],
    );

    if (coinResult.rows.length === 0) {
      throw new AppError(400, 'UNSUPPORTED_COIN', `${assetUpper} is not supported for deposits`);
    }

    const coin = coinResult.rows[0];
    if (!coin.deposit_enabled) {
      throw new AppError(400, 'DEPOSITS_DISABLED', `Deposits for ${assetUpper} are currently disabled`);
    }

    // Ensure wallet exists
    await this.ensureWallet(userId, assetUpper);

    // Get or generate deposit address
    const walletResult = await this.db.query(
      `SELECT id FROM wallets WHERE user_id = $1 AND asset = $2 AND wallet_type = 'SPOT' LIMIT 1`,
      [userId, assetUpper],
    );

    const walletId = walletResult.rows[0].id;

    // Check existing address
    const existingAddr = await this.db.query(
      `SELECT address, network, memo FROM deposit_addresses
       WHERE wallet_id = $1 AND user_id = $2 AND network = $3 AND is_active = TRUE LIMIT 1`,
      [walletId, userId, networkVal],
    );

    if (existingAddr.rows.length > 0) {
      return {
        address: existingAddr.rows[0].address,
        network: existingAddr.rows[0].network,
        memo: existingAddr.rows[0].memo || null,
        asset: assetUpper,
        min_deposit_amount: String(coin.min_deposit_amount),
        required_confirmations: coin.required_confirmations,
        coin_name: coin.name,
      };
    }

    // Generate unique deposit address per user per coin
    const { address, memo } = this.generateDepositAddress(assetUpper, networkVal, userId);

    await this.db.query(
      `INSERT INTO deposit_addresses (wallet_id, user_id, asset, address, network, memo, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE)`,
      [walletId, userId, assetUpper, address, networkVal, memo],
    );

    // Update wallet with deposit address
    await this.db.query(
      `UPDATE wallets SET address = $1 WHERE id = $2 AND address IS NULL`,
      [address, walletId],
    );

    return {
      address,
      network: networkVal,
      memo,
      asset: assetUpper,
      min_deposit_amount: String(coin.min_deposit_amount),
      required_confirmations: coin.required_confirmations,
      coin_name: coin.name,
    };
  }

  // ── List supported coins ─────────────────────
  async listSupportedCoins(): Promise<SupportedCoinResponse[]> {
    const result = await this.db.query(
      `SELECT asset, name, network, is_active, min_deposit_amount,
              min_withdrawal_amount, withdrawal_fee, withdrawal_fee_type,
              required_confirmations, deposit_enabled, withdrawal_enabled,
              withdrawal_requires_2fa
       FROM supported_coins
       WHERE is_active = TRUE
       ORDER BY asset ASC`,
    );

    return result.rows.map((r: Record<string, unknown>) => ({
      asset: r.asset as string,
      name: r.name as string,
      network: r.network as string,
      is_active: r.is_active as boolean,
      min_deposit_amount: String(r.min_deposit_amount),
      min_withdrawal_amount: String(r.min_withdrawal_amount),
      withdrawal_fee: String(r.withdrawal_fee),
      withdrawal_fee_type: r.withdrawal_fee_type as string,
      required_confirmations: r.required_confirmations as number,
      deposit_enabled: r.deposit_enabled as boolean,
      withdrawal_enabled: r.withdrawal_enabled as boolean,
      withdrawal_requires_2fa: r.withdrawal_requires_2fa as boolean,
    }));
  }

  // ── Get coin metadata ────────────────────────
  async getCoinInfo(asset: string): Promise<SupportedCoinResponse> {
    const result = await this.db.query(
      `SELECT * FROM supported_coins WHERE asset = $1 AND is_active = TRUE LIMIT 1`,
      [asset.toUpperCase()],
    );

    if (result.rows.length === 0) {
      throw new AppError(404, 'COIN_NOT_FOUND', `Coin ${asset.toUpperCase()} is not supported`);
    }

    const r = result.rows[0];
    return {
      asset: r.asset,
      name: r.name,
      network: r.network,
      is_active: r.is_active,
      min_deposit_amount: String(r.min_deposit_amount),
      min_withdrawal_amount: String(r.min_withdrawal_amount),
      withdrawal_fee: String(r.withdrawal_fee),
      withdrawal_fee_type: r.withdrawal_fee_type,
      required_confirmations: r.required_confirmations,
      deposit_enabled: r.deposit_enabled,
      withdrawal_enabled: r.withdrawal_enabled,
      withdrawal_requires_2fa: r.withdrawal_requires_2fa,
    };
  }

  // ── Admin: List pending withdrawals ──────────
  async listPendingWithdrawals(options: {
    limit: number;
    offset: number;
    status?: string;
  }): Promise<{ withdrawals: Record<string, unknown>[]; total: number }> {
    const conditions: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (options.status) {
      conditions.push(`w.status = $${paramIdx++}`);
      params.push(options.status);
    } else {
      conditions.push(`w.status IN ('PENDING', 'APPROVED')`);
    }

    const where = conditions.join(' AND ');

    const countResult = await this.db.query(
      `SELECT COUNT(*) FROM withdrawals w WHERE ${where}`,
      params,
    );
    const total = parseInt(countResult.rows[0].count, 10);

    params.push(options.limit, options.offset);
    const result = await this.db.query(
      `SELECT w.id, w.user_id, w.asset, w.amount, w.fee, w.network,
              w.to_address, w.status, w.created_at, u.email as user_email
       FROM withdrawals w
       JOIN users u ON u.id = w.user_id
       WHERE ${where}
       ORDER BY w.created_at ASC
       LIMIT $${paramIdx++} OFFSET $${paramIdx}`,
      params,
    );

    return {
      withdrawals: result.rows.map((r: Record<string, unknown>) => ({
        id: r.id,
        user_id: r.user_id,
        user_email: r.user_email,
        asset: r.asset,
        amount: String(r.amount),
        fee: String(r.fee),
        network: r.network,
        to_address: r.to_address,
        status: r.status,
        created_at: (r.created_at as Date).toISOString(),
      })),
      total,
    };
  }

  // ── Admin: Approve withdrawal ────────────────
  async approveWithdrawal(withdrawalId: string, adminId: string): Promise<void> {
    const withdrawal = await this.db.query(
      `SELECT id, status, wallet_id, amount FROM withdrawals WHERE id = $1`,
      [withdrawalId],
    );

    if (withdrawal.rows.length === 0) {
      throw new AppError(404, 'WITHDRAWAL_NOT_FOUND', 'Withdrawal not found');
    }

    const wd = withdrawal.rows[0];
    if (wd.status !== 'PENDING') {
      throw new AppError(400, 'INVALID_STATUS', `Cannot approve withdrawal with status '${wd.status}'`);
    }

    await this.db.query(
      `UPDATE withdrawals SET status = 'APPROVED', approved_by = $1, reviewed_at = NOW()
       WHERE id = $2`,
      [adminId, withdrawalId],
    );
  }

  // ── Admin: Reject withdrawal ───────────────
  async rejectWithdrawal(withdrawalId: string, adminId: string, reason?: string): Promise<void> {
    const withdrawal = await this.db.query(
      `SELECT id, status, wallet_id, amount, user_id FROM withdrawals WHERE id = $1`,
      [withdrawalId],
    );

    if (withdrawal.rows.length === 0) {
      throw new AppError(404, 'WITHDRAWAL_NOT_FOUND', 'Withdrawal not found');
    }

    const wd = withdrawal.rows[0];
    if (wd.status !== 'PENDING') {
      throw new AppError(400, 'INVALID_STATUS', `Cannot reject withdrawal with status '${wd.status}'`);
    }

    await this.db.query('BEGIN');
    try {
      // Release locked balance
      await this.db.query(
        `UPDATE wallets SET locked_balance = GREATEST(locked_balance - $1, 0) WHERE id = $2`,
        [wd.amount, wd.wallet_id],
      );

      // Update withdrawal status
      await this.db.query(
        `UPDATE withdrawals SET status = 'FAILED', approved_by = $1, reviewed_at = NOW(),
         approval_note = $2 WHERE id = $3`,
        [adminId, reason || null, withdrawalId],
      );

      await this.db.query('COMMIT');
    } catch (err) {
      await this.db.query('ROLLBACK');
      throw err;
    }
  }

  // ── Private helpers ──────────────────────────

  private async ensureWallet(userId: string, asset: string): Promise<void> {
    const existing = await this.db.query(
      `SELECT id FROM wallets WHERE user_id = $1 AND asset = $2 AND wallet_type = 'SPOT' LIMIT 1`,
      [userId, asset],
    );

    if (existing.rows.length === 0) {
      await this.db.query(
        `INSERT INTO wallets (user_id, asset, wallet_type, balance, locked_balance)
         VALUES ($1, $2, 'SPOT', 0, 0)`,
        [userId, asset],
      );
    }
  }

  private generateDepositAddress(asset: string, network: string, userId: string): { address: string; memo: string | null } {
    // In production, this would derive from an HD wallet seed
    // For dev, generate deterministic unique addresses per user
    const hash = crypto.createHash('sha256').update(`${asset}:${userId}:novabit`).digest('hex');

    const prefixes: Record<string, string> = {
      BTC: 'bc1q',
      ETH: '0x',
      ERC20: '0x',
      SOL: '',
      ADA: 'addr1',
      XRP: 'r',
      DOT: '1',
    };

    const prefix = prefixes[asset] || prefixes[network] || '';
    const address = `${prefix}${hash.substring(0, 34)}`;

    // Some networks require a memo/destination tag
    const needsMemo = ['XRP', 'EOS', 'XLM', 'ATOM'].includes(asset);
    const memo = needsMemo ? crypto.randomInt(100000, 999999).toString() : null;

    return { address, memo };
  }
}

/**
 * Mock Blockchain Watcher
 *
 * Background process that simulates blockchain confirmations.
 * In production, this would connect to node RPC or a block explorer API.
 * Runs every 30 seconds, checking for unconfirmed deposits.
 */
export class MockBlockchainWatcher {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private db: pg.Pool) {}

  start(): void {
    if (this.running) return;
    this.running = true;

    console.log('[BlockchainWatcher] Starting mock watcher (checking every 30s)...');

    this.intervalId = setInterval(async () => {
      try {
        await this.checkDeposits();
      } catch (err) {
        console.error('[BlockchainWatcher] Error:', err);
      }
    }, 30_000);

    // Also run immediately
    this.checkDeposits().catch((err) => console.error('[BlockchainWatcher] Initial check error:', err));
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.running = false;
    console.log('[BlockchainWatcher] Stopped.');
  }

  private async checkDeposits(): Promise<void> {
    // Find deposits that are pending or confirming
    const pendingDeposits = await this.db.query(
      `SELECT d.id, d.amount, d.confirmations, d.required_confirmations,
              d.asset, d.user_id, d.wallet_id, d.tx_hash
       FROM deposits d
       WHERE d.status IN ('PENDING', 'CONFIRMING')
       ORDER BY d.created_at ASC
       LIMIT 50`,
    );

    for (const deposit of pendingDeposits.rows) {
      // Mock: increment confirmations
      const newConfirmations = (deposit.confirmations || 0) + 1;
      const required = deposit.required_confirmations || 1;

      if (newConfirmations >= required) {
        // Mark as completed
        await this.db.query(
          `UPDATE deposits SET status = 'COMPLETED', confirmations = $1,
           completed_at = NOW(), updated_at = NOW()
           WHERE id = $2`,
          [newConfirmations, deposit.id],
        );

        // Credit the user's wallet balance
        await this.db.query(
          `UPDATE wallets SET balance = balance + $1, updated_at = NOW()
           WHERE id = $2`,
          [deposit.amount, deposit.wallet_id],
        );

        // Create transaction record
        await this.db.query(
          `INSERT INTO transactions (user_id, wallet_id, type, status, asset, amount,
                                     fee, tx_hash, source_address)
           VALUES ($1, $2, 'DEPOSIT', 'CONFIRMED', $3, $4, 0, $5, $6)`,
          [
            deposit.user_id,
            deposit.wallet_id,
            deposit.asset,
            deposit.amount,
            deposit.tx_hash,
            'blockchain_mock',
          ],
        );

        console.log(`[BlockchainWatcher] ✅ Deposit ${deposit.id} confirmed! Credited ${deposit.amount} ${deposit.asset} to user ${deposit.user_id}`);
      } else {
        // Update confirmations
        await this.db.query(
          `UPDATE deposits SET confirmations = $1, status = 'CONFIRMING', updated_at = NOW()
           WHERE id = $2`,
          [newConfirmations, deposit.id],
        );

        console.log(`[BlockchainWatcher] ⏳ Deposit ${deposit.id}: ${newConfirmations}/${required} confirmations`);
      }
    }
  }
}