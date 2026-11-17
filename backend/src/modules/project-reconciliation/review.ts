import { ConflictException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { Prisma, ReconciliationProject, ExternalReceipt } from '../../../prisma/generated/prisma/client';
import type { FinancialReadService } from '../documents/settlement/financial-read.service';
import { reconciliationHash, reconciliationConflict, caseRecord } from './service';
import type { ReconciliationService } from './service';
import type {
  CaseCoverageView,
  DocumentFinancialRead,
  EvidenceCoverageInput,
  MutationContext,
  ReconciliationException,
  ReviewCaseInput,
  ReviewState,
  CoverageResult,
  ReviewResult,
} from './types';
import { parse, schemas } from './validation';
import { collectedPeaks } from './external-history';
import { documentMatchesRole } from './document-links';

export const ACCEPTABLE_REVIEW_EXCEPTIONS = new Set([
  'AGREEMENT_MISSING',
  'AGREEMENT_REFERENCE_MISSING',
  'EVIDENCE_COVERAGE_MISSING',
  'RECEIPT_EVIDENCE_MISSING',
  'RECEIPT_DATE_MISSING',
  'INVOICE_DATE_MISSING',
  'CUSTOMER_COLLECTION_UNCONFIRMED',
  'UNALLOCATED_DOCUMENT',
  'BALANCE_UNAVAILABLE',
]);

export async function loadReviewSnapshot(
  tx: Prisma.TransactionClient,
  companyId: string,
  project: ReconciliationProject,
  financial: Pick<FinancialReadService, 'readMany'>,
) {
  return (await loadReviewSnapshots(tx, companyId, [project], financial))[0];
}

/** Batch facts once; keep the same material fingerprint and pure review policy for reads and writes. */
export async function loadReviewSnapshots(
  tx: Prisma.TransactionClient,
  companyId: string,
  projects: ReconciliationProject[],
  financial: Pick<FinancialReadService, 'readMany'>,
) {
  const where = { companyId, projectId: { in: projects.map((p) => p.id) } };
  const allCases = await tx.reconciliationCase.findMany({ where, orderBy: { id: 'asc' } });
  const allInvoices = await tx.customerInvoiceReference.findMany({ where, orderBy: { id: 'asc' } });
  const allReceipts = await tx.externalReceipt.findMany({ where, orderBy: { id: 'asc' } });
  const allAllocations = await tx.externalReceiptAllocation.findMany({ where, orderBy: { id: 'asc' } });
  const allLinks = await tx.projectDocumentLink.findMany({
    where,
    include: { document: { select: { typeId: true, data: true } } },
    orderBy: { id: 'asc' },
  });
  let allReads: Awaited<ReturnType<FinancialReadService['readMany']>>;
  try {
    allReads = await financial.readMany(
      companyId,
      allLinks.map((l) => ({
        id: l.documentId,
        typeId: l.document.typeId as 'invoice' | 'expense' | 'received-invoice',
      })),
      tx,
    );
  } catch {
    throw new ServiceUnavailableException({
      code: 'FINANCIAL_READ_UNAVAILABLE',
      message: 'Canonical financial sources could not be read.',
    });
  }
  const allCoverage = await tx.reconciliationAuditEvent.findMany({
    where: {
      ...where,
      operation: { in: ['coverage.attest', 'case.review', 'receipt.allocations', 'receipt.void'] },
    },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  });
  return projects.map((project) => {
    const cases = allCases.filter((c) => c.projectId === project.id);
    const invoices = allInvoices.filter((i) => i.projectId === project.id);
    const receipts = allReceipts.filter((r) => r.projectId === project.id);
    const allocations = allAllocations.filter((a) => a.projectId === project.id);
    const links = allLinks.filter((l) => l.projectId === project.id);
    const audits = allCoverage.filter((c) => c.projectId === project.id);
    const coverage = audits.filter((c) => c.operation === 'coverage.attest');
    const decisions = audits.filter((c) => c.operation === 'case.review');
    const peaks = collectedPeaks(
      audits.filter((c) => ['receipt.allocations', 'receipt.void'].includes(c.operation)),
      allocations,
    );
    const reads = new Map<string, DocumentFinancialRead>(
      links.flatMap((l) => {
        const key = `${l.document.typeId}:${l.documentId}`,
          read = allReads.get(key);
        return read ? [[key, read] as const] : [];
      }),
    );
    const creditCollectedPeaks = invoices
      .filter(
        (i) =>
          i.creditAdjustmentMinor > 0 &&
          (peaks.get(i.id) ?? 0) > i.originalGrossMinor! - i.creditAdjustmentMinor,
      )
      .map((i) => [i.id, peaks.get(i.id)!] as const);
    const fingerprint = reconciliationHash({
      project: {
        id: project.id,
        companyId,
        currency: project.currency,
        collectionMode: project.collectionMode,
        endCustomerClientId: project.endCustomerClientId,
        partnerClientId: project.partnerClientId,
      },
      cases: cases.map((c) => ({
        id: c.id,
        title: c.title,
        period: c.period,
        agreedGrossMinor: c.agreedGrossMinor,
        agreedNetMinor: c.agreedNetMinor,
        agreedTaxMinor: c.agreedTaxMinor,
        agreementReference: c.agreementReference,
        agreementReason: c.agreementReason,
        source: c.source,
        externalId: c.externalId,
        sourceSnapshot: c.sourceSnapshot,
        snapshotHash: c.snapshotHash,
      })),
      invoices,
      // Only affected historical credits reopen; unrelated saved coverage keeps its source identity.
      ...(creditCollectedPeaks.length ? { creditCollectedPeaks } : {}),
      receipts,
      allocations,
      links,
      sources: [...reads]
        .map(([key, value]) => [key, value.sourceVersion])
        .sort(([a], [b]) => a.localeCompare(b)),
    });
    return {
      project,
      cases,
      invoices,
      receipts,
      allocations,
      links,
      reads,
      coverage,
      decisions,
      peaks,
      fingerprint,
    };
  });
}
export type ReviewSnapshot = Awaited<ReturnType<typeof loadReviewSnapshot>>;

/** Same validated current union as review; stale attestations are metadata, never coverage. */
export function projectCoverage(snapshot: ReviewSnapshot, customerInvoiceIds: string[]): CaseCoverageView {
  if (snapshot.project.collectionMode === 'COMPANY') return { state: 'NOT_APPLICABLE', invoices: [] };
  const attestations = snapshot.coverage.flatMap((audit) => {
    const parsed = schemas.coverageResult.safeParse((audit.after as Record<string, unknown> | null)?.result);
    return parsed.success ? [parsed.data] : [];
  });
  const invoices = customerInvoiceIds.map((customerInvoiceId) => {
    const relevant = attestations.filter((a) => a.customerInvoiceIds.includes(customerInvoiceId));
    const chosen = relevant.findLast((a) => a.sourceFingerprint === snapshot.fingerprint) ?? relevant.at(-1);
    return {
      customerInvoiceId,
      current: chosen?.sourceFingerprint === snapshot.fingerprint,
      attestation: chosen
        ? {
            sourceAsOf: chosen.sourceAsOf,
            evidenceReference: chosen.evidenceReference,
            sourceFingerprint: chosen.sourceFingerprint,
            attestedBy: chosen.attestedBy,
            attestedAt: chosen.attestedAt,
          }
        : null,
    };
  });
  return {
    state:
      invoices.length && invoices.every((i) => i.current)
        ? 'CURRENT'
        : invoices.some((i) => !i.current && i.attestation)
          ? 'STALE'
          : 'MISSING',
    invoices,
  };
}

/** Pure review policy shared by mutation decisions and T6's complete, unpaged report basis. */
export function projectReview(snapshot: ReviewSnapshot) {
  const { project, cases, invoices, receipts, allocations, links, reads, fingerprint } = snapshot;
  const active = new Map<string, ExternalReceipt>(
    receipts.filter((r) => !r.voidedAt).map((r) => [r.id, r] as const),
  );
  const exception = (
    code: string,
    caseId: string | null,
    source: unknown,
    message: string,
  ): ReconciliationException => ({
    code,
    caseId,
    message,
    fingerprint: reconciliationHash({
      code,
      companyId: project.companyId,
      projectId: project.id,
      caseId,
      source,
    }),
    blocking: code !== 'SOURCE_CHANGED' && !ACCEPTABLE_REVIEW_EXCEPTIONS.has(code),
  });
  const projectExceptions = links
    .filter((l) => l.caseId === null)
    .map((l) =>
      exception('UNALLOCATED_DOCUMENT', null, l, 'A consolidated document is not allocated to cases.'),
    );
  const caseStates = cases.map((row) => {
    const problems: ReconciliationException[] = [];
    const add = (code: string, source: unknown, message: string) =>
      problems.push(exception(code, row.id, source, message));
    const refs = invoices.filter((i) => i.caseId === row.id);
    const relevant = links.filter((l) => l.caseId === row.id || l.caseId === null);
    if (refs.length === 0)
      add('CUSTOMER_INVOICE_MISSING', row.id, 'A required customer invoice is not linked.');
    if (project.partnerClientId) {
      if (row.agreedGrossMinor === null)
        add(
          'AGREEMENT_MISSING',
          { caseId: row.id, amount: null },
          'The historical settlement agreement is missing.',
        );
      else if (!row.agreementReference)
        add(
          'AGREEMENT_REFERENCE_MISSING',
          { caseId: row.id, amount: row.agreedGrossMinor },
          'The settlement agreement reference is missing.',
        );
      const role = project.collectionMode === 'PARTNER' ? 'SETTLEMENT_INCOME' : 'PARTNER_BILL';
      const settlementLinks = relevant.filter((l) => l.role === role);
      if (settlementLinks.length === 0 && row.agreedGrossMinor !== 0)
        add(
          'SETTLEMENT_DOCUMENT_MISSING',
          { caseId: row.id, role },
          'A required settlement document is not linked.',
        );
      if (row.agreedGrossMinor !== null && !settlementLinks.some((l) => l.caseId === null)) {
        let issued = 0,
          known = true;
        for (const link of settlementLinks) {
          const read = reads.get(`${link.document.typeId}:${link.documentId}`);
          if (!read || read.grossMinor === null || !issuedDocument(read.typeId, read.status)) known = false;
          else issued += read.grossMinor - (read.settlement?.creditedMinor ?? 0);
        }
        if (known && issued !== row.agreedGrossMinor)
          add(
            'SETTLEMENT_DIFFERENCE',
            { agreed: row.agreedGrossMinor, issued },
            'Issued settlement documents differ from the explicit agreement.',
          );
      }
    }
    for (const link of relevant) {
      const read = reads.get(`${link.document.typeId}:${link.documentId}`);
      if (
        !documentMatchesRole(
          project,
          { ...link, typeId: link.document.typeId as 'invoice' | 'expense' | 'received-invoice' },
          link.document,
        )
      )
        add(
          'DOCUMENT_IDENTITY_CHANGED',
          { linkId: link.id, document: link.document },
          'The current document type or linked party no longer matches its reconciliation role.',
        );
      if (link.caseId === null)
        problems.push(
          projectExceptions.find(
            (e) => e.fingerprint === exception('UNALLOCATED_DOCUMENT', null, link, '').fingerprint,
          )!,
        );
      if (!read) {
        add('BALANCE_UNAVAILABLE', link.id, 'The canonical document balance is unavailable.');
        continue;
      }
      // Expense has only draft status; its gross is useful, but settlement remains unsupported.
      if (read.typeId !== 'expense' && !issuedDocument(read.typeId, read.status))
        add(
          'DOCUMENT_NOT_ISSUED',
          { linkId: link.id, status: read.status },
          'A linked financial source is not issued or is cancelled/rejected.',
        );
      if (read.currency && read.currency !== project.currency)
        add(
          'CURRENCY_MISMATCH',
          { linkId: link.id, currency: read.currency, projectCurrency: project.currency },
          'A linked document currency no longer matches the project.',
        );
      if (
        read.currency === null ||
        read.grossMinor === null ||
        read.paymentKnowledge !== 'KNOWN' ||
        !read.settlement
      )
        add(
          'BALANCE_UNAVAILABLE',
          { linkId: link.id, source: read.sourceVersion },
          'The canonical document balance is unavailable or unsupported.',
        );
      if (read.settlement && read.settlement.outstandingMinor > 0)
        add(
          'OWN_OUTSTANDING',
          { linkId: link.id, source: read.sourceVersion, outstandingMinor: read.settlement.outstandingMinor },
          'A known own receivable or payable remains outstanding.',
        );
    }
    if (project.collectionMode === 'PARTNER') {
      const covered = new Set(
        projectCoverage(
          snapshot,
          refs.map((r) => r.id),
        )
          .invoices.filter((i) => i.current)
          .map((i) => i.customerInvoiceId),
      );
      for (const ref of refs) {
        const peak = snapshot.peaks.get(ref.id) ?? 0;
        const disposition = (
          ref.sourceSnapshot as {
            creditResolution?: {
              creditAdjustmentMinor: number;
              collectedPeakMinor: number;
              evidenceReference: string;
              reason: string;
              attested: boolean;
            };
          } | null
        )?.creditResolution;
        if (
          ref.creditAdjustmentMinor > 0 &&
          peak > ref.originalGrossMinor! - ref.creditAdjustmentMinor &&
          !(
            disposition?.attested &&
            disposition.evidenceReference &&
            disposition.reason &&
            disposition.creditAdjustmentMinor === ref.creditAdjustmentMinor &&
            disposition.collectedPeakMinor === peak
          )
        )
          add(
            'EXTERNAL_CREDIT_DISPOSITION_UNRESOLVED',
            { invoiceId: ref.id, peak, credit: ref.creditAdjustmentMinor },
            'Previously allocated customer money was released by a credit. Record explicit refund or credit disposition evidence before closing.',
          );
        if (!ref.issueDate)
          add(
            'INVOICE_DATE_MISSING',
            { invoiceId: ref.id, issueDate: null },
            'The external customer invoice issue date is unknown.',
          );
        if (!covered.has(ref.id))
          add(
            'EVIDENCE_COVERAGE_MISSING',
            { invoiceId: ref.id, fingerprint },
            'The external invoice/receipt set has no current explicit coverage attestation.',
          );
        const allocated = allocations.filter(
          (a) => a.invoiceReferenceId === ref.id && active.has(a.receiptId),
        );
        const amount = allocated.reduce((sum, a) => sum + a.amountMinor, 0);
        if (ref.originalGrossMinor === null || amount !== ref.originalGrossMinor - ref.creditAdjustmentMinor)
          add(
            'CUSTOMER_COLLECTION_UNCONFIRMED',
            {
              invoiceId: ref.id,
              amount,
              collectible:
                ref.originalGrossMinor === null ? null : ref.originalGrossMinor - ref.creditAdjustmentMinor,
            },
            'Customer collection is incomplete on the recorded evidence basis.',
          );
        for (const allocation of allocated) {
          const receipt = active.get(allocation.receiptId)!;
          if (
            receipt.evidenceClass !== 'EVIDENCE_CHECKED' ||
            !receipt.humanAttestation ||
            !receipt.evidenceReference ||
            !receipt.reviewedAt ||
            !receipt.reviewedBy
          )
            add(
              'RECEIPT_EVIDENCE_MISSING',
              { receiptId: receipt.id, version: receipt.version },
              'An external receipt has not been explicitly evidence checked.',
            );
          if (!receipt.receivedAt)
            add(
              'RECEIPT_DATE_MISSING',
              { receiptId: receipt.id, version: receipt.version },
              'The actual external receipt date is unknown.',
            );
        }
      }
    }
    const stale = row.status !== 'OPEN' && row.reviewedSourceFingerprint !== fingerprint;
    if (stale)
      add(
        'SOURCE_CHANGED',
        { reviewed: row.reviewedSourceFingerprint, current: fingerprint },
        'Material sources changed after the saved review.',
      );
    return {
      caseId: row.id,
      effectiveReviewState: (stale ? 'OPEN' : row.status) as ReviewState,
      exceptions: [...new Map(problems.map((e) => [e.fingerprint, e])).values()],
    };
  });
  return {
    sourceFingerprint: fingerprint,
    cases: caseStates,
    exceptions: [
      ...new Map(
        [...projectExceptions, ...caseStates.flatMap((c) => c.exceptions)].map((e) => [e.fingerprint, e]),
      ).values(),
    ],
  };
}
export function issuedDocument(typeId: string, status: string) {
  return typeId === 'invoice'
    ? ['validated', 'sending', 'sent', 'send_failed'].includes(status)
    : typeId === 'received-invoice' && ['received', 'approved'].includes(status);
}

async function recheck(core: ReconciliationService, tx: Prisma.TransactionClient, snapshot: ReviewSnapshot) {
  const current = await loadReviewSnapshot(
    tx,
    snapshot.project.companyId,
    snapshot.project,
    core.financialRead,
  );
  if (current.fingerprint !== snapshot.fingerprint)
    reconciliationConflict('Financial sources changed during review. Refresh before retrying.');
}
export async function attestEvidenceCoverage(
  core: ReconciliationService,
  companyId: string,
  projectId: string,
  input: EvidenceCoverageInput,
  context: MutationContext,
) {
  const parsed = parse(schemas.evidenceCoverage, input);
  if (new Set(parsed.customerInvoiceIds).size !== parsed.customerInvoiceIds.length)
    reconciliationConflict('Coverage invoice IDs must be unique.');
  const data = { ...parsed, customerInvoiceIds: [...parsed.customerInvoiceIds].sort() };
  return core.mutate(
    companyId,
    projectId,
    data,
    context,
    'coverage.attest',
    `project:${projectId}`,
    async (tx, project) => {
      if (project!.collectionMode !== 'PARTNER')
        reconciliationConflict('External coverage requires partner collection.');
      const snapshot = await loadReviewSnapshot(tx, companyId, project!, core.financialRead);
      const cutoff = data.sourceAsOf.slice(0, 10);
      const dated = [
        ...snapshot.invoices
          .filter((i) => data.customerInvoiceIds.includes(i.id))
          .map((i) => ({ id: i.id, date: i.issueDate })),
        ...snapshot.receipts.filter((r) => !r.voidedAt).map((r) => ({ id: r.id, date: r.receivedAt })),
      ];
      for (const record of dated)
        if (record.date && record.date.toISOString().slice(0, 10) > cutoff)
          throw new ConflictException({
            code: 'REVIEW_BLOCKED',
            message:
              'A known invoice or receipt date is after the attested coverage date. Reattest with an updated as-of date.',
            params: {
              condition: 'DATE_AFTER_COVERAGE',
              recordId: record.id,
              date: record.date.toISOString().slice(0, 10),
              sourceAsOf: cutoff,
            },
          });
      const result: CoverageResult = {
        ...data,
        receiptIds: snapshot.receipts.filter((r) => !r.voidedAt).map((r) => r.id),
        allocationIds: snapshot.allocations
          .filter((a) => snapshot.receipts.some((r) => r.id === a.receiptId && !r.voidedAt))
          .map((a) => a.id),
        sourceFingerprint: snapshot.fingerprint,
        attestedBy: `${context.actor.kind}:${context.actor.id}`,
        attestedAt: new Date().toISOString(),
      };
      await recheck(core, tx, snapshot);
      return { result, projectId };
    },
    async (tx) => {
      if (
        (await tx.customerInvoiceReference.count({
          where: { companyId, projectId, collectionMode: 'PARTNER', id: { in: data.customerInvoiceIds } },
        })) !== data.customerInvoiceIds.length
      )
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'External customer invoice not found.' });
    },
  );
}
export async function reviewCase(
  core: ReconciliationService,
  companyId: string,
  projectId: string,
  input: ReviewCaseInput & { caseId: string },
  context: MutationContext,
) {
  const { caseId: routeCaseId, ...rest } = input;
  const caseId = parse(schemas.recordId, { id: routeCaseId }).id;
  const data = { caseId, ...parse(schemas.reviewCase, rest) };
  data.exceptions.sort((a, b) => a.fingerprint.localeCompare(b.fingerprint) || a.code.localeCompare(b.code));
  return core.mutate(
    companyId,
    projectId,
    data,
    context,
    'case.review',
    `case:${caseId}`,
    async (tx, project) => {
      const snapshot = await loadReviewSnapshot(tx, companyId, project!, core.financialRead);
      const before = snapshot.cases.find((c) => c.id === caseId)!;
      const current = projectReview(snapshot).cases.find((c) => c.caseId === caseId)!;
      const exceptions = current.exceptions.filter((e) => e.code !== 'SOURCE_CHANGED');
      if (data.mode === 'REOPEN') {
        if (data.exceptions.length)
          reconciliationConflict('Reopening cannot accept exceptions.', 'REVIEW_BLOCKED');
      } else if (data.mode === 'VERIFY') {
        if (exceptions.length || data.exceptions.length)
          reconciliationConflict(
            'Verification requires complete links, agreement, evidence, dates and settled balances.',
            'REVIEW_BLOCKED',
          );
      } else {
        const expected = exceptions.map((e) => `${e.code}:${e.fingerprint}`).sort();
        const received = data.exceptions.map((e) => `${e.code}:${e.fingerprint}`).sort();
        if (
          exceptions.some((e) => !ACCEPTABLE_REVIEW_EXCEPTIONS.has(e.code)) ||
          expected.length === 0 ||
          JSON.stringify(expected) !== JSON.stringify(received)
        )
          reconciliationConflict(
            'Accept each exact current historical exception; known balances and required links cannot be overridden.',
            'REVIEW_BLOCKED',
          );
      }
      await recheck(core, tx, snapshot);
      const now = new Date(),
        reviewer = `${context.actor.kind}:${context.actor.id}`;
      const updated = await tx.reconciliationCase.update({
        where: { id: caseId },
        data: {
          status:
            data.mode === 'REOPEN'
              ? 'OPEN'
              : data.mode === 'VERIFY'
                ? 'CLOSED_VERIFIED'
                : 'CLOSED_WITH_EXCEPTIONS',
          version: { increment: 1 },
          reviewedSourceFingerprint: data.mode === 'REOPEN' ? null : snapshot.fingerprint,
          reviewedBy: data.mode === 'REOPEN' ? null : reviewer,
          reviewedAt: data.mode === 'REOPEN' ? null : now,
        },
      });
      const result: ReviewResult = {
        case: caseRecord(updated),
        mode: data.mode,
        sourceFingerprint: snapshot.fingerprint,
        exceptions: data.exceptions,
        reason: data.reason,
        reviewedBy: reviewer,
        reviewedAt: now.toISOString(),
      };
      return { result, projectId, before, auditReason: data.reason };
    },
    async (tx) => {
      if (
        !(await tx.reconciliationCase.findFirst({
          where: { companyId, projectId, id: caseId },
          select: { id: true },
        }))
      )
        throw new NotFoundException({ code: 'NOT_FOUND', message: 'Case not found.' });
    },
  );
}
