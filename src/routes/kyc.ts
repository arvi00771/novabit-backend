/**
 * NovaBit Exchange — KYC Routes
 *
 * POST /api/v1/kyc/submit      — Submit KYC application with documents
 * GET  /api/v1/kyc/status      — Get current KYC status
 * GET  /api/v1/kyc/documents   — Get KYC document list
 * GET  /api/v1/kyc/limits      — Get transaction limits for user
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { KYCService } from '../services/kyc.js';
import { AuditService } from '../services/audit.js';
import { LimitsService } from '../services/limits.js';
import { getDb } from '../db/index.js';
import { KYCSubmitSchema } from '../schemas/kyc.js';

const KYC_DATA_DIR = '/data/kyc';

function base64ToFile(dataUrl: string, userId: string, docType: string): { filePath: string; fileHash: string; fileSize: number } {
  // data URL format: "data:image/jpeg;base64,AAAA..."
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    // Not a data URL — treat as already a file path
    return { filePath: dataUrl, fileHash: crypto.createHash('sha256').update(dataUrl).digest('hex'), fileSize: 0 };
  }

  const mimeType = match[1];
  const base64Data = match[2];
  const buffer = Buffer.from(base64Data, 'base64');
  const fileHash = crypto.createHash('sha256').update(buffer).digest('hex');
  const ext = mimeType.split('/')[1] || 'jpg';
  const userDir = path.join(KYC_DATA_DIR, userId);

  if (!fs.existsSync(userDir)) {
    fs.mkdirSync(userDir, { recursive: true });
  }

  const filename = `${docType.toLowerCase()}_${Date.now()}.${ext}`;
  const filePath = path.join(userDir, filename);
  fs.writeFileSync(filePath, buffer);

  return { filePath, fileHash, fileSize: buffer.length };
}

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

    // Process documents: save base64 data URLs to disk, store file paths
    const documents = ((body.documents || []) as Array<Record<string, unknown>>).map(
      (doc: Record<string, unknown>) => {
        const rawPath = (doc.file_path as string) || '';
        const docType = (doc.document_type as string) || 'PASSPORT';
        const mimeType = (doc.mime_type as string) || 'image/jpeg';

        // If this is a base64 data URL, decode and save to disk
        if (rawPath.startsWith('data:')) {
          const saved = base64ToFile(rawPath, userId, docType);
          return {
            documentType: docType,
            filePath: saved.filePath,
            fileHash: saved.fileHash,
            fileSize: saved.fileSize,
            mimeType,
          };
        }

        // Otherwise treat as an existing file path
        return {
          documentType: docType,
          filePath: rawPath || '/dev/null',
          fileHash: (doc.file_hash as string) || crypto.createHash('sha256').update(rawPath || 'placeholder').digest('hex'),
          fileSize: Number(doc.file_size) || 0,
          mimeType,
        };
      },
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