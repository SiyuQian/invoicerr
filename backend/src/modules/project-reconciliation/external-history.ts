import type {
  ReconciliationAuditEvent,
  ExternalReceiptAllocation,
} from '../../../prisma/generated/prisma/client';

/** Replay whole receipt sets in aggregate revision order; summing individual receipt peaks invents cash. */
export function collectedPeaks(events: ReconciliationAuditEvent[], current: ExternalReceiptAllocation[]) {
  const byReceipt = new Map<string, Array<{ invoiceReferenceId: string; amountMinor: number }>>();
  const peaks = new Map<string, number>();
  const record = () => {
    const total = new Map<string, number>();
    for (const allocations of byReceipt.values())
      for (const a of allocations)
        total.set(a.invoiceReferenceId, (total.get(a.invoiceReferenceId) ?? 0) + a.amountMinor);
    for (const [id, amount] of total) peaks.set(id, Math.max(peaks.get(id) ?? 0, amount));
  };
  type Entry = {
    versionToken: string;
    result: {
      receiptId?: string;
      id?: string;
      allocations?: Array<{ customerInvoiceId: string; amountMinor: number }>;
    };
  };
  const ordered = [...events].sort(
    (a, b) =>
      Number((a.after as Entry).versionToken.split(':')[0]) -
      Number((b.after as Entry).versionToken.split(':')[0]),
  );
  for (const event of ordered) {
    const result = (event.after as Entry).result;
    const receiptId = event.operation === 'receipt.void' ? result.id! : result.receiptId!;
    const before = (
      event.before as { state: { allocations: Array<{ invoiceReferenceId: string; amountMinor: number }> } }
    ).state;
    byReceipt.set(receiptId, before.allocations);
    record();
    byReceipt.set(
      receiptId,
      (result.allocations ?? []).map((a) => ({
        invoiceReferenceId: a.customerInvoiceId,
        amountMinor: a.amountMinor,
      })),
    );
    record();
  }
  byReceipt.clear();
  for (const a of current) byReceipt.set(a.receiptId, [...(byReceipt.get(a.receiptId) ?? []), a]);
  record();
  return peaks;
}
