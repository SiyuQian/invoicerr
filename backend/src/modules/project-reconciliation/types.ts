import type { z } from 'zod';
import type { schemas } from './validation';
import type { DocumentFinancialRead, Problem } from '../documents/settlement/financial-read.service';
export type { DocumentFinancialRead, Problem };
export type ProjectId = string;
export type CollectionMode = 'COMPANY' | 'PARTNER';
export type ReviewState = 'OPEN' | 'CLOSED_VERIFIED' | 'CLOSED_WITH_EXCEPTIONS';
export type MutationContext = {
  actor: { id: string; kind: 'user' | 'api-key' };
  requestKey: string;
  expectedVersion: string;
};
export type MutationBody<T> = T & Pick<MutationContext, 'requestKey' | 'expectedVersion'>;
export type MutationResult<T> = { result: T; versionToken: string; changed: boolean };
export type Page<T> = { items: T[]; nextCursor: string | null; total: number };
export type MoneyMeasure = {
  knownMinor: number;
  missingCount: number;
  completeness: 'COMPLETE' | 'PARTIAL' | 'UNKNOWN';
};
export type CreateProjectInput = z.infer<typeof schemas.createProject>;
export type UpdateProjectInput = z.infer<typeof schemas.updateProject>;
export type CreateCaseInput = z.infer<typeof schemas.createCase>;
export type UpdateCaseInput = z.infer<typeof schemas.updateCase>;
export type ExternalInvoiceInput = z.infer<typeof schemas.externalInvoice>;
export type UpdateExternalInvoiceInput = z.infer<typeof schemas.updateExternalInvoice>;
export type UpdateReceiptInput = z.infer<typeof schemas.updateReceipt>;
export type CreditAdjustmentInput = z.infer<typeof schemas.creditAdjustment>;
export type ImportConfirmInput = z.infer<typeof schemas.importConfirm>;
export type ReceiptInput = z.infer<typeof schemas.receipt>;
export type AllocationInput = z.infer<typeof schemas.allocation>;
export type LinkDocumentInput = z.infer<typeof schemas.linkDocument>;
export type ReviewCaseInput = z.infer<typeof schemas.reviewCase>;
export type EvidenceCoverageInput = z.infer<typeof schemas.evidenceCoverage>;
export type LedgerlyInvoiceRow = z.infer<typeof schemas.ledgerlyRow>;
export type LedgerlyProjectPayload = z.infer<typeof schemas.ledgerlyPayload>;
export type AssociationLabel = z.infer<typeof schemas.associationLabel>;
export type ProjectRecord = z.infer<typeof schemas.projectRecord>;
export type CaseRecord = z.infer<typeof schemas.caseRecord>;
export type RegisterView = z.infer<typeof schemas.registerView>;
// T6 implements the declared report fields; T3 register routes return RegisterView.
export type ReconciliationException = z.infer<typeof schemas.exception>;
export type DocumentLinkRecord = z.infer<typeof schemas.documentLink>;
export type CustomerInvoiceRecord = z.infer<typeof schemas.customerInvoice>;
export type CaseView = z.infer<typeof schemas.caseView>;
export type ProjectView = z.infer<typeof schemas.projectView>;
export type ProjectListRow = z.infer<typeof schemas.projectListRow>;
export type ProjectListQuery = z.infer<typeof schemas.projectListQuery>;
export type ProjectSummary = z.infer<typeof schemas.summary>;

export type ExternalInvoiceRecord = z.infer<typeof schemas.externalInvoiceRecord>;
export type ReceiptRecord = z.infer<typeof schemas.receiptRecord>;
export type AllocationRecord = z.infer<typeof schemas.allocationRecord>;
export type ReceiptAllocationsRecord = z.infer<typeof schemas.receiptAllocationsRecord>;
export type SaveExternalInvoiceInput =
  | ({ caseId: string; invoiceId?: undefined } & ExternalInvoiceInput)
  | ({ caseId: string; invoiceId: string } & UpdateExternalInvoiceInput);
export type UpdateExternalReceiptInput = UpdateReceiptInput & { receiptId: string };
export type ReplaceReceiptAllocationsInput = z.infer<typeof schemas.allocations> & { receiptId: string };
export type VoidExternalReceiptInput = z.infer<typeof schemas.reason> & { receiptId: string };
export type ApplyExternalCreditInput = CreditAdjustmentInput & { invoiceId: string };

export type CoverageResult = z.infer<typeof schemas.coverageResult>;
export type ReviewResult = z.infer<typeof schemas.reviewResult>;

export type DocumentLinkView = z.infer<typeof schemas.documentLinkView>;
export type ExternalInvoiceView = z.infer<typeof schemas.externalInvoiceView>;
export type CustomerInvoiceView = z.infer<typeof schemas.customerInvoiceView>;
export type ReceiptView = z.infer<typeof schemas.receiptView>;
export type HistoryRecord = z.infer<typeof schemas.historyRecord>;
export type ReportQuery = z.infer<typeof schemas.reportQuery>;

export type CaseCoverageView = z.infer<typeof schemas.caseCoverageView>;

export type SelectedImportMatch = z.infer<typeof schemas.selectedImportMatch>;
export type ImportPreviewInput = z.infer<typeof schemas.importPreviewInput>;
export type ImportPreview = z.infer<typeof schemas.importPreview>;
export type ImportApplied = z.infer<typeof schemas.importApplied>;
export type ImportResult = MutationResult<ImportApplied>;
export type ImportIssue = z.infer<typeof schemas.importIssue>;

export type ReceiptQuery = z.infer<typeof schemas.receiptQuery>;
