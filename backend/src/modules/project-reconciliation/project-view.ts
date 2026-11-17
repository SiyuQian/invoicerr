import { NotFoundException } from '@nestjs/common';
import type { ExtendedPrismaClient } from '@/prisma/prisma.service';
import type { Prisma } from '../../../prisma/generated/prisma/client';
import type { FinancialReadService } from '../documents/settlement/financial-read.service';
import { caseRecord, projectInclude, projectRecord, reconciliationHash } from './service';
import {
  issuedDocument,
  loadReviewSnapshots,
  projectReview,
  projectCoverage,
  type ReviewSnapshot,
} from './review';
import { invoiceRecord, receiptRecord, type ReceiptProvenance } from './external-receipts';
import { parse, schemas } from './validation';
import { buildReconciliationCsv } from './export';
import type {
  DocumentFinancialRead,
  DocumentLinkView,
  ExternalInvoiceView,
  MoneyMeasure,
  Page,
  Problem,
  ProjectListRow,
  ProjectSummary,
  ProjectView,
  ReceiptView,
  ReportQuery,
  ReviewState,
} from './types';

type Financial = Pick<FinancialReadService, 'readMany'>;
const isolation = { isolationLevel: 'RepeatableRead' as const };
const missing = (): never => {
  throw new NotFoundException({ code: 'NOT_FOUND', message: 'Project or cursor not found.' });
};
const civil = (date: Date | null) => date?.toISOString().slice(0, 10) ?? null;
const measure = (values: Array<number | null>, missingCount = 0): MoneyMeasure => {
  const known = values.filter((v): v is number => v !== null);
  const absent = missingCount + values.length - known.length;
  const knownMinor = known.reduce((sum, n) => sum + n, 0);
  if (!Number.isSafeInteger(knownMinor)) throw new Error('Reconciliation amount exceeds safe integer range.');
  return {
    knownMinor,
    missingCount: absent,
    completeness: absent ? (known.length ? 'PARTIAL' : 'UNKNOWN') : 'COMPLETE',
  };
};
function unavailable(id: string, typeId: DocumentFinancialRead['typeId']): DocumentFinancialRead {
  return {
    documentId: id,
    typeId,
    status: 'unavailable',
    displayNumber: null,
    currency: null,
    grossMinor: null,
    netMinor: null,
    vatMinor: null,
    paymentKnowledge: 'UNKNOWN',
    settlement: null,
    payments: [],
    sourceVersion: reconciliationHash(['unavailable', typeId, id]),
    warnings: [
      { code: 'FINANCIAL_READ_UNAVAILABLE', message: 'Canonical financial sources could not be read.' },
    ],
  };
}
/** Report failures become unknown facts; the mutation reader continues to throw503. */
function reportFinancial(financial: Financial): Financial {
  return {
    async readMany(companyId, refs, tx) {
      try {
        return await financial.readMany(companyId, refs, tx);
      } catch {
        return new Map(refs.map((ref) => [`${ref.typeId}:${ref.id}`, unavailable(ref.id, ref.typeId)]));
      }
    },
  };
}
function sourceDate(link: ReviewSnapshot['links'][number]): string | null {
  const data = link.document.data as Record<string, unknown> | null;
  const value = data?.[link.document.typeId === 'expense' ? 'date' : 'issueDate'];
  if (typeof value !== 'string') return null;
  const day = value.slice(0, 10);
  // Document date fields also accept ISO timestamps; retain their stated civil date.
  return schemas.externalInvoice.shape.issueDate.safeParse(day).success &&
    (value.length === 10 || schemas.coverageResult.shape.sourceAsOf.safeParse(value).success)
    ? day
    : null;
}
function dateMatch(date: string | null, from?: string, to?: string): boolean | null {
  if (!from && !to) return true;
  if (!date) return null;
  return (!from || date >= from) && (!to || date <= to);
}
function page<T extends { id: string; createdAt: Date }>(
  rows: T[],
  query: { cursor?: string; limit?: string },
): Page<T> {
  const sorted = [...rows].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
  );
  const index = query.cursor ? sorted.findIndex((r) => r.id === query.cursor) : -1;
  if (query.cursor && index === -1) missing();
  const take = Number(query.limit ?? '25'),
    selected = sorted.slice(index + 1, index + 1 + take);
  return {
    items: selected,
    total: rows.length,
    nextCursor: sorted.length > index + 1 + take ? selected.at(-1)!.id : null,
  };
}
function optimistic(snapshot: ReviewSnapshot) {
  const sourceFingerprint = reconciliationHash(
    [...snapshot.reads]
      .map(([key, value]) => [key, value.sourceVersion])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
  return { sourceFingerprint, versionToken: `${snapshot.project.revision}:${sourceFingerprint}` };
}
function externalViews(snapshot: ReviewSnapshot): ExternalInvoiceView[] {
  const active = new Set(snapshot.receipts.filter((r) => !r.voidedAt).map((r) => r.id));
  const allocated = new Map<string, number>();
  for (const a of snapshot.allocations)
    if (active.has(a.receiptId))
      allocated.set(a.invoiceReferenceId, (allocated.get(a.invoiceReferenceId) ?? 0) + a.amountMinor);
  return snapshot.invoices
    .filter((i) => i.collectionMode === 'PARTNER')
    .map((i) => {
      return {
        ...invoiceRecord(i),
        caseTitle: snapshot.cases.find((c) => c.id === i.caseId)!.title,
        allocatedMinor: allocated.get(i.id) ?? 0,
        availableMinor: i.originalGrossMinor! - i.creditAdjustmentMinor - (allocated.get(i.id) ?? 0),
      };
    });
}
function financialProjection(
  snapshot: ReviewSnapshot,
  caseId: string | undefined,
  filters: ReportQuery,
  links: DocumentLinkView[],
  externals: ExternalInvoiceView[],
  warnings: Problem[],
) {
  const ownLinks = links.filter((l) => caseId === undefined || l.caseId === caseId);
  const invoices = externals.filter((i) => caseId === undefined || i.caseId === caseId);
  const cases = snapshot.cases.filter((c) => caseId === undefined || c.id === caseId);
  const values: Record<keyof ProjectSummary, Array<number | null>> = {
    customerInvoiced: [],
    customerCredits: [],
    customerCollectible: [],
    customerRemaining: [],
    agreedSettlement: [],
    unbilledDifference: [],
    settlementInvoiced: [],
    ownRecordedReceipts: [],
    ownOutstanding: [],
    partnerBills: [],
    partnerPaid: [],
    partnerOutstanding: [],
    projectCosts: [],
  };
  const paid: Array<number | null> = [],
    checked: Array<number | null> = [],
    reported: Array<number | null> = [];
  const undated = {
    checkedReceipts: [] as number[],
    reportedReceipts: [] as number[],
    ownRecordedReceipts: [] as number[],
  };
  let lifetimeSettlement = 0,
    missingSettlement = 0;
  const invoiceValue = (
    target: Array<number | null>,
    value: number | null,
    date: string | null,
    id: string,
  ) => {
    const match = dateMatch(date, filters.invoiceFrom, filters.invoiceTo);
    if (match === false) return;
    if (match === null) {
      target.push(null);
      warnings.push({
        code: 'INVOICE_DATE_UNKNOWN',
        message: 'A document with unknown date was omitted from period amounts.',
        params: { recordId: id, omittedKnownMinor: value ?? 0, count: 1 },
      });
    } else target.push(value);
  };
  for (const c of cases)
    if (snapshot.project.partnerClientId) values.agreedSettlement.push(c.agreedGrossMinor);
  for (const i of invoices) {
    invoiceValue(values.customerInvoiced, i.originalGrossMinor, i.external.issueDate, i.id);
    invoiceValue(values.customerCredits, i.creditAdjustmentMinor, i.external.issueDate, i.id);
    invoiceValue(values.customerCollectible, i.adjustedGrossMinor, i.external.issueDate, i.id);
    values.customerRemaining.push(i.adjustedGrossMinor - i.allocatedMinor);
    if (!projectCoverage(snapshot, [i.id]).invoices[0]?.current) values.customerRemaining.push(null);
    if (i.external.reportedStatus?.toLowerCase() === 'paid')
      invoiceValue(paid, i.originalGrossMinor, i.external.issueDate, i.id);
  }
  const active = new Map<string, ReviewSnapshot['receipts'][number]>(
    snapshot.receipts.filter((r) => !r.voidedAt).map((r) => [r.id, r] as const),
  );
  const invoiceIds = new Set(invoices.map((i) => i.id));
  const evidenced = new Set<string>(),
    reportedIds = new Set<string>();
  for (const a of snapshot.allocations) {
    const r = active.get(a.receiptId);
    if (!r || !invoiceIds.has(a.invoiceReferenceId)) continue;
    const checkedEvidence = r.evidenceClass === 'EVIDENCE_CHECKED';
    (checkedEvidence ? evidenced : reportedIds).add(a.invoiceReferenceId);
    const target = checkedEvidence ? checked : reported;
    const key = checkedEvidence ? 'checkedReceipts' : 'reportedReceipts';
    if (!r.receivedAt) undated[key].push(a.amountMinor);
    if (dateMatch(civil(r.receivedAt), filters.cashFrom, filters.cashTo) === true) target.push(a.amountMinor);
  }
  for (const i of invoices) {
    if (!evidenced.has(i.id)) checked.push(null);
    if (!reportedIds.has(i.id)) reported.push(null);
  }
  for (const link of ownLinks) {
    const read = link.financial;
    const valid = read.currency === snapshot.project.currency && read.grossMinor !== null;
    // Status controls issued subtotals; canonical cash and balances survive cancellation.
    const excludeDocumentValue =
      valid && read.typeId !== 'expense' && !issuedDocument(read.typeId, read.status);
    const gross = valid ? read.grossMinor : null;
    const settlement = valid ? read.settlement : null;
    const collectible = gross !== null && settlement ? Math.max(0, gross - settlement.creditedMinor) : null;
    const money = (key: keyof ProjectSummary, amount: number | null) => {
      if (!excludeDocumentValue) invoiceValue(values[key], amount, link.issueDate, link.id);
    };
    if (link.role === 'CUSTOMER_INVOICE') {
      money('customerInvoiced', gross);
      money('customerCredits', settlement?.creditedMinor ?? null);
      money('customerCollectible', collectible);
      values.customerRemaining.push(settlement?.outstandingMinor ?? null);
    }
    if (link.role === 'SETTLEMENT_INCOME') {
      money('settlementInvoiced', collectible);
    }
    if (!excludeDocumentValue && (link.role === 'SETTLEMENT_INCOME' || link.role === 'PARTNER_BILL')) {
      if (collectible === null) missingSettlement++;
      else lifetimeSettlement += collectible;
    }
    if (link.role === 'PARTNER_BILL') {
      money('partnerBills', gross);
      values.partnerOutstanding.push(settlement?.outstandingMinor ?? null);
    }
    if (link.role === 'PROJECT_COST') money('projectCosts', gross);
    const income = link.role === 'CUSTOMER_INVOICE' || link.role === 'SETTLEMENT_INCOME';
    if (income) values.ownOutstanding.push(settlement?.outstandingMinor ?? null);
    if (income || link.role === 'PARTNER_BILL') {
      const target = income ? values.ownRecordedReceipts : values.partnerPaid;
      if (!settlement || read.paymentKnowledge !== 'KNOWN') target.push(null);
      else
        for (const p of read.payments) {
          // Canonical timestamps use their UTC calendar date; never the host timezone or invoice date.
          const date =
            p.paidOn && Number.isFinite(Date.parse(p.paidOn))
              ? new Date(p.paidOn).toISOString().slice(0, 10)
              : null;
          if (!date && income) undated.ownRecordedReceipts.push(p.documentAmountMinor);
          if (!date && !income)
            warnings.push({
              code: 'CASH_DATE_UNKNOWN',
              message: 'An undated outgoing payment is excluded from dated cash.',
              params: { recordId: p.id, omittedKnownMinor: p.documentAmountMinor, count: 1 },
            });
          if (dateMatch(date, filters.cashFrom, filters.cashTo) === true) target.push(p.documentAmountMinor);
        }
    }
  }
  const agreed = measure(values.agreedSettlement);
  const summary = Object.fromEntries(
    Object.entries(values).map(([key, rows]) => [key, measure(rows)]),
  ) as ProjectSummary;
  summary.unbilledDifference = measure(
    [agreed.knownMinor - lifetimeSettlement],
    agreed.missingCount + missingSettlement,
  );
  const undatedMeasures = Object.fromEntries(
    Object.entries(undated).map(([key, rows]) => [key, { ...measure(rows), count: rows.length }]),
  ) as ProjectView['undated'];
  return {
    summary,
    sourceMarkedPaid: measure(paid),
    checkedReceipts: measure(checked),
    reportedReceipts: measure(reported),
    undated: undatedMeasures,
  };
}
function compose(
  snapshot: ReviewSnapshot,
  project: ReturnType<typeof projectRecord>,
  filters: ReportQuery,
  allCases = false,
): ProjectView {
  const review = projectReview(snapshot),
    warnings: Problem[] = [];
  const links: DocumentLinkView[] = snapshot.links.map((l) => {
    const financial =
      snapshot.reads.get(`${l.document.typeId}:${l.documentId}`) ??
      unavailable(l.documentId, l.document.typeId as DocumentFinancialRead['typeId']);
    warnings.push(...financial.warnings);
    return {
      id: l.id,
      documentId: l.documentId,
      typeId: financial.typeId,
      caseId: l.caseId,
      role: l.role,
      issueDate: sourceDate(l),
      financial,
    };
  });
  const externals = externalViews(snapshot);
  const failed = links.some((l) => l.financial.warnings.some((w) => w.code === 'FINANCIAL_READ_UNAVAILABLE'));
  const exactCase = filters.caseId ? snapshot.cases.find((row) => row.id === filters.caseId) : null;
  if (filters.caseId && !exactCase) missing();
  const casePage = exactCase
    ? { items: [exactCase], nextCursor: null, total: 1 }
    : allCases
      ? {
          items: [...snapshot.cases].sort(
            (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
          ),
          nextCursor: null,
          total: snapshot.cases.length,
        }
      : page(snapshot.cases, filters);
  const states = review.cases.map((c) => (failed ? { ...c, effectiveReviewState: 'OPEN' as const } : c));
  const effectiveReviewState: ReviewState =
    !states.length || states.some((c) => c.effectiveReviewState === 'OPEN')
      ? 'OPEN'
      : states.some((c) => c.effectiveReviewState === 'CLOSED_WITH_EXCEPTIONS')
        ? 'CLOSED_WITH_EXCEPTIONS'
        : 'CLOSED_VERIFIED';
  const projection = financialProjection(snapshot, undefined, filters, links, externals, warnings);
  const items = casePage.items.map((row) => {
    const state = states.find((c) => c.caseId === row.id)!;
    return {
      ...caseRecord(row),
      status: state.effectiveReviewState,
      ...financialProjection(snapshot, row.id, filters, links, externals, []),
      customerInvoices: snapshot.invoices
        .filter((i) => i.caseId === row.id)
        .map((i) =>
          i.collectionMode === 'PARTNER'
            ? externals.find((e) => e.id === i.id)!
            : { id: i.id, caseId: i.caseId, documentLinkId: i.documentLinkId!, external: null },
        ),
      coverage: projectCoverage(
        snapshot,
        snapshot.invoices.filter((i) => i.caseId === row.id).map((i) => i.id),
      ),
      documentLinks: links.filter((l) => l.caseId === row.id),
      reviewDecision: (() => {
        const decisions = snapshot.decisions
          .flatMap((a) => {
            const parsed = schemas.reviewResult.safeParse((a.after as { result?: unknown } | null)?.result);
            return parsed.success && parsed.data.case.id === row.id ? [parsed.data] : [];
          })
          .sort((a, b) => b.case.version - a.case.version);
        const decision = decisions[0];
        return decision
          ? {
              ...decision,
              current:
                decision.case.version === row.version && decision.sourceFingerprint === snapshot.fingerprint,
            }
          : null;
      })(),
      effectiveReviewState: state.effectiveReviewState,
      exceptions: state.exceptions,
    };
  });
  return {
    project,
    ...optimistic(snapshot),
    asOf: new Date().toISOString(),
    ...projection,
    attentionCount: review.exceptions.length,
    unknownAgreementCount: snapshot.project.partnerClientId
      ? snapshot.cases.filter((c) => c.agreedGrossMinor === null).length
      : 0,
    effectiveReviewState,
    exceptions: review.exceptions,
    warnings: [...new Map(warnings.map((w) => [JSON.stringify(w), w])).values()],
    cases: { ...casePage, items },
    unallocatedDocumentLinks: links.filter((l) => l.caseId === null),
  };
}
async function ownedProject(tx: Prisma.TransactionClient, companyId: string, projectId: string) {
  const project = await tx.reconciliationProject.findFirst({
    where: { companyId, id: projectId },
    include: projectInclude,
  });
  if (!project) missing();
  return project;
}
export async function readProjectView(
  companyId: string,
  projectId: string,
  filters: unknown,
  db: ExtendedPrismaClient,
  financial: Financial,
): Promise<ProjectView> {
  const query = parse(schemas.reportQuery, filters);
  return db.$transaction(async (tx) => {
    const project = await ownedProject(tx, companyId, projectId);
    const [snapshot] = await loadReviewSnapshots(tx, companyId, [project], reportFinancial(financial));
    return compose(snapshot, projectRecord(project), query);
  }, isolation);
}
export async function listProjectViews(
  companyId: string,
  filters: unknown,
  db: ExtendedPrismaClient,
  financial: Financial,
): Promise<Page<ProjectListRow>> {
  const query = parse(schemas.projectListQuery, filters);
  return db.$transaction(async (tx) => {
    const cursor = query.cursor
      ? await tx.reconciliationProject.findFirst({ where: { companyId, id: query.cursor } })
      : null;
    if (query.cursor && !cursor) missing();
    const take = Number(query.limit ?? '25'),
      rows: ProjectListRow[] = [];
    let total = 0,
      scan: { id: string; createdAt: Date } | undefined;
    for (;;) {
      const projects = await tx.reconciliationProject.findMany({
        where: {
          companyId,
          ...(query.status !== 'ALL' ? { status: query.status ?? 'ACTIVE' } : {}),
          ...(query.collectionMode ? { collectionMode: query.collectionMode } : {}),
          ...(query.search
            ? {
                OR: [
                  { name: { contains: query.search, mode: 'insensitive' as const } },
                  { endCustomerName: { contains: query.search, mode: 'insensitive' as const } },
                ],
              }
            : {}),
          ...(scan
            ? {
                AND: [
                  {
                    OR: [
                      { createdAt: { lt: scan.createdAt } },
                      { createdAt: scan.createdAt, id: { lt: scan.id } },
                    ],
                  },
                ],
              }
            : {}),
        },
        include: projectInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: 100,
      });
      if (!projects.length) break;
      const snapshots = await loadReviewSnapshots(tx, companyId, projects, reportFinancial(financial));
      for (let i = 0; i < projects.length; i++) {
        const view = compose(snapshots[i], projectRecord(projects[i]), {});
        if (
          query.needsAttention !== undefined &&
          view.attentionCount > 0 !== (query.needsAttention === 'true')
        )
          continue;
        total++;
        const p = projects[i];
        if (
          cursor &&
          !(
            p.createdAt < cursor.createdAt ||
            (p.createdAt.getTime() === cursor.createdAt.getTime() && p.id < cursor.id)
          )
        )
          continue;
        if (rows.length <= take)
          rows.push({
            project: view.project,
            versionToken: view.versionToken,
            sourceFingerprint: view.sourceFingerprint,
            asOf: view.asOf,
            summary: view.summary,
            effectiveReviewState: view.effectiveReviewState,
            attentionCount: view.attentionCount,
          });
      }
      scan = projects.at(-1)!;
      if (projects.length < 100) break;
    }
    return {
      items: rows.slice(0, take),
      total,
      nextCursor: rows.length > take ? rows[take - 1].project.id : null,
    };
  }, isolation);
}
export async function listCustomerInvoiceViews(
  companyId: string,
  projectId: string,
  filters: unknown,
  db: ExtendedPrismaClient,
  financial: Financial,
) {
  const query = parse(schemas.invoiceChoiceQuery, filters);
  return db.$transaction(async (tx) => {
    const project = await ownedProject(tx, companyId, projectId);
    const [snapshot] = await loadReviewSnapshots(tx, companyId, [project], reportFinancial(financial));
    const all = externalViews(snapshot);
    const scope = snapshot.invoices.filter((i) => i.collectionMode === 'PARTNER');
    if (query.cursor && !scope.some((i) => i.id === query.cursor)) missing();
    const search = query.search?.toLowerCase();
    const matching = scope.filter(
      (i) =>
        !search ||
        i.invoiceNumber?.toLowerCase().includes(search) ||
        snapshot.cases
          .find((c) => c.id === i.caseId)!
          .title.toLowerCase()
          .includes(search),
    );
    const ordered = [...matching].sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
    );
    const cursor = query.cursor ? scope.find((i) => i.id === query.cursor)! : null;
    const eligible = ordered.filter(
      (i) =>
        !cursor ||
        i.createdAt < cursor.createdAt ||
        (i.createdAt.getTime() === cursor.createdAt.getTime() && i.id < cursor.id),
    );
    const take = Number(query.limit ?? '25');
    return {
      items: eligible.slice(0, take).map((i) => all.find((v) => v.id === i.id)!),
      total: matching.length,
      nextCursor: eligible.length > take ? eligible[take - 1].id : null,
    };
  }, isolation);
}
export async function listReceiptViews(
  companyId: string,
  projectId: string,
  filters: unknown,
  db: ExtendedPrismaClient,
): Promise<Page<ReceiptView>> {
  const query = parse(schemas.receiptQuery, filters);
  return db.$transaction(async (tx) => {
    await ownedProject(tx, companyId, projectId);
    const where = { companyId, projectId },
      take = Number(query.limit ?? '25');
    const cursor = query.cursor
      ? await tx.externalReceipt.findFirst({ where: { ...where, id: query.cursor } })
      : null;
    if (query.cursor && !cursor) missing();
    const rows = await tx.externalReceipt.findMany({
      where: {
        ...where,
        ...(query.receiptId ? { id: query.receiptId } : {}),
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });
    if (query.receiptId && !rows.length) missing();
    const selected = rows.slice(0, take);
    const states = selected.length
      ? await tx.reconciliationAuditEvent.findMany({
          where: {
            ...where,
            operation: { in: ['receipt.create', 'receipt.update', 'receipt.void'] },
            OR: selected.map((r) => ({
              AND: [
                { after: { path: ['result', 'id'], equals: r.id } },
                { after: { path: ['result', 'version'], equals: r.version } },
              ],
            })),
          },
        })
      : [];
    const allocations = await tx.externalReceiptAllocation.findMany({
      where: { ...where, receiptId: { in: selected.filter((r) => !r.voidedAt).map((r) => r.id) } },
      orderBy: { invoiceReferenceId: 'asc' },
    });
    const invoiceIds = [...new Set(allocations.map((a) => a.invoiceReferenceId))];
    const invoices = await tx.customerInvoiceReference.findMany({
      where: { ...where, id: { in: invoiceIds } },
      include: { case: { select: { title: true } } },
    });
    const totals = await tx.externalReceiptAllocation.groupBy({
      by: ['invoiceReferenceId'],
      where: { ...where, invoiceReferenceId: { in: invoiceIds }, receipt: { voidedAt: null } },
      _sum: { amountMinor: true },
    });
    const items = selected.map((r) => {
      const state = states.find(
        (a) =>
          (a.after as { result?: { id?: string; version?: number } } | null)?.result?.id === r.id &&
          (a.after as { result?: { version?: number } } | null)?.result?.version === r.version,
      );
      const provenance = (state?.after as { result?: ReceiptProvenance } | null)?.result;
      const allocationViews = allocations
        .filter((a) => a.receiptId === r.id)
        .map((a) => {
          const i = invoices.find((i) => i.id === a.invoiceReferenceId)!;
          const allocatedMinor = totals.find((t) => t.invoiceReferenceId === i.id)?._sum.amountMinor ?? 0;
          return {
            id: a.id,
            customerInvoiceId: i.id,
            amountMinor: a.amountMinor,
            createdAt: a.createdAt.toISOString(),
            customerInvoice: {
              id: i.id,
              caseId: i.caseId,
              caseTitle: i.case.title,
              number: i.invoiceNumber!,
              currency: i.currency!,
              originalGrossMinor: i.originalGrossMinor!,
              creditAdjustmentMinor: i.creditAdjustmentMinor,
              adjustedGrossMinor: i.originalGrossMinor! - i.creditAdjustmentMinor,
              allocatedMinor,
              availableMinor: i.originalGrossMinor! - i.creditAdjustmentMinor - allocatedMinor,
            },
          };
        });
      if (allocationViews.length > 1000)
        throw new Error('Receipt allocations exceed the supported complete read size.');
      const allocatedMinor = allocationViews.reduce((sum, a) => sum + a.amountMinor, 0);
      return {
        ...receiptRecord(r, {
          sourceSystem: provenance?.sourceSystem ?? null,
          sourceId: provenance?.sourceId ?? null,
        }),
        allocations: allocationViews,
        allocatedMinor,
        unallocatedMinor: r.voidedAt ? 0 : r.grossMinor - allocatedMinor,
      };
    });
    return {
      items,
      total: query.receiptId ? 1 : await tx.externalReceipt.count({ where }),
      nextCursor: rows.length > take ? selected.at(-1)!.id : null,
    };
  }, isolation);
}
export async function listProjectHistory(
  companyId: string,
  projectId: string,
  filters: unknown,
  db: ExtendedPrismaClient,
) {
  const query = parse(schemas.page, filters);
  return db.$transaction(async (tx) => {
    await ownedProject(tx, companyId, projectId);
    const where = { companyId, projectId },
      take = Number(query.limit ?? '25');
    const cursor = query.cursor
      ? await tx.reconciliationAuditEvent.findFirst({ where: { ...where, id: query.cursor } })
      : null;
    if (query.cursor && !cursor) missing();
    const rows = await tx.reconciliationAuditEvent.findMany({
      where: {
        ...where,
        ...(cursor
          ? {
              OR: [
                { occurredAt: { lt: cursor.occurredAt } },
                { occurredAt: cursor.occurredAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: take + 1,
    });
    return {
      items: rows.slice(0, take).map((r) => ({
        id: r.id,
        actor: r.actor,
        occurredAt: r.occurredAt.toISOString(),
        operation: r.operation,
        affectedRecord: r.affectedRecord,
        before: r.before,
        after: r.after,
        reason: r.reason,
      })),
      total: await tx.reconciliationAuditEvent.count({ where }),
      nextCursor: rows.length > take ? rows[take - 1].id : null,
    };
  }, isolation);
}
export async function exportProjectCsv(
  companyId: string,
  projectId: string,
  filters: unknown,
  db: ExtendedPrismaClient,
  financial: Financial,
) {
  const query = parse(schemas.exportQuery, filters);
  return db.$transaction(async (tx) => {
    const project = await ownedProject(tx, companyId, projectId);
    const [snapshot] = await loadReviewSnapshots(tx, companyId, [project], reportFinancial(financial));
    return buildReconciliationCsv(compose(snapshot, projectRecord(project), query, true), query);
  }, isolation);
}
