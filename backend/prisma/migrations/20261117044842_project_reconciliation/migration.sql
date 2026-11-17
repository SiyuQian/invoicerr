/*
  Warnings:

  - A unique constraint covering the columns `[companyId,id]` on the table `Client` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[companyId,id]` on the table `DocumentInstance` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[companyId,id]` on the table `Project` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "ReconciliationCollectionMode" AS ENUM ('COMPANY', 'PARTNER');

-- CreateEnum
CREATE TYPE "ReconciliationProjectStatus" AS ENUM ('ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ReconciliationCaseStatus" AS ENUM ('OPEN', 'CLOSED_VERIFIED', 'CLOSED_WITH_EXCEPTIONS');

-- CreateEnum
CREATE TYPE "ReconciliationDocumentRole" AS ENUM ('CUSTOMER_INVOICE', 'SETTLEMENT_INCOME', 'PARTNER_BILL', 'PROJECT_COST');

-- CreateEnum
CREATE TYPE "ReconciliationEvidenceClass" AS ENUM ('PARTNER_REPORTED', 'EVIDENCE_CHECKED');

-- CreateTable
CREATE TABLE "ReconciliationProject" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "currency" "Currency" NOT NULL,
    "endCustomerName" TEXT NOT NULL,
    "endCustomerClientId" TEXT,
    "partnerClientId" TEXT,
    "collectionMode" "ReconciliationCollectionMode" NOT NULL,
    "description" TEXT,
    "status" "ReconciliationProjectStatus" NOT NULL DEFAULT 'ACTIVE',
    "timeProjectId" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReconciliationProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationCase" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "period" TEXT,
    "status" "ReconciliationCaseStatus" NOT NULL DEFAULT 'OPEN',
    "agreedGrossMinor" INTEGER,
    "agreedNetMinor" INTEGER,
    "agreedTaxMinor" INTEGER,
    "agreementReference" TEXT,
    "agreementReason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "reviewedSourceFingerprint" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "source" TEXT,
    "externalId" TEXT,
    "sourceSnapshot" JSONB,
    "snapshotHash" TEXT,

    CONSTRAINT "ReconciliationCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomerInvoiceReference" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "collectionMode" "ReconciliationCollectionMode" NOT NULL,
    "caseId" TEXT NOT NULL,
    "documentLinkId" TEXT,
    "documentLinkRole" "ReconciliationDocumentRole",
    "issuer" TEXT,
    "recipient" TEXT,
    "invoiceNumber" TEXT,
    "issueDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "currency" "Currency",
    "originalGrossMinor" INTEGER,
    "creditAdjustmentMinor" INTEGER NOT NULL DEFAULT 0,
    "netMinor" INTEGER,
    "taxMinor" INTEGER,
    "reportedStatus" TEXT,
    "sourceReference" TEXT,
    "source" TEXT,
    "externalId" TEXT,
    "sourceSnapshot" JSONB,
    "snapshotHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomerInvoiceReference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalReceipt" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "collectionMode" "ReconciliationCollectionMode" NOT NULL DEFAULT 'PARTNER',
    "currency" "Currency" NOT NULL,
    "collector" TEXT NOT NULL,
    "grossMinor" INTEGER NOT NULL,
    "receivedAt" TIMESTAMP(3),
    "evidenceClass" "ReconciliationEvidenceClass" NOT NULL DEFAULT 'PARTNER_REPORTED',
    "sourceReference" TEXT NOT NULL,
    "evidenceReference" TEXT,
    "evidenceUrl" TEXT,
    "enteredBy" TEXT NOT NULL,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "humanAttestation" TEXT,
    "reason" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "voidedAt" TIMESTAMP(3),
    "voidedBy" TEXT,
    "voidReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalReceipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalReceiptAllocation" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "invoiceReferenceId" TEXT NOT NULL,
    "collectionMode" "ReconciliationCollectionMode" NOT NULL DEFAULT 'PARTNER',
    "amountMinor" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExternalReceiptAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectDocumentLink" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "caseId" TEXT,
    "documentId" TEXT NOT NULL,
    "role" "ReconciliationDocumentRole" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectDocumentLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReconciliationAuditEvent" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "operation" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "affectedRecord" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,

    CONSTRAINT "ReconciliationAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReconciliationProject_companyId_status_idx" ON "ReconciliationProject"("companyId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationProject_companyId_id_key" ON "ReconciliationProject"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationProject_companyId_id_currency_key" ON "ReconciliationProject"("companyId", "id", "currency");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationProject_companyId_id_collectionMode_key" ON "ReconciliationProject"("companyId", "id", "collectionMode");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationProject_companyId_id_currency_collectionMode_key" ON "ReconciliationProject"("companyId", "id", "currency", "collectionMode");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationProject_companyId_timeProjectId_key" ON "ReconciliationProject"("companyId", "timeProjectId");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationCase_companyId_source_externalId_key" ON "ReconciliationCase"("companyId", "source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationCase_companyId_projectId_id_key" ON "ReconciliationCase"("companyId", "projectId", "id");

-- CreateIndex
CREATE INDEX "CustomerInvoiceReference_companyId_issuer_invoiceNumber_iss_idx" ON "CustomerInvoiceReference"("companyId", "issuer", "invoiceNumber", "issueDate");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerInvoiceReference_companyId_projectId_id_collectionM_key" ON "CustomerInvoiceReference"("companyId", "projectId", "id", "collectionMode");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerInvoiceReference_companyId_documentLinkId_key" ON "CustomerInvoiceReference"("companyId", "documentLinkId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomerInvoiceReference_companyId_source_externalId_key" ON "CustomerInvoiceReference"("companyId", "source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalReceipt_companyId_projectId_id_key" ON "ExternalReceipt"("companyId", "projectId", "id");

-- CreateIndex
CREATE INDEX "ExternalReceiptAllocation_companyId_projectId_invoiceRefere_idx" ON "ExternalReceiptAllocation"("companyId", "projectId", "invoiceReferenceId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalReceiptAllocation_companyId_receiptId_invoiceRefere_key" ON "ExternalReceiptAllocation"("companyId", "receiptId", "invoiceReferenceId");

-- CreateIndex
CREATE INDEX "ProjectDocumentLink_companyId_projectId_idx" ON "ProjectDocumentLink"("companyId", "projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectDocumentLink_companyId_documentId_key" ON "ProjectDocumentLink"("companyId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectDocumentLink_reference_key" ON "ProjectDocumentLink"("companyId", "projectId", "caseId", "id", "role");

-- CreateIndex
CREATE INDEX "ReconciliationAuditEvent_companyId_projectId_occurredAt_idx" ON "ReconciliationAuditEvent"("companyId", "projectId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReconciliationAuditEvent_companyId_actor_requestKey_key" ON "ReconciliationAuditEvent"("companyId", "actor", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "Client_companyId_id_key" ON "Client"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentInstance_companyId_id_key" ON "DocumentInstance"("companyId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Project_companyId_id_key" ON "Project"("companyId", "id");

-- AddForeignKey
ALTER TABLE "ReconciliationProject" ADD CONSTRAINT "ReconciliationProject_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationProject" ADD CONSTRAINT "ReconciliationProject_companyId_endCustomerClientId_fkey" FOREIGN KEY ("companyId", "endCustomerClientId") REFERENCES "Client"("companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReconciliationProject" ADD CONSTRAINT "ReconciliationProject_companyId_partnerClientId_fkey" FOREIGN KEY ("companyId", "partnerClientId") REFERENCES "Client"("companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReconciliationProject" ADD CONSTRAINT "ReconciliationProject_companyId_timeProjectId_fkey" FOREIGN KEY ("companyId", "timeProjectId") REFERENCES "Project"("companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReconciliationCase" ADD CONSTRAINT "ReconciliationCase_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationCase" ADD CONSTRAINT "ReconciliationCase_companyId_projectId_fkey" FOREIGN KEY ("companyId", "projectId") REFERENCES "ReconciliationProject"("companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomerInvoiceReference" ADD CONSTRAINT "CustomerInvoiceReference_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomerInvoiceReference" ADD CONSTRAINT "CustomerInvoiceReference_companyId_projectId_collectionMod_fkey" FOREIGN KEY ("companyId", "projectId", "collectionMode") REFERENCES "ReconciliationProject"("companyId", "id", "collectionMode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomerInvoiceReference" ADD CONSTRAINT "CustomerInvoiceReference_companyId_projectId_caseId_fkey" FOREIGN KEY ("companyId", "projectId", "caseId") REFERENCES "ReconciliationCase"("companyId", "projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomerInvoiceReference" ADD CONSTRAINT "CustomerInvoiceReference_companyId_projectId_caseId_docume_fkey" FOREIGN KEY ("companyId", "projectId", "caseId", "documentLinkId", "documentLinkRole") REFERENCES "ProjectDocumentLink"("companyId", "projectId", "caseId", "id", "role") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "CustomerInvoiceReference" ADD CONSTRAINT "CustomerInvoiceReference_companyId_projectId_currency_fkey" FOREIGN KEY ("companyId", "projectId", "currency") REFERENCES "ReconciliationProject"("companyId", "id", "currency") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ExternalReceipt" ADD CONSTRAINT "ExternalReceipt_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalReceipt" ADD CONSTRAINT "ExternalReceipt_companyId_projectId_currency_collectionMod_fkey" FOREIGN KEY ("companyId", "projectId", "currency", "collectionMode") REFERENCES "ReconciliationProject"("companyId", "id", "currency", "collectionMode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ExternalReceiptAllocation" ADD CONSTRAINT "ExternalReceiptAllocation_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalReceiptAllocation" ADD CONSTRAINT "ExternalReceiptAllocation_companyId_projectId_receiptId_fkey" FOREIGN KEY ("companyId", "projectId", "receiptId") REFERENCES "ExternalReceipt"("companyId", "projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ExternalReceiptAllocation" ADD CONSTRAINT "ExternalReceiptAllocation_companyId_projectId_invoiceRefer_fkey" FOREIGN KEY ("companyId", "projectId", "invoiceReferenceId", "collectionMode") REFERENCES "CustomerInvoiceReference"("companyId", "projectId", "id", "collectionMode") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProjectDocumentLink" ADD CONSTRAINT "ProjectDocumentLink_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectDocumentLink" ADD CONSTRAINT "ProjectDocumentLink_companyId_projectId_fkey" FOREIGN KEY ("companyId", "projectId") REFERENCES "ReconciliationProject"("companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProjectDocumentLink" ADD CONSTRAINT "ProjectDocumentLink_companyId_projectId_caseId_fkey" FOREIGN KEY ("companyId", "projectId", "caseId") REFERENCES "ReconciliationCase"("companyId", "projectId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ProjectDocumentLink" ADD CONSTRAINT "ProjectDocumentLink_companyId_documentId_fkey" FOREIGN KEY ("companyId", "documentId") REFERENCES "DocumentInstance"("companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "ReconciliationAuditEvent" ADD CONSTRAINT "ReconciliationAuditEvent_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReconciliationAuditEvent" ADD CONSTRAINT "ReconciliationAuditEvent_companyId_projectId_fkey" FOREIGN KEY ("companyId", "projectId") REFERENCES "ReconciliationProject"("companyId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Prisma cannot express CHECK constraints. Int columns also impose PostgreSQL's 2^31-1 ceiling.
ALTER TABLE "ReconciliationProject" ADD CONSTRAINT "ReconciliationProject_shape_check" CHECK (
  length(btrim(name)) > 0 AND length(btrim("endCustomerName")) > 0 AND revision > 0
  AND ("collectionMode" <> 'PARTNER' OR "partnerClientId" IS NOT NULL)
);
ALTER TABLE "ReconciliationCase" ADD CONSTRAINT "ReconciliationCase_shape_check" CHECK (
  length(btrim(title)) > 0 AND version > 0
  AND ("agreedGrossMinor" IS NULL OR "agreedGrossMinor" >= 0)
  AND ("agreedNetMinor" IS NULL OR "agreedNetMinor" >= 0)
  AND ("agreedTaxMinor" IS NULL OR "agreedTaxMinor" >= 0)
  AND (("reviewedSourceFingerprint" IS NULL AND "reviewedBy" IS NULL AND "reviewedAt" IS NULL)
    OR ("reviewedSourceFingerprint" IS NOT NULL AND length(btrim("reviewedSourceFingerprint")) > 0
      AND "reviewedBy" IS NOT NULL AND length(btrim("reviewedBy")) > 0 AND "reviewedAt" IS NOT NULL))
  AND ((source IS NULL AND "externalId" IS NULL) OR
    (source IS NOT NULL AND length(btrim(source)) > 0 AND "externalId" IS NOT NULL AND length(btrim("externalId")) > 0))
  AND ("snapshotHash" IS NULL OR "snapshotHash" ~ '^[a-f0-9]{64}$')
  AND ("sourceSnapshot" IS NULL OR "snapshotHash" IS NOT NULL)
);
ALTER TABLE "CustomerInvoiceReference" ADD CONSTRAINT "CustomerInvoiceReference_shape_check" CHECK (
  ("collectionMode" = 'COMPANY' AND "documentLinkId" IS NOT NULL AND "documentLinkRole" IS NOT NULL
    AND "documentLinkRole" = 'CUSTOMER_INVOICE' AND issuer IS NULL AND recipient IS NULL
    AND "invoiceNumber" IS NULL AND "issueDate" IS NULL AND "dueDate" IS NULL AND currency IS NULL
    AND "originalGrossMinor" IS NULL AND "creditAdjustmentMinor" = 0 AND "netMinor" IS NULL AND "taxMinor" IS NULL
    AND "reportedStatus" IS NULL AND "sourceReference" IS NULL AND source IS NULL AND "externalId" IS NULL
    AND "sourceSnapshot" IS NULL AND "snapshotHash" IS NULL)
  OR ("collectionMode" = 'PARTNER' AND "documentLinkId" IS NULL AND "documentLinkRole" IS NULL
    AND issuer IS NOT NULL AND length(btrim(issuer)) > 0 AND recipient IS NOT NULL AND length(btrim(recipient)) > 0
    AND "invoiceNumber" IS NOT NULL AND length(btrim("invoiceNumber")) > 0 AND currency IS NOT NULL
    AND "originalGrossMinor" IS NOT NULL AND "originalGrossMinor" >= 0
    AND "creditAdjustmentMinor" >= 0 AND "creditAdjustmentMinor" <= "originalGrossMinor"
    AND ("netMinor" IS NULL OR "netMinor" >= 0) AND ("taxMinor" IS NULL OR "taxMinor" >= 0)
    AND "sourceReference" IS NOT NULL AND length(btrim("sourceReference")) > 0
    AND "snapshotHash" IS NOT NULL AND "snapshotHash" ~ '^[a-f0-9]{64}$'
    AND ((source IS NULL AND "externalId" IS NULL) OR
      (source IS NOT NULL AND length(btrim(source)) > 0 AND "externalId" IS NOT NULL AND length(btrim("externalId")) > 0)))
);
ALTER TABLE "ExternalReceipt" ADD CONSTRAINT "ExternalReceipt_shape_check" CHECK (
  "collectionMode" = 'PARTNER' AND "grossMinor" > 0 AND version > 0 AND length(btrim(collector)) > 0
  AND length(btrim("sourceReference")) > 0 AND length(btrim("enteredBy")) > 0
  AND ("evidenceUrl" IS NULL OR "evidenceUrl" ~ '^https://[^[:space:]]+$')
  AND (("reviewedBy" IS NULL AND "reviewedAt" IS NULL) OR
    ("reviewedBy" IS NOT NULL AND length(btrim("reviewedBy")) > 0 AND "reviewedAt" IS NOT NULL))
  AND ("evidenceClass" <> 'EVIDENCE_CHECKED' OR
    ("humanAttestation" IS NOT NULL AND length(btrim("humanAttestation")) > 0
      AND "evidenceReference" IS NOT NULL AND length(btrim("evidenceReference")) > 0
      AND "reviewedBy" IS NOT NULL AND "reviewedAt" IS NOT NULL))
  AND (("voidedAt" IS NULL AND "voidedBy" IS NULL AND "voidReason" IS NULL) OR
    ("voidedAt" IS NOT NULL AND "voidedBy" IS NOT NULL AND length(btrim("voidedBy")) > 0
      AND "voidReason" IS NOT NULL AND length(btrim("voidReason")) > 0))
);
ALTER TABLE "ExternalReceiptAllocation" ADD CONSTRAINT "ExternalReceiptAllocation_shape_check"
  CHECK ("amountMinor" > 0 AND "collectionMode" = 'PARTNER');
ALTER TABLE "ReconciliationAuditEvent" ADD CONSTRAINT "ReconciliationAuditEvent_shape_check" CHECK (
  actor ~ '^[a-z][a-z0-9_-]*:.+' AND "affectedRecord" ~ '^[a-z][a-z0-9_-]*:.+'
  AND length(btrim(operation)) > 0 AND length(btrim("requestKey")) > 0
);

-- A case without a partner cannot record a settlement agreement. Lock the parent while checking
-- so a concurrent partner removal cannot turn an accepted agreement into an orphaned assertion.
CREATE FUNCTION reconciliation_case_partner_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."agreedGrossMinor" IS NOT NULL OR NEW."agreedNetMinor" IS NOT NULL OR NEW."agreedTaxMinor" IS NOT NULL
    OR NEW."agreementReference" IS NOT NULL OR NEW."agreementReason" IS NOT NULL THEN
    PERFORM 1 FROM "ReconciliationProject" WHERE "companyId" = NEW."companyId" AND id = NEW."projectId"
      AND "partnerClientId" IS NOT NULL FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'A settlement agreement requires a project partner' USING ERRCODE = '23514'; END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ReconciliationCase_partner_check" BEFORE INSERT OR UPDATE ON "ReconciliationCase"
  FOR EACH ROW EXECUTE FUNCTION reconciliation_case_partner_check();
CREATE FUNCTION reconciliation_project_partner_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."partnerClientId" IS NULL AND EXISTS (
    SELECT 1 FROM "ReconciliationCase" WHERE "companyId" = OLD."companyId" AND "projectId" = OLD.id
      AND ("agreedGrossMinor" IS NOT NULL OR "agreedNetMinor" IS NOT NULL OR "agreedTaxMinor" IS NOT NULL
        OR "agreementReference" IS NOT NULL OR "agreementReason" IS NOT NULL)
  ) THEN RAISE EXCEPTION 'A settlement agreement requires a project partner' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ReconciliationProject_partner_check" BEFORE UPDATE ON "ReconciliationProject"
  FOR EACH ROW EXECUTE FUNCTION reconciliation_project_partner_check();

CREATE FUNCTION reconciliation_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Reconciliation audit events are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER "ReconciliationAuditEvent_immutable" BEFORE UPDATE ON "ReconciliationAuditEvent"
  FOR EACH ROW EXECUTE FUNCTION reconciliation_audit_immutable();
