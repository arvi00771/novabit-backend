/**
 * NovaBit Exchange — Global Error Handler
 *
 * Provides consistent error responses across the API.
 */

import { FastifyInstance, FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { ZodError } from 'zod';

export class AppError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function registerErrorHandler(fastify: FastifyInstance): void {
  fastify.setErrorHandler(
    (error: FastifyError | AppError | ZodError | Error, request: FastifyRequest, reply: FastifyReply) => {
      const requestId = request.id;

      // Zod validation errors
      if (error instanceof ZodError) {
        return reply.status(400).send({
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: 'Request validation failed',
            details: error.errors.map((e) => ({
              path: e.path.join('.'),
              message: e.message,
            })),
          },
          timestamp: Date.now(),
        });
      }

      // Application errors
      if (error instanceof AppError) {
        return reply.status(error.statusCode).send({
          success: false,
          error: {
            code: error.code,
            message: error.message,
            details: error.details,
          },
          timestamp: Date.now(),
        });
      }

      // Fastify built-in errors
      if ('statusCode' in error && typeof (error as FastifyError).statusCode === 'number') {
        return reply.status((error as FastifyError).statusCode!).send({
          success: false,
          error: {
            code: (error as FastifyError).code || 'INTERNAL_ERROR',
            message: error.message,
          },
          timestamp: Date.now(),
        });
      }

      // Unknown errors
      console.error(`[${requestId}] Unhandled error:`, error);
      return reply.status(500).send({
        success: false,
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected error occurred',
        },
        timestamp: Date.now(),
      });
    },
  );
}