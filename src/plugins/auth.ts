/**
 * NovaBit Exchange — JWT Authentication Plugin
 *
 * Registers @fastify/jwt and provides preHandler hooks for route protection.
 * Supports access tokens (short-lived) and refresh tokens (long-lived).
 */

import fp from 'fastify-plugin';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { config } from '../config/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
    optionalAuth: (
      request: FastifyRequest,
      reply: FastifyReply,
    ) => Promise<void>;
  }
}

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: {
      userId: string;
      role: string;
      sessionId?: string;
    };
    user: {
      id: string;
      role: string;
      sessionId?: string;
    };
  }
}

export default fp(async function authPlugin(fastify: FastifyInstance) {
  // Register JWT
  await fastify.register(import('@fastify/jwt'), {
    secret: config.JWT_SECRET,
    sign: {
      expiresIn: '15m', // short-lived access token
    },
  });

  // Register cookie support for refresh tokens
  await fastify.register(import('@fastify/cookie'), {
    secret: config.JWT_SECRET,
    parseOptions: {},
  });

  // ── Authenticate (required) ────────────────
  fastify.decorate(
    'authenticate',
    async function (request: FastifyRequest, reply: FastifyReply) {
      try {
        await request.jwtVerify();
      } catch (err) {
        reply.status(401).send({
          success: false,
          error: {
            code: 'UNAUTHORIZED',
            message: 'Invalid or expired token',
          },
          timestamp: Date.now(),
        });
      }
    },
  );

  // ── Authenticate (optional) ────────────────
  fastify.decorate(
    'optionalAuth',
    async function (request: FastifyRequest, _reply: FastifyReply) {
      try {
        await request.jwtVerify();
      } catch {
        // User is not authenticated — that's fine
      }
    },
  );
});