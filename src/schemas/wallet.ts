/**
 * NovaBit Exchange — Wallet & Transaction Zod Schemas
 */

import { z } from 'zod';

// ── Wallet ────────────────────────────────────
export const WalletAssetSchema = z.string().min(1).max(10).toUpperCase();
export type WalletAsset = z.infer<typeof WalletAssetSchema>;

export const WalletResponseSchema = z.object({
  id: z.string().uuid(),
  asset: z.string(),
  wallet_type: z.string(),
  balance: z.string(),
  locked_balance: z.string(),
  available_balance: z.string(),
  address: z.string().nullable(),
  is_active: z.boolean(),
});

export type WalletResponse = z.infer<typeof WalletResponseSchema>;

// ── Deposit Info ───────────────────────────────
export interface DepositInfoResponse {
  address: string;
  network: string;
  memo: string | null;
  asset: string;
  min_deposit_amount: string;
  required_confirmations: number;
  coin_name: string;
}

export interface SupportedCoinResponse {
  asset: string;
  name: string;
  network: string;
  is_active: boolean;
  min_deposit_amount: string;
  min_withdrawal_amount: string;
  withdrawal_fee: string;
  withdrawal_fee_type: string;
  required_confirmations: number;
  deposit_enabled: boolean;
  withdrawal_enabled: boolean;
  withdrawal_requires_2fa: boolean;
}

// ── Withdrawal ────────────────────────────────
export const CreateWithdrawalSchema = z.object({
  asset: z.string().min(1).max(10).toUpperCase(),
  amount: z.string().regex(/^\d+(\.\d+)?$/, 'Must be a valid number'),
  address: z.string().min(1).max(255),
  network: z.string().min(1).max(20),
  memo: z.string().max(255).optional(),
  totp_code: z.string().length(6).regex(/^\d{6}$/).optional(),
});
export type CreateWithdrawalInput = z.infer<typeof CreateWithdrawalSchema>;

// ── Deposit Address ───────────────────────────
export const DepositAddressSchema = z.object({
  asset: z.string().min(1).max(10).toUpperCase(),
  network: z.string().min(1).max(20),
});
export type DepositAddressInput = z.infer<typeof DepositAddressSchema>;

export const DepositAddressResponse = z.object({
  address: z.string(),
  network: z.string(),
  memo: z.string().nullable(),
  asset: z.string(),
});

// ── Transaction Query ─────────────────────────
export const TransactionQuerySchema = z.object({
  type: z.string().optional(),
  status: z.string().optional(),
  asset: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type TransactionQuery = z.infer<typeof TransactionQuerySchema>;

export const WithdrawalQuerySchema = z.object({
  status: z.string().optional(),
  asset: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});
export type WithdrawalQuery = z.infer<typeof WithdrawalQuerySchema>;

// ── Response types ────────────────────────────
export interface TransactionResponse {
  id: string;
  type: string;
  status: string;
  asset: string;
  amount: string;
  fee: string;
  tx_hash: string | null;
  destination_address: string | null;
  source_address: string | null;
  reference_id: string | null;
  memo: string | null;
  created_at: string;
  confirmed_at: string | null;
}

export interface WithdrawalResponse {
  id: string;
  asset: string;
  amount: string;
  fee: string;
  network: string;
  to_address: string;
  status: string;
  tx_hash: string | null;
  created_at: string;
  completed_at: string | null;
}