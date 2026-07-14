/**
 * NovaBit Exchange — KYC Service
 *
 * Handles Know Your Customer compliance workflows:
 * - Document upload and metadata storage
 * - KYC status management
 * - Admin review workflow
 * - File handling with hash verification
 */

import pg from 'pg';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AppError } from '../middleware/error-handler.js';
import { KYCSubmitInput, KYCDocumentResponse, KYCStatusResponse } from '../schemas/kyc.js';

const KYC_DATA_DIR = '/data/kyc';

export class KYCService {
  constructor(private db: pg.Pool) {}

  /**
   * Submit KYC application with personal info and documents.
   * Documents are multipart file uploads handled by the route layer.
   * This method stores the metadata and updates user status.
   */
  async submitKYC(
    userId: string,
    personalInfo: KYCSubmitInput,
    documents: Array<{
      documentType: string;
      filePath: string;
      fileHash: string;
      fileSize: number;
      mimeType: string;
    }>,
  ): Promise<{ message: string; kyc_status: string }> {
    // Check current KYC status
    const userResult = await this.db.query(
      `SELECT kyc_status FROM users WHERE id = $1`,
      [userId],
    );

    if (userResult.rows.length === 0) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    }

    const currentStatus = userResult.rows[0].kyc_status;
    if (currentStatus === 'VERIFIED') {
      throw new AppError(400, 'ALREADY_VERIFIED', 'KYC is already verified');
    }
    if (currentStatus === 'PENDING') {
      throw new AppError(400, 'KYC_PENDING', 'KYC submission is already pending review');
    }

    // Validate minimum documents required
    const idDocuments = documents.filter(
      (d) => d.documentType !== 'SELFIE' && d.documentType !== 'PROOF_OF_ADDRESS',
    );
    if (idDocuments.length === 0) {
      throw new AppError(400, 'NO_ID_DOCUMENT', 'At least one identity document is required');
    }

    // Store KYC personal data in users table
    const kycData = {
      full_name: personalInfo.full_name,
      date_of_birth: personalInfo.date_of_birth,
      nationality: personalInfo.nationality,
      address: {
        street: personalInfo.address_street,
        city: personalInfo.address_city,
        postal_code: personalInfo.address_postal_code,
        country: personalInfo.address_country,
      },
      document_type: personalInfo.document_type,
      submitted_at: new Date().toISOString(),
    };

    await this.db.query('BEGIN');
    try {
      // Insert document records
      for (const doc of documents) {
        await this.db.query(
          `INSERT INTO kyc_documents (user_id, document_type, file_path, file_hash,
                                       file_size, mime_type, status)
           VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')`,
          [userId, doc.documentType, doc.filePath, doc.fileHash, doc.fileSize, doc.mimeType],
        );
      }

      // Update user KYC status
      await this.db.query(
        `UPDATE users SET kyc_status = 'PENDING', kyc_data = $1, updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(kycData), userId],
      );

      await this.db.query('COMMIT');
    } catch (err) {
      await this.db.query('ROLLBACK');
      throw err;
    }

    return {
      message: 'KYC application submitted successfully. It will be reviewed shortly.',
      kyc_status: 'PENDING',
    };
  }

  /**
   * Get current KYC status for a user.
   */
  async getKYCStatus(userId: string): Promise<KYCStatusResponse> {
    const result = await this.db.query(
      `SELECT kyc_status, kyc_verified_at FROM users WHERE id = $1`,
      [userId],
    );

    if (result.rows.length === 0) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    }

    const row = result.rows[0];
    return {
      kyc_status: row.kyc_status,
      kyc_verified_at: row.kyc_verified_at ? (row.kyc_verified_at as Date).toISOString() : null,
      verification_level: row.kyc_status === 'VERIFIED' ? 'FULL' : 'NONE',
    };
  }

  /**
   * Get KYC documents for a user.
   */
  async getKYCDocuments(userId: string): Promise<KYCDocumentResponse[]> {
    const result = await this.db.query(
      `SELECT id, user_id, document_type, file_path, file_hash, file_size,
              mime_type, status, rejection_reason, reviewed_at, created_at
       FROM kyc_documents
       WHERE user_id = $1
       ORDER BY created_at DESC`,
      [userId],
    );

    return result.rows.map((r: Record<string, unknown>) => ({
      id: r.id as string,
      user_id: r.user_id as string,
      document_type: r.document_type as string,
      file_path: r.file_path as string,
      file_hash: r.file_hash as string,
      file_size: r.file_size as number,
      mime_type: r.mime_type as string,
      status: r.status as string,
      rejection_reason: (r.rejection_reason as string) || null,
      reviewed_at: r.reviewed_at ? (r.reviewed_at as Date).toISOString() : null,
      created_at: (r.created_at as Date).toISOString(),
    }));
  }

  /**
   * Admin: List pending KYC submissions.
   */
  async listPendingKYC(options: { limit?: number; offset?: number } = {}): Promise<{
    submissions: Array<{
      user_id: string;
      email: string;
      full_name: string;
      kyc_status: string;
      kyc_data: Record<string, unknown> | null;
      documents: KYCDocumentResponse[];
      created_at: string;
    }>;
    total: number;
  }> {
    const limit = options.limit || 20;
    const offset = options.offset || 0;

    const countResult = await this.db.query(
      `SELECT COUNT(*) FROM users WHERE kyc_status = 'PENDING'`,
    );
    const total = parseInt(countResult.rows[0].count, 10);

    // Get users with pending KYC
    const usersResult = await this.db.query(
      `SELECT id, email, kyc_status, kyc_data, created_at
       FROM users
       WHERE kyc_status = 'PENDING'
       ORDER BY created_at ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset],
    );

    const submissions = [];
    for (const user of usersResult.rows) {
      const docs = await this.getKYCDocuments(user.id);
      const kycData = user.kyc_data ? (typeof user.kyc_data === 'string' ? JSON.parse(user.kyc_data) : user.kyc_data) : null;

      submissions.push({
        user_id: user.id,
        email: user.email,
        full_name: kycData?.full_name || 'Unknown',
        kyc_status: user.kyc_status,
        kyc_data: kycData,
        documents: docs,
        created_at: (user.created_at as Date).toISOString(),
      });
    }

    return { submissions, total };
  }

  /**
   * Admin: Approve KYC for a user.
   */
  async approveKYC(userId: string, adminId: string): Promise<{ message: string }> {
    const userResult = await this.db.query(
      `SELECT kyc_status FROM users WHERE id = $1`,
      [userId],
    );

    if (userResult.rows.length === 0) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    }

    if (userResult.rows[0].kyc_status !== 'PENDING') {
      throw new AppError(400, 'INVALID_STATUS',
        `Cannot approve KYC with status '${userResult.rows[0].kyc_status}'`);
    }

    await this.db.query('BEGIN');
    try {
      // Update user
      await this.db.query(
        `UPDATE users SET kyc_status = 'VERIFIED', kyc_verified_at = NOW(), updated_at = NOW()
         WHERE id = $1`,
        [userId],
      );

      // Approve all pending documents
      await this.db.query(
        `UPDATE kyc_documents SET status = 'APPROVED', reviewed_at = NOW(), reviewed_by = $1
         WHERE user_id = $2 AND status = 'PENDING'`,
        [adminId, userId],
      );

      await this.db.query('COMMIT');
    } catch (err) {
      await this.db.query('ROLLBACK');
      throw err;
    }

    return { message: 'KYC has been approved. User is now verified.' };
  }

  /**
   * Admin: Reject KYC for a user.
   */
  async rejectKYC(userId: string, adminId: string, reason: string): Promise<{ message: string }> {
    const userResult = await this.db.query(
      `SELECT kyc_status FROM users WHERE id = $1`,
      [userId],
    );

    if (userResult.rows.length === 0) {
      throw new AppError(404, 'USER_NOT_FOUND', 'User not found');
    }

    if (userResult.rows[0].kyc_status !== 'PENDING') {
      throw new AppError(400, 'INVALID_STATUS',
        `Cannot reject KYC with status '${userResult.rows[0].kyc_status}'`);
    }

    await this.db.query('BEGIN');
    try {
      // Update user
      await this.db.query(
        `UPDATE users SET kyc_status = 'REJECTED', updated_at = NOW()
         WHERE id = $1`,
        [userId],
      );

      // Reject all pending documents
      await this.db.query(
        `UPDATE kyc_documents SET status = 'REJECTED', rejection_reason = $1,
         reviewed_at = NOW(), reviewed_by = $2
         WHERE user_id = $3 AND status = 'PENDING'`,
        [reason, adminId, userId],
      );

      await this.db.query('COMMIT');
    } catch (err) {
      await this.db.query('ROLLBACK');
      throw err;
    }

    return { message: `KYC has been rejected. Reason: ${reason}` };
  }

  /**
   * Save uploaded file to disk and return file info.
   */
  async saveUploadedFile(
    userId: string,
    documentType: string,
    fileBuffer: Buffer,
    mimeType: string,
  ): Promise<{ filePath: string; fileHash: string; fileSize: number }> {
    const userDir = path.join(KYC_DATA_DIR, userId);
    if (!fs.existsSync(userDir)) {
      fs.mkdirSync(userDir, { recursive: true });
    }

    const fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    const ext = mimeType.split('/')[1] || 'jpg';
    const filename = `${documentType.toLowerCase()}_${Date.now()}.${ext}`;
    const filePath = path.join(userDir, filename);

    fs.writeFileSync(filePath, fileBuffer);

    return {
      filePath,
      fileHash,
      fileSize: fileBuffer.length,
    };
  }
}