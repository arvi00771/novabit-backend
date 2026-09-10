/**
 * Regression tests for server-side withdrawal 2FA enforcement.
 *
 * POST /wallets/withdraw must verify a TOTP code against the user's stored
 * secret whenever the account has 2FA enabled — before locking any balance
 * or creating any withdrawal record. Previously the (optional, unvalidated)
 * `totp_code` field was only used to set the `requires_2fa` flag, so an
 * attacker with a valid JWT could withdraw without ever passing a 2FA
 * challenge.
 */
import { describe, it, expect, vi } from 'vitest';
import { authenticator } from 'otplib';

const BASE_INPUT = {
  asset: 'BTC',
  amount: '0.1',
  address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
  network: 'BTC',
};

const WALLET_ROW = {
  id: 'wallet-1',
  balance: '1.0',
  locked_balance: '0',
  is_active: true,
};

function makeDb(userRow: Record<string, unknown>) {
  return {
    query: vi
      .fn()
      // 1st: wallet lookup
      .mockResolvedValueOnce({ rows: [WALLET_ROW], rowCount: 1 })
      // 2nd: user 2FA lookup
      .mockResolvedValueOnce({ rows: [userRow], rowCount: 1 })
      // 3rd: lock balance
      .mockResolvedValueOnce({ rows: [], rowCount: 1 })
      // 4th: insert withdrawal
      .mockResolvedValueOnce({ rows: [{ id: 'wd-1', status: 'PENDING' }], rowCount: 1 })
      // 5th: insert transaction
      .mockResolvedValue({ rows: [], rowCount: 1 }),
  };
}

describe('Withdrawal 2FA enforcement', () => {
  it('rejects a withdrawal with no TOTP code when 2FA is enabled (400/INVALID_2FA)', async () => {
    const secret = authenticator.generateSecret();
    const db = makeDb({ id: 'u-2fa', is_2fa_enabled: 1, totp_secret: secret });
    const { WalletService } = await import('../services/wallet.js');
    const service = new WalletService(db as any);

    await expect(service.createWithdrawal('u-2fa', { ...BASE_INPUT } as any)).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_2FA',
    });
    // No balance lock, no withdrawal insert, no transaction insert
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('rejects a withdrawal with a wrong TOTP code when 2FA is enabled (400/INVALID_2FA)', async () => {
    const secret = authenticator.generateSecret();
    const valid = authenticator.generate(secret);
    // Flip the last digit to guarantee a wrong code
    const wrong = valid.slice(0, 5) + (valid[5] === '0' ? '1' : '0');
    const db = makeDb({ id: 'u-2fa', is_2fa_enabled: 1, totp_secret: secret });
    const { WalletService } = await import('../services/wallet.js');
    const service = new WalletService(db as any);

    await expect(
      service.createWithdrawal('u-2fa', { ...BASE_INPUT, totp_code: wrong } as any),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_2FA' });
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('accepts a withdrawal with a valid TOTP code when 2FA is enabled', async () => {
    const secret = authenticator.generateSecret();
    const db = makeDb({ id: 'u-2fa', is_2fa_enabled: 1, totp_secret: secret });
    const { WalletService } = await import('../services/wallet.js');
    const service = new WalletService(db as any);

    const result = await service.createWithdrawal('u-2fa', {
      ...BASE_INPUT,
      totp_code: authenticator.generate(secret),
    } as any);

    expect(result.id).toBe('wd-1');
    expect(result.status).toBe('PENDING');
    expect(db.query).toHaveBeenCalledTimes(5);
    // requires_2fa flag records 2FA enforcement (1), and must be a
    // SQLite-bindable value — never a JS boolean.
    const insertParams = db.query.mock.calls[3][1];
    expect(insertParams[8]).toBe(1);
    expect(typeof insertParams[8]).toBe('number');
  });

  it('allows withdrawals without a TOTP code when 2FA is NOT enabled', async () => {
    const db = makeDb({ id: 'u-plain', is_2fa_enabled: 0, totp_secret: null });
    const { WalletService } = await import('../services/wallet.js');
    const service = new WalletService(db as any);

    const result = await service.createWithdrawal('u-plain', { ...BASE_INPUT } as any);

    expect(result.id).toBe('wd-1');
    expect(db.query).toHaveBeenCalledTimes(5);
    const insertParams = db.query.mock.calls[3][1];
    expect(insertParams[8]).toBe(0);
  });

  it('does not accept a fabricated code for a 2FA-enabled account without a stored secret', async () => {
    const db = makeDb({ id: 'u-nosecret', is_2fa_enabled: 1, totp_secret: null });
    const { WalletService } = await import('../services/wallet.js');
    const service = new WalletService(db as any);

    await expect(
      service.createWithdrawal('u-nosecret', { ...BASE_INPUT, totp_code: '123456' } as any),
    ).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_2FA' });
    expect(db.query).toHaveBeenCalledTimes(2);
  });
});
