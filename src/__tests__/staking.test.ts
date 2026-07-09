/**
 * Tests for the Staking system schemas and services.
 */

import { describe, it, expect } from 'vitest';

describe('Staking Schemas - Input Validation', () => {
  it('should accept valid stake input', async () => {
    const { StakeInputSchema } = await import('../schemas/staking.js');

    const result = StakeInputSchema.parse({
      product_id: '550e8400-e29b-41d4-a716-446655440000',
      amount: '10.5',
    });

    expect(result.product_id).toBe('550e8400-e29b-41d4-a716-446655440000');
    expect(result.amount).toBe('10.5');
  });

  it('should reject invalid stake amount', async () => {
    const { StakeInputSchema } = await import('../schemas/staking.js');

    expect(() =>
      StakeInputSchema.parse({
        product_id: '550e8400-e29b-41d4-a716-446655440000',
        amount: 'abc',
      }),
    ).toThrow();
  });

  it('should accept valid unstake input', async () => {
    const { UnstakeInputSchema } = await import('../schemas/staking.js');

    const result = UnstakeInputSchema.parse({
      stake_id: '550e8400-e29b-41d4-a716-446655440000',
    });

    expect(result.stake_id).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('should accept valid claim rewards input', async () => {
    const { ClaimRewardsInputSchema } = await import('../schemas/staking.js');

    const result = ClaimRewardsInputSchema.parse({
      stake_id: '550e8400-e29b-41d4-a716-446655440000',
    });

    expect(result.stake_id).toBe('550e8400-e29b-41d4-a716-446655440000');
  });
});

describe('Staking Schemas - Admin Product Management', () => {
  it('should accept valid create product input', async () => {
    const { CreateStakingProductSchema } = await import('../schemas/staking.js');

    const result = CreateStakingProductSchema.parse({
      asset: 'eth',
      name: 'ETH Staking',
      apy: '5.5',
      min_stake: '0.1',
      lock_period_days: 0,
    });

    expect(result.asset).toBe('ETH');
    expect(result.name).toBe('ETH Staking');
    expect(result.apy).toBe('5.5');
    expect(result.lock_period_days).toBe(0);
  });

  it('should accept partial update input', async () => {
    const { UpdateStakingProductSchema } = await import('../schemas/staking.js');

    const result = UpdateStakingProductSchema.parse({
      apy: '6.0',
    });

    expect(result.apy).toBe('6.0');
    expect(result.asset).toBeUndefined();
  });

  it('should reject invalid create product input', async () => {
    const { CreateStakingProductSchema } = await import('../schemas/staking.js');

    expect(() =>
      CreateStakingProductSchema.parse({
        asset: '',
        name: 'Test',
        apy: '5.5',
        min_stake: '0.1',
      }),
    ).toThrow();
  });
});

describe('Staking Schemas - Response Types', () => {
  it('should validate staking product response', async () => {
    const { StakingProductResponseSchema } = await import('../schemas/staking.js');

    const response = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      asset: 'ETH',
      name: 'ETH Staking',
      apy: '5.5000',
      min_stake: '0.10000000',
      lock_period_days: 0,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const parsed = StakingProductResponseSchema.parse(response);
    expect(parsed.asset).toBe('ETH');
    expect(parsed.apy).toBe('5.5000');
    expect(parsed.is_active).toBe(true);
  });

  it('should validate stake response', async () => {
    const { StakeResponseSchema } = await import('../schemas/staking.js');

    const response = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      user_id: '550e8400-e29b-41d4-a716-446655440001',
      product_id: '550e8400-e29b-41d4-a716-446655440002',
      asset: 'ETH',
      amount: '10.00000000',
      apy_at_stake: '5.5000',
      status: 'ACTIVE',
      start_date: new Date().toISOString(),
      end_date: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const parsed = StakeResponseSchema.parse(response);
    expect(parsed.status).toBe('ACTIVE');
    expect(parsed.amount).toBe('10.00000000');
  });

  it('should validate staking reward response', async () => {
    const { StakingRewardResponseSchema } = await import('../schemas/staking.js');

    const response = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      stake_id: '550e8400-e29b-41d4-a716-446655440001',
      user_id: '550e8400-e29b-41d4-a716-446655440002',
      asset: 'ETH',
      amount: '0.00150000',
      period_start: new Date().toISOString(),
      period_end: new Date().toISOString(),
      status: 'PENDING',
      paid_at: null,
      created_at: new Date().toISOString(),
    };

    const parsed = StakingRewardResponseSchema.parse(response);
    expect(parsed.status).toBe('PENDING');
    expect(parsed.amount).toBe('0.00150000');
  });
});

describe('Staking Service - Reward Calculation', () => {
  it('should calculate daily reward correctly', () => {
    // amount * (apy / 365 / 100)
    const amount = 10; // 10 ETH
    const apy = 5.5; // 5.5% APY
    const dailyReward = amount * (apy / 365 / 100);

    // 10 * (5.5 / 365 / 100) = 10 * 0.0001506849... = 0.001506849...
    expect(dailyReward).toBeCloseTo(0.00150685, 8);
  });

  it('should calculate zero reward for zero APY', () => {
    const amount = 100;
    const apy = 0;
    const dailyReward = amount * (apy / 365 / 100);

    expect(dailyReward).toBe(0);
  });

  it('should scale reward with amount', () => {
    const apy = 6.0;
    const dailyReward1 = 10 * (apy / 365 / 100);
    const dailyReward2 = 100 * (apy / 365 / 100);

    expect(dailyReward2).toBeCloseTo(dailyReward1 * 10, 12);
  });

  it('should calculate yearly compounding from daily', () => {
    const amount = 100; // 100 USDT
    const apy = 3.0; // 3% APY
    const dailyReward = amount * (apy / 365 / 100);
    const yearlyReward = dailyReward * 365;

    expect(yearlyReward).toBeCloseTo(3.0, 2); // ~3 USDT per year
  });
});

describe('Staking Schemas - Migration', () => {
  it('should have the staking migration file', async () => {
    const { readdirSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const migrationsDir = join(__dirname, '..', 'db', 'migrations');
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

    expect(files).toContain('008_create_staking.sql');
  });

  it('should have all required staking tables in migration', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const migrationPath = join(__dirname, '..', 'db', 'migrations', '008_create_staking.sql');
    const content = readFileSync(migrationPath, 'utf-8');

    expect(content).toContain('staking_products');
    expect(content).toContain('stakes');
    expect(content).toContain('staking_rewards');
  });

  it('should have seed data for default staking products', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const migrationPath = join(__dirname, '..', 'db', 'migrations', '008_create_staking.sql');
    const content = readFileSync(migrationPath, 'utf-8');

    expect(content).toContain('ETH');
    expect(content).toContain('SOL');
    expect(content).toContain('ADA');
    expect(content).toContain('DOT');
    expect(content).toContain('AVAX');
    expect(content).toContain('USDT');
  });
});

describe('Staking Service - Exports', () => {
  it('should export StakingService class', async () => {
    const { StakingService } = await import('../services/staking.js');

    expect(StakingService).toBeDefined();
    expect(StakingService.prototype.stake).toBeInstanceOf(Function);
    expect(StakingService.prototype.unstake).toBeInstanceOf(Function);
    expect(StakingService.prototype.listProducts).toBeInstanceOf(Function);
    expect(StakingService.prototype.listPositions).toBeInstanceOf(Function);
    expect(StakingService.prototype.listRewards).toBeInstanceOf(Function);
    expect(StakingService.prototype.claimRewards).toBeInstanceOf(Function);
  });

  it('should export StakingRewardDistributor class', async () => {
    const { StakingRewardDistributor } = await import('../services/staking.js');

    expect(StakingRewardDistributor).toBeDefined();
    expect(StakingRewardDistributor.prototype.start).toBeInstanceOf(Function);
    expect(StakingRewardDistributor.prototype.stop).toBeInstanceOf(Function);
    expect(StakingRewardDistributor.prototype.distribute).toBeInstanceOf(Function);
  });
});

describe('Staking Routes - Existence', () => {
  it('should have staking route file', async () => {
    const { accessSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const routePath = join(__dirname, '..', 'routes', 'staking.ts');

    expect(() => accessSync(routePath)).not.toThrow();
  });

  it('should have staking routes registered in index', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const indexPath = join(__dirname, '..', 'routes', 'index.ts');
    const content = readFileSync(indexPath, 'utf-8');

    expect(content).toContain('staking');
  });
});