/**
 * NovaBit Exchange — Audit Logging Service
 *
 * Provides structured logging of compliance-relevant events.
 * All KYC submissions, approvals, rejections, withdrawals, and logins are logged.
 */

import pg from 'pg';

export interface AuditEntry {
  action: string;
  entityType: string;
  entityId: string | null;
  userId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  oldValue: unknown | null;
  newValue: unknown | null;
}

export class AuditService {
  constructor(private db: pg.Pool) {}

  /**
   * Log an audit entry to the database.
   */
  async log(entry: AuditEntry): Promise<void> {
    await this.db.query(
      `INSERT INTO audit_logs (user_id, action, entity_type, entity_id,
                                old_value, new_value, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        entry.userId,
        entry.action,
        entry.entityType,
        entry.entityId,
        entry.oldValue ? JSON.stringify(entry.oldValue) : null,
        entry.newValue ? JSON.stringify(entry.newValue) : null,
        entry.ipAddress,
        entry.userAgent,
      ],
    );
  }

  /**
   * Convenience: log KYC submission.
   */
  async logKYCSubmission(
    userId: string,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<void> {
    await this.log({
      action: 'KYC_SUBMIT',
      entityType: 'USER',
      entityId: userId,
      userId,
      ipAddress: ipAddress || null,
      userAgent: userAgent || null,
      oldValue: null,
      newValue: { kyc_status: 'PENDING' },
    });
  }

  /**
   * Convenience: log KYC approval.
   */
  async logKYCApproval(
    userId: string,
    adminId: string,
    ipAddress?: string,
  ): Promise<void> {
    await this.log({
      action: 'KYC_APPROVE',
      entityType: 'USER',
      entityId: userId,
      userId: adminId,
      ipAddress: ipAddress || null,
      userAgent: null,
      oldValue: { kyc_status: 'PENDING' },
      newValue: { kyc_status: 'VERIFIED' },
    });
  }

  /**
   * Convenience: log KYC rejection.
   */
  async logKYCRejection(
    userId: string,
    adminId: string,
    reason: string,
    ipAddress?: string,
  ): Promise<void> {
    await this.log({
      action: 'KYC_REJECT',
      entityType: 'USER',
      entityId: userId,
      userId: adminId,
      ipAddress: ipAddress || null,
      userAgent: null,
      oldValue: { kyc_status: 'PENDING' },
      newValue: { kyc_status: 'REJECTED', reason },
    });
  }

  /**
   * Convenience: log withdrawal attempt.
   */
  async logWithdrawalAttempt(
    userId: string,
    withdrawalId: string,
    amount: string,
    asset: string,
    ipAddress?: string,
  ): Promise<void> {
    await this.log({
      action: 'WITHDRAWAL_CREATE',
      entityType: 'WITHDRAWAL',
      entityId: withdrawalId,
      userId,
      ipAddress: ipAddress || null,
      userAgent: null,
      oldValue: null,
      newValue: { amount, asset },
    });
  }

  /**
   * Convenience: log login event.
   */
  async logLogin(
    userId: string,
    ipAddress?: string,
    userAgent?: string,
    success: boolean = true,
  ): Promise<void> {
    await this.log({
      action: success ? 'LOGIN_SUCCESS' : 'LOGIN_FAILED',
      entityType: 'USER',
      entityId: userId,
      userId,
      ipAddress: ipAddress || null,
      userAgent: userAgent || null,
      oldValue: null,
      newValue: { success },
    });
  }

  /**
   * Query audit logs for a user.
   */
  async getUserLogs(
    userId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<{ logs: unknown[]; total: number }> {
    const limit = options.limit || 50;
    const offset = options.offset || 0;

    const countResult = await this.db.query(
      `SELECT COUNT(*) FROM audit_logs WHERE user_id = $1`,
      [userId],
    );
    const total = parseInt(countResult.rows[0].count, 10);

    const result = await this.db.query(
      `SELECT id, user_id, action, entity_type, entity_id,
              old_value, new_value, ip_address, user_agent, created_at
       FROM audit_logs
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, limit, offset],
    );

    return {
      logs: result.rows.map((r: Record<string, unknown>) => ({
        id: r.id,
        user_id: r.user_id,
        action: r.action,
        entity_type: r.entity_type,
        entity_id: r.entity_id,
        old_value: r.old_value,
        new_value: r.new_value,
        ip_address: r.ip_address,
        user_agent: r.user_agent,
        created_at: (r.created_at as Date).toISOString(),
      })),
      total,
    };
  }
}