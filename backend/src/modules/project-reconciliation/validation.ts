import { BadRequestException } from '@nestjs/common';
import { isIP } from 'node:net';
import { z } from 'zod';
import { Currency } from '../../../prisma/generated/prisma/client';

const text = (max: number) => z.string().trim().min(1).max(max);
const id = text(200);
const name = text(200);
const note = text(4000);
const sourceCents = z.number().int().nonnegative();
const amount = sourceCents.max(2147483647);
const currency = z.enum(Currency);
const date = z.iso.date();
const instant = z.iso.datetime({ offset: true });
const mode = z.enum(['COMPANY', 'PARTNER']);
const projectFields = {
  name,
  endCustomerName: name,
  currency,
  collectionMode: mode,
  endCustomerClientId: id.nullable(),
  partnerClientId: id.nullable(),
  timeProjectId: id.nullable(),
  description: note.nullable(),
};
function parties(
  value: { collectionMode?: string; endCustomerClientId?: string | null; partnerClientId?: string | null },
  ctx: z.RefinementCtx,
) {
  if (value.collectionMode === 'PARTNER' && !value.partnerClientId)
    ctx.addIssue({ code: 'custom', message: 'PARTNER requires a partner client', path: ['partnerClientId'] });
  if (value.endCustomerClientId && value.endCustomerClientId === value.partnerClientId)
    ctx.addIssue({ code: 'custom', message: 'Customer and partner must differ', path: ['partnerClientId'] });
}
const project = z.strictObject(projectFields).superRefine(parties);
const caseFields = {
  title: name,
  periodStart: date.nullable(),
  periodEnd: date.nullable(),
  agreedGrossMinor: amount.nullable(),
  agreedNetMinor: amount.nullable(),
  agreedVatMinor: amount.nullable(),
  agreementReference: note.nullable(),
};
function period(value: { periodStart?: string | null; periodEnd?: string | null }, ctx: z.RefinementCtx) {
  if (value.periodStart && value.periodEnd && value.periodStart > value.periodEnd)
    ctx.addIssue({ code: 'custom', message: 'Period start must precede its end', path: ['periodEnd'] });
}
const caseInput = z.strictObject(caseFields).superRefine(period);
function sourcePair(value: { sourceSystem?: string | null; sourceId?: string | null }, ctx: z.RefinementCtx) {
  if (!!value.sourceSystem !== !!value.sourceId)
    ctx.addIssue({ code: 'custom', message: 'Supply both sourceSystem and sourceId', path: ['sourceId'] });
}
const evidenceUrl = z
  .string()
  .max(2048)
  .refine((value) => {
    if (/\s/.test(value)) return false;
    try {
      const url = new URL(value);
      const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !isIP(host) &&
        host.includes('.') &&
        !/(^|\.)(localhost|local|internal|test)$/i.test(host)
      );
    } catch {
      return false;
    }
  }, 'Use a public HTTPS evidence URL without credentials');
const provenance = { sourceSystem: text(200).nullable().optional(), sourceId: id.nullable().optional() };
const invoiceReviewFields = {
  duplicateReview: z
    .strictObject({
      invoiceIds: z.array(id).min(1).max(1000),
      fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
      evidenceReference: note,
      reason: note,
      attested: z.literal(true),
    })
    .optional(),
  creditResolution: z
    .strictObject({ evidenceReference: note, reason: note, attested: z.literal(true) })
    .optional(),
};
const invoiceFields = {
  issuer: name,
  recipient: name,
  number: text(100),
  issueDate: date.nullable(),
  dueDate: date.nullable(),
  currency,
  grossMinor: amount,
  netMinor: amount.nullable(),
  vatMinor: amount.nullable(),
  reportedStatus: text(200).nullable(),
  sourceSystem: text(200).nullable(),
  sourceId: id.nullable(),
  sourceAsOf: instant.nullable(),
  sourceReference: note,
};
function invoiceDates(value: { issueDate?: string | null; dueDate?: string | null }, ctx: z.RefinementCtx) {
  if (value.issueDate && value.dueDate && value.issueDate > value.dueDate)
    ctx.addIssue({ code: 'custom', message: 'Issue date must precede due date', path: ['dueDate'] });
}
const receiptFields = {
  amountMinor: amount.positive(),
  currency,
  paidOn: date.nullable(),
  evidenceClass: z.enum(['PARTNER_REPORTED', 'EVIDENCE_CHECKED']),
  attested: z
    .literal(true)
    .optional()
    .describe(
      'Required explicitly on each mutation resulting in EVIDENCE_CHECKED; never inferred or inherited.',
    ),
  evidenceReference: note.nullable(),
  evidenceUrl: evidenceUrl.nullable(),
  reason: note,
  ...provenance,
};
const receipt = z
  .strictObject(receiptFields)
  .superRefine(sourcePair)
  .superRefine((value, ctx) => {
    if (value.evidenceClass === 'EVIDENCE_CHECKED') {
      if (!value.evidenceReference)
        ctx.addIssue({
          code: 'custom',
          message: 'Checked evidence requires a reference',
          path: ['evidenceReference'],
        });
      if (value.attested !== true)
        ctx.addIssue({
          code: 'custom',
          message: 'Checked evidence requires explicit attestation',
          path: ['attested'],
        });
    }
  });
const historicalCents = z.number().int();
const percent = z.number().min(0).max(100);
const sourceCard = z.strictObject({
  label: z.string().trim().max(200),
  issuer: z.string().trim().max(200),
  recipient: z.string().trim().max(200),
  number: z.string().trim().max(100).nullable(),
  pending: z.boolean(),
  amountCents: historicalCents,
  totalCents: historicalCents,
});
const snapshot = z
  .strictObject({
    customerCard: sourceCard.optional(),
    shareCard: sourceCard.optional(),
    lineItems: z
      .array(
        z.strictObject({
          category: name,
          description: note,
          amountCents: historicalCents,
          earnsReferralFee: z.boolean(),
          revenueType: name,
          treatment: name,
        }),
      )
      .max(1000)
      .optional(),
    calculation: z
      .strictObject({
        sourceSubtotalCents: historicalCents,
        eligibleSubtotalCents: historicalCents,
        internalSubtotalCents: historicalCents,
        thirdPartyCostsCents: historicalCents,
        passThroughExpensesCents: historicalCents,
        sharePercent: percent,
        gstAmountCents: historicalCents,
        totalCents: historicalCents,
      })
      .optional(),
  })
  .refine(
    (value) => Buffer.byteLength(JSON.stringify(value), 'utf8') <= 65536,
    'Source snapshot is too large',
  );
const ledgerlyRow = z.strictObject({
  id,
  projectId: z.string().trim().max(200).nullable().optional(),
  number: text(100),
  projectName: z.string().trim().max(200),
  issuer: name,
  recipient: name,
  kind: z.enum(['Customer invoice', 'Internal share']),
  status: z.enum(['Needs review', 'Paid', 'Sent']),
  issueDate: date.nullable(),
  dueDate: date.nullable(),
  paidDate: date.nullable(),
  exGstAmountCents: sourceCents,
  gstAmountCents: sourceCents,
  totalCents: sourceCents,
  sharePercent: z.number().min(0).max(100).nullable(),
  sourceNumber: text(100).nullable(),
  linkedInvoiceNumber: text(100).nullable(),
  sourceSnapshot: snapshot.optional(),
});
const ledgerlyPayload = z.strictObject({
  sourceSystem: z.literal('ledgerly'),
  sourceAsOf: instant,
  currency,
  project: z.strictObject({
    id,
    name,
    customerIssuer: name,
    customerRecipient: name,
    shareIssuer: name,
    shareRecipient: name,
  }),
  invoices: z.array(ledgerlyRow).max(1000),
});
const reviewState = z.enum(['OPEN', 'CLOSED_VERIFIED', 'CLOSED_WITH_EXCEPTIONS']);
const count = z.number().int().nonnegative();
const associationLabel = z.strictObject({ id, name, inactive: z.boolean() });
const projectRecord = z.strictObject({
  ...projectFields,
  id,
  companyId: id,
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  version: count.positive(),
  identityLocked: z.boolean(),
  createdAt: instant,
  updatedAt: instant,
  endCustomerClient: associationLabel.nullable(),
  partnerClient: associationLabel.nullable(),
  timeProject: associationLabel.nullable(),
});
const caseRecord = z.strictObject({
  ...caseFields,
  id,
  companyId: id,
  projectId: id,
  status: reviewState,
  version: count.positive(),
  createdAt: instant,
  updatedAt: instant,
});
function pageOf<T extends z.ZodType>(item: T) {
  return z.strictObject({ items: z.array(item), nextCursor: id.nullable(), total: count });
}
const registerFields = {
  project: projectRecord,
  cases: pageOf(caseRecord),
  versionToken: text(200),
  asOf: instant,
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
};
const moneyFields = {
  knownMinor: z.number().int(),
  missingCount: count,
  completeness: z.enum(['COMPLETE', 'PARTIAL', 'UNKNOWN']),
};
const moneyMeasure = z
  .strictObject(moneyFields)
  .refine(
    (value) => value.missingCount === 0 || value.completeness !== 'COMPLETE',
    'A subtotal with missing records is not complete',
  );
const undatedMeasure = z
  .strictObject({ ...moneyFields, count })
  .refine(
    (value) => value.missingCount === 0 || value.completeness !== 'COMPLETE',
    'A subtotal with missing records is not complete',
  );
const summary = z.strictObject({
  customerInvoiced: moneyMeasure,
  customerCredits: moneyMeasure,
  customerCollectible: moneyMeasure,
  customerRemaining: moneyMeasure,
  agreedSettlement: moneyMeasure,
  unbilledDifference: moneyMeasure,
  settlementInvoiced: moneyMeasure,
  ownRecordedReceipts: moneyMeasure,
  ownOutstanding: moneyMeasure,
  partnerBills: moneyMeasure,
  partnerPaid: moneyMeasure,
  partnerOutstanding: moneyMeasure,
  projectCosts: moneyMeasure,
});
const problemFields = {
  code: text(100),
  message: note,
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
};
const problem = z.strictObject(problemFields);
const exception = z.strictObject({
  ...problemFields,
  fingerprint: text(200),
  caseId: id.nullable(),
  blocking: z.boolean(),
});
const coverageResult = z.strictObject({
  customerInvoiceIds: z.array(id),
  receiptIds: z.array(id),
  allocationIds: z.array(id),
  sourceAsOf: instant,
  evidenceReference: note,
  attested: z.literal(true),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  attestedBy: text(400),
  attestedAt: instant,
});
const reviewResult = z.strictObject({
  case: caseRecord,
  mode: z.enum(['VERIFY', 'ACCEPT_EXCEPTIONS', 'REOPEN']),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  exceptions: z.array(z.strictObject({ code: text(100), fingerprint: text(200), reason: note })),
  reason: note,
  reviewedBy: text(400),
  reviewedAt: instant,
});
const documentLink = z.strictObject({
  id,
  documentId: id,
  typeId: z.enum(['invoice', 'expense', 'received-invoice']),
  caseId: id.nullable(),
  role: z.enum(['CUSTOMER_INVOICE', 'SETTLEMENT_INCOME', 'PARTNER_BILL', 'PROJECT_COST']),
});
const customerInvoice = z.strictObject({
  id,
  caseId: id,
  documentLinkId: id.nullable(),
  external: z.strictObject(invoiceFields).superRefine(sourcePair).nullable(),
});
const externalInvoiceRecord = z.strictObject({
  id,
  companyId: id,
  projectId: id,
  caseId: id,
  documentLinkId: z.null(),
  external: z.strictObject(invoiceFields).superRefine(sourcePair).superRefine(invoiceDates),
  originalGrossMinor: amount,
  creditAdjustmentMinor: amount,
  adjustedGrossMinor: amount,
  sourceSnapshot: z.record(z.string(), z.unknown()),
  snapshotHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: instant,
  updatedAt: instant,
});
const receiptRecord = z.strictObject({
  id,
  companyId: id,
  projectId: id,
  amountMinor: amount.positive(),
  currency,
  paidOn: date.nullable(),
  collector: name,
  evidenceClass: receiptFields.evidenceClass,
  sourceReference: note,
  evidenceReference: note.nullable(),
  evidenceUrl: evidenceUrl.nullable(),
  reason: note.nullable(),
  sourceSystem: text(200).nullable(),
  sourceId: id.nullable(),
  enteredBy: id,
  reviewedBy: id.nullable(),
  reviewedAt: instant.nullable(),
  humanAttestation: note.nullable(),
  version: count.positive(),
  voidedAt: instant.nullable(),
  voidedBy: id.nullable(),
  voidReason: note.nullable(),
  createdAt: instant,
  updatedAt: instant,
});
const allocationRecord = z.strictObject({
  id,
  customerInvoiceId: id,
  amountMinor: amount.positive(),
  createdAt: instant,
});
const receiptAllocationsRecord = z.strictObject({
  receiptId: id,
  allocations: z.array(allocationRecord),
  allocatedMinor: count,
  unallocatedMinor: count,
});
const financialRead = z.strictObject({
  documentId: id,
  typeId: documentLink.shape.typeId,
  status: text(200),
  displayNumber: z.string().nullable(),
  currency: z.string().nullable(),
  grossMinor: z.number().int().nullable(),
  netMinor: z.number().int().nullable(),
  vatMinor: z.number().int().nullable(),
  paymentKnowledge: z.enum(['KNOWN', 'UNKNOWN', 'UNSUPPORTED']),
  settlement: z
    .strictObject({
      paidMinor: count,
      creditedMinor: count,
      outstandingMinor: count,
      excessMinor: count,
      settled: z.boolean(),
    })
    .nullable(),
  payments: z.array(
    z.strictObject({
      source: z.enum(['document-payment', 'disbursement-event']),
      id,
      documentAmountMinor: count,
      originalAmountMinor: count,
      originalCurrency: z.string(),
      paidOn: z.string().nullable(),
    }),
  ),
  sourceVersion: text(200),
  warnings: z.array(problem),
});
const documentLinkView = documentLink.extend({ issueDate: date.nullable(), financial: financialRead });
const coverageView = coverageResult.pick({
  sourceAsOf: true,
  evidenceReference: true,
  sourceFingerprint: true,
  attestedBy: true,
  attestedAt: true,
});
const caseCoverageView = z.strictObject({
  state: z.enum(['NOT_APPLICABLE', 'MISSING', 'CURRENT', 'STALE']),
  invoices: z.array(
    z.strictObject({ customerInvoiceId: id, current: z.boolean(), attestation: coverageView.nullable() }),
  ),
});
const externalInvoiceView = externalInvoiceRecord.extend({
  caseTitle: name,
  allocatedMinor: count,
  availableMinor: count,
});
const customerInvoiceView = z.union([
  z.strictObject({ id, caseId: id, documentLinkId: id, external: z.null() }),
  externalInvoiceView,
]);
const allocationInvoiceContext = externalInvoiceView
  .pick({
    id: true,
    caseId: true,
    caseTitle: true,
    originalGrossMinor: true,
    creditAdjustmentMinor: true,
    adjustedGrossMinor: true,
    allocatedMinor: true,
    availableMinor: true,
  })
  .extend({ number: text(100), currency });
const allocationView = allocationRecord.extend({ customerInvoice: allocationInvoiceContext });
const receiptView = receiptRecord.extend({
  allocations: z.array(allocationView).max(1000),
  allocatedMinor: count,
  unallocatedMinor: count,
});
const historyRecord = z.strictObject({
  id,
  actor: text(400),
  occurredAt: instant,
  operation: text(200),
  affectedRecord: text(400),
  before: z.unknown().nullable().describe('Stored JSON before-state or null; not an editable DTO.'),
  after: z.unknown().nullable().describe('Stored JSON after-state or null; not an editable DTO.'),
  reason: note.nullable(),
});
const receiptMeasures = {
  sourceMarkedPaid: moneyMeasure,
  checkedReceipts: moneyMeasure,
  reportedReceipts: moneyMeasure,
  undated: z.strictObject({
    checkedReceipts: undatedMeasure,
    reportedReceipts: undatedMeasure,
    ownRecordedReceipts: undatedMeasure,
  }),
};
const caseView = caseRecord.extend({
  summary,
  ...receiptMeasures,
  coverage: caseCoverageView,
  reviewDecision: reviewResult.extend({ current: z.boolean() }).nullable(),
  customerInvoices: z.array(customerInvoiceView),
  documentLinks: z.array(documentLinkView),
  effectiveReviewState: reviewState,
  exceptions: z.array(exception),
});
const projectView = z.strictObject({
  ...registerFields,
  summary,
  ...receiptMeasures,
  attentionCount: count,
  unknownAgreementCount: count,
  effectiveReviewState: reviewState,
  exceptions: z.array(exception),
  warnings: z.array(problem),
  cases: pageOf(caseView),
  unallocatedDocumentLinks: z.array(documentLinkView),
});
const pageQuery = z.strictObject({
  cursor: id.optional(),
  limit: z
    .string()
    .regex(/^(?:[1-9]|[1-9][0-9]|100)$/)
    .optional(),
});
const projectListRow = z.strictObject({
  project: projectRecord,
  versionToken: text(200),
  asOf: instant,
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  summary,
  effectiveReviewState: reviewState,
  attentionCount: count,
});
const projectListQuery = pageQuery.extend({
  search: z.string().trim().max(200).optional(),
  status: z.enum(['ACTIVE', 'ARCHIVED', 'ALL']).optional(),
  collectionMode: mode.optional(),
  needsAttention: z.enum(['true', 'false']).optional(),
});
const reportDateQuery = z.strictObject({
  invoiceFrom: date.optional(),
  invoiceTo: date.optional(),
  cashFrom: date.optional(),
  cashTo: date.optional(),
});
function reportDates(value: z.infer<typeof reportDateQuery>, ctx: z.RefinementCtx) {
  for (const [from, to] of [
    [value.invoiceFrom, value.invoiceTo],
    [value.cashFrom, value.cashTo],
  ])
    if (from && to && from > to)
      ctx.addIssue({ code: 'custom', message: 'Date range start must precede its end' });
}
function targetCursor(value: { cursor?: string; caseId?: string; receiptId?: string }, ctx: z.RefinementCtx) {
  if (value.cursor && (value.caseId || value.receiptId))
    ctx.addIssue({
      code: 'custom',
      message: 'Exact target selectors cannot be combined with cursor pagination',
      path: ['cursor'],
    });
}
const reportQuery = pageQuery
  .extend({ ...reportDateQuery.shape, caseId: id.optional() })
  .superRefine(reportDates)
  .superRefine(targetCursor);
const receiptQuery = pageQuery.extend({ receiptId: id.optional() }).superRefine(targetCursor);
const exportQuery = reportDateQuery.superRefine(reportDates);
const invoiceChoiceQuery = pageQuery.extend({ search: z.string().trim().max(200).optional() });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const selectedImportMatch = z.strictObject({
  sourceId: id,
  documentId: id,
  typeId: documentLink.shape.typeId,
  caseSourceId: id,
});
const importPreviewInput = z.strictObject({
  payload: ledgerlyPayload,
  selectedMatches: z.array(selectedImportMatch).max(1000),
});
const importConfirm = importPreviewInput.extend({ previewHash: hash });
const importIssue = problem.extend({
  sourceIds: z.array(id),
  caseSourceId: id.nullable(),
  blocking: z.boolean(),
});
const importCounts = z.strictObject({
  sourceRows: count,
  casesToCreate: count,
  referencesToCreate: count,
  linksToCreate: count,
  reused: count,
  revisions: count,
  unresolved: count,
  errors: count,
});
const importCaseProposal = z.strictObject({
  caseSourceId: id,
  sourceIds: z.array(id),
  caseId: id.nullable(),
  action: z.enum(['CREATE', 'REUSE', 'REVISION']),
  existing: caseRecord.nullable(),
  proposed: caseInput,
  existingSnapshotHash: hash.nullable(),
  proposedSnapshotHash: hash,
});
const importReferenceProposal = z.strictObject({
  sourceId: id,
  caseSourceId: id,
  referenceId: id.nullable(),
  action: z.enum(['CREATE', 'REUSE', 'REVISION']),
  existing: externalInvoiceRecord.nullable(),
  proposed: z.strictObject(invoiceFields).superRefine(sourcePair).superRefine(invoiceDates),
  proposedSnapshotHash: hash,
});
const importCandidate = z.strictObject({
  documentId: id,
  typeId: documentLink.shape.typeId,
  basis: z.enum(['CONTEXTUAL_REFERENCE', 'EXPLICIT_SELECTION']),
  financial: financialRead,
});
const importLinkProposal = z.strictObject({
  sourceId: id,
  caseSourceId: id,
  role: documentLink.shape.role,
  historical: externalInvoiceRecord.shape.external,
  candidates: z.array(importCandidate),
  selectedMatch: selectedImportMatch.nullable(),
  existingLinkId: id.nullable(),
  action: z.enum(['CREATE', 'REUSE', 'UNRESOLVED']),
});
const importPreview = z.strictObject({
  previewHash: hash,
  sourceHash: hash,
  projectVersion: text(200),
  sourceAsOf: instant,
  proposedCases: z.array(importCaseProposal),
  proposedReferences: z.array(importReferenceProposal),
  proposedLinks: z.array(importLinkProposal),
  unresolved: z.array(importIssue),
  errors: z.array(importIssue),
  counts: importCounts,
});
const importApplied = z.strictObject({
  previewHash: hash,
  sourceHash: hash,
  sourceAsOf: instant,
  cases: z.array(z.strictObject({ caseSourceId: id, caseId: id, created: z.boolean() })),
  references: z.array(z.strictObject({ sourceId: id, referenceId: id, created: z.boolean() })),
  links: z.array(z.strictObject({ sourceId: id, linkId: id, created: z.boolean() })),
  unresolved: z.array(importIssue),
  counts: importCounts,
});
export const schemas = {
  selectedImportMatch,
  importPreviewInput,
  importConfirm,
  importIssue,
  importCounts,
  importCaseProposal,
  importReferenceProposal,
  importCandidate,
  importLinkProposal,
  importPreview,
  importApplied,
  importResult: z.strictObject({ result: importApplied, versionToken: text(200), changed: z.boolean() }),
  caseCoverageView,
  financialRead,
  documentLinkView,
  coverageView,
  externalInvoiceView,
  customerInvoiceView,
  allocationView,
  receiptView,
  receiptPage: pageOf(receiptView),
  externalInvoicePage: pageOf(externalInvoiceView),
  historyRecord,
  historyPage: pageOf(historyRecord),
  reportQuery,
  receiptQuery,
  exportQuery,
  invoiceChoiceQuery,
  recordId: z.strictObject({ id }),
  coverageResult,
  reviewResult,
  externalInvoiceRecord,
  receiptRecord,
  allocationRecord,
  receiptAllocationsRecord,
  invoiceTarget: z.strictObject({ caseId: id, invoiceId: id.optional() }),
  receiptTarget: z.strictObject({ receiptId: id }),
  creditTarget: z.strictObject({ invoiceId: id }),
  projectListRow,
  projectListPage: pageOf(projectListRow),
  projectListQuery,
  associationLabel,
  projectRecord,
  caseRecord,
  projectPage: pageOf(projectRecord),
  registerView: z.strictObject(registerFields),
  moneyMeasure,
  caseView,
  projectView,
  documentLink,
  customerInvoice,
  exception,
  summary,
  createProject: project,
  updateProject: z
    .strictObject(projectFields)
    .partial()
    .extend({ status: z.enum(['ACTIVE', 'ARCHIVED']).optional() }),
  createCase: caseInput,
  updateCase: z.strictObject(caseFields).partial().superRefine(period),
  externalInvoice: z
    .strictObject({ ...invoiceFields, ...invoiceReviewFields })
    .superRefine(sourcePair)
    .superRefine(invoiceDates),
  receipt,
  updateReceipt: z.strictObject(receiptFields).partial().extend({ reason: note }),
  updateExternalInvoice: z.strictObject({ ...invoiceFields, ...invoiceReviewFields }).partial(),
  allocation: z.strictObject({ customerInvoiceId: id, amountMinor: amount.positive() }),
  allocations: z
    .strictObject({
      allocations: z
        .array(z.strictObject({ customerInvoiceId: id, amountMinor: amount.positive() }))
        .max(1000),
    })
    .superRefine((value, ctx) => {
      if (new Set(value.allocations.map((a) => a.customerInvoiceId)).size !== value.allocations.length)
        ctx.addIssue({
          code: 'custom',
          message: 'Invoice allocations must be unique',
          path: ['allocations'],
        });
    }),
  linkDocument: z.strictObject({
    documentId: id,
    typeId: z.enum(['invoice', 'expense', 'received-invoice']),
    caseId: id.nullable(),
    role: z.enum(['CUSTOMER_INVOICE', 'SETTLEMENT_INCOME', 'PARTNER_BILL', 'PROJECT_COST']),
  }),
  reviewCase: z.strictObject({
    mode: z.enum(['VERIFY', 'ACCEPT_EXCEPTIONS', 'REOPEN']),
    exceptions: z.array(z.strictObject({ code: text(100), fingerprint: text(200), reason: note })).max(1000),
    reason: note,
  }),
  evidenceCoverage: z.strictObject({
    customerInvoiceIds: z.array(id).min(1).max(1000),
    sourceAsOf: instant,
    evidenceReference: note,
    attested: z.literal(true),
  }),
  creditAdjustment: z
    .strictObject({ amountMinor: amount.positive(), sourceReference: note, reason: note, ...provenance })
    .superRefine(sourcePair),
  reason: z.strictObject({ reason: note }),
  ledgerlyRow,
  ledgerlyPayload,
  envelope: z.strictObject({ requestKey: text(200), expectedVersion: text(200) }),
  page: pageQuery,
};
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new BadRequestException({ code: 'INVALID_INPUT', message: 'Expected a plain object.' });
  const result = schema.safeParse(value);
  if (!result.success)
    throw new BadRequestException({
      code: 'INVALID_INPUT',
      message: 'Invalid reconciliation input.',
      issues: result.error.issues,
    });
  return result.data;
}
export function parseMutation<T>(schema: z.ZodType<T>, value: unknown) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new BadRequestException({ code: 'INVALID_INPUT', message: 'Expected a plain object.' });
  const { requestKey, expectedVersion, ...input } = value as Record<string, unknown>;
  return { input: parse(schema, input), ...parse(schemas.envelope, { requestKey, expectedVersion }) };
}
export function encodePeriod(start: string | null, end: string | null): string | null {
  return start === null && end === null ? null : `${start ?? ''}/${end ?? ''}`;
}
export function decodePeriod(value: string | null): { periodStart: string | null; periodEnd: string | null } {
  const [start, end] = value?.split('/') ?? [];
  return { periodStart: start || null, periodEnd: end || null };
}

/** Check the original parsed HTTP body before schemas trim or normalize any fields. */
export function assertImportSize(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') > 2 * 1024 * 1024)
    throw new BadRequestException({ code: 'IMPORT_INPUT_TOO_LARGE', message: 'Import input exceeds 2MiB.' });
  const payload =
    value && typeof value === 'object' ? (value as { payload?: { invoices?: unknown } }).payload : null;
  if (Array.isArray(payload?.invoices))
    for (const row of payload.invoices) {
      if (
        row &&
        typeof row === 'object' &&
        'sourceSnapshot' in row &&
        Buffer.byteLength(JSON.stringify(row.sourceSnapshot) ?? '', 'utf8') > 65536
      )
        throw new BadRequestException({
          code: 'IMPORT_INPUT_TOO_LARGE',
          message: 'Source snapshot exceeds 64KiB.',
        });
    }
}
