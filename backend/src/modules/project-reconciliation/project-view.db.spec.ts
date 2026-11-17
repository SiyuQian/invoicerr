import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import prisma from '@/prisma/prisma.service';
import { FinancialReadService } from '../documents/settlement/financial-read.service';
import { ReconciliationService } from './service';
import { ExternalReceiptsService } from './external-receipts';
import { purgeReconciliationForCompany } from './persistence';
import { parse, schemas } from './validation';
const actor = { id: 'invented-viewer', kind: 'user' as const };
const stage = {
  title: 'Invented stage',
  periodStart: null,
  periodEnd: null,
  agreedGrossMinor: null,
  agreedNetMinor: null,
  agreedVatMinor: null,
  agreementReference: null,
};
describe('project-view coherent real Postgres reads', () => {
  const financial = new FinancialReadService();
  const core = new ReconciliationService(financial, prisma);
  const external = new ExternalReceiptsService(core);
  let companyId: string, customerId: string, partnerId: string, projectId: string, caseId: string;
  async function context() {
    return {
      actor,
      requestKey: randomUUID(),
      expectedVersion: (await core.getProject(companyId, projectId)).versionToken,
    };
  }
  async function project(mode: 'PARTNER' | 'COMPANY' = 'PARTNER') {
    projectId = (
      await core.createProject(
        companyId,
        {
          name: 'Invented project',
          endCustomerName: 'Invented customer',
          currency: 'NZD',
          collectionMode: mode,
          endCustomerClientId: customerId,
          partnerClientId: partnerId,
          timeProjectId: null,
          description: null,
        },
        { actor, requestKey: randomUUID(), expectedVersion: 'new' },
      )
    ).result.id;
    caseId = (await core.createCase(companyId, projectId, stage, await context())).result.id;
  }
  async function invoice(grossMinor = 230000, date: string | null = '2026-10-01') {
    return (
      await external.saveExternalInvoice(
        companyId,
        projectId,
        {
          caseId,
          issuer: 'Invented partner',
          recipient: 'Invented customer',
          number: randomUUID(),
          issueDate: date,
          dueDate: null,
          currency: 'NZD',
          grossMinor,
          netMinor: null,
          vatMinor: null,
          reportedStatus: 'Paid',
          sourceSystem: null,
          sourceId: null,
          sourceAsOf: null,
          sourceReference: 'Invented export',
        },
        await context(),
      )
    ).result;
  }
  async function receipt(amountMinor = 230000, paidOn: string | null = null) {
    return (
      await external.recordExternalReceipt(
        companyId,
        projectId,
        {
          amountMinor,
          currency: 'NZD',
          paidOn,
          evidenceClass: 'EVIDENCE_CHECKED',
          attested: true,
          evidenceReference: 'Invented proof',
          evidenceUrl: null,
          reason: 'Human checked invented evidence',
        },
        await context(),
      )
    ).result;
  }
  async function document(
    role = 'SETTLEMENT_INCOME',
    amount = 1150,
    date = '2026-10-01',
    target: string | null = caseId,
  ) {
    const typeId =
      role === 'PARTNER_BILL' ? 'received-invoice' : role === 'PROJECT_COST' ? 'expense' : 'invoice';
    const row = await prisma.documentInstance.create({
      data: {
        companyId,
        typeId,
        status: typeId === 'invoice' ? 'sent' : typeId === 'expense' ? 'draft' : 'approved',
        data: {
          currency: 'NZD',
          client: role === 'SETTLEMENT_INCOME' ? partnerId : customerId,
          supplierClient: partnerId,
          issueDate: date,
          date,
          amount,
          grossAmount: amount,
          lines: [{ quantity: 1, unitPrice: amount, vatRate: '0' }],
        },
      },
    });
    await core.linkDocument(
      companyId,
      projectId,
      { documentId: row.id, typeId, caseId: target, role } as never,
      await context(),
    );
    return row;
  }
  async function pay(documentId: string, amount: number, date = '2026-11-05') {
    await prisma.documentPayment.create({
      data: {
        companyId,
        documentId,
        amountMinor: amount,
        documentAmountMinor: amount,
        currency: 'NZD',
        paidAt: new Date(date),
      },
    });
  }
  beforeEach(async () => {
    companyId = (
      await prisma.company.create({
        data: {
          name: 'Invented T6 company',
          foundedAt: new Date('2020-01-01'),
          address: '1 Invented St',
          postalCode: '1010',
          city: 'Auckland',
          country: 'New Zealand',
          countryCode: 'NZ',
          phone: '+6400000000',
          email: `${randomUUID()}@example.test`,
        },
      })
    ).id;
    customerId = (
      await prisma.client.create({ data: { companyId, name: 'Invented customer', country: 'New Zealand' } })
    ).id;
    partnerId = (
      await prisma.client.create({ data: { companyId, name: 'Invented partner', country: 'New Zealand' } })
    ).id;
    await project();
  });
  afterEach(async () => {
    await prisma.$transaction(async (tx) => {
      await purgeReconciliationForCompany(tx, companyId);
      await tx.company.delete({ where: { id: companyId } });
    });
  });
  it('keeps source Paid separate from checked customer evidence and company recorded cash', async () => {
    await core.updateCase(
      companyId,
      projectId,
      caseId,
      { agreedGrossMinor: 115000, agreementReference: 'Invented agreement' },
      await context(),
    );
    const i = await invoice();
    const own = await document();
    await pay(own.id, 115000);
    let view = await core.getProject(companyId, projectId);
    expect(view).toHaveProperty('summary');
    expect(view.sourceMarkedPaid).toMatchObject({ knownMinor: 230000, completeness: 'COMPLETE' });
    expect(view.checkedReceipts.completeness).toBe('UNKNOWN');
    expect(view.summary.ownRecordedReceipts.knownMinor).toBe(115000);
    expect(view.summary.ownOutstanding.knownMinor).toBe(0);
    const r = await receipt();
    await external.replaceReceiptAllocations(
      companyId,
      projectId,
      { receiptId: r.id, allocations: [{ customerInvoiceId: i.id, amountMinor: 230000 }] },
      await context(),
    );
    view = await core.getProject(companyId, projectId);
    expect(view.checkedReceipts.knownMinor).toBe(230000);
    expect(view.undated.checkedReceipts).toMatchObject({ knownMinor: 230000, count: 1 });
    expect(view.summary.ownRecordedReceipts.knownMinor).toBe(115000);
    expect(view.cases.items[0].documentLinks[0].financial.payments[0].documentAmountMinor).toBe(115000);
    parse(schemas.projectView, view);
    for (let n = 0; n < 3; n++) await core.createCase(companyId, projectId, stage, await context());
    expect((await core.getProject(companyId, projectId)).unknownAgreementCount).toBe(3);
  });
  it('counts own customer invoice once, outgoing bill separately, with global balances under date filters', async () => {
    await project('COMPANY');
    await core.updateCase(
      companyId,
      projectId,
      caseId,
      { agreedGrossMinor: 86250, agreementReference: 'Outgoing agreement' },
      await context(),
    );
    const own = await document('CUSTOMER_INVOICE', 1725);
    await pay(own.id, 69000);
    await pay(own.id, 103500, '2026-12-01');
    const bill = await document('PARTNER_BILL', 862.5, '2026-10-01', null);
    await pay(bill.id, 86250);
    const full = await core.getProject(companyId, projectId);
    expect(full).toHaveProperty('summary');
    expect(full.summary.customerInvoiced.knownMinor).toBe(172500);
    expect(full.summary.ownRecordedReceipts.knownMinor).toBe(172500);
    expect(full.summary.unbilledDifference.knownMinor).toBe(0);
    expect(full.summary.partnerPaid.knownMinor).toBe(86250);
    expect(full.summary.projectCosts.knownMinor).toBe(0);
    const filtered = await core.getProject(companyId, projectId, {
      invoiceFrom: '2026-11-01',
      cashFrom: '2026-11-01',
      cashTo: '2026-11-30',
    });
    expect(filtered.summary.customerInvoiced.knownMinor).toBe(0);
    expect(filtered.summary.ownRecordedReceipts.knownMinor).toBe(69000);
    expect(filtered.summary.ownOutstanding.knownMinor).toBe(0);
    expect(filtered.summary.partnerPaid.knownMinor).toBe(86250);
    expect(filtered.versionToken).toBe(full.versionToken);
    expect(filtered.attentionCount).toBe(full.attentionCount);
    expect(full.cases.items[0].customerInvoices[0].documentLinkId).toBe(
      full.cases.items[0].documentLinks[0].id,
    );
  });
  it.each([
    {
      mode: 'COMPANY',
      role: 'CUSTOMER_INVOICE',
      status: 'cancelled',
      issued: 'customerInvoiced',
      cash: 'ownRecordedReceipts',
      outstanding: 'ownOutstanding',
    },
    {
      mode: 'PARTNER',
      role: 'SETTLEMENT_INCOME',
      status: 'cancelled',
      issued: 'settlementInvoiced',
      cash: 'ownRecordedReceipts',
      outstanding: 'ownOutstanding',
    },
    {
      mode: 'COMPANY',
      role: 'PARTNER_BILL',
      status: 'rejected',
      issued: 'partnerBills',
      cash: 'partnerPaid',
      outstanding: 'partnerOutstanding',
    },
    {
      mode: 'COMPANY',
      role: 'CUSTOMER_INVOICE',
      status: 'draft',
      issued: 'customerInvoiced',
      cash: 'ownRecordedReceipts',
      outstanding: 'ownOutstanding',
    },
  ] as const)('retains canonical $cash/$outstanding after $role becomes $status across detail/list/CSV', async ({
    mode,
    role,
    status,
    issued,
    cash,
    outstanding,
  }) => {
    await project(mode);
    const source = await document(role, 10);
    await pay(source.id, 400);
    const before = await core.getProject(companyId, projectId);
    expect(before.summary[issued].knownMinor).toBe(1000);
    expect(before.summary[cash].knownMinor).toBe(400);
    expect(before.summary[outstanding].knownMinor).toBe(600);
    const recordedPayments = await prisma.documentPayment.findMany({
      where: { companyId, documentId: source.id },
    });
    await prisma.documentInstance.update({ where: { id: source.id }, data: { status } });
    const lifetime = await core.getProject(companyId, projectId);
    const dated = await core.getProject(companyId, projectId, {
      cashFrom: '2026-11-01',
      cashTo: '2026-11-30',
    });
    for (const view of [lifetime, dated]) {
      expect(view.summary[issued]).toEqual({ knownMinor: 0, missingCount: 0, completeness: 'COMPLETE' });
      expect(view.summary[cash]).toEqual({ knownMinor: 400, missingCount: 0, completeness: 'COMPLETE' });
      expect(view.summary[outstanding]).toEqual({
        knownMinor: 600,
        missingCount: 0,
        completeness: 'COMPLETE',
      });
      expect(view.cases.items[0].summary[cash].knownMinor).toBe(400);
      expect(view.cases.items[0].summary[outstanding].knownMinor).toBe(600);
      if (role === 'CUSTOMER_INVOICE') expect(view.summary.customerRemaining.knownMinor).toBe(600);
      expect(view.cases.items[0].documentLinks[0].financial).toMatchObject({
        status,
        settlement: { paidMinor: 400, outstandingMinor: 600, settled: false },
      });
      expect(view.exceptions).toContainEqual(
        expect.objectContaining({ code: 'DOCUMENT_NOT_ISSUED', blocking: true }),
      );
      expect(view.exceptions).toContainEqual(
        expect.objectContaining({ code: 'OWN_OUTSTANDING', blocking: true }),
      );
      expect(view.effectiveReviewState).toBe('OPEN');
    }
    const outsideCashWindow = await core.getProject(companyId, projectId, { cashFrom: '2026-12-01' });
    expect(outsideCashWindow.summary[cash].knownMinor).toBe(0);
    expect(outsideCashWindow.summary[outstanding].knownMinor).toBe(600);
    const list = await core.listProjects(companyId, { needsAttention: 'true' });
    const listed = list.items.find((row) => row.project.id === projectId)!;
    expect(listed.summary[issued].knownMinor).toBe(0);
    expect(listed.summary[cash].knownMinor).toBe(400);
    expect(listed.summary[outstanding].knownMinor).toBe(600);
    for (const filters of [{}, { cashFrom: '2026-11-01', cashTo: '2026-11-30' }]) {
      const csv = await core.exportProject(companyId, projectId, filters);
      for (const [key, amount, basis] of [
        [issued, 0, 'overall'],
        [cash, 400, 'cashFrom' in filters ? 'in period: cash date' : 'overall'],
        [outstanding, 600, 'overall'],
      ] as const) {
        const measures = csv.split('\r\n').filter((line) => line.includes(`,measure,,${key},`));
        expect(measures).toHaveLength(2);
        for (const line of measures) expect(line).toContain(`${key},${amount},0,COMPLETE,${basis}`);
      }
    }
    expect((await prisma.documentInstance.findUniqueOrThrow({ where: { id: source.id } })).data).toEqual(
      source.data,
    );
    expect(await prisma.documentPayment.findMany({ where: { companyId, documentId: source.id } })).toEqual(
      recordedPayments,
    );
  });
  it('omits undated cash in dated totals while preserving global and off-page allocation context', async () => {
    const i = await invoice();
    const r = await receipt();
    await external.replaceReceiptAllocations(
      companyId,
      projectId,
      { receiptId: r.id, allocations: [{ customerInvoiceId: i.id, amountMinor: 230000 }] },
      await context(),
    );
    const view = await core.getProject(companyId, projectId, { cashFrom: '2026-01-01' });
    expect(view).toHaveProperty('checkedReceipts');
    expect(view.checkedReceipts.knownMinor).toBe(0);
    expect(view.undated.checkedReceipts).toMatchObject({ knownMinor: 230000, count: 1 });
    expect(view.cases.items[0].customerInvoices[0]).toMatchObject({
      originalGrossMinor: 230000,
      allocatedMinor: 230000,
      availableMinor: 0,
    });
    await invoice(1000);
    const choices = await core.listCustomerInvoices(companyId, projectId, { limit: '1' });
    expect(choices.items[0].id).not.toBe(i.id);
    const nextChoices = await core.listCustomerInvoices(companyId, projectId, {
      limit: '1',
      cursor: choices.nextCursor,
    });
    expect(nextChoices.items[0].availableMinor).toBe(0);
    const receipts = await core.listReceipts(companyId, projectId);
    expect(receipts.items[0].allocations[0].customerInvoice).toMatchObject({
      id: i.id,
      number: i.external.number,
      availableMinor: 0,
    });
    parse(schemas.receiptPage, receipts);
    await external.voidExternalReceipt(
      companyId,
      projectId,
      { receiptId: r.id, reason: 'Invented reversal' },
      await context(),
    );
    expect((await core.listReceipts(companyId, projectId)).items[0]).toMatchObject({
      amountMinor: 230000,
      allocatedMinor: 0,
      unallocatedMinor: 0,
      allocations: [],
    });
  });
  it('paginates tied cases/receipts without losing rows and rejects cross-project cursors', async () => {
    const time = new Date('2026-01-01');
    for (let n = 0; n < 29; n++)
      await prisma.reconciliationCase.create({
        data: { companyId, projectId, title: `Stage ${n}`, createdAt: time },
      });
    await prisma.reconciliationCase.update({ where: { id: caseId }, data: { createdAt: time } });
    await prisma.externalReceipt.createMany({
      data: Array.from({ length: 30 }, (_, n) => ({
        id: `invented-${randomUUID()}-${n}`,
        companyId,
        projectId,
        currency: 'NZD' as const,
        collector: 'Invented',
        grossMinor: 100,
        enteredBy: 'user:invented',
        sourceReference: 'Invented',
        createdAt: time,
      })),
    });
    const one = await core.getProject(companyId, projectId);
    expect(one.cases.items).toHaveLength(25);
    expect(one.cases.total).toBe(30);
    const two = await core.getProject(companyId, projectId, { cursor: one.cases.nextCursor });
    expect(new Set([...one.cases.items, ...two.cases.items].map((c) => c.id)).size).toBe(30);
    const receipts = await core.listReceipts(companyId, projectId);
    expect(receipts.items).toHaveLength(25);
    expect(
      (await core.listReceipts(companyId, projectId, { cursor: receipts.nextCursor })).items,
    ).toHaveLength(5);
    const original = projectId;
    await project();
    await expect(core.getProject(companyId, original, { cursor: caseId })).rejects.toMatchObject({
      status: 404,
    });
    await expect(core.listReceipts(companyId, original, { cursor: 'missing' })).rejects.toMatchObject({
      status: 404,
    });
    await expect(core.getProject(companyId, original, { limit: '101' })).rejects.toMatchObject({
      status: 400,
    });
  });
  it('returns unknown canonical failures and OPEN empty projects, with no mixed-currency cash total', async () => {
    await document();
    const broken = new ReconciliationService(
      {
        readMany: async () => {
          throw new Error('Invented source failure');
        },
      } as FinancialReadService,
      prisma,
    );
    const view = await broken.getProject(companyId, projectId);
    expect(view).toHaveProperty('summary');
    expect(view.summary.ownOutstanding.completeness).toBe('UNKNOWN');
    expect(view.warnings.some((w) => w.code === 'FINANCIAL_READ_UNAVAILABLE')).toBe(true);
    expect(view.effectiveReviewState).toBe('OPEN');
    expect(view.cases.items[0].documentLinks[0].financial.settlement).toBeNull();
    await expect(
      broken.updateCase(companyId, projectId, caseId, { title: 'Cannot write' }, await context()),
    ).rejects.toMatchObject({ status: 503 });
    const empty = await core.createProject(
      companyId,
      {
        name: 'Empty',
        endCustomerName: 'Empty customer',
        currency: 'JPY',
        collectionMode: 'COMPANY',
        endCustomerClientId: null,
        partnerClientId: null,
        timeProjectId: null,
        description: null,
      },
      { actor, requestKey: randomUUID(), expectedVersion: 'new' },
    );
    expect((await core.getProject(companyId, empty.result.id)).effectiveReviewState).toBe('OPEN');
    const rows = await core.listProjects(companyId, { search: 'empty', status: 'ALL' });
    expect(rows.total).toBe(1);
    expect(rows.items[0].project.currency).toBe('JPY');
    expect(rows).not.toHaveProperty('totalCash');
  });
  it('reports current split coverage, stale metadata, invalid records and nonvacuous empty coverage', async () => {
    expect((await core.getProject(companyId, projectId)).cases.items[0].coverage).toEqual({
      state: 'MISSING',
      invoices: [],
    });
    const one = await invoice(),
      two = await invoice();
    await core.attestEvidenceCoverage(
      companyId,
      projectId,
      {
        customerInvoiceIds: [one.id],
        sourceAsOf: '2026-11-01T00:00:00Z',
        evidenceReference: 'Invented first coverage',
        attested: true,
      },
      await context(),
    );
    let view = await core.getProject(companyId, projectId);
    expect(view.cases.items[0].coverage.state).toBe('MISSING');
    expect(view.cases.items[0].coverage.invoices.find((i) => i.customerInvoiceId === one.id)).toMatchObject({
      current: true,
      attestation: { evidenceReference: 'Invented first coverage', attestedBy: 'user:invented-viewer' },
    });
    await core.attestEvidenceCoverage(
      companyId,
      projectId,
      {
        customerInvoiceIds: [two.id],
        sourceAsOf: '2026-11-01T00:00:00Z',
        evidenceReference: 'Invented second coverage',
        attested: true,
      },
      await context(),
    );
    view = await core.getProject(companyId, projectId);
    expect(view.cases.items[0].coverage.state).toBe('CURRENT');
    await external.saveExternalInvoice(
      companyId,
      projectId,
      { caseId, invoiceId: one.id, number: 'Changed source' },
      await context(),
    );
    view = await core.getProject(companyId, projectId);
    expect(view.cases.items[0].coverage.state).toBe('STALE');
    expect(view.cases.items[0].coverage.invoices.every((i) => !i.current && i.attestation)).toBe(true);
    await prisma.reconciliationAuditEvent.create({
      data: {
        companyId,
        projectId,
        actor: 'user:invented',
        operation: 'coverage.attest',
        requestKey: randomUUID(),
        affectedRecord: 'project:invented',
        after: { result: { attested: false } },
      },
    });
    expect((await core.getProject(companyId, projectId)).cases.items[0].coverage.state).toBe('STALE');
    await project('COMPANY');
    expect((await core.getProject(companyId, projectId)).cases.items[0].coverage).toEqual({
      state: 'NOT_APPLICABLE',
      invoices: [],
    });
  });

  it('selects exact receipt row version despite out-of-order/tied state audit timestamps and retains retry results', async () => {
    const r = await receipt();
    const ctx = await context();
    const changed = await external.updateExternalReceipt(
      companyId,
      projectId,
      {
        receiptId: r.id,
        sourceSystem: 'invented',
        sourceId: 'version-two',
        attested: true,
        reason: 'Version two',
      },
      ctx,
    );
    const originalAudit = await prisma.reconciliationAuditEvent.findUniqueOrThrow({
      where: {
        companyId_actor_requestKey: { companyId, actor: 'user:invented-viewer', requestKey: ctx.requestKey },
      },
    });
    const third = { ...changed.result, version: 3, sourceId: 'version-three' };
    await prisma.externalReceipt.update({ where: { id: r.id }, data: { version: 3 } });
    await prisma.reconciliationAuditEvent.create({
      data: {
        companyId,
        projectId,
        actor: 'user:invented',
        requestKey: randomUUID(),
        operation: 'receipt.update',
        affectedRecord: `receipt:${r.id}`,
        occurredAt: new Date('2000-01-01'),
        after: { result: third },
      },
    });
    expect((await core.listReceipts(companyId, projectId)).items[0].sourceId).toBe('version-three');
    const fourth = await external.updateExternalReceipt(
      companyId,
      projectId,
      { receiptId: r.id, reason: 'Preserve exact provenance', attested: true },
      await context(),
    );
    expect(fourth.result.sourceId).toBe('version-three');
    const fifth = { ...fourth.result, version: 5, sourceId: 'version-five' };
    await prisma.externalReceipt.update({ where: { id: r.id }, data: { version: 5 } });
    await prisma.reconciliationAuditEvent.create({
      data: {
        companyId,
        projectId,
        actor: 'user:invented',
        requestKey: randomUUID(),
        operation: 'receipt.update',
        affectedRecord: `receipt:${r.id}`,
        occurredAt: originalAudit.occurredAt,
        after: { result: fifth },
      },
    });
    const next = await external.updateExternalReceipt(
      companyId,
      projectId,
      { receiptId: r.id, reason: 'Preserve tied exact provenance', attested: true },
      await context(),
    );
    expect(next.result.sourceId).toBe('version-five');
    const retry = await external.updateExternalReceipt(
      companyId,
      projectId,
      {
        receiptId: r.id,
        sourceSystem: 'invented',
        sourceId: 'version-two',
        attested: true,
        reason: 'Version two',
      },
      ctx,
    );
    expect(retry).toEqual({ ...changed, changed: false });
    expect(
      await prisma.reconciliationAuditEvent.findUniqueOrThrow({ where: { id: originalAudit.id } }),
    ).toEqual(originalAudit);
  });
  it('exports all case pages with the exact period/overall basis and never writes GET state', async () => {
    const i = await invoice();
    await external.applyExternalCreditAdjustment(
      companyId,
      projectId,
      { invoiceId: i.id, amountMinor: 30000, reason: 'Invented credit', sourceReference: 'Credit document' },
      await context(),
    );
    const own = await document();
    await pay(own.id, 120000);
    const exp = await document('PROJECT_COST', 20, '2026-09-01');
    await prisma.documentInstance.update({
      where: { id: exp.id },
      data: {
        data: { currency: 'NZD', amount: 20, date: '2026-09-01T01:00:00+13:00', issueDate: '2026-11-10' },
      },
    });
    for (let n = 0; n < 27; n++)
      await prisma.reconciliationCase.create({ data: { companyId, projectId, title: `CSV stage ${n}` } });
    const before = await prisma.reconciliationProject.findUniqueOrThrow({ where: { id: projectId } });
    const auditCount = await prisma.reconciliationAuditEvent.count({ where: { companyId } });
    const view = await core.getProject(companyId, projectId, { limit: '100' });
    expect(view.summary.projectCosts.knownMinor).toBe(2000);
    expect(view.warnings.some((w) => w.code === 'PAYMENTS_UNSUPPORTED')).toBe(true);
    expect(view.summary.customerCollectible.knownMinor).toBe(200000);
    expect(view.summary.ownRecordedReceipts.knownMinor).toBe(120000);
    expect(
      view.cases.items.flatMap((c) => c.documentLinks).find((l) => l.documentId === own.id)?.financial
        .settlement?.excessMinor,
    ).toBe(5000);
    const filtered = await core.getProject(companyId, projectId, { invoiceFrom: '2026-11-01' });
    expect(filtered.summary.projectCosts.knownMinor).toBe(0);
    expect(filtered.summary.projectCosts.completeness).toBe('COMPLETE');
    expect(
      view.cases.items.flatMap((c) => c.documentLinks).find((l) => l.documentId === exp.id)?.issueDate,
    ).toBe('2026-09-01');
    const csv = await core.exportProject(companyId, projectId, { cashFrom: '2026-11-01' });
    expect(csv).toContain('CSV stage 0');
    expect(csv).toContain('CSV stage 26');
    expect(csv).toContain('in period: cash date');
    expect(csv).toContain('overall');
    expect(await prisma.reconciliationAuditEvent.count({ where: { companyId } })).toBe(auditCount);
    expect(await prisma.reconciliationProject.findUniqueOrThrow({ where: { id: projectId } })).toEqual(
      before,
    );
  });
  it('reads canonical payments in the same repeatable-read snapshot and batches list sources', async () => {
    const own = await document();
    let arrived!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gated = new ReconciliationService(
      {
        readMany: async (...args: Parameters<FinancialReadService['readMany']>) => {
          arrived();
          await wait;
          return financial.readMany(...args);
        },
      } as FinancialReadService,
      prisma,
    );
    const reading = gated.getProject(companyId, projectId);
    await entered;
    await pay(own.id, 115000);
    release();
    const old = await reading;
    expect(old.summary.ownOutstanding.knownMinor).toBe(115000);
    expect((await core.getProject(companyId, projectId)).summary.ownOutstanding.knownMinor).toBe(0);
    await project();
    await document();
    let calls = 0;
    const counted = new ReconciliationService(
      {
        readMany: async (...args: Parameters<FinancialReadService['readMany']>) => {
          calls++;
          return financial.readMany(...args);
        },
      } as FinancialReadService,
      prisma,
    );
    const list = await counted.listProjects(companyId, { needsAttention: 'true', limit: '1' });
    expect(list.total).toBe(2);
    expect(list.items).toHaveLength(1);
    expect(calls).toBe(1);
    parse(schemas.projectListPage, list);
  });

  it('pages real history at timestamp ties and exposes unknown source-date eligibility', async () => {
    const i = await invoice(230000, null);
    const view = await core.getProject(companyId, projectId, { invoiceFrom: '2026-01-01' });
    expect(view.summary.customerInvoiced).toMatchObject({
      knownMinor: 0,
      missingCount: 1,
      completeness: 'UNKNOWN',
    });
    expect(view.warnings).toContainEqual(
      expect.objectContaining({
        code: 'INVOICE_DATE_UNKNOWN',
        params: expect.objectContaining({ omittedKnownMinor: 230000 }),
      }),
    );
    const time = new Date('2040-01-01');
    await prisma.reconciliationAuditEvent.createMany({
      data: Array.from({ length: 30 }, (_, n) => ({
        companyId,
        projectId,
        actor: 'user:invented',
        operation: 'invented.history',
        requestKey: randomUUID(),
        affectedRecord: `source:invented-${n}`,
        occurredAt: time,
        reason: `Invented note ${n}`,
      })),
    });
    const one = await core.listHistory(companyId, projectId);
    expect(one.items).toHaveLength(25);
    const two = await core.listHistory(companyId, projectId, { cursor: one.nextCursor });
    expect(new Set([...one.items, ...two.items].map((a) => a.id)).size).toBe(one.total);
    parse(schemas.historyPage, two);
    expect(one.items[0].reason).toMatch(/^Invented note/);
    expect((await core.listCustomerInvoices(companyId, projectId, { search: i.external.number })).total).toBe(
      1,
    );
  });
  it('reads off-page exact case/receipt targets while preserving global metrics, allocations and read-only state', async () => {
    const targetCase = caseId;
    const i = await invoice();
    const r = await receipt(100000);
    const otherReceipt = await receipt(50000, '2026-11-03');
    for (const [receiptId, amountMinor] of [
      [r.id, 100000],
      [otherReceipt.id, 50000],
    ] as const)
      await external.replaceReceiptAllocations(
        companyId,
        projectId,
        { receiptId, allocations: [{ customerInvoiceId: i.id, amountMinor }] },
        await context(),
      );
    await core.updateCase(
      companyId,
      projectId,
      targetCase,
      { agreedGrossMinor: 100000, agreementReference: 'Invented target agreement' },
      await context(),
    );
    const newer = new Date('2040-01-01');
    await prisma.reconciliationCase.createMany({
      data: Array.from({ length: 30 }, (_, n) => ({
        companyId,
        projectId,
        title: `Newer stage ${n}`,
        createdAt: newer,
      })),
    });
    await prisma.externalReceipt.createMany({
      data: Array.from({ length: 30 }, () => ({
        companyId,
        projectId,
        currency: 'NZD' as const,
        collector: 'Invented partner',
        grossMinor: 100,
        enteredBy: 'user:invented',
        sourceReference: 'Invented later receipt',
        createdAt: newer,
      })),
    });
    const state = async () => ({
      project: await prisma.reconciliationProject.findUniqueOrThrow({ where: { id: projectId } }),
      cases: await prisma.reconciliationCase.findMany({
        where: { companyId, projectId },
        orderBy: { id: 'asc' },
      }),
      receipts: await prisma.externalReceipt.findMany({
        where: { companyId, projectId },
        orderBy: { id: 'asc' },
      }),
      allocations: await prisma.externalReceiptAllocation.findMany({
        where: { companyId, projectId },
        orderBy: { id: 'asc' },
      }),
      audits: await prisma.reconciliationAuditEvent.findMany({
        where: { companyId, projectId },
        orderBy: { id: 'asc' },
      }),
    });
    const before = await state();
    const dates = { invoiceFrom: '2026-10-01', cashFrom: '2026-11-01', cashTo: '2026-11-30' };
    const paged = await core.getProject(companyId, projectId, dates);
    expect(paged.cases.items).toHaveLength(25);
    expect(paged.cases.total).toBe(31);
    expect(paged.cases.items.some((c) => c.id === targetCase)).toBe(false);
    const selected = await core.getProject(companyId, projectId, {
      ...dates,
      caseId: targetCase,
      limit: '1',
    });
    expect(selected.cases.items.map((c) => c.id)).toEqual([targetCase]);
    expect(selected.cases).toMatchObject({ nextCursor: null, total: 1 });
    expect(selected.cases.items[0].customerInvoices[0].id).toBe(i.id);
    const global = (view: typeof selected) =>
      Object.fromEntries(Object.entries(view).filter(([key]) => !['cases', 'asOf'].includes(key)));
    expect(global(selected)).toEqual(global(paged));
    expect(selected.summary.customerInvoiced.knownMinor).toBe(230000);
    expect(selected.checkedReceipts.knownMinor).toBe(50000);
    expect(selected.undated.checkedReceipts.knownMinor).toBe(100000);
    expect(selected.unknownAgreementCount).toBe(30);
    const receiptPage = await core.listReceipts(companyId, projectId);
    expect(receiptPage.items).toHaveLength(25);
    expect(receiptPage.items.some((row) => row.id === r.id)).toBe(false);
    const exact = await core.listReceipts(companyId, projectId, { receiptId: r.id, limit: '1' });
    expect(exact.items.map((row) => row.id)).toEqual([r.id]);
    expect(exact).toMatchObject({ nextCursor: null, total: 1 });
    expect(exact.items[0]).toMatchObject({
      amountMinor: 100000,
      allocatedMinor: 100000,
      unallocatedMinor: 0,
      voidedAt: null,
    });
    expect(exact.items[0].allocations[0].customerInvoice).toMatchObject({
      id: i.id,
      number: i.external.number,
      allocatedMinor: 150000,
      availableMinor: 80000,
    });
    expect(await state()).toEqual(before);
    await external.voidExternalReceipt(
      companyId,
      projectId,
      { receiptId: r.id, reason: 'Invented exact target reversal' },
      await context(),
    );
    const voidedBefore = await state();
    const voided = await core.listReceipts(companyId, projectId, { receiptId: r.id });
    expect(voided).toMatchObject({ nextCursor: null, total: 1 });
    expect(voided.items[0]).toMatchObject({
      id: r.id,
      amountMinor: 100000,
      allocations: [],
      allocatedMinor: 0,
      unallocatedMinor: 0,
      voidedBy: 'user:invented-viewer',
      voidReason: 'Invented exact target reversal',
    });
    expect(voided.items[0].voidedAt).not.toBeNull();
    expect(await state()).toEqual(voidedBefore);
  });
  it('rejects missing and cross-project/company exact targets and selector/cursor combinations', async () => {
    const originalProject = projectId,
      originalCase = caseId;
    const originalReceipt = await receipt(100);
    await project();
    const otherCase = caseId,
      otherReceipt = await receipt(100);
    const foreign = await prisma.company.create({
      data: {
        name: 'Invented selector foreign',
        foundedAt: new Date('2020-01-01'),
        address: '1 Invented St',
        postalCode: '1010',
        city: 'Auckland',
        country: 'New Zealand',
        countryCode: 'NZ',
        phone: '+6400000000',
        email: `${randomUUID()}@example.test`,
      },
    });
    try {
      const partner = await prisma.client.create({
        data: { companyId: foreign.id, name: 'Foreign invented partner', country: 'New Zealand' },
      });
      const foreignProject = await prisma.reconciliationProject.create({
        data: {
          companyId: foreign.id,
          name: 'Foreign project',
          endCustomerName: 'Foreign customer',
          currency: 'NZD',
          collectionMode: 'PARTNER',
          partnerClientId: partner.id,
        },
      });
      const foreignCase = await prisma.reconciliationCase.create({
        data: { companyId: foreign.id, projectId: foreignProject.id, title: 'Foreign stage' },
      });
      const foreignReceipt = await prisma.externalReceipt.create({
        data: {
          companyId: foreign.id,
          projectId: foreignProject.id,
          currency: 'NZD',
          collector: 'Foreign partner',
          grossMinor: 100,
          enteredBy: 'user:foreign',
          sourceReference: 'Invented foreign proof',
        },
      });
      for (const target of ['missing-exact-case', otherCase, foreignCase.id])
        await expect(core.getProject(companyId, originalProject, { caseId: target })).rejects.toMatchObject({
          status: 404,
        });
      for (const target of ['missing-exact-receipt', otherReceipt.id, foreignReceipt.id])
        await expect(
          core.listReceipts(companyId, originalProject, { receiptId: target }),
        ).rejects.toMatchObject({ status: 404 });
      await expect(
        core.getProject(companyId, originalProject, { caseId: originalCase, cursor: originalCase }),
      ).rejects.toMatchObject({ status: 400 });
      await expect(
        core.listReceipts(companyId, originalProject, {
          receiptId: originalReceipt.id,
          cursor: originalReceipt.id,
        }),
      ).rejects.toMatchObject({ status: 400 });
    } finally {
      await prisma.$transaction(async (tx) => {
        await purgeReconciliationForCompany(tx, foreign.id);
        await tx.company.delete({ where: { id: foreign.id } });
      });
    }
  });
});
