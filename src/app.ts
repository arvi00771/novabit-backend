/**
 * NovaBit Exchange — Fastify Application Entry Point
 *
 * Creates and configures the Fastify server with all plugins,
 * routes, and middleware. Starts listening on the configured port.
 */

import Fastify from 'fastify';
import { config } from './config/index.js';
import { registerErrorHandler } from './middleware/error-handler.js';
import { closeConnections } from './db/index.js';

async function buildApp() {
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      ...(config.NODE_ENV === 'development' && {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }),
    },
    trustProxy: true,
    bodyLimit: 1_048_576, // 1MB
  });

  // ── Global middleware & plugins ────────────

  // CORS — allow frontend origins
  const allowedOrigins = [
    ...config.CORS_ORIGIN.split(',').map((o) => o.trim()),
    'https://novabit.exchange',
    'https://novabit-frontend1.onrender.com',
  ];
  await app.register(import('@fastify/cors'), {
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  } as any);

  // Security headers
  await app.register(import('@fastify/helmet'), {
    contentSecurityPolicy: false, // TradingView widgets require relaxed CSP
  });

  // Rate limiting
  await app.register(import('@fastify/rate-limit'), {
    max: config.RATE_LIMIT_MAX,
    timeWindow: config.RATE_LIMIT_WINDOW_MS,
    errorResponseBuilder: (_request, context) => {
      const afterMs = Number(context.after) || 0;
      return {
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message: `Rate limit exceeded. Max ${context.max} requests per ${Math.round(afterMs / 1000)}s.`,
        },
        timestamp: Date.now(),
      };
    },
  });

  // Swagger/OpenAPI documentation
  await app.register(import('@fastify/swagger'), {
    openapi: {
      info: {
        title: 'NovaBit Exchange API',
        description: 'REST API for the NovaBit cryptocurrency exchange',
        version: '0.1.0',
      },
      servers: [{ url: `http://localhost:${config.PORT}` }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
          apiKey: {
            type: 'apiKey',
            name: 'X-API-Key',
            in: 'header',
          },
        },
      },
    },
  });

  await app.register(import('@fastify/swagger-ui'), {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
    },
  });

  // Prometheus metrics
  await app.register(import('./plugins/metrics.js'));

  // Auth plugin (JWT)
  await app.register(import('./plugins/auth.js'));

  // WebSocket support (for real-time order book, trades, tickers)
  await app.register(import('@fastify/websocket'));

  // PostgreSQL & Redis connection plugins
  await app.register(import('@fastify/postgres'), {
    connectionString: config.DATABASE_URL,
  });

  // ── Error handler ──────────────────────────
  registerErrorHandler(app);

  // ── Routes ─────────────────────────────────
  await app.register(import('./routes/index.js'));

  // ── Graceful shutdown ──────────────────────
  const gracefulShutdown = async (signal: string) => {
    app.log.info(`Received ${signal}. Shutting down gracefully...`);
    await app.close();
    await closeConnections();
    process.exit(0);
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  return app;
}

// ── Start server ───────────────────────────────
async function main() {
  const app = await buildApp();

  try {
    await app.listen({
      host: config.HOST,
      port: config.PORT,
    });
    app.log.info(`NovaBit Exchange API running at http://${config.HOST}:${config.PORT}`);
    app.log.info(`Swagger docs at http://${config.HOST}:${config.PORT}/docs`);
  } catch (err: unknown) {
    app.log.error(err as Error, 'Failed to start server');
    await closeConnections();
    process.exit(1);
  }
}

main();

// Export for testing
export { buildApp };