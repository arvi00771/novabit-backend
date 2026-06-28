/**
 * NovaBit Exchange — Auth Routes
 *
 * POST /api/v1/auth/register       — Create a new account
 * POST /api/v1/auth/login          — Authenticate, get tokens
 * POST /api/v1/auth/refresh        — Rotate refresh token
 * POST /api/v1/auth/logout         — Revoke a refresh token
 * POST /api/v1/auth/logout/all     — Revoke all sessions
 * GET  /api/v1/auth/me             — Current user profile
 * POST /api/v1/auth/2fa/enable     — Generate TOTP secret
 * POST /api/v1/auth/2fa/verify     — Verify & enable 2FA
 * POST /api/v1/auth/2fa/disable    — Disable 2FA
 */

import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AuthService } from '../services/auth.js';
import { getDb } from '../db/index.js';
import { AppError } from '../middleware/error-handler.js';
import {
  RegisterSchema,
  LoginSchema,
  RefreshSchema,
  Verify2faSchema,
  Disable2faSchema,
  ForgotPasswordSchema,
  ResetPasswordSchema,
} from '../schemas/auth.js';

// ── Rate limiter key generators ────────────────
const ipKey = (req: FastifyRequest) => `auth:ip:${req.ip}`;
const userKey = (req: FastifyRequest) => `auth:user:${(req.user as any)?.id || 'anon'}`;

export default async function authRoutes(fastify: FastifyInstance) {
  const authService = new AuthService(getDb());

  // ── POST /register ──────────────────────────
  fastify.post(
    '/auth/register',
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: 60 * 60 * 1000, // 20 per hour
          keyGenerator: ipKey,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const input = RegisterSchema.parse(request.body);
      const user = await authService.register(input);

      return reply.status(201).send({
        success: true,
        data: {
          user_id: user.id,
          email: user.email,
          message: 'Account created successfully. Please log in.',
        },
        timestamp: Date.now(),
      });
    },
  );

  // ── POST /login ─────────────────────────────
  fastify.post(
    '/auth/login',
    {
      config: {
        rateLimit: {
          max: 10,
          timeWindow: 60 * 1000, // 10 per minute
          keyGenerator: ipKey,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const input = LoginSchema.parse(request.body);
      const deviceInfo = request.headers['user-agent'] || undefined;
      const ipAddress = request.ip;

      // Verify credentials
      const verified = await authService.verifyCredentials(
        input.email,
        input.password,
        input.totp_code,
      );

      // Generate access token (JWT) using Fastify's JWT
      const accessToken = fastify.jwt.sign(
        {
          userId: verified.id,
          role: verified.role,
        },
        { expiresIn: '15m' },
      );

      // Generate refresh token (opaque UUID stored in DB)
      const { refreshToken } = await authService.createRefreshToken(
        verified.id,
        deviceInfo,
        ipAddress,
      );

      return reply.send({
        success: true,
        data: {
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: 900, // 15 min in seconds
          token_type: 'Bearer',
          user: verified.profile,
        },
        timestamp: Date.now(),
      });
    },
  );

  // ── POST /refresh ───────────────────────────
  fastify.post(
    '/auth/refresh',
    {
      config: {
        rateLimit: {
          max: 20,
          timeWindow: 60 * 1000, // 20 per minute
          keyGenerator: ipKey,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const input = RefreshSchema.parse(request.body);
      const deviceInfo = request.headers['user-agent'] || undefined;
      const ipAddress = request.ip;

      // Validate the refresh token
      const validated = await authService.validateRefreshToken(input.refresh_token);
      if (!validated) {
        throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid or expired');
      }

      // Revoke the old token (rotation)
      await authService.revokeRefreshToken(validated.tokenRecordId);

      // Generate new access token
      const accessToken = fastify.jwt.sign(
        {
          userId: validated.userId,
          role: validated.role,
        },
        { expiresIn: '15m' },
      );

      // Generate new refresh token
      const { refreshToken } = await authService.createRefreshToken(
        validated.userId,
        deviceInfo,
        ipAddress,
      );

      return reply.send({
        success: true,
        data: {
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: 900,
          token_type: 'Bearer',
        },
        timestamp: Date.now(),
      });
    },
  );

  // ── POST /logout ────────────────────────────
  fastify.post(
    '/auth/logout',
    { preHandler: [fastify.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const { refresh_token } = request.body as { refresh_token?: string };
      if (refresh_token) {
        await authService.logout(refresh_token);
      }

      return reply.send({
        success: true,
        data: { message: 'Logged out successfully' },
        timestamp: Date.now(),
      });
    },
  );

  // ── POST /logout/all ────────────────────────
  fastify.post(
    '/auth/logout/all',
    { preHandler: [fastify.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request.user as any).id;
      await authService.logoutAll(userId);

      return reply.send({
        success: true,
        data: { message: 'All sessions logged out' },
        timestamp: Date.now(),
      });
    },
  );

  // ── GET /me ─────────────────────────────────
  fastify.get(
    '/auth/me',
    { preHandler: [fastify.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request.user as any).id;
      const profile = await authService.getUserProfile(userId);

      return reply.send({
        success: true,
        data: profile,
        timestamp: Date.now(),
      });
    },
  );

  // ── POST /2fa/enable ────────────────────────
  fastify.post(
    '/auth/2fa/enable',
    { preHandler: [fastify.authenticate] },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request.user as any).id;
      const setup = await authService.generate2faSecret(userId);

      return reply.send({
        success: true,
        data: setup,
        timestamp: Date.now(),
      });
    },
  );

  // ── POST /2fa/verify ────────────────────────
  fastify.post(
    '/auth/2fa/verify',
    {
      preHandler: [fastify.authenticate],
      config: {
        rateLimit: {
          max: 10,
          timeWindow: 60 * 1000, // 10 per minute
          keyGenerator: userKey,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request.user as any).id;
      const input = Verify2faSchema.parse(request.body);
      await authService.verifyAndEnable2fa(userId, input.totp_code);

      return reply.send({
        success: true,
        data: {
          message: '2FA has been enabled successfully',
          recovery_codes_hint: 'Save your recovery codes. They were shown during setup.',
        },
        timestamp: Date.now(),
      });
    },
  );

  // ── POST /2fa/disable ───────────────────────
  fastify.post(
    '/auth/2fa/disable',
    {
      preHandler: [fastify.authenticate],
      config: {
        rateLimit: {
          max: 5,
          timeWindow: 60 * 1000, // 5 per minute
          keyGenerator: userKey,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const userId = (request.user as any).id;
      const input = Disable2faSchema.parse(request.body);
      await authService.disable2fa(userId, input.password, input.totp_code);

      return reply.send({
        success: true,
        data: { message: '2FA has been disabled' },
        timestamp: Date.now(),
      });
    },
  );

  // ── POST /forgot-password ─────────────────────
  fastify.post(
    '/auth/forgot-password',
    {
      config: {
        rateLimit: {
          max: 3,
          timeWindow: 60 * 60 * 1000, // 3 per hour per IP
          keyGenerator: ipKey,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const input = ForgotPasswordSchema.parse(request.body);
      const result = await authService.forgotPassword(input.email);

      return reply.send({
        success: true,
        data: result,
        timestamp: Date.now(),
      });
    },
  );

  // ── POST /reset-password ──────────────────────
  fastify.post(
    '/auth/reset-password',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: 60 * 1000, // 5 per minute per IP
          keyGenerator: ipKey,
        },
      },
    },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const input = ResetPasswordSchema.parse(request.body);
      await authService.resetPassword(input.token, input.password);

      return reply.send({
        success: true,
        data: { message: 'Password has been reset successfully. Please log in with your new password.' },
        timestamp: Date.now(),
      });
    },
  );
}