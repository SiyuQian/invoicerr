import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../../../prisma/generated/prisma/client';
import { buildInvoiceDescriptor } from '../descriptors/invoice.descriptor';
import { formatServerMessage } from '../messages/server-message';
import { findOwnedDocumentsByIds } from '../persistence';
import { computeDocumentTotals } from '../totals/compute-totals';
import { isFinancialCurrency, resolveFlatTotals } from '../totals/flat-document-totals';
import { computeSettlement } from './compute-settlement';
import { creditsForInvoiceFromNotes, listCreditNotes, toSettlementCreditInputs } from './credits';
import { listPaymentsForDocuments, toSettlementPaymentInputs } from './payments';

export type Problem = { code: string; message: string; params?: Record<string, string | number> };
export type DocumentFinancialRead = {
  documentId: string;
  typeId: 'invoice' | 'expense' | 'received-invoice';
  status: string;
  displayNumber: string | null;
  currency: string | null;
  grossMinor: number | null;
  netMinor: number | null;
  vatMinor: number | null;
  paymentKnowledge: 'KNOWN' | 'UNKNOWN' | 'UNSUPPORTED';
  settlement: {
    paidMinor: number;
    creditedMinor: number;
    outstandingMinor: number;
    excessMinor: number;
    settled: boolean;
  } | null;
  payments: Array<{
    source: 'document-payment' | 'disbursement-event';
    id: string;
    documentAmountMinor: number;
    originalAmountMinor: number;
    originalCurrency: string;
    paidOn: string | null;
  }>;
  sourceVersion: string;
  warnings: Problem[];
};

type FinancialRef = { typeId: DocumentFinancialRead['typeId']; id: string };
const invoiceDescriptor = buildInvoiceDescriptor();
export function financialReadKey(ref: FinancialRef): string {
  return `${ref.typeId}:${ref.id}`;
}
function version(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

@Injectable()
export class FinancialReadService {
  /** Reads only through tx. Callers choose snapshot isolation when composing this with other reads. */
  async readMany(
    companyId: string,
    refs: FinancialRef[],
    tx: Prisma.TransactionClient,
  ): Promise<Map<string, DocumentFinancialRead>> {
    const result = new Map<string, DocumentFinancialRead>();
    if (refs.length === 0) return result;
    const documents = await findOwnedDocumentsByIds(
      companyId,
      refs.map((ref) => ref.id),
      tx,
    );
    const byKey = new Map(documents.map((doc) => [`${doc.typeId}:${doc.id}`, doc]));
    const sources = refs.map((ref) => byKey.get(financialReadKey(ref))).filter((doc) => doc !== undefined);
    const supportedIds = sources.filter((doc) => doc.typeId !== 'expense').map((doc) => doc.id);
    const payments = await listPaymentsForDocuments(companyId, supportedIds, tx);
    const creditNotes = sources.some((doc) => doc.typeId === 'invoice')
      ? await listCreditNotes(companyId, tx)
      : [];
    const paymentsById = new Map<string, typeof payments>();
    for (const payment of payments) {
      const rows = paymentsById.get(payment.documentId) ?? [];
      rows.push(payment);
      paymentsById.set(payment.documentId, rows);
    }
    const notesByInvoice = new Map<string, typeof creditNotes>();
    for (const note of creditNotes) {
      const invoiceId = ((note.data ?? {}) as Record<string, unknown>).invoice;
      if (typeof invoiceId !== 'string') continue;
      const rows = notesByInvoice.get(invoiceId) ?? [];
      rows.push(note);
      notesByInvoice.set(invoiceId, rows);
    }

    for (const ref of refs) {
      const source = byKey.get(financialReadKey(ref));
      const read: DocumentFinancialRead = {
        documentId: ref.id,
        typeId: ref.typeId,
        status: source?.status ?? 'unavailable',
        displayNumber: source?.displayNumber ?? null,
        currency: null,
        grossMinor: null,
        netMinor: null,
        vatMinor: null,
        paymentKnowledge: 'UNKNOWN',
        settlement: null,
        payments: [],
        sourceVersion: version([ref, null]),
        warnings: [],
      };
      result.set(financialReadKey(ref), read);
      if (!source) {
        read.warnings.push({ code: 'SOURCE_UNAVAILABLE', message: 'The source document is unavailable.' });
        continue;
      }
      const data = (source.data ?? {}) as Record<string, unknown>;
      const sourcePayments = paymentsById.get(source.id) ?? [];
      const notes = ref.typeId === 'invoice' ? (notesByInvoice.get(source.id) ?? []) : [];
      // Freezing identifiers and sealing existing payments do not change a reviewed balance.
      const { buyerIdentifiers: _buyerIdentifiers, ...financialSource } = source;
      read.sourceVersion = version([
        financialSource,
        sourcePayments.map(({ ledgerSequence: _ledgerSequence, reversesPaymentId, ...payment }) =>
          reversesPaymentId ? { ...payment, reversesPaymentId } : payment,
        ),
        notes.map(({ buyerIdentifiers: _buyerIdentifiers, ...note }) => note),
      ]);
      read.currency = isFinancialCurrency(data.currency) ? data.currency : null;
      const validInvoiceLines =
        ref.typeId !== 'invoice' ||
        (Array.isArray(data.lines) &&
          data.lines.every((line) => {
            if (!line || typeof line !== 'object') return false;
            const row = line as Record<string, unknown>;
            return (
              read.currency !== null &&
              typeof row.unitPrice === 'number' &&
              Number.isFinite(row.unitPrice) &&
              (row.quantity === undefined ||
                (typeof row.quantity === 'number' && Number.isFinite(row.quantity))) &&
              (row.discountPercent === undefined ||
                row.discountPercent === null ||
                row.discountPercent === '' ||
                (typeof row.discountPercent === 'number' && Number.isFinite(row.discountPercent)))
            );
          }));
      if (!read.currency || !validInvoiceLines) {
        read.warnings.push({
          code: 'TOTALS_UNAVAILABLE',
          message: 'Recorded financial amounts or currency are missing or invalid.',
        });
        continue;
      }
      const totals = resolveFlatTotals(ref.typeId, data) ?? computeDocumentTotals(invoiceDescriptor, data);
      read.warnings = totals.warnings.map((warning) => ({
        code: warning.key,
        message: formatServerMessage(warning),
        ...(warning.params ? { params: warning.params } : {}),
      }));
      if (
        totals.grossMinor === null ||
        ![totals.grossMinor, totals.netMinor, totals.vatMinor].every(
          (value) => value === null || Number.isSafeInteger(value),
        )
      ) {
        read.warnings.push({
          code: 'TOTALS_UNAVAILABLE',
          message: 'Recorded financial amounts or currency are missing or invalid.',
        });
        continue;
      }
      read.grossMinor = totals.grossMinor;
      read.netMinor = totals.netMinor;
      read.vatMinor = totals.vatMinor;
      if (ref.typeId === 'expense') {
        read.paymentKnowledge = 'UNSUPPORTED';
        read.warnings.push({
          code: 'PAYMENTS_UNSUPPORTED',
          message: 'Expense payment information is not supported.',
        });
        continue;
      }
      const { credits, warnings } = creditsForInvoiceFromNotes(notes, source.id, invoiceDescriptor, data);
      read.warnings.push(
        ...warnings.map((warning) => ({
          code: warning.key,
          message: formatServerMessage(warning),
          ...(warning.params ? { params: warning.params } : {}),
        })),
      );
      const paymentsByEntry = new Map(sourcePayments.map((payment) => [payment.id, payment]));
      const validPayments = sourcePayments.every((payment) => {
        if (
          !Number.isSafeInteger(payment.documentAmountMinor) ||
          !Number.isSafeInteger(payment.amountMinor) ||
          !isFinancialCurrency(payment.currency)
        ) {
          return false;
        }

        if (!payment.reversesPaymentId) return payment.documentAmountMinor >= 0 && payment.amountMinor >= 0;

        const original = paymentsByEntry.get(payment.reversesPaymentId);
        return (
          original !== undefined &&
          !original.reversesPaymentId &&
          payment.currency === original.currency &&
          payment.amountMinor === -original.amountMinor &&
          payment.documentAmountMinor === -original.documentAmountMinor
        );
      });
      const paid = sourcePayments.reduce((sum, payment) => sum + payment.documentAmountMinor, 0);
      const credited = credits.reduce((sum, credit) => sum + credit.amountMinor, 0);
      if (
        !validPayments ||
        !credits.every((credit) => Number.isSafeInteger(credit.amountMinor) && credit.amountMinor >= 0) ||
        ![paid, credited, paid + credited, totals.grossMinor - paid - credited].every(Number.isSafeInteger)
      ) {
        read.warnings.push({
          code: 'SETTLEMENT_UNAVAILABLE',
          message: 'Recorded payments or credits contain invalid amounts or currency.',
        });
        continue;
      }
      read.paymentKnowledge = 'KNOWN';
      const { totalGrossMinor: _, ...settlement } = computeSettlement(
        totals.grossMinor,
        toSettlementPaymentInputs(sourcePayments),
        toSettlementCreditInputs(credits),
      );
      read.settlement = settlement;
      read.payments = sourcePayments.map((payment) => ({
        source: 'document-payment',
        id: payment.id,
        documentAmountMinor: payment.documentAmountMinor,
        originalAmountMinor: payment.amountMinor,
        originalCurrency: payment.currency,
        paidOn: payment.paidAt.toISOString(),
      }));
    }
    return result;
  }
}
