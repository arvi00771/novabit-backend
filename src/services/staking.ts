/**
 * NovaBit Exchange — Staking Service
 *
 * Handles soft staking: users lock coins internally and earn rewards
 * from exchange revenue. Supports flexible and locked staking products.
 */

import pg from 'pg';
import { AppError } from '../middleware/error-handler.js';
import {
  ClaimRewardsInput,
  CreateStakingProductInput,
  StakeInput,
  StakingProductResponse,
  StakeResponse,
  StakingRewardResponse,
  StakingSummaryResponse,
  UpdateStakingProductInput,
} from '../schemas/staking.js';

export class StakingService {
  constructor(private db: pg.Pool) {}

  // ── List available staking products ────────────
  async listProducts(): Promise<StakingProductResponse[]> {
    const result = await this.db.query(
      `SELECT id, asset, name, apy, min_stake, lock_period_days, is_active,
              created_at, updated_at
       FROM staking_products
       WHERE is_active = TRUE
       ORDER BY asset ASC, lock_period_days ASC`,
    );

    return result.rows.map(this.mapProductResponse);
  }

  // ── Get single product ─────────────────────────
  async getProduct(productId: string): Promise<StakingProductResponse> {
    const result = await this.db.query(
      `SELECT id, asset, name, apy, min_stake, lock_period_days, is_active,
              created_at, updated_at
       FROM staking_products
       WHERE id = $1`,
      [productId],
    );

    if (result.rows.length === 0) {
      throw new AppError(404, 'PRODUCT_NOT_FOUND', 'Staking product not found');
    }

    return this.mapProductResponse(result.rows[0]);
  }

  // ── Stake an amount ────────────────────────────
  async stake(userId: string, input: StakeInput): Promise<StakeResponse> {
    // Validate product exists and is active
    const product = await this.getProduct(input.product_id);
    if (!product.is_active) {
      throw new AppError(400, 'PRODUCT_INACTIVE', 'This staking product is not currently active');
    }

    const asset = product.asset;
    const amount = input.amount;

    // Validate minimum stake
    if (Number(amount) < Number(product.min_stake)) {
      throw new AppError(400, 'MIN_STAKE_NOT_MET',
        `Minimum stake is ${product.min_stake} ${asset}`);
    }

    // Find user's wallet for this asset
    const walletResult = await this.db.query(
      `SELECT id, balance, locked_balance
       FROM wallets
       WHERE user_id = $1 AND asset = $2 AND wallet_type = 'SPOT' AND is_active = TRUE
       LIMIT 1`,
      [userId, asset],
    );

    if (walletResult.rows.length === 0) {
      throw new AppError(400, 'NO_WALLET',
        `No wallet found for ${asset}. Please deposit ${asset} first.`);
    }

    const wallet = walletResult.rows[0];
    const availableBalance = Number(wallet.balance) - Number(wallet.locked_balance);

    if (Number(amount) > availableBalance) {
      throw new AppError(400, 'INSUFFICIENT_BALANCE',
        `Insufficient available balance. Available: ${availableBalance.toFixed(8)} ${asset}`);
    }

    // Calculate end date for locked stakes
    let endDate: string | null = null;
    if (product.lock_period_days > 0) {
      const end = new Date();
      end.setDate(end.getDate() + product.lock_period_days);
      endDate = end.toISOString();
    }

    // Use a transaction to ensure atomicity
    await this.db.query('BEGIN');
    try {
      // Lock the balance in the wallet
      await this.db.query(
        `UPDATE wallets
         SET locked_balance = locked_balance + $1, updated_at = NOW()
         WHERE id = $2`,
        [amount, wallet.id],
      );

      // Create the stake record
      const stakeResult = await this.db.query(
        `INSERT INTO stakes (user_id, product_id, asset, amount, apy_at_stake, status, end_date)
         VALUES ($1, $2, $3, $4, $5, 'ACTIVE', $6)
         RETURNING id, user_id, product_id, asset, amount, apy_at_stake, status,
                   start_date, end_date, created_at, updated_at`,
        [userId, input.product_id, asset, amount, product.apy, endDate],
      );

      await this.db.query('COMMIT');

      return this.mapStakeResponse(stakeResult.rows[0]);
    } catch (err) {
      await this.db.query('ROLLBACK');
      throw err;
    }
  }

  // ── Unstake ────────────────────────────────────
  async unstake(userId: string, stakeId: string): Promise<{ message: string; status: string }> {
    const stake = await this.getUserStake(userId, stakeId);

    if (stake.status !== 'ACTIVE') {
      throw new AppError(400, 'INVALID_STATUS',
        `Cannot unstake a stake with status '${stake.status}'`);
    }

    const product = await this.getProduct(stake.product_id);

    // Flexible stakes: process immediately
    if (product.lock_period_days === 0) {
      await this.db.query('BEGIN');
      try {
        // Release locked balance back to available
        await this.db.query(
          `UPDATE wallets
           SET locked_balance = GREATEST(locked_balance - $1, 0), updated_at = NOW()
           WHERE user_id = $2 AND asset = $3 AND wallet_type = 'SPOT'`,
          [stake.amount, userId, stake.asset],
        );

        // Mark stake as COMPLETED
        await this.db.query(
          `UPDATE stakes SET status = 'COMPLETED', updated_at = NOW()
           WHERE id = $1`,
          [stakeId],
        );

        await this.db.query('COMMIT');
      } catch (err) {
        await this.db.query('ROLLBACK');
        throw err;
      }

      return {
        message: `Successfully unstaked ${stake.amount} ${stake.asset}. Funds returned to your wallet.`,
        status: 'COMPLETED',
      };
    }

    // Locked stakes: set to UNSTAKING, will be released after lock period ends
    await this.db.query(
      `UPDATE stakes SET status = 'UNSTAKING', updated_at = NOW()
       WHERE id = $1`,
      [stakeId],
    );

    const endDateStr = stake.end_date
      ? new Date(stake.end_date).toLocaleDateString()
      : 'the lock period end date';

    return {
      message: `Unstake requested. Your ${stake.asset} will be released after ${endDateStr}.`,
      status: 'UNSTAKING',
    };
  }

  // ── List user's active stakes ──────────────────
  async listPositions(userId: string): Promise<StakeResponse[]> {
    const result = await this.db.query(
      `SELECT s.id, s.user_id, s.product_id, s.asset, s.amount, s.apy_at_stake,
              s.status, s.start_date, s.end_date, s.created_at, s.updated_at
       FROM stakes s
       WHERE s.user_id = $1
       ORDER BY s.created_at DESC`,
      [userId],
    );

    return result.rows.map(this.mapStakeResponse);
  }

  // ── List user's reward history ─────────────────
  async listRewards(userId: string): Promise<StakingRewardResponse[]> {
    const result = await this.db.query(
      `SELECT r.id, r.stake_id, r.user_id, r.asset, r.amount,
              r.period_start, r.period_end, r.status, r.paid_at, r.created_at
       FROM staking_rewards r
       WHERE r.user_id = $1
       ORDER BY r.created_at DESC
       LIMIT 200`,
      [userId],
    );

    return result.rows.map(this.mapRewardResponse);
  }

  // ── Claim pending rewards for a stake ──────────
  async claimRewards(userId: string, input: ClaimRewardsInput): Promise<{ message: string; claimed: string; asset: string }> {
    const stake = await this.getUserStake(userId, input.stake_id);

    // Get all pending rewards for this stake
    const rewardsResult = await this.db.query(
      `SELECT id, amount FROM staking_rewards
       WHERE stake_id = $1 AND user_id = $2 AND status = 'PENDING'
       FOR UPDATE`,
      [input.stake_id, userId],
    );

    if (rewardsResult.rows.length === 0) {
      throw new AppError(404, 'NO_REWARDS', 'No pending rewards to claim for this stake');
    }

    const totalRewards = rewardsResult.rows.reduce(
      (sum: number, r: { amount: string }) => sum + Number(r.amount), 0,
    );
    const rewardIds = rewardsResult.rows.map((r: { id: string }) => r.id);

    await this.db.query('BEGIN');
    try {
      // Credit rewards to user's wallet balance
      await this.db.query(
        `UPDATE wallets
         SET balance = balance + $1, updated_at = NOW()
         WHERE user_id = $2 AND asset = $3 AND wallet_type = 'SPOT'`,
        [totalRewards, userId, stake.asset],
      );

      // Mark rewards as PAID
      await this.db.query(
        `UPDATE staking_rewards
         SET status = 'PAID', paid_at = NOW()
         WHERE id = ANY($1::uuid[])`,
        [rewardIds],
      );

      await this.db.query('COMMIT');
    } catch (err) {
      await this.db.query('ROLLBACK');
      throw err;
    }

    return {
      message: `Successfully claimed ${totalRewards.toFixed(8)} ${stake.asset} in rewards.`,
      claimed: String(totalRewards),
      asset: stake.asset,
    };
  }

  // ── Admin: Get staking summary ─────────────────
  async getAdminSummary(): Promise<StakingSummaryResponse> {
    const totalStaked = await this.db.query(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM stakes WHERE status IN ('ACTIVE', 'UNSTAKING')`,
    );

    const totalUsers = await this.db.query(
      `SELECT COUNT(DISTINCT user_id) as count FROM stakes WHERE status IN ('ACTIVE', 'UNSTAKING')`,
    );

    const totalRewardsPaid = await this.db.query(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM staking_rewards WHERE status = 'PAID'`,
    );

    const totalPendingRewards = await this.db.query(
      `SELECT COALESCE(SUM(amount), 0) as total
       FROM staking_rewards WHERE status = 'PENDING'`,
    );

    const activeStakesCount = await this.db.query(
      `SELECT COUNT(*) as count FROM stakes WHERE status = 'ACTIVE'`,
    );

    const products = await this.listProducts();

    return {
      total_staked: String(totalStaked.rows[0].total),
      total_users: parseInt(totalUsers.rows[0].count, 10),
      total_rewards_paid: String(totalRewardsPaid.rows[0].total),
      total_pending_rewards: String(totalPendingRewards.rows[0].total),
      products,
      active_stakes_count: parseInt(activeStakesCount.rows[0].count, 10),
    };
  }

  // ── Admin: Create staking product ──────────────
  async createProduct(input: CreateStakingProductInput): Promise<StakingProductResponse> {
    const result = await this.db.query(
      `INSERT INTO staking_products (asset, name, apy, min_stake, lock_period_days, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, asset, name, apy, min_stake, lock_period_days, is_active,
                 created_at, updated_at`,
      [input.asset, input.name, input.apy, input.min_stake, input.lock_period_days, input.is_active],
    );

    return this.mapProductResponse(result.rows[0]);
  }

  // ── Admin: Update staking product ──────────────
  async updateProduct(productId: string, input: UpdateStakingProductInput): Promise<StakingProductResponse> {
    // Check product exists
    await this.getProduct(productId);

    const fields: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    if (input.asset !== undefined) { fields.push(`asset = $${paramIdx++}`); params.push(input.asset); }
    if (input.name !== undefined) { fields.push(`name = $${paramIdx++}`); params.push(input.name); }
    if (input.apy !== undefined) { fields.push(`apy = $${paramIdx++}`); params.push(input.apy); }
    if (input.min_stake !== undefined) { fields.push(`min_stake = $${paramIdx++}`); params.push(input.min_stake); }
    if (input.lock_period_days !== undefined) { fields.push(`lock_period_days = $${paramIdx++}`); params.push(input.lock_period_days); }
    if (input.is_active !== undefined) { fields.push(`is_active = $${paramIdx++}`); params.push(input.is_active); }

    if (fields.length === 0) {
      throw new AppError(400, 'NO_UPDATES', 'No fields to update');
    }

    params.push(productId);
    const result = await this.db.query(
      `UPDATE staking_products SET ${fields.join(', ')} WHERE id = $${paramIdx}
       RETURNING id, asset, name, apy, min_stake, lock_period_days, is_active,
                 created_at, updated_at`,
      params,
    );

    return this.mapProductResponse(result.rows[0]);
  }

  // ── Admin: Manually trigger reward distribution ─
  async distributeRewards(): Promise<{ message: string; rewards_created: number }> {
    const distributor = new StakingRewardDistributor(this.db);
    const count = await distributor.distribute();
    return {
      message: `Reward distribution completed. ${count} rewards created.`,
      rewards_created: count,
    };
  }

  // ── Private helpers ──────────────────────────

  private async getUserStake(userId: string, stakeId: string): Promise<StakeResponse> {
    const result = await this.db.query(
      `SELECT id, user_id, product_id, asset, amount, apy_at_stake,
              status, start_date, end_date, created_at, updated_at
       FROM stakes
       WHERE id = $1 AND user_id = $2`,
      [stakeId, userId],
    );

    if (result.rows.length === 0) {
      throw new AppError(404, 'STAKE_NOT_FOUND', 'Stake not found');
    }

    return this.mapStakeResponse(result.rows[0]);
  }

  private mapProductResponse(row: Record<string, unknown>): StakingProductResponse {
    return {
      id: row.id as string,
      asset: row.asset as string,
      name: row.name as string,
      apy: String(row.apy),
      min_stake: String(row.min_stake),
      lock_period_days: Number(row.lock_period_days),
      is_active: row.is_active as boolean,
      created_at: (row.created_at as Date).toISOString(),
      updated_at: (row.updated_at as Date).toISOString(),
    };
  }

  private mapStakeResponse(row: Record<string, unknown>): StakeResponse {
    return {
      id: row.id as string,
      user_id: row.user_id as string,
      product_id: row.product_id as string,
      asset: row.asset as string,
      amount: String(row.amount),
      apy_at_stake: String(row.apy_at_stake),
      status: row.status as string,
      start_date: (row.start_date as Date).toISOString(),
      end_date: row.end_date ? (row.end_date as Date).toISOString() : null,
      created_at: (row.created_at as Date).toISOString(),
      updated_at: (row.updated_at as Date).toISOString(),
    };
  }

  private mapRewardResponse(row: Record<string, unknown>): StakingRewardResponse {
    return {
      id: row.id as string,
      stake_id: row.stake_id as string,
      user_id: row.user_id as string,
      asset: row.asset as string,
      amount: String(row.amount),
      period_start: (row.period_start as Date).toISOString(),
      period_end: (row.period_end as Date).toISOString(),
      status: row.status as string,
      paid_at: row.paid_at ? (row.paid_at as Date).toISOString() : null,
      created_at: (row.created_at as Date).toISOString(),
    };
  }
}

/**
 * Staking Reward Distributor
 *
 * Background process that calculates and distributes staking rewards daily.
 * Runs every 24 hours, computing rewards for active stakes.
 * Similar pattern to MockBlockchainWatcher in deposit.ts.
 */
export class StakingRewardDistributor {
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(private db: pg.Pool) {}

  start(): void {
    if (this.running) return;
    this.running = true;

    console.log('[StakingRewards] Starting reward distributor (checking every 24h)...');

    // Run immediately on start
    this.distribute()
      .then((count) => console.log(`[StakingRewards] Initial distribution: ${count} rewards created`))
      .catch((err) => console.error('[StakingRewards] Initial distribution error:', err));

    // Then every 24 hours
    this.intervalId = setInterval(async () => {
      try {
        const count = await this.distribute();
        console.log(`[StakingRewards] Distributed ${count} rewards`);
      } catch (err) {
        console.error('[StakingRewards] Distribution error:', err);
      }
    }, 24 * 60 * 60 * 1000); // 24 hours
  }

  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.running = false;
    console.log('[StakingRewards] Reward distributor stopped.');
  }

  /**
   * Calculate and create rewards for all active stakes.
   * Rewards = amount * (apy / 365 / 100) per day
   * Returns the number of rewards created.
   */
  async distribute(): Promise<number> {
    // Get all active stakes
    const activeStakes = await this.db.query(
      `SELECT s.id, s.user_id, s.asset, s.amount, s.apy_at_stake,
              s.start_date, s.end_date
       FROM stakes s
       WHERE s.status = 'ACTIVE'
       ORDER BY s.created_at ASC`,
    );

    if (activeStakes.rows.length === 0) {
      return 0;
    }

    let rewardsCreated = 0;
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const yesterdayEnd = new Date(todayStart.getTime() - 1);

    for (const stake of activeStakes.rows) {
      // Check if stake has ended (locked stake past end_date)
      if (stake.end_date && new Date(stake.end_date) < today) {
        // Auto-complete stakes that have passed their end date
        await this.db.query(
          `UPDATE stakes SET status = 'COMPLETED', updated_at = NOW()
           WHERE id = $1`,
          [stake.id],
        );
        continue;
      }

      // Check if a reward was already created for today
      const existingReward = await this.db.query(
        `SELECT id FROM staking_rewards
         WHERE stake_id = $1 AND period_start >= $2 AND period_start < $3
         LIMIT 1`,
        [stake.id, yesterdayEnd.toISOString(), todayStart.toISOString()],
      );

      if (existingReward.rows.length > 0) {
        continue; // Already distributed for today
      }

      // Calculate daily reward: amount * (apy / 365 / 100)
      const apy = Number(stake.apy_at_stake);
      const amount = Number(stake.amount);
      const dailyReward = amount * (apy / 365 / 100);

      if (dailyReward <= 0) continue;

      // Create reward record
      const periodStart = yesterdayEnd;
      const periodEnd = todayStart;

      await this.db.query(
        `INSERT INTO staking_rewards (stake_id, user_id, asset, amount,
                                       period_start, period_end, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')`,
        [stake.id, stake.user_id, stake.asset, dailyReward.toFixed(8),
         periodStart.toISOString(), periodEnd.toISOString()],
      );

      rewardsCreated++;
    }

    return rewardsCreated;
  }
}