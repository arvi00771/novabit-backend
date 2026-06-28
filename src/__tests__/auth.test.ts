/**
 * Unit tests for the Auth schemas and service validation logic.
 * These tests validate Zod schemas — no database required.
 */

import { describe, it, expect } from 'vitest';

describe('Auth Schemas - Register', () => {
  it('should accept valid registration input', async () => {
    const { RegisterSchema } = await import('../schemas/auth.js');

    const result = RegisterSchema.parse({
      email: 'user@example.com',
      password: 'securePass123!',
    });

    expect(result.email).toBe('user@example.com'); // lowered
    expect(result.password).toBe('securePass123!');
  });

  it('should lowercase email on registration', async () => {
    const { RegisterSchema } = await import('../schemas/auth.js');

    const result = RegisterSchema.parse({
      email: 'User@Example.COM',
      password: 'securePass123!',
    });

    expect(result.email).toBe('user@example.com');
  });

  it('should reject short passwords', async () => {
    const { RegisterSchema } = await import('../schemas/auth.js');

    expect(() =>
      RegisterSchema.parse({ email: 'test@test.com', password: '1234567' }),
    ).toThrow();
  });

  it('should reject invalid emails', async () => {
    const { RegisterSchema } = await import('../schemas/auth.js');

    expect(() =>
      RegisterSchema.parse({ email: 'not-an-email', password: 'securePass123!' }),
    ).toThrow();
  });

  it('should reject too-long emails', async () => {
    const { RegisterSchema } = await import('../schemas/auth.js');

    const longEmail = 'a'.repeat(250) + '@test.com';
    expect(() =>
      RegisterSchema.parse({ email: longEmail, password: 'securePass123!' }),
    ).toThrow();
  });
});

describe('Auth Schemas - Login', () => {
  it('should accept valid login input without 2FA', async () => {
    const { LoginSchema } = await import('../schemas/auth.js');

    const result = LoginSchema.parse({
      email: 'User@Example.COM',
      password: 'securePass123!',
    });

    expect(result.email).toBe('user@example.com');
    expect(result.password).toBe('securePass123!');
    expect(result.totp_code).toBeUndefined();
  });

  it('should accept login with 2FA code', async () => {
    const { LoginSchema } = await import('../schemas/auth.js');

    const result = LoginSchema.parse({
      email: 'test@test.com',
      password: 'password',
      totp_code: '123456',
    });

    expect(result.totp_code).toBe('123456');
  });

  it('should reject missing password', async () => {
    const { LoginSchema } = await import('../schemas/auth.js');

    expect(() =>
      LoginSchema.parse({ email: 'test@test.com' }),
    ).toThrow();
  });
});

describe('Auth Schemas - Refresh Token', () => {
  it('should accept valid UUID refresh token', async () => {
    const { RefreshSchema } = await import('../schemas/auth.js');

    const result = RefreshSchema.parse({
      refresh_token: '550e8400-e29b-41d4-a716-446655440000',
    });

    expect(result.refresh_token).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('should reject non-UUID tokens', async () => {
    const { RefreshSchema } = await import('../schemas/auth.js');

    expect(() =>
      RefreshSchema.parse({ refresh_token: 'not-a-uuid' }),
    ).toThrow();
  });
});

describe('Auth Schemas - 2FA Verify', () => {
  it('should accept valid 6-digit code', async () => {
    const { Verify2faSchema } = await import('../schemas/auth.js');

    const result = Verify2faSchema.parse({ totp_code: '123456' });
    expect(result.totp_code).toBe('123456');
  });

  it('should reject non-6-digit code', async () => {
    const { Verify2faSchema } = await import('../schemas/auth.js');

    expect(() => Verify2faSchema.parse({ totp_code: '12345' })).toThrow();
    expect(() => Verify2faSchema.parse({ totp_code: '1234567' })).toThrow();
    expect(() => Verify2faSchema.parse({ totp_code: 'abc123' })).toThrow();
  });
});

describe('Auth Schemas - 2FA Disable', () => {
  it('should accept valid disable input', async () => {
    const { Disable2faSchema } = await import('../schemas/auth.js');

    const result = Disable2faSchema.parse({
      totp_code: '654321',
      password: 'myPassword',
    });

    expect(result.totp_code).toBe('654321');
    expect(result.password).toBe('myPassword');
  });

  it('should reject missing password', async () => {
    const { Disable2faSchema } = await import('../schemas/auth.js');

    expect(() =>
      Disable2faSchema.parse({ totp_code: '123456' }),
    ).toThrow();
  });
});

describe('Auth Service - AppError creation', () => {
  it('should create proper error instances for auth failures', async () => {
    const { AppError } = await import('../middleware/error-handler.js');

    const emailExists = new AppError(409, 'EMAIL_EXISTS', 'An account with this email already exists');
    expect(emailExists.statusCode).toBe(409);
    expect(emailExists.code).toBe('EMAIL_EXISTS');

    const invalidCreds = new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    expect(invalidCreds.statusCode).toBe(401);
    expect(invalidCreds.code).toBe('INVALID_CREDENTIALS');

    const locked = new AppError(429, 'ACCOUNT_LOCKED', 'Account is temporarily locked');
    expect(locked.statusCode).toBe(429);

    const twofaRequired = new AppError(400, '2FA_REQUIRED', '2FA code is required');
    expect(twofaRequired.statusCode).toBe(400);
    expect(twofaRequired.code).toBe('2FA_REQUIRED');
  });
});

describe('Auth Schemas - Forgot Password', () => {
  it('should accept valid email', async () => {
    const { ForgotPasswordSchema } = await import('../schemas/auth.js');

    const result = ForgotPasswordSchema.parse({ email: 'User@Example.COM' });
    expect(result.email).toBe('user@example.com'); // lowered
  });

  it('should reject invalid email', async () => {
    const { ForgotPasswordSchema } = await import('../schemas/auth.js');

    expect(() => ForgotPasswordSchema.parse({ email: 'not-an-email' })).toThrow();
  });
});

describe('Auth Schemas - Reset Password', () => {
  it('should accept valid token and password', async () => {
    const { ResetPasswordSchema } = await import('../schemas/auth.js');

    const result = ResetPasswordSchema.parse({
      token: 'abc123def456token',
      password: 'newSecurePass123!',
    });

    expect(result.token).toBe('abc123def456token');
    expect(result.password).toBe('newSecurePass123!');
  });

  it('should reject short passwords', async () => {
    const { ResetPasswordSchema } = await import('../schemas/auth.js');

    expect(() =>
      ResetPasswordSchema.parse({ token: 'sometoken', password: '1234567' }),
    ).toThrow();
  });

  it('should reject missing token', async () => {
    const { ResetPasswordSchema } = await import('../schemas/auth.js');

    expect(() =>
      ResetPasswordSchema.parse({ password: 'newSecurePass123!' }),
    ).toThrow();
  });
});

describe('Migration - Password Resets', () => {
  it('should have the password_resets migration file', async () => {
    const { readdirSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const migrationsDir = join(__dirname, '..', 'db', 'migrations');
    const files = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    expect(files).toContain('006_create_password_resets.sql');
  });
});