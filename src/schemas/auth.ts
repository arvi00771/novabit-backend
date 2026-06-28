/**
 * NovaBit Exchange — Auth Zod Schemas & Types
 *
 * Extends the shared types with auth-specific request/response schemas.
 */

import { z } from 'zod';

// ── Registration ──────────────────────────────
export const RegisterSchema = z.object({
  email: z.string().email().max(255).transform((e) => e.toLowerCase().trim()),
  password: z.string().min(8).max(128),
});
export type RegisterInput = z.infer<typeof RegisterSchema>;

// ── Login ─────────────────────────────────────
export const LoginSchema = z.object({
  email: z.string().email().transform((e) => e.toLowerCase().trim()),
  password: z.string().min(1),
  totp_code: z.string().optional(),
});
export type LoginInput = z.infer<typeof LoginSchema>;

// ── Refresh Token ─────────────────────────────
export const RefreshSchema = z.object({
  refresh_token: z.string().uuid(),
});
export type RefreshInput = z.infer<typeof RefreshSchema>;

// ── 2FA ───────────────────────────────────────
export const Enable2faSchema = z.object({});
export type Enable2faInput = z.infer<typeof Enable2faSchema>;

export const Verify2faSchema = z.object({
  totp_code: z.string().length(6).regex(/^\d{6}$/),
});
export type Verify2faInput = z.infer<typeof Verify2faSchema>;

export const Disable2faSchema = z.object({
  totp_code: z.string().length(6).regex(/^\d{6}$/),
  password: z.string().min(1),
});
export type Disable2faInput = z.infer<typeof Disable2faSchema>;

// ── Forgot / Reset Password ──────────────────
export const ForgotPasswordSchema = z.object({
  email: z.string().email().transform((e) => e.toLowerCase().trim()),
});
export type ForgotPasswordInput = z.infer<typeof ForgotPasswordSchema>;

export const ResetPasswordSchema = z.object({
  token: z.string().min(1),
  password: z.string().min(8).max(128),
});
export type ResetPasswordInput = z.infer<typeof ResetPasswordSchema>;

// ── Response types ────────────────────────────
export interface AuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: 'Bearer';
}

export interface UserProfile {
  id: string;
  email: string;
  role: string;
  kyc_status: string;
  is_2fa_enabled: boolean;
  is_active: boolean;
  created_at: string;
}

export interface TwoFactorSetup {
  secret: string;
  uri: string;
  qr_code_url: string;
}