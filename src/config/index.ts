/**
 * NovaBit Exchange — Application Configuration
 *
 * All configuration is sourced from environment variables with sensible defaults
 * for development. In production, all values must be set via the environment.
 */

import { z } from 'zod';
import os from 'node:os';
import path from 'node:path';

const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),

  // PostgreSQL — production REQUIRES an explicit connection string. Empty is only
  // allowed in development/test and selects the in-memory SQLite adapter.
  DATABASE_URL: z.string().default(''),  // empty = dev/test-only in-memory SQLite

  // Redis — empty in dev/test = in-memory mock. Production requires a real URL.
  REDIS_URL: z.string().default(''),

  // JWT — production REQUIRES an explicit long secret; the dev default must never
  // reach production (would make issued tokens forgeable).
  JWT_SECRET: z.string().min(16).default('novabit-dev-jwt-secret-min-32-chars!!'),

  // CORS
  CORS_ORIGIN: z.string().default('http://localhost:5173,https://novabit-frontend1.onrender.com,https://novabit.exchange,https://062b1d0912863e846025d0fb0123f00c.ctonew.app'),

  // Rate Limiting
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  // Logging
  LOG_LEVEL: z.string().toLowerCase().pipe(z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])).default('info'),

  // Wallet address generation
  WALLET_SEED: z.string().min(8).default('novabit-seed-change-in-production!!'),
  // KYC document storage — MUST be a private, persistent directory owned by the
  // application user (identity documents are sensitive PII).
  //  - Default (dev/test): a private 0700 directory under the app user's home —
  //    never the shared team volume, never ephemeral /data.
  //  - Production: KYC_DATA_DIR MUST be set explicitly (see loadConfig) and the
  //    startup preflight (ensureKycDataDir) enforces 0700 + ownership + writability.
  KYC_DATA_DIR: z.string().default(() => path.join(os.homedir(), '.local/share/novabit/kyc')),
});

export type EnvConfig = z.infer<typeof envSchema>;

function loadConfig(): EnvConfig {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid configuration:', result.error.flatten().fieldErrors);
    process.exit(1);
  }
  const cfg = result.data;
  const isProd = cfg.NODE_ENV === 'production';
  // Production must NEVER fall back to a derived default for identity-document
  // storage — the operator has to point KYC_DATA_DIR at a private, persistent,
  // app-owned directory explicitly. Fail startup instead of guessing.
  if (isProd && !process.env.KYC_DATA_DIR) {
    console.error(
      '❌ Invalid configuration: KYC_DATA_DIR must be explicitly set in production. ' +
      'Point it at a private, persistent, application-owned directory (e.g. /var/lib/novabit/kyc). ' +
      'Sensitive identity documents must not be stored in a shared or ephemeral location.',
    );
    process.exit(1);
  }
  // Production deployment gate: an exchange MUST NOT boot against an ephemeral
  // in-memory database or the shipped JWT/seed defaults.
  if (isProd) {
    const missing: string[] = [];
    if (!process.env.DATABASE_URL) missing.push('DATABASE_URL');
    if (!process.env.REDIS_URL) missing.push('REDIS_URL');
    if (!process.env.JWT_SECRET) missing.push('JWT_SECRET');
    if (!process.env.WALLET_SEED) missing.push('WALLET_SEED');
    if (missing.length > 0) {
      console.error(
        `❌ Invalid configuration: production requires explicit ${missing.join(', ')}. ` +
        'Refusing to start with an ephemeral database or default secrets — ' +
        'provision real PostgreSQL/Redis and secrets before deploying.',
      );
      process.exit(1);
    }
  }
  return cfg;
}

export const config = loadConfig();