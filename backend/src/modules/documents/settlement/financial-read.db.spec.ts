import prisma from '@/prisma/prisma.service';
import { Prisma } from '../../../../prisma/generated/prisma/client';
import { ROW_ID_KEY } from '../row-selection/row-selection';
import { FinancialReadService, financialReadKey } from './financial-read.service';

// Only invented tenants, on the disposable test DB selected by the test environment.
describe('FinancialReadService supplied transaction, real Postgres', () => {
  const service = new FinancialReadService();
  let companyId: string;
  let foreignCompanyId: string;
  const ids: string[] = [];
  beforeAll(async () => {
    for (const name of ['Financial read', 'Foreign financial read']) {
      const co = await prisma.company.create({
        data: {
          name,
          foundedAt: new Date('2020-01-01'),
          address: '1 Test Street',
          postalCode: '1010',
          city: 'Auckland',
          country: 'New Zealand',
          countryCode: 'NZ',
          phone: '+6400000000',
          email: `financial-read-${crypto.randomUUID()}@example.test`,
        },
      });
      if (!companyId) companyId = co.id;
      else foreignCompanyId = co.id;
    }
    for (let i = 0; i < 21; i++) {
      const doc = await prisma.documentInstance.create({
        data: {
          companyId: i === 20 ? foreignCompanyId : companyId,
          typeId: 'invoice',
          status: 'sent',
          data: {
            currency: 'NZD',
            lines: [
              { [ROW_ID_KEY]: 'a', quantity: 1, unitPrice: 2000, vatRate: '0' },
              { [ROW_ID_KEY]: 'b', quantity: 1, unitPrice: 300, vatRate: '0' },
            ],
          },
        },
      });
      ids.push(doc.id);
    }
    await prisma.documentPayment.create({
      data: {
        companyId,
        documentId: ids[1],
        amountMinor: 110000,
        currency: 'USD',
        documentAmountMinor: 100000,
        method: 'other',
        paidAt: new Date('2026-01-01'),
      },
    });
    await prisma.documentInstance.create({
      data: {
        companyId,
        typeId: 'credit-note',
        status: 'sent',
        data: { invoice: ids[1], currency: 'NZD', correctedLines: ['b'] },
      },
    });
  });
  afterAll(async () => {
    await prisma.company.deleteMany({ where: { id: { in: [companyId, foreignCompanyId].filter(Boolean) } } });
  });

  it('holds one coherent snapshot when payment and credit arrive between facade queries', async () => {
    let releaseRead!: () => void;
    let sourceRead!: () => void;
    const writerFinished = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const sourceReady = new Promise<void>((resolve) => {
      sourceRead = resolve;
    });
    let intercepted = false;
    const reader = prisma.$extends({
      query: {
        documentInstance: {
          async findMany({ args, query }) {
            const rows = await query(args);
            if (!intercepted) {
              intercepted = true;
              sourceRead();
              await writerFinished;
            }
            return rows;
          },
        },
      },
    });
    const refs = [{ typeId: 'invoice' as const, id: ids[0] }];
    const original = await prisma.documentInstance.findUniqueOrThrow({ where: { id: ids[0] } });
    const reading = reader.$transaction((tx) => service.readMany(companyId, refs, tx), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      timeout: 15000,
    });
    await sourceReady;
    try {
      await prisma.$transaction(async (tx) => {
        await tx.documentPayment.create({
          data: {
            companyId,
            documentId: ids[0],
            amountMinor: 110000,
            currency: 'USD',
            documentAmountMinor: 100000,
            method: 'other',
            paidAt: new Date('2026-01-01'),
          },
        });
        await tx.documentInstance.create({
          data: {
            companyId,
            typeId: 'credit-note',
            status: 'sent',
            data: { invoice: ids[0], currency: 'NZD', correctedLines: ['b'] },
          },
        });
      });
    } finally {
      releaseRead();
    }
    const snapshot = (await reading).get(financialReadKey(refs[0]))!;
    expect(snapshot.settlement).toMatchObject({ paidMinor: 0, creditedMinor: 0, outstandingMinor: 230000 });
    const later = (await prisma.$transaction((tx) => service.readMany(companyId, refs, tx))).get(
      financialReadKey(refs[0]),
    )!;
    expect(later.settlement).toMatchObject({
      paidMinor: 100000,
      creditedMinor: 30000,
      outstandingMinor: 100000,
    });
    expect(later.sourceVersion).not.toBe(snapshot.sourceVersion);
    expect((await prisma.documentInstance.findUniqueOrThrow({ where: { id: ids[0] } })).updatedAt).toEqual(
      original.updatedAt,
    );
  });

  it('uses one bounded payment/credit query set per batch and never exposes a foreign source', async () => {
    const calls: string[] = [];
    const reader = prisma.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            calls.push(`${model}.${operation}`);
            return query(args);
          },
        },
      },
    });
    async function batch(sourceIds: string[]) {
      calls.length = 0;
      const result = await reader.$transaction((tx) =>
        service.readMany(
          companyId,
          sourceIds.map((id) => ({ typeId: 'invoice', id })),
          tx,
        ),
      );
      return { result, queries: [...calls].sort() };
    }
    const one = await batch(ids.slice(1, 2));
    const many = await batch(ids);
    expect(many.queries).toEqual(one.queries);
    expect(many.queries).toEqual([
      'DocumentInstance.findMany',
      'DocumentInstance.findMany',
      'DocumentPayment.findMany',
    ]);
    expect(many.result.get(financialReadKey({ typeId: 'invoice', id: ids[20] }))).toMatchObject({
      status: 'unavailable',
      grossMinor: null,
      settlement: null,
      payments: [],
    });
    expect(many.result.get(financialReadKey({ typeId: 'invoice', id: ids[1] }))?.settlement).toMatchObject({
      paidMinor: 100000,
      creditedMinor: 30000,
    });
  });
});
