import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  CustomerInvoiceReference,
  ExternalReceipt,
  ReconciliationProject,
} from '../../../prisma/generated/prisma/client';
import { ReconciliationService, reconciliationConflict, reconciliationHash } from './service';
import { parse, schemas } from './validation';
import type {
  ApplyExternalCreditInput,
  ExternalInvoiceRecord,
  UpdateExternalInvoiceInput,
  MutationContext,
  ReceiptInput,
  ReceiptRecord,
  ReplaceReceiptAllocationsInput,
  SaveExternalInvoiceInput,
  UpdateExternalReceiptInput,
  VoidExternalReceiptInput,
} from './types';

import { collectedPeaks } from './external-history';

const actorName = (context: MutationContext) => `${context.actor.kind}:${context.actor.id}`;
const date = (value: Date | null) => value?.toISOString().slice(0, 10) ?? null;
const instant = (value: Date | null) => value?.toISOString() ?? null;
const missing = (label: string): never => {
  throw new NotFoundException({ code: 'NOT_FOUND', message: `${label} not found.` });
};
function partnerProject(project: ReconciliationProject, currency?: string) {
  if (project.collectionMode !== 'PARTNER')
    reconciliationConflict('External evidence requires partner collection.');
  if (currency && project.currency !== currency)
    reconciliationConflict('Currency must match the project.', 'CURRENCY_MISMATCH');
}
function snapshot(row: CustomerInvoiceReference): Record<string, Prisma.JsonValue> {
  return row.sourceSnapshot && typeof row.sourceSnapshot === 'object' && !Array.isArray(row.sourceSnapshot)
    ? row.sourceSnapshot
    : {};
}
export function invoiceRecord(row: CustomerInvoiceReference): ExternalInvoiceRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    caseId: row.caseId,
    documentLinkId: null,
    external: {
      issuer: row.issuer!,
      recipient: row.recipient!,
      number: row.invoiceNumber!,
      issueDate: date(row.issueDate),
      dueDate: date(row.dueDate),
      currency: row.currency!,
      grossMinor: row.originalGrossMinor!,
      netMinor: row.netMinor,
      vatMinor: row.taxMinor,
      reportedStatus: row.reportedStatus,
      sourceReference: row.sourceReference!,
      sourceSystem: row.source,
      sourceId: row.externalId,
      sourceAsOf: (snapshot(row).sourceAsOf as string | null) ?? null,
    },
    originalGrossMinor: row.originalGrossMinor!,
    creditAdjustmentMinor: row.creditAdjustmentMinor,
    adjustedGrossMinor: row.originalGrossMinor! - row.creditAdjustmentMinor,
    sourceSnapshot: snapshot(row),
    snapshotHash: row.snapshotHash!,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
export type ReceiptProvenance = { sourceSystem: string | null; sourceId: string | null };
export function receiptRecord(row: ExternalReceipt, provenance: ReceiptProvenance): ReceiptRecord {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId,
    amountMinor: row.grossMinor,
    currency: row.currency,
    paidOn: date(row.receivedAt),
    collector: row.collector,
    evidenceClass: row.evidenceClass,
    sourceReference: row.sourceReference,
    evidenceReference: row.evidenceReference,
    evidenceUrl: row.evidenceUrl,
    reason: row.reason,
    sourceSystem: provenance.sourceSystem,
    sourceId: provenance.sourceId,
    enteredBy: row.enteredBy,
    reviewedBy: row.reviewedBy,
    reviewedAt: instant(row.reviewedAt),
    humanAttestation: row.humanAttestation,
    version: row.version,
    voidedAt: instant(row.voidedAt),
    voidedBy: row.voidedBy,
    voidReason: row.voidReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
/** Parent lock serialises all limits; source rows are locked in the same table/id order for every action. */
async function lockSources(
  tx: Prisma.TransactionClient,
  companyId: string,
  projectId: string,
  invoices: string[] = [],
  receipts: string[] = [],
) {
  for (const id of [...new Set(invoices)].sort())
    await tx.$queryRaw`SELECT id FROM "CustomerInvoiceReference" WHERE "companyId"=${companyId} AND "projectId"=${projectId} AND id=${id} FOR UPDATE`;
  for (const id of [...new Set(receipts)].sort())
    await tx.$queryRaw`SELECT id FROM "ExternalReceipt" WHERE "companyId"=${companyId} AND "projectId"=${projectId} AND id=${id} FOR UPDATE`;
}
async function findInvoice(
  tx: Prisma.TransactionClient,
  companyId: string,
  projectId: string,
  invoiceId: string,
  caseId?: string,
) {
  const row = await tx.customerInvoiceReference.findFirst({
    where: { companyId, projectId, id: invoiceId, ...(caseId ? { caseId } : {}) },
  });
  if (!row) missing('Invoice reference');
  return row;
}
async function findReceipt(
  tx: Prisma.TransactionClient,
  companyId: string,
  projectId: string,
  receiptId: string,
) {
  const row = await tx.externalReceipt.findFirst({ where: { companyId, projectId, id: receiptId } });
  if (!row) missing('Receipt');
  return row;
}
async function receiptState(tx: Prisma.TransactionClient, row: ExternalReceipt) {
  // Exact version matters: transaction timestamps can tie or commit out of order.
  const event = await tx.reconciliationAuditEvent.findFirst({
    where: {
      companyId: row.companyId,
      projectId: row.projectId,
      operation: { in: ['receipt.create', 'receipt.update', 'receipt.void'] },
      AND: [
        { after: { path: ['result', 'id'], equals: row.id } },
        { after: { path: ['result', 'version'], equals: row.version } },
      ],
    },
  });
  const prior = (event?.after as { result?: ReceiptProvenance } | null)?.result;
  return receiptRecord(row, { sourceSystem: prior?.sourceSystem ?? null, sourceId: prior?.sourceId ?? null });
}
async function allocations(
  tx: Prisma.TransactionClient,
  companyId: string,
  projectId: string,
  receiptId: string,
) {
  return tx.externalReceiptAllocation.findMany({
    where: { companyId, projectId, receiptId },
    orderBy: { invoiceReferenceId: 'asc' },
  });
}
async function invoiceAllocated(
  tx: Prisma.TransactionClient,
  companyId: string,
  projectId: string,
  invoiceReferenceId: string,
  exceptReceiptId?: string,
) {
  return (
    (
      await tx.externalReceiptAllocation.aggregate({
        where: {
          companyId,
          projectId,
          invoiceReferenceId,
          receipt: { voidedAt: null },
          ...(exceptReceiptId ? { receiptId: { not: exceptReceiptId } } : {}),
        },
        _sum: { amountMinor: true },
      })
    )._sum.amountMinor ?? 0
  );
}
function ceiling(total: number, available: number) {
  if (total > available)
    reconciliationConflict('Active allocations exceed the available amount.', 'ALLOCATION_EXCEEDS_AVAILABLE');
}

export async function duplicateInvoiceIds(
  tx: Prisma.TransactionClient,
  companyId: string,
  data: { issuer: string; number: string; issueDate: string | null },
  invoiceId?: string,
) {
  const year = data.issueDate?.slice(0, 4);
  const matches = await tx.customerInvoiceReference.findMany({
    where: {
      companyId,
      collectionMode: 'PARTNER',
      issuer: data.issuer,
      invoiceNumber: data.number,
      id: invoiceId ? { not: invoiceId } : undefined,
      issueDate: year ? { gte: new Date(`${year}-01-01`), lt: new Date(`${Number(year) + 1}-01-01`) } : null,
    },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  return matches.map((row) => row.id);
}
async function invoiceCollectedPeak(
  tx: Prisma.TransactionClient,
  companyId: string,
  projectId: string,
  invoiceId: string,
) {
  const where = { companyId, projectId };
  const events = await tx.reconciliationAuditEvent.findMany({
    where: { ...where, operation: { in: ['receipt.allocations', 'receipt.void'] } },
  });
  const allocations = await tx.externalReceiptAllocation.findMany({ where });
  return collectedPeaks(events, allocations).get(invoiceId) ?? 0;
}

export async function saveExternalInvoiceTx(
  tx: Prisma.TransactionClient,
  project: ReconciliationProject,
  caseId: string,
  patch: UpdateExternalInvoiceInput,
  invoiceId?: string,
  ledgerlyImportV1?: Prisma.InputJsonObject,
) {
  const companyId = project.companyId,
    projectId = project.id;
  if (!(await tx.reconciliationCase.findFirst({ where: { companyId, projectId, id: caseId } })))
    missing('Case');
  partnerProject(project);
  if (invoiceId) await lockSources(tx, companyId, projectId, [invoiceId]);
  const current = invoiceId ? await findInvoice(tx, companyId, projectId, invoiceId, caseId) : null;
  if (current?.collectionMode === 'COMPANY')
    reconciliationConflict('Own invoices must use canonical document links.');
  const before = current ? invoiceRecord(current) : undefined;
  const data = parse(schemas.externalInvoice, { ...(before?.external ?? {}), ...patch });
  partnerProject(project, data.currency);
  const duplicates = await duplicateInvoiceIds(tx, companyId, data, invoiceId);
  const previousReview = (current ? snapshot(current).duplicateReview : undefined) as
    | { invoiceIds?: string[]; identity?: string; fingerprint?: string }
    | undefined;
  const identity = reconciliationHash({
    issuer: data.issuer,
    number: data.number,
    year: data.issueDate?.slice(0, 4) ?? null,
  });
  const matches = await tx.customerInvoiceReference.findMany({
    where: { companyId, id: { in: duplicates } },
    select: {
      id: true,
      issuer: true,
      invoiceNumber: true,
      issueDate: true,
      snapshotHash: true,
      project: { select: { name: true } },
    },
    orderBy: { id: 'asc' },
  });
  const duplicateFingerprint = reconciliationHash({ identity, matches });
  const review = patch.duplicateReview;
  const reviewedIds = review
    ? [...review.invoiceIds].sort()
    : previousReview?.identity === identity
      ? previousReview.invoiceIds
      : [];
  const reviewedFingerprint = review?.fingerprint ?? previousReview?.fingerprint;
  if (
    (duplicates.length || review) &&
    (JSON.stringify(duplicates) !== JSON.stringify(reviewedIds) ||
      reviewedFingerprint !== duplicateFingerprint)
  ) {
    throw new ConflictException({
      code: 'DUPLICATE_INVOICE_REVIEW_REQUIRED',
      message:
        'Matching issuer, invoice number and year require explicit review before recording a distinct invoice.',
      params: { matches, fingerprint: duplicateFingerprint },
    });
  }
  let resolution: Record<string, Prisma.JsonValue> | undefined;
  if (patch.creditResolution) {
    if (!current?.creditAdjustmentMinor)
      reconciliationConflict('Credit disposition requires an existing credit.');
    const collectedPeakMinor = await invoiceCollectedPeak(tx, companyId, projectId, current.id);
    if (collectedPeakMinor <= current.originalGrossMinor! - current.creditAdjustmentMinor)
      reconciliationConflict('There is no collected credit disposition to resolve.');
    resolution = {
      ...patch.creditResolution,
      creditAdjustmentMinor: current.creditAdjustmentMinor,
      collectedPeakMinor,
    };
  }
  if (current) {
    if (current.creditAdjustmentMinor && data.grossMinor !== current.originalGrossMinor)
      reconciliationConflict('Original gross cannot change after a credit adjustment.');
    ceiling(
      await invoiceAllocated(tx, companyId, projectId, current.id),
      data.grossMinor - current.creditAdjustmentMinor,
    );
  }
  const sourceSnapshot = {
    ...(current ? snapshot(current) : {}),
    ...data,
    ...(review
      ? {
          duplicateReview: { ...review, invoiceIds: duplicates, identity, fingerprint: duplicateFingerprint },
        }
      : {}),
    ...(resolution ? { creditResolution: resolution } : {}),
    ...(ledgerlyImportV1 ? { ledgerlyImportV1 } : {}),
  };
  const values = {
    issuer: data.issuer,
    recipient: data.recipient,
    invoiceNumber: data.number,
    issueDate: data.issueDate ? new Date(data.issueDate) : null,
    dueDate: data.dueDate ? new Date(data.dueDate) : null,
    currency: data.currency,
    originalGrossMinor: data.grossMinor,
    netMinor: data.netMinor,
    taxMinor: data.vatMinor,
    reportedStatus: data.reportedStatus,
    sourceReference: data.sourceReference,
    source: data.sourceSystem,
    externalId: data.sourceId,
    sourceSnapshot,
    snapshotHash: reconciliationHash(sourceSnapshot),
  };
  const row = current
    ? await tx.customerInvoiceReference.update({ where: { id: current.id }, data: values })
    : await tx.customerInvoiceReference.create({
        data: { companyId, projectId, caseId, collectionMode: 'PARTNER', ...values },
      });
  return { result: invoiceRecord(row), projectId, before };
}

@Injectable()
export class ExternalReceiptsService {
  constructor(private readonly service: ReconciliationService) {}
  async saveExternalInvoice(
    companyId: string,
    projectId: string,
    input: SaveExternalInvoiceInput,
    context: MutationContext,
  ) {
    const { caseId: caseTarget, invoiceId: invoiceTarget, ...fields } = input;
    const { caseId, invoiceId } = parse(schemas.invoiceTarget, {
      caseId: caseTarget,
      invoiceId: invoiceTarget,
    });
    // Route IDs are part of retry identity, including the case on nested invoice PATCH routes.
    const patch = parse(invoiceId ? schemas.updateExternalInvoice : schemas.externalInvoice, fields);
    if ((patch.duplicateReview || patch.creditResolution) && context.actor.kind !== 'user')
      throw new ForbiddenException({
        code: 'RECONCILIATION_FORBIDDEN',
        message: 'A human reviewer must record identity or credit disposition evidence.',
      });
    return this.service.mutate(
      companyId,
      projectId,
      { caseId, invoiceId, ...patch },
      context,
      invoiceId ? 'external-invoice.update' : 'external-invoice.create',
      `case:${caseId}:invoice:${invoiceId ?? 'new'}`,
      async (tx, project) => {
        return saveExternalInvoiceTx(tx, project!, caseId, patch, invoiceId);
      },
      async (tx) => {
        if (!(await tx.reconciliationCase.findFirst({ where: { companyId, projectId, id: caseId } })))
          missing('Case');
        if (invoiceId) await findInvoice(tx, companyId, projectId, invoiceId, caseId);
      },
      [],
      { exclusiveCompany: true },
    );
  }
  async recordExternalReceipt(
    companyId: string,
    projectId: string,
    input: ReceiptInput,
    context: MutationContext,
  ) {
    const data = parse(schemas.receipt, input);
    return this.service.mutate(
      companyId,
      projectId,
      data,
      context,
      'receipt.create',
      `project:${projectId}:receipt:new`,
      async (tx, project) => {
        partnerProject(project!, data.currency);
        const values = await this.receiptValues(tx, companyId, project!, data, context);
        const row = await tx.externalReceipt.create({
          data: { companyId, projectId, ...values, enteredBy: actorName(context) },
        });
        return {
          result: receiptRecord(row, {
            sourceSystem: data.sourceSystem ?? null,
            sourceId: data.sourceId ?? null,
          }),
          projectId,
        };
      },
    );
  }
  private async receiptValues(
    tx: Prisma.TransactionClient,
    companyId: string,
    project: ReconciliationProject,
    data: ReceiptInput,
    context: MutationContext,
  ) {
    const partner = await tx.client.findFirst({ where: { companyId, id: project.partnerClientId! } });
    if (!partner) missing('Partner');
    const checked = data.evidenceClass === 'EVIDENCE_CHECKED';
    return {
      currency: data.currency,
      collector: partner.name,
      grossMinor: data.amountMinor,
      receivedAt: data.paidOn ? new Date(data.paidOn) : null,
      evidenceClass: data.evidenceClass,
      sourceReference: data.evidenceReference ?? data.reason,
      evidenceReference: data.evidenceReference,
      evidenceUrl: data.evidenceUrl,
      reason: data.reason,
      reviewedBy: checked ? actorName(context) : null,
      reviewedAt: checked ? new Date() : null,
      humanAttestation: checked
        ? 'Human explicitly attested that the supplied receipt evidence was checked.'
        : null,
    };
  }
  async updateExternalReceipt(
    companyId: string,
    projectId: string,
    input: UpdateExternalReceiptInput,
    context: MutationContext,
  ) {
    const { receiptId: target, ...fields } = input;
    const { receiptId } = parse(schemas.receiptTarget, { receiptId: target });
    const patch = parse(schemas.updateReceipt, fields);
    return this.service.mutate(
      companyId,
      projectId,
      { receiptId, ...patch },
      context,
      'receipt.update',
      `receipt:${receiptId}`,
      async (tx, project) => {
        await lockSources(tx, companyId, projectId, [], [receiptId]);
        const row = await findReceipt(tx, companyId, projectId, receiptId);
        if (row.voidedAt) reconciliationConflict('A void receipt cannot be edited.');
        const before = await receiptState(tx, row);
        const current = {
          amountMinor: before.amountMinor,
          currency: before.currency,
          paidOn: before.paidOn,
          evidenceClass: before.evidenceClass,
          evidenceReference: before.evidenceReference,
          evidenceUrl: before.evidenceUrl,
          reason: before.reason,
          sourceSystem: before.sourceSystem,
          sourceId: before.sourceId,
        };
        // Never merge a prior attestation: every checked update requires an explicit true in this request.
        const data = parse(schemas.receipt, { ...current, ...patch });
        partnerProject(project!, data.currency);
        ceiling(
          (await allocations(tx, companyId, projectId, receiptId)).reduce((sum, a) => sum + a.amountMinor, 0),
          data.amountMinor,
        );
        const updated = await tx.externalReceipt.update({
          where: { id: receiptId },
          data: {
            ...(await this.receiptValues(tx, companyId, project!, data, context)),
            version: { increment: 1 },
          },
        });
        return {
          result: receiptRecord(updated, {
            sourceSystem: data.sourceSystem ?? null,
            sourceId: data.sourceId ?? null,
          }),
          projectId,
          before,
        };
      },
      async (tx) => {
        await findReceipt(tx, companyId, projectId, receiptId);
      },
    );
  }
  async replaceReceiptAllocations(
    companyId: string,
    projectId: string,
    input: ReplaceReceiptAllocationsInput,
    context: MutationContext,
  ) {
    const { receiptId: target, ...fields } = input;
    const { receiptId } = parse(schemas.receiptTarget, { receiptId: target });
    const data = parse(schemas.allocations, fields);
    return this.service.mutate(
      companyId,
      projectId,
      { receiptId, ...data },
      context,
      'receipt.allocations',
      `receipt:${receiptId}`,
      async (tx, project) => {
        partnerProject(project!);
        const previous = await allocations(tx, companyId, projectId, receiptId);
        const ids = [
          ...previous.map((a) => a.invoiceReferenceId),
          ...data.allocations.map((a) => a.customerInvoiceId),
        ];
        await lockSources(tx, companyId, projectId, ids, [receiptId]);
        const row = await findReceipt(tx, companyId, projectId, receiptId);
        if (row.voidedAt) reconciliationConflict('A void receipt cannot be allocated.');
        const total = data.allocations.reduce((sum, a) => sum + a.amountMinor, 0);
        ceiling(total, row.grossMinor);
        for (const a of data.allocations) {
          const invoice = await findInvoice(tx, companyId, projectId, a.customerInvoiceId);
          if (invoice.collectionMode !== 'PARTNER')
            reconciliationConflict('Only external references accept receipt allocations.');
          ceiling(
            (await invoiceAllocated(tx, companyId, projectId, invoice.id, receiptId)) + a.amountMinor,
            invoice.originalGrossMinor! - invoice.creditAdjustmentMinor,
          );
        }
        await tx.externalReceiptAllocation.deleteMany({ where: { companyId, projectId, receiptId } });
        if (data.allocations.length)
          await tx.externalReceiptAllocation.createMany({
            data: data.allocations.map((a) => ({
              companyId,
              projectId,
              receiptId,
              invoiceReferenceId: a.customerInvoiceId,
              amountMinor: a.amountMinor,
            })),
          });
        const saved = await allocations(tx, companyId, projectId, receiptId);
        return {
          result: {
            receiptId,
            allocations: saved.map((a) => ({
              id: a.id,
              customerInvoiceId: a.invoiceReferenceId,
              amountMinor: a.amountMinor,
              createdAt: a.createdAt.toISOString(),
            })),
            allocatedMinor: total,
            unallocatedMinor: row.grossMinor - total,
          },
          projectId,
          before: { receipt: await receiptState(tx, row), allocations: previous },
        };
      },
      async (tx) => {
        await findReceipt(tx, companyId, projectId, receiptId);
        for (const a of data.allocations) await findInvoice(tx, companyId, projectId, a.customerInvoiceId);
      },
    );
  }
  async voidExternalReceipt(
    companyId: string,
    projectId: string,
    input: VoidExternalReceiptInput,
    context: MutationContext,
  ) {
    const { receiptId: target, ...fields } = input;
    const { receiptId } = parse(schemas.receiptTarget, { receiptId: target });
    const data = parse(schemas.reason, fields);
    return this.service.mutate(
      companyId,
      projectId,
      { receiptId, ...data },
      context,
      'receipt.void',
      `receipt:${receiptId}`,
      async (tx) => {
        const previous = await allocations(tx, companyId, projectId, receiptId);
        await lockSources(
          tx,
          companyId,
          projectId,
          previous.map((a) => a.invoiceReferenceId),
          [receiptId],
        );
        const row = await findReceipt(tx, companyId, projectId, receiptId);
        if (row.voidedAt) reconciliationConflict('The receipt was already voided.');
        const before = await receiptState(tx, row);
        await tx.externalReceiptAllocation.deleteMany({ where: { companyId, projectId, receiptId } });
        const updated = await tx.externalReceipt.update({
          where: { id: receiptId },
          data: {
            voidedAt: new Date(),
            voidedBy: actorName(context),
            voidReason: data.reason,
            version: { increment: 1 },
          },
        });
        return {
          result: receiptRecord(updated, before),
          projectId,
          before: { ...before, allocations: previous },
        };
      },
      async (tx) => {
        await findReceipt(tx, companyId, projectId, receiptId);
      },
    );
  }
  async applyExternalCreditAdjustment(
    companyId: string,
    projectId: string,
    input: ApplyExternalCreditInput,
    context: MutationContext,
  ) {
    const { invoiceId: target, ...fields } = input;
    const { invoiceId } = parse(schemas.creditTarget, { invoiceId: target });
    const data = parse(schemas.creditAdjustment, fields);
    return this.service.mutate(
      companyId,
      projectId,
      { invoiceId, ...data },
      context,
      'external-invoice.credit',
      `invoice:${invoiceId}`,
      async (tx, project) => {
        partnerProject(project!);
        await lockSources(tx, companyId, projectId, [invoiceId]);
        const row = await findInvoice(tx, companyId, projectId, invoiceId);
        if (row.collectionMode !== 'PARTNER')
          reconciliationConflict('Own credits belong to canonical documents.');
        const credit = row.creditAdjustmentMinor + data.amountMinor;
        ceiling(credit, row.originalGrossMinor!);
        ceiling(
          await invoiceAllocated(tx, companyId, projectId, invoiceId),
          row.originalGrossMinor! - credit,
        );
        const updated = await tx.customerInvoiceReference.update({
          where: { id: invoiceId },
          data: { creditAdjustmentMinor: credit },
        });
        return {
          result: invoiceRecord(updated),
          projectId,
          before: { ...invoiceRecord(row), adjustment: data },
        };
      },
      async (tx) => {
        await findInvoice(tx, companyId, projectId, invoiceId);
      },
    );
  }
}
