/**
 * NovaBit Exchange — Staking Zod Schemas
 */

import { z } from 'zod';

// ── Staking Product ─────────────────────────────
export const StakingProductResponseSchema = z.object({
  id: z.string().uuid(),
  asset: z.string(),
  name: z.string(),
  apy: z.string(),
  min_stake: z.string(),
  lock_period_days: z.number(),
  is_active: z.boolean(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type StakingProductResponse = z.infer<typeof StakingProductResponseSchema>;

// ── Stake ───────────────────────────────────────
export const StakeResponseSchema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  product_id: z.string().uuid(),
  asset: z.string(),
  amount: z.string(),
  apy_at_stake: z.string(),
  status: z.string(),
  start_date: z.string(),
  end_date: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});

export type StakeResponse = z.infer<typeof StakeResponseSchema>;

// ── Staking Reward ──────────────────────────────
export const StakingRewardResponseSchema = z.object({
  id: z.string().uuid(),
  stake_id: z.string().uuid(),
  user_id: z.string().uuid(),
  asset: z.string(),
  amount: z.string(),
  period_start: z.string(),
  period_end: z.string(),
  status: z.string(),
  paid_at: z.string().nullable(),
  created_at: z.string(),
});

export type StakingRewardResponse = z.infer<typeof StakingRewardResponseSchema>;

// ── Input Schemas ───────────────────────────────
export const StakeInputSchema = z.object({
  product_id: z.string().uuid(),
  amount: z.string().regex(/^\d+(\.\d+)?$/, 'Must be a valid number'),
});

export type StakeInput = z.infer<typeof StakeInputSchema>;

export const UnstakeInputSchema = z.object({
  stake_id: z.string().uuid(),
});

export type UnstakeInput = z.infer<typeof UnstakeInputSchema>;

export const ClaimRewardsInputSchema = z.object({
  stake_id: z.string().uuid(),
});

export type ClaimRewardsInput = z.infer<typeof ClaimRewardsInputSchema>;

// ── Admin Input Schemas ─────────────────────────
export const CreateStakingProductSchema = z.object({
  asset: z.string().min(1).max(10).toUpperCase(),
  name: z.string().min(1).max(100),
  apy: z.string().regex(/^\d+(\.\d+)?$/, 'Must be a valid number'),
  min_stake: z.string().regex(/^\d+(\.\d+)?$/, 'Must be a valid number'),
  lock_period_days: z.coerce.number().int().min(0).default(0),
  is_active: z.boolean().optional().default(true),
});

export type CreateStakingProductInput = z.infer<typeof CreateStakingProductSchema>;

export const UpdateStakingProductSchema = CreateStakingProductSchema.partial();

export type UpdateStakingProductInput = z.infer<typeof UpdateStakingProductSchema>;

// ── Admin Summary ───────────────────────────────
export const StakingSummaryResponseSchema = z.object({
  total_staked: z.string(),
  total_users: z.number(),
  total_rewards_paid: z.string(),
  total_pending_rewards: z.string(),
  products: z.array(StakingProductResponseSchema),
  active_stakes_count: z.number(),
});

export type StakingSummaryResponse = z.infer<typeof StakingSummaryResponseSchema>;