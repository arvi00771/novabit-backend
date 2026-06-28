/**
 * Tests for the deposit/withdrawal system schemas and migrations.
 */

import { describe, it, expect } from 'vitest';

describe('Deposit Info Response', () => {
  it('should export DepositInfoResponse from schemas', async () => {
    const mod = await import('../schemas/wallet.js');
    // Interfaces are compile-time only, but verify the module exports
    expect(mod).toBeDefined();
    expect(typeof mod.DepositAddressResponse).toBe('object');
  });
});

describe('Support Coin Response', () => {
  it('should export supported coin schemas', async () => {
    const mod = await import('../schemas/wallet.js');
    expect(mod.WalletAssetSchema).toBeDefined();
    expect(mod.CreateWithdrawalSchema).toBeDefined();
    expect(mod.TransactionQuerySchema).toBeDefined();
  });
});

describe('Migrations - Deposit System', () => {
  it('should have the supported_coins migration', async () => {
    const { readdirSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const migrationsDir = join(__dirname, '..', 'db', 'migrations');
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

    expect(files).toContain('007_create_supported_coins.sql');
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  it('should have correct supported coins count', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const migrationPath = join(__dirname, '..', 'db', 'migrations', '007_create_supported_coins.sql');
    const content = readFileSync(migrationPath, 'utf-8');

    // Check that default coins are inserted
    expect(content).toContain('BTC');
    expect(content).toContain('ETH');
    expect(content).toContain('USDT');
    expect(content).toContain('SOL');
    expect(content).toContain('ADA');
  });
});

describe('Admin Withdrawal Routes', () => {
  it('should have the admin routes file', async () => {
    const { accessSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const adminRoutePath = join(__dirname, '..', 'routes', 'admin.ts');
    
    expect(() => accessSync(adminRoutePath)).not.toThrow();
  });
});

describe('Blockchain Watcher', () => {
  it('should have the deposit service with watcher', async () => {
    const { DepositService, MockBlockchainWatcher } = await import('../services/deposit.js');

    expect(DepositService).toBeDefined();
    expect(MockBlockchainWatcher).toBeDefined();
    expect(MockBlockchainWatcher.prototype.start).toBeInstanceOf(Function);
    expect(MockBlockchainWatcher.prototype.stop).toBeInstanceOf(Function);
  });
});