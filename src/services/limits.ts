/**
 * NovaBit Exchange — Transaction Limits Service
 *
 * Enforces withdrawal and trading limits based on KYC verification level.
 * Limits are enforced per 24-hour rolling window.
 */

import pg from 'pg';

interface LimitConfig {
  maxWithdrawal24h: number;  // in EUR equivalent
  maxTradeVolume24h: number; // in EUR equivalent (0 = unlimited)
}

const KYC_LIMITS: Record<string, LimitConfig> = {
  UNVERIFIED: { maxWithdrawal24h: 500, maxTradeVolume24h: 5000 },
  PENDING:    { maxWithdrawal24h: 500, maxTradeVolume24h: 5000 },
  VERIFIED:   { maxWithdrawal24h: 100_000, maxTradeVolume24h: 0 },    // 0 = unlimited
  REJECTED:   { maxWithdrawal24h: 0, maxTradeVolume24h: 0 },
};

export class LimitsService {
  constructor(private db: pg.Pool) {}

  /**
   * Get the KYC status for a user.
   */
  async getUserKYCStatus(userId: string): Promise<{ kyc_status: string; kyc_verified_at: Date | null }> {
    const result = await this.db.query(
      `SELECT kyc_status, kyc_verified_at FROM users WHERE id = $1`,
      [userId],
    );

    if (result.rows.length === 0) {
      return { kyc_status: 'UNVERIFIED', kyc_verified_at: null };
    }

    return {
      kyc_status: result.rows[0].kyc_status,
      kyc_verified_at: result.rows[0].kyc_verified_at || null,
    };
  }

  /**
   * Get the 24h withdrawal usage for a user.
   */
  async getWithdrawalUsage24h(userId: string): Promise<number> {
    const result = await this.db.query(
      `SELECT COALESCE(SUM(CAST(amount AS DECIMAL)), 0) as total
       FROM withdrawals
       WHERE user_id = $1
         AND status IN ('PENDING', 'APPROVED', 'COMPLETED')
         AND created_at > NOW() - INTERVAL '24 hours'`,
      [userId],
    );

    return Number(result.rows[0].total);
  }

  /**
   * Get the 24h trade volume for a user.
   */
  async getTradeVolume24h(userId: string): Promise<number> {
    const result = await this.db.query(
      `SELECT COALESCE(SUM(CAST(total AS DECIMAL)), 0) as total
       FROM trades
       WHERE taker_user_id = $1
         AND created_at > NOW() - INTERVAL '24 hours'`,
      [userId],
    );

    return Number(result.rows[0].total);
  }

  /**
   * Check if a withdrawal is within limits.
   */
  async checkWithdrawalLimit(
    userId: string,
    amount: number,
  ): Promise<{
    allowed: boolean;
    current_24h_usage: string;
    limit_24h: string;
    remaining: string;
    reset_at: string;
  }> {
    const { kyc_status } = await this.getUserKYCStatus(userId);
    const limits = KYC_LIMITS[kyc_status] || KYC_LIMITS.UNVERIFIED;
    const currentUsage = await this.getWithdrawalUsage24h(userId);
    const remaining = Math.max(0, limits.maxWithdrawal24h - currentUsage);

    // Calculate reset time (next midnight or 24h from now)
    const resetAt = new Date();
    resetAt.setHours(23, 59, 59, 999);

    return {
      allowed: limits.maxWithdrawal24h === 0 || (currentUsage + amount) <= limits.maxWithdrawal24h,
      current_24h_usage: currentUsage.toFixed(2),
      limit_24h: limits.maxWithdrawal24h === 0 ? '0' : limits.maxWithdrawal24h.toFixed(2),
      remaining: remaining.toFixed(2),
      reset_at: resetAt.toISOString(),
    };
  }

  /**
   * Check if a trade is within limits.
   */
  async checkTradeLimit(
    userId: string,
    tradeVolume: number,
  ): Promise<{
    allowed: boolean;
    current_24h_volume: string;
    limit_24h: string;
    remaining: string;
    reset_at: string;
  }> {
    const { kyc_status } = await this.getUserKYCStatus(userId);
    const limits = KYC_LIMITS[kyc_status] || KYC_LIMITS.UNVERIFIED;
    const currentVolume = await this.getTradeVolume24h(userId);
    const remaining = limits.maxTradeVolume24h === 0
      ? 'Unlimited'
      : Math.max(0, limits.maxTradeVolume24h - currentVolume).toFixed(2);

    const resetAt = new Date();
    resetAt.setHours(23, 59, 59, 999);

    return {
      allowed: limits.maxTradeVolume24h === 0 || (currentVolume + tradeVolume) <= limits.maxTradeVolume24h,
      current_24h_volume: currentVolume.toFixed(2),
      limit_24h: limits.maxTradeVolume24h === 0 ? 'Unlimited' : limits.maxTradeVolume24h.toFixed(2),
      remaining,
      reset_at: resetAt.toISOString(),
    };
  }

  /**
   * Get the limits config for a user's KYC level.
   */
  async getLimitsForUser(userId: string): Promise<{
    kyc_status: string;
    withdrawal_limit_24h: string;
    trade_limit_24h: string;
  }> {
    const { kyc_status } = await this.getUserKYCStatus(userId);
    const limits = KYC_LIMITS[kyc_status] || KYC_LIMITS.UNVERIFIED;

    return {
      kyc_status,
      withdrawal_limit_24h: limits.maxWithdrawal24h === 0 ? '0' : limits.maxWithdrawal24h.toFixed(2),
      trade_limit_24h: limits.maxTradeVolume24h === 0
        ? 'Unlimited'
        : limits.maxTradeVolume24h.toFixed(2),
    };
  }
}