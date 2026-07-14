/**
 * NovaBit Exchange — Application Configuration
 *
 * All configuration is sourced from environment variables with sensible defaults
 * for development. In production, all values must be set via the environment.
 */

import { z } from 'zod';

const envSchema = z.object({
  // Server
  NODE_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(3000),

  // PostgreSQL
  DATABASE_URL: z.string().default('postgres://novabit:novabit_secret@localhost:5432/novabit_exchange'),

  // Redis
  REDIS_URL: z.string().default('redis://localhost:6379'),

  // JWT
  JWT_SECRET: z.string().min(16).default('novabit-dev-jwt-secret-min-32-chars!!'),

  // CORS
  CORS_ORIGIN: z.string().default('http://localhost:5173,https://novabit-frontend1.onrender.com,https://novabit.exchange,https://062b1d0912863e846025d0fb0123f00c.ctonew.app'),

  // Rate Limiting
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),

  // Logging
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),

  // Wallet address generation
  WALLET_SEED: z.string().min(8).default('novabit-seed-change-in-production!!'),
});

export type EnvConfig = z.infer<typeof envSchema>;

function loadConfig(): EnvConfig {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    console.error('❌ Invalid configuration:', result.error.flatten().fieldErrors);
    process.exit(1);
  }
  return result.data;
}

export const config = loadConfig();