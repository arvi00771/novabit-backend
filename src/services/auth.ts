/**
 * NovaBit Exchange — Auth Service
 *
 * Handles user registration, credential verification, refresh token validation,
 * TOTP 2FA management. JWT signing is done at the route layer which has access
 * to the Fastify instance.
 */

import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { authenticator } from 'otplib';
import pg from 'pg';
import { AppError } from '../middleware/error-handler.js';
import {
  RegisterInput,
  UserProfile,
  TwoFactorSetup,
} from '../schemas/auth.js';

const BCRYPT_ROUNDS = 12;
const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MIN = 15;

export class AuthService {
  constructor(
    private db: pg.Pool,
  ) {}

  // ── Register ──────────────────────────────────
  async register(input: RegisterInput): Promise<{ id: string; email: string }> {
    const { email, password } = input;

    // Check for existing user
    const existing = await this.db.query(
      'SELECT id FROM users WHERE email = $1',
      [email],
    );
    if (existing.rows.length > 0) {
      throw new AppError(409, 'EMAIL_EXISTS', 'An account with this email already exists');
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Insert user
    const result = await this.db.query(
      `INSERT INTO users (email, password_hash, role, kyc_status, is_active)
       VALUES ($1, $2, 'USER', 'UNVERIFIED', TRUE)
       RETURNING id, email, created_at`,
      [email, password_hash],
    );

    const user = result.rows[0];

    // Generate default SPOT wallets for common assets
    await this.createDefaultWallets(user.id);

    return { id: user.id, email: user.email };
  }

  // ── Verify credentials (returns user info for JWT generation) ──
  async verifyCredentials(
    email: string,
    password: string,
    totpCode?: string,
  ): Promise<{
    id: string;
    role: string;
    is_2fa_enabled: boolean;
    profile: UserProfile;
  }> {
    // Fetch user
    const result = await this.db.query(
      `SELECT id, email, password_hash, role, kyc_status,
              is_2fa_enabled, is_active, failed_login_attempts, locked_until,
              totp_secret, created_at
       FROM users WHERE email = $1`,
      [email],
    );

    if (result.rows.length === 0) {
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const user = result.rows[0];

    // Check if account is active
    if (!user.is_active) {
      throw new AppError(403, 'ACCOUNT_DISABLED', 'Account is disabled. Contact support.');
    }

    // Check if account is locked
    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const remainingMin = Math.ceil(
        (new Date(user.locked_until).getTime() - Date.now()) / 60000,
      );
      throw new AppError(
        429,
        'ACCOUNT_LOCKED',
        `Account is temporarily locked. Try again in ${remainingMin} minutes.`,
      );
    }

    // Verify password
    const passwordValid = await bcrypt.compare(password, user.password_hash);
    if (!passwordValid) {
      await this.recordFailedAttempt(user.id);
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    // Check 2FA
    if (user.is_2fa_enabled && user.totp_secret) {
      if (!totpCode) {
        throw new AppError(400, '2FA_REQUIRED', '2FA code is required');
      }
      const totpValid = authenticator.check(totpCode, user.totp_secret);
      if (!totpValid) {
        throw new AppError(401, 'INVALID_2FA', 'Invalid 2FA code');
      }
    }

    // Reset failed attempts and update last login
    await this.db.query(
      `UPDATE users SET failed_login_attempts = 0, locked_until = NULL, last_login_at = NOW()
       WHERE id = $1`,
      [user.id],
    );

    return {
      id: user.id,
      role: user.role,
      is_2fa_enabled: user.is_2fa_enabled,
      profile: this.mapUserProfile(user),
    };
  }

  // ── Store refresh token (returns opaque UUID token) ──
  async createRefreshToken(
    userId: string,
    deviceInfo?: string,
    ipAddress?: string,
  ): Promise<{ refreshToken: string; expiresAt: Date }> {
    const refreshToken = crypto.randomUUID();
    const tokenHash = this.hashToken(refreshToken);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    await this.db.query(
      `INSERT INTO refresh_tokens (user_id, token_hash, device_info, ip_address, expires_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, tokenHash, deviceInfo || null, ipAddress || null, expiresAt],
    );

    return { refreshToken, expiresAt };
  }

  // ── Validate refresh token (returns user info for new token generation) ──
  async validateRefreshToken(
    token: string,
  ): Promise<{ userId: string; role: string; tokenRecordId: string } | null> {
    const tokenHash = this.hashToken(token);

    const result = await this.db.query(
      `SELECT rt.id, rt.user_id, rt.revoked_at, u.role, u.is_active
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1 AND rt.expires_at > NOW()`,
      [tokenHash],
    );

    if (result.rows.length === 0) return null;

    const row = result.rows[0];

    if (row.revoked_at) {
      // Token reuse detected — revoke ALL tokens for this user (security measure)
      await this.revokeAllUserTokens(row.user_id);
      return null;
    }

    if (!row.is_active) return null;

    return { userId: row.user_id, role: row.role, tokenRecordId: row.id };
  }

  // ── Revoke a used refresh token (rotation) ──
  async revokeRefreshToken(tokenRecordId: string): Promise<void> {
    await this.db.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1',
      [tokenRecordId],
    );
  }

  // ── 2FA: Generate setup ──────────────────────
  async generate2faSecret(userId: string): Promise<TwoFactorSetup> {
    const user = await this.db.query(
      'SELECT id, email, is_2fa_enabled FROM users WHERE id = $1',
      [userId],
    );
    if (user.rows.length === 0) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    }
    if (user.rows[0].is_2fa_enabled) {
      throw new AppError(400, '2FA_ALREADY_ENABLED', '2FA is already enabled');
    }

    const secret = authenticator.generateSecret();
    const serviceName = 'NovaBit Exchange';
    const uri = authenticator.keyuri(user.rows[0].email, serviceName, secret);

    // Store secret in the database (not yet enabled — verified in next step)
    await this.db.query(
      'UPDATE users SET totp_secret = $1 WHERE id = $2 AND NOT is_2fa_enabled',
      [secret, userId],
    );

    return { secret, uri, qr_code_url: uri };
  }

  // ── 2FA: Verify & Enable ─────────────────────
  async verifyAndEnable2fa(userId: string, totpCode: string): Promise<void> {
    const user = await this.db.query(
      'SELECT id, totp_secret, is_2fa_enabled FROM users WHERE id = $1',
      [userId],
    );
    if (user.rows.length === 0) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    }
    if (user.rows[0].is_2fa_enabled) {
      throw new AppError(400, '2FA_ALREADY_ENABLED', '2FA is already enabled');
    }
    if (!user.rows[0].totp_secret) {
      throw new AppError(400, '2FA_NOT_SETUP', 'Generate a 2FA secret first');
    }

    const isValid = authenticator.check(totpCode, user.rows[0].totp_secret);
    if (!isValid) {
      throw new AppError(400, 'INVALID_2FA_CODE', 'Invalid 2FA code. Try again.');
    }

    // Generate and store recovery codes
    const recoveryCodes = this.generateRecoveryCodes();
    const hashedRecoveryCodes = await Promise.all(
      recoveryCodes.map((code) => bcrypt.hash(code, 10)),
    );

    await this.db.query(
      `UPDATE users SET is_2fa_enabled = TRUE, recovery_codes = $1 WHERE id = $2`,
      [hashedRecoveryCodes, userId],
    );
  }

  // ── 2FA: Disable ────────────────────────────
  async disable2fa(userId: string, password: string, totpCode: string): Promise<void> {
    const user = await this.db.query(
      'SELECT id, password_hash, totp_secret, is_2fa_enabled FROM users WHERE id = $1',
      [userId],
    );
    if (user.rows.length === 0) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    }
    if (!user.rows[0].is_2fa_enabled) {
      throw new AppError(400, '2FA_NOT_ENABLED', '2FA is not enabled');
    }

    const passwordValid = await bcrypt.compare(password, user.rows[0].password_hash);
    if (!passwordValid) {
      throw new AppError(401, 'INVALID_PASSWORD', 'Password is incorrect');
    }

    if (user.rows[0].totp_secret) {
      const totpValid = authenticator.check(totpCode, user.rows[0].totp_secret);
      if (!totpValid) {
        throw new AppError(400, 'INVALID_2FA_CODE', 'Invalid 2FA code');
      }
    }

    await this.db.query(
      `UPDATE users SET is_2fa_enabled = FALSE, totp_secret = NULL, recovery_codes = NULL
       WHERE id = $1`,
      [userId],
    );
  }

  // ── Get current user profile ─────────────────
  async getUserProfile(userId: string): Promise<UserProfile> {
    const result = await this.db.query(
      `SELECT id, email, role, kyc_status, is_2fa_enabled, is_active, created_at
       FROM users WHERE id = $1`,
      [userId],
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    }
    return this.mapUserProfile(result.rows[0]);
  }

  // ── Forgot Password ───────────────────────────
  async forgotPassword(email: string): Promise<{ message: string }> {
    // Always return success to avoid email enumeration
    const user = await this.db.query(
      'SELECT id FROM users WHERE email = $1 AND is_active = TRUE',
      [email],
    );

    if (user.rows.length > 0) {
      const userId = user.rows[0].id;
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = this.hashToken(token);
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      // Invalidate any existing unused tokens for this user
      await this.db.query(
        `UPDATE password_resets SET used_at = NOW()
         WHERE user_id = $1 AND used_at IS NULL AND expires_at > NOW()`,
        [userId],
      );

      await this.db.query(
        `INSERT INTO password_resets (user_id, token_hash, expires_at)
         VALUES ($1, $2, $3)`,
        [userId, tokenHash, expiresAt],
      );

      // In production, send email with reset link containing the token
      console.log(`[DEV] Password reset token for ${email}: ${token}`);
    }

    return {
      message: 'If an account with that email exists, a password reset link has been sent.',
    };
  }

  // ── Reset Password ────────────────────────────
  async resetPassword(token: string, newPassword: string): Promise<void> {
    const tokenHash = this.hashToken(token);

    const result = await this.db.query(
      `SELECT pr.id, pr.user_id, pr.expires_at
       FROM password_resets pr
       WHERE pr.token_hash = $1 AND pr.used_at IS NULL AND pr.expires_at > NOW()`,
      [tokenHash],
    );

    if (result.rows.length === 0) {
      throw new AppError(400, 'INVALID_RESET_TOKEN', 'Reset token is invalid or has expired');
    }

    const resetRecord = result.rows[0];

    // Hash new password
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    // Update user password and mark token as used in a single transaction
    await this.db.query('BEGIN');

    try {
      await this.db.query(
        'UPDATE users SET password_hash = $1, updated_at = NOW() WHERE id = $2',
        [passwordHash, resetRecord.user_id],
      );

      await this.db.query(
        'UPDATE password_resets SET used_at = NOW() WHERE id = $1',
        [resetRecord.id],
      );

      // Revoke all refresh tokens for security
      await this.db.query(
        'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
        [resetRecord.user_id],
      );

      await this.db.query('COMMIT');
    } catch (err) {
      await this.db.query('ROLLBACK');
      throw err;
    }
  }

  // ── Logout ───────────────────────────────────
  async logout(refreshToken: string): Promise<void> {
    const tokenHash = this.hashToken(refreshToken);
    await this.db.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1 AND revoked_at IS NULL',
      [tokenHash],
    );
  }

  // ── Logout all sessions ──────────────────────
  async logoutAll(userId: string): Promise<void> {
    await this.revokeAllUserTokens(userId);
  }

  // ── Private helpers ──────────────────────────

  private hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex');
  }

  private async recordFailedAttempt(userId: string): Promise<void> {
    await this.db.query(
      `UPDATE users SET
         failed_login_attempts = failed_login_attempts + 1,
         locked_until = CASE
           WHEN failed_login_attempts + 1 >= $2
           THEN NOW() + INTERVAL '${LOCKOUT_DURATION_MIN} minutes'
           ELSE locked_until
         END
       WHERE id = $1`,
      [userId, MAX_LOGIN_ATTEMPTS],
    );
  }

  private async revokeAllUserTokens(userId: string): Promise<void> {
    await this.db.query(
      'UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    );
  }

  private async createDefaultWallets(userId: string): Promise<void> {
    const defaultAssets = ['BTC', 'ETH', 'USDT', 'SOL'];
    for (const asset of defaultAssets) {
      await this.db.query(
        `INSERT INTO wallets (user_id, asset, wallet_type, balance, locked_balance)
         VALUES ($1, $2, 'SPOT', 0, 0)
         ON CONFLICT (user_id, asset, wallet_type) DO NOTHING`,
        [userId, asset],
      );
    }
  }

  private generateRecoveryCodes(): string[] {
    const codes: string[] = [];
    for (let i = 0; i < 8; i++) {
      codes.push(crypto.randomBytes(4).toString('hex').toUpperCase());
    }
    return codes;
  }

  private mapUserProfile(row: Record<string, unknown>): UserProfile {
    return {
      id: row.id as string,
      email: row.email as string,
      role: row.role as string,
      kyc_status: row.kyc_status as string,
      is_2fa_enabled: row.is_2fa_enabled as boolean,
      is_active: row.is_active as boolean,
      created_at: (row.created_at as Date).toISOString(),
    };
  }
}