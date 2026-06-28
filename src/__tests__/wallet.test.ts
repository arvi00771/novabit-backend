/**
 * Unit tests for the Wallet schemas.
 */

import { describe, it, expect } from 'vitest';

describe('Wallet Schemas - CreateWithdrawal', () => {
  it('should accept valid withdrawal input', async () => {
    const { CreateWithdrawalSchema } = await import('../schemas/wallet.js');

    const result = CreateWithdrawalSchema.parse({
      asset: 'btc',
      amount: '0.5',
      address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      network: 'BTC',
    });

    expect(result.asset).toBe('BTC'); // uppercase
    expect(result.amount).toBe('0.5');
    expect(result.address).toBe('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa');
  });

  it('should accept withdrawal with optional fields', async () => {
    const { CreateWithdrawalSchema } = await import('../schemas/wallet.js');

    const result = CreateWithdrawalSchema.parse({
      asset: 'USDT',
      amount: '100',
      address: '0x742d35Cc6634C0532925a3b844Bc9e7595f2bD18',
      network: 'ERC20',
      memo: 'payment123',
      totp_code: '123456',
    });

    expect(result.memo).toBe('payment123');
    expect(result.totp_code).toBe('123456');
  });

  it('should reject zero or negative amounts', async () => {
    const { CreateWithdrawalSchema } = await import('../schemas/wallet.js');

    expect(() =>
      CreateWithdrawalSchema.parse({
        asset: 'BTC',
        amount: '-1',
        address: 'xyz',
        network: 'BTC',
      }),
    ).toThrow();

    expect(() =>
      CreateWithdrawalSchema.parse({
        asset: 'BTC',
        amount: 'abc',
        address: 'xyz',
        network: 'BTC',
      }),
    ).toThrow();
  });

  it('should reject invalid TOTP codes', async () => {
    const { CreateWithdrawalSchema } = await import('../schemas/wallet.js');

    expect(() =>
      CreateWithdrawalSchema.parse({
        asset: 'BTC',
        amount: '1',
        address: 'xyz',
        network: 'BTC',
        totp_code: 'abc123',
      }),
    ).toThrow();

    expect(() =>
      CreateWithdrawalSchema.parse({
        asset: 'BTC',
        amount: '1',
        address: 'xyz',
        network: 'BTC',
        totp_code: '12345',
      }),
    ).toThrow();
  });
});

describe('Wallet Schemas - Transaction Query', () => {
  it('should apply default pagination values', async () => {
    const { TransactionQuerySchema } = await import('../schemas/wallet.js');

    const result = TransactionQuerySchema.parse({});
    expect(result.limit).toBe(20);
    expect(result.offset).toBe(0);
  });

  it('should accept all optional filters', async () => {
    const { TransactionQuerySchema } = await import('../schemas/wallet.js');

    const result = TransactionQuerySchema.parse({
      type: 'DEPOSIT',
      status: 'CONFIRMED',
      asset: 'BTC',
      limit: 50,
      offset: 10,
    });

    expect(result.type).toBe('DEPOSIT');
    expect(result.status).toBe('CONFIRMED');
    expect(result.asset).toBe('BTC');
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(10);
  });

  it('should cap limit at 100', async () => {
    const { TransactionQuerySchema } = await import('../schemas/wallet.js');

    expect(() =>
      TransactionQuerySchema.parse({ limit: 200 }),
    ).toThrow();
  });
});

describe('Wallet Schemas - Withdrawal Query', () => {
  it('should apply defaults and accept filters', async () => {
    const { WithdrawalQuerySchema } = await import('../schemas/wallet.js');

    const result = WithdrawalQuerySchema.parse({ status: 'PENDING' });
    expect(result.status).toBe('PENDING');
    expect(result.limit).toBe(20);
  });
});

describe('Wallet Response Mapping', () => {
  it('should have correct TypeScript interface for WalletResponse', async () => {
    // This validates the schema shape at runtime
    const response = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      asset: 'BTC',
      wallet_type: 'SPOT',
      balance: '1.50000000',
      locked_balance: '0.50000000',
      available_balance: '1.00000000',
      address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
      is_active: true,
    };

    const { WalletResponseSchema } = await import('../schemas/wallet.js');
    const parsed = WalletResponseSchema.parse(response);
    expect(parsed.asset).toBe('BTC');
    expect(parsed.wallet_type).toBe('SPOT');
    expect(parsed.is_active).toBe(true);
  });
});