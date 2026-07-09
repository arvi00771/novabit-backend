/**
 * NovaBit Exchange — KYC Zod Schemas
 */

import { z } from 'zod';

// ── KYC Document ───────────────────────────────
export const KYCDocumentResponseSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  document_type: z.string(),
  file_path: z.string(),
  file_hash: z.string(),
  file_size: z.number(),
  mime_type: z.string(),
  status: z.string(),
  rejection_reason: z.string().nullable(),
  reviewed_at: z.string().nullable(),
  created_at: z.string(),
});

export type KYCDocumentResponse = z.infer<typeof KYCDocumentResponseSchema>;

// ── KYC Status Response ────────────────────────
export const KYCStatusResponseSchema = z.object({
  kyc_status: z.string(),
  kyc_verified_at: z.string().nullable(),
  verification_level: z.string().default('NONE'),
});

export type KYCStatusResponse = z.infer<typeof KYCStatusResponseSchema>;

// ── KYC Submit Input ───────────────────────────
export const KYCSubmitSchema = z.object({
  full_name: z.string().min(1).max(255),
  date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be YYYY-MM-DD'),
  nationality: z.string().min(2).max(3),  // ISO country code
  address_street: z.string().min(1).max(255),
  address_city: z.string().min(1).max(100),
  address_postal_code: z.string().min(1).max(20),
  address_country: z.string().min(2).max(3),  // ISO country code
  document_type: z.enum(['PASSPORT', 'DRIVERS_LICENSE', 'NATIONAL_ID']),
});

export type KYCSubmitInput = z.infer<typeof KYCSubmitSchema>;

// ── Admin KYC Review ───────────────────────────
export const KYCApproveSchema = z.object({
  verification_level: z.string().default('FULL'),
});

export const KYCRejectSchema = z.object({
  reason: z.string().min(1).max(500),
});

export type KYCRejectInput = z.infer<typeof KYCRejectSchema>;

// ── Admin Pending KYC Response ─────────────────
export const PendingKYCResponseSchema = z.object({
  user_id: z.string().uuid(),
  email: z.string().email(),
  full_name: z.string(),
  kyc_status: z.string(),
  kyc_data: z.any().nullable(),
  documents: z.array(KYCDocumentResponseSchema),
  created_at: z.string(),
});

export type PendingKYCResponse = z.infer<typeof PendingKYCResponseSchema>;

// ── Transaction Limits ─────────────────────────
export interface WithdrawalLimitCheck {
  allowed: boolean;
  current_24h_usage: string;
  limit_24h: string;
  remaining: string;
  reset_at: string;
}

export interface TradeLimitCheck {
  allowed: boolean;
  current_24h_volume: string;
  limit_24h: string;
  remaining: string;
  reset_at: string;
}

// ── Audit Log ──────────────────────────────────
export const AuditLogEntrySchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid().nullable(),
  action: z.string(),
  entity_type: z.string(),
  entity_id: z.string().nullable(),
  old_value: z.any().nullable(),
  new_value: z.any().nullable(),
  ip_address: z.string().nullable(),
  user_agent: z.string().nullable(),
  created_at: z.string(),
});

export type AuditLogEntry = z.infer<typeof AuditLogEntrySchema>;