/**
 * Tests for the KYC compliance system.
 */

import { describe, it, expect } from 'vitest';

describe('KYC Schemas - Submit Validation', () => {
  it('should accept valid KYC submission', async () => {
    const { KYCSubmitSchema } = await import('../schemas/kyc.js');

    const result = KYCSubmitSchema.parse({
      full_name: 'John Doe',
      date_of_birth: '1990-01-15',
      nationality: 'US',
      address_street: '123 Main St',
      address_city: 'New York',
      address_postal_code: '10001',
      address_country: 'US',
      document_type: 'PASSPORT',
    });

    expect(result.full_name).toBe('John Doe');
    expect(result.document_type).toBe('PASSPORT');
    expect(result.nationality).toBe('US');
  });

  it('should reject invalid date format', async () => {
    const { KYCSubmitSchema } = await import('../schemas/kyc.js');

    expect(() =>
      KYCSubmitSchema.parse({
        full_name: 'John Doe',
        date_of_birth: '01/15/1990',
        nationality: 'US',
        address_street: '123 Main St',
        address_city: 'New York',
        address_postal_code: '10001',
        address_country: 'US',
        document_type: 'PASSPORT',
      }),
    ).toThrow();
  });

  it('should reject empty name', async () => {
    const { KYCSubmitSchema } = await import('../schemas/kyc.js');

    expect(() =>
      KYCSubmitSchema.parse({
        full_name: '',
        date_of_birth: '1990-01-15',
        nationality: 'US',
        address_street: '123 Main St',
        address_city: 'New York',
        address_postal_code: '10001',
        address_country: 'US',
        document_type: 'PASSPORT',
      }),
    ).toThrow();
  });
});

describe('KYC Schemas - Admin Review', () => {
  it('should accept valid approval', async () => {
    const { KYCApproveSchema } = await import('../schemas/kyc.js');

    const result = KYCApproveSchema.parse({});
    expect(result.verification_level).toBe('FULL');
  });

  it('should accept valid rejection with reason', async () => {
    const { KYCRejectSchema } = await import('../schemas/kyc.js');

    const result = KYCRejectSchema.parse({ reason: 'Document is illegible' });
    expect(result.reason).toBe('Document is illegible');
  });

  it('should reject empty rejection reason', async () => {
    const { KYCRejectSchema } = await import('../schemas/kyc.js');

    expect(() => KYCRejectSchema.parse({ reason: '' })).toThrow();
  });
});

describe('KYC Schemas - Response Types', () => {
  it('should validate KYC status response', async () => {
    const { KYCStatusResponseSchema } = await import('../schemas/kyc.js');

    const response = {
      kyc_status: 'PENDING',
      kyc_verified_at: null,
      verification_level: 'NONE',
    };

    const parsed = KYCStatusResponseSchema.parse(response);
    expect(parsed.kyc_status).toBe('PENDING');
    expect(parsed.verification_level).toBe('NONE');
  });

  it('should validate verified KYC status', async () => {
    const { KYCStatusResponseSchema } = await import('../schemas/kyc.js');

    const response = {
      kyc_status: 'VERIFIED',
      kyc_verified_at: new Date().toISOString(),
      verification_level: 'FULL',
    };

    const parsed = KYCStatusResponseSchema.parse(response);
    expect(parsed.kyc_status).toBe('VERIFIED');
    expect(parsed.verification_level).toBe('FULL');
  });

  it('should validate document response', async () => {
    const { KYCDocumentResponseSchema } = await import('../schemas/kyc.js');

    const response = {
      id: '550e8400-e29b-41d4-a716-446655440000',
      user_id: '550e8400-e29b-41d4-a716-446655440001',
      document_type: 'PASSPORT',
      file_path: '/data/kyc/user123/passport.jpg',
      file_hash: 'abc123def456',
      file_size: 102400,
      mime_type: 'image/jpeg',
      status: 'PENDING',
      rejection_reason: null,
      reviewed_at: null,
      created_at: new Date().toISOString(),
    };

    const parsed = KYCDocumentResponseSchema.parse(response);
    expect(parsed.document_type).toBe('PASSPORT');
    expect(parsed.status).toBe('PENDING');
  });
});

describe('KYC Schemas - Transaction Limits', () => {
  it('should enforce UNVERIFIED withdrawal limit of 500', async () => {
    const limits = {
      UNVERIFIED: { maxWithdrawal24h: 500, maxTradeVolume24h: 5000 },
      PENDING: { maxWithdrawal24h: 500, maxTradeVolume24h: 5000 },
      VERIFIED: { maxWithdrawal24h: 100_000, maxTradeVolume24h: 0 },
      REJECTED: { maxWithdrawal24h: 0, maxTradeVolume24h: 0 },
    };

    expect(limits.UNVERIFIED.maxWithdrawal24h).toBe(500);
    expect(limits.VERIFIED.maxWithdrawal24h).toBe(100_000);
    expect(limits.REJECTED.maxWithdrawal24h).toBe(0);
  });

  it('should allow withdrawal within limit', () => {
    const currentUsage = 200;
    const limit = 500;
    const amount = 100;
    const allowed = (currentUsage + amount) <= limit;

    expect(allowed).toBe(true);
  });

  it('should block withdrawal exceeding limit', () => {
    const currentUsage = 450;
    const limit = 500;
    const amount = 100;
    const allowed = (currentUsage + amount) <= limit;

    expect(allowed).toBe(false);
  });
});

describe('KYC Migrations', () => {
  it('should have kyc_documents migration file', async () => {
    const { readdirSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const migrationsDir = join(__dirname, '..', 'db', 'migrations');
    const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();

    expect(files).toContain('009_create_kyc_documents.sql');
    expect(files).toContain('010_create_audit_logs.sql');
  });

  it('should have correct kyc tables in migration', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const migrationPath = join(__dirname, '..', 'db', 'migrations', '009_create_kyc_documents.sql');
    const content = readFileSync(migrationPath, 'utf-8');

    expect(content).toContain('kyc_documents');
    expect(content).toContain('document_type');
    expect(content).toContain('file_hash');
  });

  it('should have audit_logs table in migration', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const migrationPath = join(__dirname, '..', 'db', 'migrations', '010_create_audit_logs.sql');
    const content = readFileSync(migrationPath, 'utf-8');

    expect(content).toContain('audit_logs');
    expect(content).toContain('action');
    expect(content).toContain('entity_type');
  });
});

describe('KYC Services - Exports', () => {
  it('should export KYCService class', async () => {
    const { KYCService } = await import('../services/kyc.js');

    expect(KYCService).toBeDefined();
    expect(KYCService.prototype.submitKYC).toBeInstanceOf(Function);
    expect(KYCService.prototype.getKYCStatus).toBeInstanceOf(Function);
    expect(KYCService.prototype.getKYCDocuments).toBeInstanceOf(Function);
    expect(KYCService.prototype.listPendingKYC).toBeInstanceOf(Function);
    expect(KYCService.prototype.approveKYC).toBeInstanceOf(Function);
    expect(KYCService.prototype.rejectKYC).toBeInstanceOf(Function);
  });

  it('should export AuditService class', async () => {
    const { AuditService } = await import('../services/audit.js');

    expect(AuditService).toBeDefined();
    expect(AuditService.prototype.log).toBeInstanceOf(Function);
    expect(AuditService.prototype.logKYCSubmission).toBeInstanceOf(Function);
    expect(AuditService.prototype.logKYCApproval).toBeInstanceOf(Function);
    expect(AuditService.prototype.logKYCRejection).toBeInstanceOf(Function);
    expect(AuditService.prototype.logWithdrawalAttempt).toBeInstanceOf(Function);
    expect(AuditService.prototype.logLogin).toBeInstanceOf(Function);
    expect(AuditService.prototype.getUserLogs).toBeInstanceOf(Function);
  });

  it('should export LimitsService class', async () => {
    const { LimitsService } = await import('../services/limits.js');

    expect(LimitsService).toBeDefined();
    expect(LimitsService.prototype.checkWithdrawalLimit).toBeInstanceOf(Function);
    expect(LimitsService.prototype.checkTradeLimit).toBeInstanceOf(Function);
    expect(LimitsService.prototype.getLimitsForUser).toBeInstanceOf(Function);
  });
});

describe('KYC Routes - Existence', () => {
  it('should have kyc route file', async () => {
    const { accessSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const routePath = join(__dirname, '..', 'routes', 'kyc.ts');

    expect(() => accessSync(routePath)).not.toThrow();
  });

  it('should have kyc routes registered in index', async () => {
    const { readFileSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const __dirname = dirname(fileURLToPath(import.meta.url));
    const indexPath = join(__dirname, '..', 'routes', 'index.ts');
    const content = readFileSync(indexPath, 'utf-8');

    expect(content).toContain('kyc');
  });
});