import { Prisma } from '../../../../prisma/generated/prisma/client';
import { ROW_ID_KEY } from '../row-selection/row-selection';
import { buildReceivedInvoiceDescriptor } from '../descriptors/received-invoice.descriptor';
import { buildExpenseDescriptor } from '../descriptors/expense.descriptor';
import { resolveDocumentTotalsView, resolveSettlementTotals } from '../totals/document-totals-view';
import { FinancialReadService, financialReadKey } from './financial-read.service';

const at = new Date('2026-01-01T00:00:00Z');
function document(typeId: string, data: Record<string, unknown>, id = 'doc-1') {
  return {
    id,
    typeId,
    data,
    companyId: 'co-1',
    status: 'sent',
    displayNumber: null,
    createdAt: at,
    updatedAt: at,
  };
}
function payment(overrides = {}) {
  return {
    id: 'pay-1',
    documentId: 'doc-1',
    amountMinor: 110000,
    currency: 'USD',
    documentAmountMinor: 100000,
    conversionRate: null,
    conversionRateAsOf: null,
    conversionSource: null,
    paidAt: at,
    method: 'card',
    note: null,
    createdAt: at,
    ...overrides,
  };
}
function store(documents: ReturnType<typeof document>[], payments: ReturnType<typeof payment>[] = []) {
  return {
    documentInstance: {
      findMany: async (args: { where: { companyId: string; typeId?: string; id?: { in: string[] } } }) =>
        documents.filter(
          (d) =>
            d.companyId === args.where.companyId &&
            (!args.where.typeId || d.typeId === args.where.typeId) &&
            (!args.where.id?.in || args.where.id.in.includes(d.id)),
        ),
    },
    documentPayment: { findMany: async () => payments },
  } as unknown as Prisma.TransactionClient;
}
async function read(
  typeId: 'invoice' | 'expense' | 'received-invoice',
  data: Record<string, unknown>,
  payments: ReturnType<typeof payment>[] = [],
) {
  const result = await new FinancialReadService().readMany(
    'co-1',
    [{ typeId, id: 'doc-1' }],
    store([document(typeId, data)], payments),
  );
  return result.get(financialReadKey({ typeId, id: 'doc-1' }))!;
}

describe('FinancialReadService canonical money', () => {
  it('settles recorded gross without inventing net or tax on a lines-less received invoice', async () => {
    const result = await read('received-invoice', { grossAmount: 86.96, lines: [], currency: 'NZD' }, [
      payment({ amountMinor: 8696, currency: 'NZD', documentAmountMinor: 8696 }),
    ]);
    expect(result).toMatchObject({
      grossMinor: 8696,
      netMinor: null,
      vatMinor: null,
      paymentKnowledge: 'KNOWN',
      settlement: { paidMinor: 8696, creditedMinor: 0, outstandingMinor: 0, excessMinor: 0, settled: true },
    });
    expect(
      resolveSettlementTotals(
        'received-invoice',
        buildReceivedInvoiceDescriptor(),
        { grossAmount: 86.96, lines: [], currency: 'NZD' },
        null,
        'Bill',
      ).grossMinor,
    ).toBe(8696);
  });

  it('preserves an expense amount while disclosing unsupported payment knowledge', async () => {
    expect(await read('expense', { amount: 77.51, currency: 'NZD' })).toMatchObject({
      grossMinor: 7751,
      netMinor: null,
      vatMinor: null,
      paymentKnowledge: 'UNSUPPORTED',
      settlement: null,
      payments: [],
    });
    expect(
      resolveDocumentTotalsView(
        'expense',
        buildExpenseDescriptor(),
        { amount: 77.51, currency: 'NZD' },
        null,
      ),
    ).toMatchObject({ grossMinor: 7751, netMinor: null, vatMinor: null });
  });

  it('keeps explicit zero tax distinct from absent tax and prefers supplier flat totals over informational lines', async () => {
    expect(
      await read('received-invoice', {
        grossAmount: 86.96,
        netAmount: 86.96,
        vatAmount: 0,
        currency: 'NZD',
        lines: [{ quantity: 1, unitPrice: 1, vatRate: '0' }],
      }),
    ).toMatchObject({ grossMinor: 8696, netMinor: 8696, vatMinor: 0 });
  });

  it.each([
    { grossAmount: 1, currency: 'wat' },
    { grossAmount: 1, currency: '' },
    { grossAmount: 1 },
    { grossAmount: 1.001, currency: 'NZD' },
    { grossAmount: Number.MAX_SAFE_INTEGER, currency: 'NZD' },
    { grossAmount: '86.96', currency: 'NZD' },
    { grossAmount: 86.96, vatAmount: 0.001, currency: 'NZD' },
  ])('returns unavailable rather than rounding/defaulting invalid flat money %j', async (data) => {
    const result = await read('received-invoice', data);
    expect(result.grossMinor).toBeNull();
    expect(result.settlement).toBeNull();
    expect(result.paymentKnowledge).toBe('UNKNOWN');
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('keeps ordinary invoice totals, pinned converted payments, and canonical credits separate', async () => {
    const invoice = document('invoice', {
      currency: 'NZD',
      lines: [
        { [ROW_ID_KEY]: 'a', quantity: 1, unitPrice: 2000, vatRate: '0' },
        { [ROW_ID_KEY]: 'b', quantity: 1, unitPrice: 300, vatRate: '0' },
      ],
    });
    const note = document(
      'credit-note',
      { invoice: invoice.id, currency: 'NZD', correctedLines: ['b'] },
      'note-1',
    );
    const payments = [payment()];
    const db = store([invoice, note], payments);
    const service = new FinancialReadService();
    const refs = [{ typeId: 'invoice' as const, id: invoice.id }];
    const first = (await service.readMany('co-1', refs, db)).get(financialReadKey(refs[0]))!;
    expect(first).toMatchObject({
      grossMinor: 230000,
      settlement: {
        paidMinor: 100000,
        creditedMinor: 30000,
        outstandingMinor: 100000,
        excessMinor: 0,
        settled: false,
      },
    });
    expect(first.payments[0]).toEqual({
      source: 'document-payment',
      id: 'pay-1',
      documentAmountMinor: 100000,
      originalAmountMinor: 110000,
      originalCurrency: 'USD',
      paidOn: at.toISOString(),
    });
    payments[0].documentAmountMinor = 110000;
    const second = (await service.readMany('co-1', refs, db)).get(financialReadKey(refs[0]))!;
    expect(second.sourceVersion).not.toBe(first.sourceVersion);
    note.data.correctedLines = ['a'];
    const third = (await service.readMany('co-1', refs, db)).get(financialReadKey(refs[0]))!;
    expect(third.sourceVersion).not.toBe(second.sourceVersion);
    expect(third.settlement?.creditedMinor).toBe(200000);
  });

  it.each([
    { line: { quantity: 1, unitPrice: 1.001, vatRate: '0' }, minor: 100 },
    { line: { quantity: 1, unitPrice: 10, discountPercent: null, vatRate: '0' }, minor: 1000 },
    { line: { quantity: 1, unitPrice: 10, discountPercent: '', vatRate: '0' }, minor: 1000 },
  ])('preserves canonical invoice arithmetic for $line', async ({ line, minor }) => {
    const result = await read('invoice', { currency: 'NZD', lines: [line] });
    expect(result).toMatchObject({
      grossMinor: minor,
      netMinor: minor,
      vatMinor: 0,
      paymentKnowledge: 'KNOWN',
      settlement: { paidMinor: 0, creditedMinor: 0, outstandingMinor: minor, excessMinor: 0, settled: false },
    });
    expect(result.warnings).toEqual([]);
  });

  it.each([
    null,
    'bad',
    { currency: 'NZD', lines: [null] },
    { currency: 'NZD', lines: [{ unitPrice: Number.POSITIVE_INFINITY, quantity: 1 }] },
    { currency: 'NZD', lines: [{ unitPrice: Number.MAX_SAFE_INTEGER, quantity: 1 }] },
  ])('reports malformed invoice amounts as unavailable %j', async (data) => {
    const result = await read('invoice', data as Record<string, unknown>);
    expect(result.grossMinor).toBeNull();
    expect(result.settlement).toBeNull();
  });

  it.each([
    ['JPY', 15, 15],
    ['KWD', 1.234, 1234],
    ['NZD', 0, 0],
  ] as const)('uses the currency precision for %s', async (currency, grossAmount, grossMinor) => {
    expect(await read('received-invoice', { currency, grossAmount })).toMatchObject({
      grossMinor,
      netMinor: null,
      vatMinor: null,
    });
  });

  it('does not infer payment completion from a paid status label', async () => {
    const source = {
      ...document('received-invoice', { currency: 'NZD', grossAmount: 86.96 }),
      status: 'paid',
    };
    const result = await new FinancialReadService().readMany(
      'co-1',
      [{ typeId: 'received-invoice', id: source.id }],
      store([source]),
    );
    expect(
      result.get(financialReadKey({ typeId: 'received-invoice', id: source.id }))?.settlement,
    ).toMatchObject({ paidMinor: 0, outstandingMinor: 8696, settled: false });
  });

  it.each([
    { amountMinor: 1.5 },
    { currency: 'wat' },
    { documentAmountMinor: -1 },
    { documentAmountMinor: Number.MAX_SAFE_INTEGER + 1 },
  ])('discloses unavailable settlement for invalid stored payments %j', async (overrides) => {
    const result = await read('received-invoice', { currency: 'NZD', grossAmount: 86.96 }, [
      payment(overrides),
    ]);
    expect(result.grossMinor).toBe(8696);
    expect(result.paymentKnowledge).toBe('UNKNOWN');
    expect(result.settlement).toBeNull();
    expect(result.warnings.map((warning) => warning.code)).toContain('SETTLEMENT_UNAVAILABLE');
  });

  it('returns typed unavailable entries for missing or wrong-type sources', async () => {
    const result = await new FinancialReadService().readMany(
      'co-1',
      [
        { typeId: 'invoice', id: 'missing' },
        { typeId: 'invoice', id: 'doc-1' },
      ],
      store([document('expense', { amount: 1, currency: 'NZD' })]),
    );
    for (const value of result.values())
      expect(value).toMatchObject({
        typeId: 'invoice',
        grossMinor: null,
        status: 'unavailable',
        paymentKnowledge: 'UNKNOWN',
        settlement: null,
      });
    expect(result.size).toBe(2);
  });
});
