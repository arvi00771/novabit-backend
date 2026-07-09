-- 009_create_kyc_documents.sql
-- NovaBit Exchange — KYC Document Storage

BEGIN;

CREATE TABLE IF NOT EXISTS kyc_documents (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_type   VARCHAR(30) NOT NULL CHECK (document_type IN ('PASSPORT', 'DRIVERS_LICENSE', 'NATIONAL_ID', 'SELFIE', 'PROOF_OF_ADDRESS')),
    file_path       VARCHAR(500) NOT NULL,
    file_hash       VARCHAR(128) NOT NULL,
    file_size       INTEGER NOT NULL DEFAULT 0,
    mime_type       VARCHAR(50) NOT NULL DEFAULT 'image/jpeg',
    status          VARCHAR(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
    rejection_reason VARCHAR(500),
    reviewed_at     TIMESTAMPTZ,
    reviewed_by     UUID REFERENCES users(id),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_kyc_documents_user_id ON kyc_documents (user_id);
CREATE INDEX idx_kyc_documents_status ON kyc_documents (status);
CREATE INDEX idx_kyc_documents_user_status ON kyc_documents (user_id, status);

COMMIT;