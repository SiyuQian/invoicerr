import { escapeCsvCell } from '@/utils/csv';
import type { ProjectView, ReportQuery } from './types';

export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (typeof value !== 'number' && (/^[\s]*[=+\-@\t\r]/.test(text) || /^[\t\r]/.test(text)))
    text = `'${text}`;
  return escapeCsvCell(text);
}
const invoiceMeasures = new Set([
  'customerInvoiced',
  'customerCredits',
  'customerCollectible',
  'sourceMarkedPaid',
  'settlementInvoiced',
  'partnerBills',
  'projectCosts',
]);
const cashMeasures = new Set(['ownRecordedReceipts', 'partnerPaid', 'checkedReceipts', 'reportedReceipts']);
export function buildReconciliationCsv(view: ProjectView, filters: ReportQuery = {}): string {
  if (view.cases.nextCursor !== null || view.cases.items.length !== view.cases.total)
    throw new Error('CSV export requires a complete project view.');
  const rows: unknown[][] = [
    [
      'projectId',
      'project',
      'currency',
      'caseId',
      'case',
      'kind',
      'reference',
      'measure',
      'knownMinor',
      'missingCount',
      'completeness',
      'basis',
      'count',
      'notes',
    ],
  ];
  const push = (caseId: string, title: string, cells: unknown[]) =>
    rows.push([view.project.id, view.project.name, view.project.currency, caseId, title, ...cells]);
  const report = (
    record: Pick<
      ProjectView,
      'summary' | 'sourceMarkedPaid' | 'checkedReceipts' | 'reportedReceipts' | 'undated' | 'exceptions'
    >,
    caseId = '',
    title = '',
  ) => {
    const amounts = {
      ...record.summary,
      sourceMarkedPaid: record.sourceMarkedPaid,
      checkedReceipts: record.checkedReceipts,
      reportedReceipts: record.reportedReceipts,
    };
    for (const [name, value] of Object.entries(amounts)) {
      const basis =
        invoiceMeasures.has(name) && (filters.invoiceFrom || filters.invoiceTo)
          ? 'in period: invoice date'
          : cashMeasures.has(name) && (filters.cashFrom || filters.cashTo)
            ? 'in period: cash date'
            : 'overall';
      push(caseId, title, [
        'measure',
        '',
        name,
        value.knownMinor,
        value.missingCount,
        value.completeness,
        basis,
        '',
        '',
      ]);
    }
    for (const [name, value] of Object.entries(record.undated))
      push(caseId, title, [
        'undated',
        '',
        name,
        value.knownMinor,
        value.missingCount,
        value.completeness,
        'overall; excluded from dated cash',
        value.count,
        '',
      ]);
    for (const e of record.exceptions)
      push(caseId, title, ['exception', e.fingerprint, e.code, '', '', '', 'overall', '', e.message]);
  };
  report(view);
  for (const row of view.cases.items) {
    report(row, row.id, row.title);
    push(row.id, row.title, ['review state', '', row.effectiveReviewState, '', '', '', 'overall', '', '']);
    if (row.reviewDecision) {
      const decision = row.reviewDecision;
      push(row.id, row.title, [
        'review decision',
        decision.sourceFingerprint,
        decision.mode,
        '',
        '',
        '',
        decision.current ? 'CURRENT' : 'STALE HISTORICAL',
        '',
        decision.reason,
      ]);
      for (const accepted of decision.exceptions)
        push(row.id, row.title, [
          'accepted discrepancy',
          accepted.fingerprint,
          accepted.code,
          '',
          '',
          '',
          decision.current ? 'CURRENT' : 'STALE HISTORICAL',
          '',
          accepted.reason,
        ]);
    }
    for (const invoice of row.customerInvoices)
      if (invoice.external)
        push(row.id, row.title, [
          'external invoice',
          invoice.external.number,
          'original / credit / adjusted',
          invoice.originalGrossMinor,
          '',
          '',
          'overall source facts',
          '',
          JSON.stringify({
            creditAdjustmentMinor: invoice.creditAdjustmentMinor,
            adjustedGrossMinor: invoice.adjustedGrossMinor,
            status: invoice.external.reportedStatus,
            source: invoice.external.sourceReference,
            sourceAsOf: invoice.external.sourceAsOf,
            coverage: row.coverage,
          }),
        ]);
  }
  for (const link of [
    ...view.cases.items.flatMap((c) => c.documentLinks),
    ...view.unallocatedDocumentLinks,
  ]) {
    const read = link.financial;
    push(link.caseId ?? '', view.cases.items.find((c) => c.id === link.caseId)?.title ?? '', [
      'document',
      read.displayNumber ?? read.documentId,
      link.role,
      read.grossMinor,
      '',
      read.grossMinor === null ? 'UNKNOWN' : 'COMPLETE',
      'overall canonical facts',
      '',
      JSON.stringify({
        status: read.status,
        issueDate: link.issueDate,
        paymentKnowledge: read.paymentKnowledge,
        settlement: read.settlement,
        payments: read.payments,
        warnings: read.warnings,
      }),
    ]);
  }
  for (const warning of view.warnings)
    push('', '', ['warning', '', warning.code, '', '', '', 'overall', '', JSON.stringify(warning)]);
  push('', '', [
    'snapshot',
    view.versionToken,
    'asOf',
    '',
    '',
    '',
    'overall',
    '',
    JSON.stringify({ asOf: view.asOf, sourceFingerprint: view.sourceFingerprint, filters }),
  ]);
  return `${rows.map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
