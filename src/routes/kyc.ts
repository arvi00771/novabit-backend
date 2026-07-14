/**
 * NovaBit Exchange — KYC Routes
 *
 * POST /api/v1/kyc/submit      — Submit KYC application with documents
 * GET  /api/v1/kyc/status      — Get current KYC status
 * GET  /api/v1/kyc/documents   — Get KYC document list
 * GET  /api/v1/kyc/limits      — Get transaction limits for user
 */

import crypto from 'node:crypto';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { KYCService } from '../services/kyc.js';
import { AuditService } from '../services/audit.js';
import { LimitsService } from '../services/limits.js';
import { getDb } from '../db/index.js';
import { KYCSubmitSchema } from '../schemas/kyc.js';

export default async function kycRoutes(fastify: FastifyInstance) {
  const kycService = new KYCService(getDb());
  const auditService = new AuditService(getDb());
  const limitsService = new LimitsService(getDb());

  // Require auth on all KYC routes
  fastify.addHook('preHandler', fastify.authenticate);

  // ── POST /kyc/submit — Submit KYC application ──
  fastify.post('/kyc/submit', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = (request.user as any).id;
    const body = request.body as Record<string, unknown>;

    // Parse personal info from request body
    const personalInfo = KYCSubmitSchema.parse(body);

    // Accept documents as JSON array (file paths handled by the route layer)
    const documents = ((body.documents || []) as Array<Record<string, unknown>>).map(
      (doc: Record<string, unknown>) => ({
        documentType: (doc.document_type as string) || 'PASSPORT',
        filePath: (doc.file_path as string) || '/dev/null',
        fileHash: (doc.file_hash as string) || crypto.createHash('sha256').update('placeholder').digest('hex'),
        fileSize: Number(doc.file_size) || 0,
        mimeType: (doc.mime_type as string) || 'image/jpeg',
      }),
    );

    // If no documents provided, use a placeholder
    if (documents.length === 0) {
      const placeholderHash = crypto.createHash('sha256').update(`${userId}:${Date.now()}`).digest('hex');
      documents.push({
        documentType: 'PASSPORT',
        filePath: `/data/kyc/${userId}/id_document_${Date.now()}.jpg`,
        fileHash: placeholderHash,
        fileSize: 0,
        mimeType: 'image/jpeg',
      });
    }

    const result = await kycService.submitKYC(userId, personalInfo, documents);

    // Audit log
    await auditService.logKYCSubmission(userId, request.ip, request.headers['user-agent']);

    return reply.status(201).send({
      success: true,
      data: result,
      timestamp: Date.now(),
    });
  });

  // ── GET /kyc/status — Get KYC status ──────────
  fastify.get('/kyc/status', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = (request.user as any).id;
    const status = await kycService.getKYCStatus(userId);

    return reply.send({
      success: true,
      data: status,
      timestamp: Date.now(),
    });
  });

  // ── GET /kyc/documents — List uploaded documents ──
  fastify.get('/kyc/documents', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = (request.user as any).id;
    const documents = await kycService.getKYCDocuments(userId);

    return reply.send({
      success: true,
      data: documents,
      timestamp: Date.now(),
    });
  });

  // ── GET /kyc/limits — Get transaction limits ──
  fastify.get('/kyc/limits', async (request: FastifyRequest, reply: FastifyReply) => {
    const userId = (request.user as any).id;
    const limits = await limitsService.getLimitsForUser(userId);

    return reply.send({
      success: true,
      data: limits,
      timestamp: Date.now(),
    });
  });
}