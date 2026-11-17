import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Prisma } from '../../../prisma/generated/prisma/client';
import prisma from '@/prisma/prisma.service';
import { createLibRedisClient } from '@/lib/redis-connection';
import { FinancialReadService } from '../documents/settlement/financial-read.service';
import { deleteDocument } from '../documents/persistence';
import { ReconciliationService } from './service';
import { ExternalReceiptsService } from './external-receipts';
import { purgeReconciliationForCompany } from './persistence';
import { loadReviewSnapshot, projectReview } from './review';
import { schemas, parse } from './validation';
import type { MutationContext, LinkDocumentInput } from './types';

const caseInput = {
  title: 'Invented stage',
  periodStart: null,
  periodEnd: null,
  agreedGrossMinor: null,
  agreedNetMinor: null,
  agreedVatMinor: null,
  agreementReference: null,
};
const actor = { kind: 'user' as const, id: 'invented-link-reviewer' };
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

describe('document-links and review real Postgres', () => {
  const financial = new FinancialReadService();
  const core = new ReconciliationService(financial, prisma);
  const external = new ExternalReceiptsService(core);
  const redis = createLibRedisClient({ lazyConnect: true });
  let companyId: string,
    foreignId: string,
    customerId: string,
    partnerId: string,
    projectId: string,
    caseId: string;
  async function context(id = projectId): Promise<MutationContext> {
    return {
      actor,
      requestKey: randomUUID(),
      expectedVersion: (await core.getProject(companyId, id)).versionToken,
    };
  }
  async function project(mode: 'COMPANY' | 'PARTNER' = 'COMPANY', partner = true) {
    projectId = (
      await core.createProject(
        companyId,
        {
          name: 'Invented reconciliation',
          endCustomerName: 'Invented customer',
          currency: 'NZD',
          collectionMode: mode,
          endCustomerClientId: customerId,
          partnerClientId: partner ? partnerId : null,
          timeProjectId: null,
          description: null,
        },
        { actor, requestKey: randomUUID(), expectedVersion: 'new' },
      )
    ).result.id;
    caseId = (await core.createCase(companyId, projectId, caseInput, await context())).result.id;
  }
  async function doc(typeId = 'invoice', status = 'sent', data: Record<string, unknown> = {}) {
    return prisma.documentInstance.create({
      data: {
        companyId,
        typeId,
        status,
        data: {
          currency: 'NZD',
          client: customerId,
          supplierClient: partnerId,
          lines: [{ __rowId: 'a', quantity: 1, unitPrice: 1, vatRate: '0' }],
          ...data,
        },
      },
    });
  }
  async function payment(documentId: string, amount = 100) {
    return prisma.documentPayment.create({
      data: {
        companyId,
        documentId,
        amountMinor: amount,
        documentAmountMinor: amount,
        currency: 'NZD',
        paidAt: new Date('2026-11-01'),
      },
    });
  }
  async function link(
    documentId: string,
    role: LinkDocumentInput['role'] = 'CUSTOMER_INVOICE',
    typeId: LinkDocumentInput['typeId'] = 'invoice',
    id: string | null = caseId,
  ) {
    return core.linkDocument(companyId, projectId, { documentId, typeId, caseId: id, role }, await context());
  }
  async function snapshot() {
    return prisma.$transaction(
      async (tx) =>
        loadReviewSnapshot(
          tx,
          companyId,
          await tx.reconciliationProject.findUniqueOrThrow({ where: { id: projectId } }),
          financial,
        ),
      { isolationLevel: 'RepeatableRead' },
    );
  }
  async function review(mode: 'VERIFY' | 'ACCEPT_EXCEPTIONS' | 'REOPEN' = 'VERIFY') {
    const current = projectReview(await snapshot()).cases.find((row) => row.caseId === caseId)!;
    return core.reviewCase(
      companyId,
      projectId,
      {
        caseId,
        mode,
        reason: 'Invented explicit decision',
        exceptions:
          mode === 'ACCEPT_EXCEPTIONS'
            ? current.exceptions.map((e) => ({
                code: e.code,
                fingerprint: e.fingerprint,
                reason: 'Invented historical limitation',
              }))
            : [],
      },
      await context(),
    );
  }
  async function sourceState() {
    const queues: Record<string, string | null> = {};
    for (const key of (await redis.keys('bull:*')).sort()) queues[key] = await redis.dump(key);
    return {
      documents: await prisma.documentInstance.findMany({ where: { companyId }, orderBy: { id: 'asc' } }),
      payments: await prisma.documentPayment.findMany({ where: { companyId }, orderBy: { id: 'asc' } }),
      queues,
    };
  }
  async function externalInvoice() {
    return (
      await external.saveExternalInvoice(
        companyId,
        projectId,
        {
          caseId,
          issuer: 'Invented partner',
          recipient: 'Invented customer',
          number: randomUUID(),
          issueDate: '2026-10-01',
          dueDate: null,
          currency: 'NZD',
          grossMinor: 100,
          netMinor: null,
          vatMinor: null,
          reportedStatus: 'Paid',
          sourceSystem: null,
          sourceId: null,
          sourceAsOf: null,
          sourceReference: 'Invented source',
        },
        await context(),
      )
    ).result;
  }
  beforeAll(async () => {
    for (const name of ['Invented T5', 'Invented foreign T5']) {
      const co = await prisma.company.create({
        data: {
          name,
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
      if (!companyId) companyId = co.id;
      else foreignId = co.id;
    }
    customerId = (
      await prisma.client.create({ data: { companyId, name: 'Invented customer', country: 'New Zealand' } })
    ).id;
    partnerId = (
      await prisma.client.create({ data: { companyId, name: 'Invented partner', country: 'New Zealand' } })
    ).id;
  });
  beforeEach(async () => {
    await project();
  });
  afterAll(async () => {
    await redis.quit();
    for (const id of [companyId, foreignId].filter(Boolean))
      await prisma.$transaction(async (tx) => {
        await purgeReconciliationForCompany(tx, id);
        await tx.company.delete({ where: { id } });
      });
  });
  it('creates one same-case own reference and unlinks without financial or queue side effects', async () => {
    const d = await doc();
    await payment(d.id);
    const before = await sourceState();
    const input = { documentId: d.id, typeId: 'invoice' as const, caseId, role: 'CUSTOMER_INVOICE' as const };
    const ctx = await context();
    const added = await core.linkDocument(companyId, projectId, input, ctx);
    parse(schemas.documentLink, added.result);
    expect(await core.linkDocument(companyId, projectId, input, ctx)).toMatchObject({
      result: added.result,
      changed: false,
    });
    expect(
      await prisma.customerInvoiceReference.findFirst({
        where: { companyId, documentLinkId: added.result.id },
      }),
    ).toMatchObject({ caseId, collectionMode: 'COMPANY', issuer: null, originalGrossMinor: null });
    await expect(link(d.id, 'PROJECT_COST', 'expense')).rejects.toMatchObject({ status: 409 });
    const removed = await core.unlinkDocument(
      companyId,
      projectId,
      { linkId: added.result.id, reason: 'Corrected link' },
      await context(),
    );
    expect(removed.result).toEqual(added.result);
    expect(
      await prisma.customerInvoiceReference.count({ where: { companyId, documentLinkId: added.result.id } }),
    ).toBe(0);
    expect(await sourceState()).toEqual(before);
  });
  it('enforces mode, real type, exact party, currency, case ownership and unique roles', async () => {
    const wrong = await doc('invoice', 'sent', { client: partnerId });
    await expect(link(wrong.id)).rejects.toMatchObject({ status: 409 });
    const currency = await doc('invoice', 'sent', { currency: 'USD' });
    await expect(link(currency.id)).rejects.toMatchObject({ response: { code: 'CURRENCY_MISMATCH' } });
    const d = await doc();
    await expect(link(d.id, 'SETTLEMENT_INCOME')).rejects.toMatchObject({ status: 409 });
    await expect(link(d.id, 'CUSTOMER_INVOICE', 'invoice', null)).rejects.toMatchObject({ status: 409 });
    await expect(link(d.id, 'CUSTOMER_INVOICE', 'invoice', 'missing')).rejects.toMatchObject({ status: 404 });
    const foreign = await prisma.documentInstance.create({
      data: { companyId: foreignId, typeId: 'invoice', status: 'draft', data: {} },
    });
    await expect(link(foreign.id)).rejects.toMatchObject({ status: 404 });
    const bill = await doc('received-invoice', 'received', { grossAmount: 1 });
    await link(bill.id, 'PARTNER_BILL', 'received-invoice');
    await expect(link(bill.id, 'PROJECT_COST', 'received-invoice')).rejects.toMatchObject({
      response: { code: 'DOCUMENT_ALREADY_LINKED' },
    });
    const expense = await doc('expense', 'draft', { grossAmount: 1 });
    await link(expense.id, 'PROJECT_COST', 'expense');
    const badBill = await doc('received-invoice', 'received', { supplierClient: customerId, grossAmount: 1 });
    await expect(link(badBill.id, 'PARTNER_BILL', 'received-invoice')).rejects.toMatchObject({ status: 409 });
    await project('PARTNER');
    await expect(link(d.id)).rejects.toMatchObject({ status: 409 });
    await link(wrong.id, 'SETTLEMENT_INCOME');
    await expect(link(badBill.id, 'PARTNER_BILL', 'received-invoice')).rejects.toMatchObject({ status: 409 });
  });
  it('requires an existing end customer association and prevents cross-project document reuse', async () => {
    const d = await doc();
    await link(d.id);
    await project();
    await expect(link(d.id)).rejects.toMatchObject({ response: { code: 'DOCUMENT_ALREADY_LINKED' } });
    await core.updateProject(companyId, projectId, { endCustomerClientId: null }, await context());
    await expect(link((await doc()).id)).rejects.toMatchObject({ status: 409 });
  });
  it('blocks deleting active links, while historical IDs are not dependencies', async () => {
    const d = await doc('invoice', 'draft');
    const added = await link(d.id);
    await expect(deleteDocument(companyId, 'invoice', d.id, 'draft')).rejects.toMatchObject({
      response: { code: 'DOCUMENT_HAS_RECONCILIATION_LINKS' },
      status: 409,
    });
    await core.unlinkDocument(
      companyId,
      projectId,
      { linkId: added.result.id, reason: 'Remove relationship' },
      await context(),
    );
    await prisma.reconciliationAuditEvent.create({
      data: {
        companyId,
        projectId,
        actor: 'user:invented',
        operation: 'historical',
        requestKey: randomUUID(),
        affectedRecord: `document:${d.id}`,
        after: { source: `document:${d.id}` },
      },
    });
    await deleteDocument(companyId, 'invoice', d.id, 'draft');
    expect(await prisma.documentInstance.findUnique({ where: { id: d.id } })).toBeNull();
  });
  it('link-first deletion waits and then returns translated conflict', async () => {
    const d = await doc('invoice', 'draft');
    const entered = gate(),
      release = gate();
    const db = prisma.$extends({
      query: {
        projectDocumentLink: {
          async create({ args, query }) {
            const row = await query(args);
            entered.release();
            await release.promise;
            return row;
          },
        },
      },
    });
    const linking = new ReconciliationService(financial, db).linkDocument(
      companyId,
      projectId,
      { documentId: d.id, typeId: 'invoice', caseId, role: 'CUSTOMER_INVOICE' },
      await context(),
    );
    await entered.promise;
    const deleting = deleteDocument(companyId, 'invoice', d.id, 'draft');
    release.release();
    await linking;
    await expect(deleting).rejects.toMatchObject({ response: { code: 'DOCUMENT_HAS_RECONCILIATION_LINKS' } });
    expect(await prisma.documentInstance.findUnique({ where: { id: d.id } })).not.toBeNull();
  });
  it('delete-first candidate lock waits then returns404 without orphan', async () => {
    const d = await doc('invoice', 'draft');
    const held = gate(),
      release = gate();
    const ctx = await context();
    const deleting = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "DocumentInstance" WHERE id=${d.id} FOR UPDATE`;
      held.release();
      await release.promise;
      await tx.documentInstance.delete({ where: { id: d.id } });
    });
    await held.promise;
    const linking = core.linkDocument(
      companyId,
      projectId,
      { documentId: d.id, typeId: 'invoice', caseId, role: 'CUSTOMER_INVOICE' },
      ctx,
    );
    release.release();
    await deleting;
    await expect(linking).rejects.toMatchObject({ status: 404 });
    expect(await prisma.projectDocumentLink.count({ where: { companyId, documentId: d.id } })).toBe(0);
  });
  it.each(['VERIFY', 'ACCEPT_EXCEPTIONS'] as const)(
    'known own outstanding1 hard-blocks %s and never alters balances',
    async (mode) => {
      const d = await doc();
      await payment(d.id, 99);
      await link(d.id);
      const before = await sourceState();
      await expect(review(mode)).rejects.toMatchObject({ response: { code: 'REVIEW_BLOCKED' }, status: 409 });
      expect(await sourceState()).toEqual(before);
    },
  );
  it('stores exact historical exceptions and reasons but keeps attention; rejects changed/omitted fingerprints', async () => {
    const own = await doc();
    await payment(own.id);
    await link(own.id);
    const bill = await doc('received-invoice', 'received', { grossAmount: 1 });
    await payment(bill.id);
    await link(bill.id, 'PARTNER_BILL', 'received-invoice');
    const s = await snapshot();
    const exceptions = projectReview(s).cases.find((c) => c.caseId === caseId)!.exceptions;
    expect(exceptions.length).toBeGreaterThan(0);
    await expect(review()).rejects.toMatchObject({ response: { code: 'REVIEW_BLOCKED' } });
    await expect(
      core.reviewCase(
        companyId,
        projectId,
        { caseId, mode: 'ACCEPT_EXCEPTIONS', reason: 'History', exceptions: [] },
        await context(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      core.reviewCase(
        companyId,
        projectId,
        {
          caseId,
          mode: 'ACCEPT_EXCEPTIONS',
          reason: 'History',
          exceptions: exceptions.map((e) => ({ code: e.code, fingerprint: 'stale', reason: 'History' })),
        },
        await context(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    const accepted = await review('ACCEPT_EXCEPTIONS');
    expect(accepted.result.case.status).toBe('CLOSED_WITH_EXCEPTIONS');
    expect(projectReview(await snapshot()).cases.find((c) => c.caseId === caseId)!.exceptions.length).toBe(
      exceptions.length,
    );
    const audit = await prisma.reconciliationAuditEvent.findFirstOrThrow({
      where: { companyId, projectId, operation: 'case.review' },
    });
    expect((audit.after as { result: unknown }).result).toEqual(accepted.result);
    expect(audit.reason).toBe('Invented explicit decision');
    const csv = await core.exportProject(companyId, projectId);
    expect(csv).toContain('CURRENT');
    expect(csv).toContain('Invented explicit decision');
    expect(csv).toContain('ACCEPT_EXCEPTIONS');
    for (const exception of accepted.result.exceptions) expect(csv).toContain(exception.reason);
    await core.updateCase(companyId, projectId, caseId, { title: 'Changed after review' }, await context());
    const stale = await core.exportProject(companyId, projectId);
    expect(stale).toContain('STALE HISTORICAL');
    expect(stale).toContain('Invented explicit decision');
    const reopened = await review('REOPEN');
    expect(reopened.result.case.status).toBe('OPEN');
  });
  it('verifies complete direct work, derivesOPEN on payment edit without parent timestamp change and persists reopening on mutation', async () => {
    await project('COMPANY', false);
    const d = await doc();
    const p = await payment(d.id);
    await link(d.id);
    const before = await sourceState();
    const accepted = await review();
    expect(accepted.result.case.status).toBe('CLOSED_VERIFIED');
    expect(await sourceState()).toEqual(before);
    const parent = await prisma.documentInstance.findUniqueOrThrow({ where: { id: d.id } });
    await prisma.documentPayment.update({ where: { id: p.id }, data: { documentAmountMinor: 99 } });
    expect((await prisma.documentInstance.findUniqueOrThrow({ where: { id: d.id } })).updatedAt).toEqual(
      parent.updatedAt,
    );
    const closed = await prisma.reconciliationCase.findUniqueOrThrow({ where: { id: caseId } });
    const auditCount = await prisma.reconciliationAuditEvent.count({ where: { companyId, projectId } });
    expect(projectReview(await snapshot()).cases.find((c) => c.caseId === caseId)!.effectiveReviewState).toBe(
      'OPEN',
    );
    expect(
      (await core.getProject(companyId, projectId)).cases.items.find((c) => c.id === caseId)!.status,
    ).toBe('OPEN');
    expect(await prisma.reconciliationCase.findUniqueOrThrow({ where: { id: caseId } })).toEqual(closed);
    expect(await prisma.reconciliationAuditEvent.count({ where: { companyId, projectId } })).toBe(auditCount);
    await core.updateProject(
      companyId,
      projectId,
      { description: 'Reviewed source update' },
      await context(),
    );
    expect(await prisma.reconciliationCase.findUniqueOrThrow({ where: { id: caseId } })).toMatchObject({
      status: 'OPEN',
      reviewedSourceFingerprint: null,
    });
  });
  it('draft, consolidated and unsupported sources cannot verify and never prorate case payments', async () => {
    await project('PARTNER');
    await externalInvoice();
    const d = await doc('invoice', 'draft', { client: partnerId });
    await payment(d.id);
    await link(d.id, 'SETTLEMENT_INCOME', 'invoice', null);
    const state = projectReview(await snapshot());
    expect(state.exceptions.some((e) => e.code === 'UNALLOCATED_DOCUMENT')).toBe(true);
    expect(
      state.cases.find((c) => c.caseId === caseId)!.exceptions.some((e) => e.code === 'DOCUMENT_NOT_ISSUED'),
    ).toBe(true);
    await expect(review()).rejects.toMatchObject({ response: { code: 'REVIEW_BLOCKED' } });
    const cost = await doc('expense', 'draft', { grossAmount: 1 });
    await link(cost.id, 'PROJECT_COST', 'expense');
    expect(
      projectReview(await snapshot())
        .cases.find((c) => c.caseId === caseId)!
        .exceptions.some((e) => e.code === 'BALANCE_UNAVAILABLE'),
    ).toBe(true);
  });
  it('coverage is explicit, records complete receipt/allocation sets including advances, and invalidates on new material', async () => {
    await project('PARTNER');
    const inv = await externalInvoice();
    const receipt = (
      await external.recordExternalReceipt(
        companyId,
        projectId,
        {
          amountMinor: 150,
          currency: 'NZD',
          paidOn: '2026-11-01',
          evidenceClass: 'EVIDENCE_CHECKED',
          attested: true,
          evidenceReference: 'Invented statement',
          evidenceUrl: null,
          reason: 'Checked',
        },
        await context(),
      )
    ).result;
    await external.replaceReceiptAllocations(
      companyId,
      projectId,
      { receiptId: receipt.id, allocations: [{ customerInvoiceId: inv.id, amountMinor: 100 }] },
      await context(),
    );
    await core.updateCase(
      companyId,
      projectId,
      caseId,
      { agreedGrossMinor: 100, agreementReference: 'Invented agreement' },
      await context(),
    );
    const d = await doc('invoice', 'sent', { client: partnerId });
    await payment(d.id);
    await link(d.id, 'SETTLEMENT_INCOME');
    await expect(review()).rejects.toMatchObject({ response: { code: 'REVIEW_BLOCKED' } });
    const input = {
      customerInvoiceIds: [inv.id],
      sourceAsOf: '2026-11-10T00:00:00Z',
      evidenceReference: 'Invented complete invoice and statement set',
      attested: true as const,
    };
    await expect(
      core.attestEvidenceCoverage(
        companyId,
        projectId,
        { ...input, attested: false } as never,
        await context(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    const attestation = await core.attestEvidenceCoverage(companyId, projectId, input, await context());
    parse(schemas.coverageResult, attestation.result);
    expect(attestation.result.receiptIds).toEqual([receipt.id]);
    expect(attestation.result.allocationIds).toHaveLength(1);
    expect(attestation.result.attestedBy).toBe('user:invented-link-reviewer');
    const before = await sourceState();
    await review();
    expect(await sourceState()).toEqual(before);
    await externalInvoice();
    const projection = projectReview(await snapshot());
    expect(projection.cases.find((c) => c.caseId === caseId)!.effectiveReviewState).toBe('OPEN');
    expect(
      projection.cases
        .find((c) => c.caseId === caseId)!
        .exceptions.some((e) => e.code === 'EVIDENCE_COVERAGE_MISSING'),
    ).toBe(true);
  });
  it('coverage never promotes reported evidence or supplies missing receipt dates', async () => {
    await project('PARTNER');
    const inv = await externalInvoice();
    const r = (
      await external.recordExternalReceipt(
        companyId,
        projectId,
        {
          amountMinor: 100,
          currency: 'NZD',
          paidOn: null,
          evidenceClass: 'PARTNER_REPORTED',
          evidenceReference: null,
          evidenceUrl: null,
          reason: 'Reported',
        },
        await context(),
      )
    ).result;
    await external.replaceReceiptAllocations(
      companyId,
      projectId,
      { receiptId: r.id, allocations: [{ customerInvoiceId: inv.id, amountMinor: 100 }] },
      await context(),
    );
    await core.attestEvidenceCoverage(
      companyId,
      projectId,
      {
        customerInvoiceIds: [inv.id],
        sourceAsOf: '2026-11-10T00:00:00Z',
        evidenceReference: 'Reviewed export',
        attested: true,
      },
      await context(),
    );
    const codes = projectReview(await snapshot())
      .cases.find((c) => c.caseId === caseId)!
      .exceptions.map((e) => e.code);
    expect(codes).toContain('RECEIPT_EVIDENCE_MISSING');
    expect(codes).toContain('RECEIPT_DATE_MISSING');
    for (const exception of projectReview(await snapshot()).exceptions) parse(schemas.exception, exception);
    expect((await prisma.externalReceipt.findUniqueOrThrow({ where: { id: r.id } })).evidenceClass).toBe(
      'PARTNER_REPORTED',
    );
  });
  it('rejects dates after the attested civil cutoff, including unallocated advances, without filling unknown dates', async () => {
    await project('PARTNER');
    const inv = await externalInvoice();
    const input = {
      customerInvoiceIds: [inv.id],
      sourceAsOf: '2026-10-01T23:30:00-12:00',
      evidenceReference: 'Invented cutoff',
      attested: true as const,
    };
    await core.attestEvidenceCoverage(companyId, projectId, input, await context());
    const r = (
      await external.recordExternalReceipt(
        companyId,
        projectId,
        {
          amountMinor: 1,
          currency: 'NZD',
          paidOn: '2026-10-02',
          evidenceClass: 'PARTNER_REPORTED',
          evidenceReference: null,
          evidenceUrl: null,
          reason: 'Invented later advance',
        },
        await context(),
      )
    ).result;
    await expect(
      core.attestEvidenceCoverage(companyId, projectId, input, await context()),
    ).rejects.toMatchObject({
      response: {
        code: 'REVIEW_BLOCKED',
        params: { condition: 'DATE_AFTER_COVERAGE', recordId: r.id, sourceAsOf: '2026-10-01' },
      },
    });
    await external.voidExternalReceipt(
      companyId,
      projectId,
      { receiptId: r.id, reason: 'Void invented advance' },
      await context(),
    );
    await external.saveExternalInvoice(
      companyId,
      projectId,
      { caseId, invoiceId: inv.id, issueDate: '2026-10-02' },
      await context(),
    );
    await expect(
      core.attestEvidenceCoverage(companyId, projectId, input, await context()),
    ).rejects.toMatchObject({
      response: { code: 'REVIEW_BLOCKED', params: { condition: 'DATE_AFTER_COVERAGE', recordId: inv.id } },
    });
  });
  it.each(['missing-link', 'draft', 'difference'] as const)(
    'cannot accept non-overridable %s discrepancies',
    async (kind) => {
      if (kind !== 'missing-link') {
        const own = await doc('invoice', kind === 'draft' ? 'draft' : 'sent');
        await payment(own.id);
        await link(own.id);
        const bill = await doc('received-invoice', 'received', { grossAmount: 1 });
        await payment(bill.id);
        await link(bill.id, 'PARTNER_BILL', 'received-invoice');
        if (kind === 'difference')
          await core.updateCase(
            companyId,
            projectId,
            caseId,
            { agreedGrossMinor: 101, agreementReference: 'Explicit101' },
            await context(),
          );
      }
      const current = projectReview(await snapshot()).cases.find((c) => c.caseId === caseId)!;
      expect(current.exceptions.map((e) => e.code)).toContain(
        kind === 'missing-link'
          ? 'CUSTOMER_INVOICE_MISSING'
          : kind === 'draft'
            ? 'DOCUMENT_NOT_ISSUED'
            : 'SETTLEMENT_DIFFERENCE',
      );
      await expect(review('ACCEPT_EXCEPTIONS')).rejects.toMatchObject({
        response: { code: 'REVIEW_BLOCKED' },
      });
    },
  );
  it('reverifies a stale closed case against current sources, but cannot overlook a newly positive balance', async () => {
    await project('COMPANY', false);
    const d = await doc();
    const p = await payment(d.id);
    await link(d.id);
    const original = await review();
    await prisma.documentPayment.update({
      where: { id: p.id },
      data: { note: 'Externally corrected evidence' },
    });
    expect(
      projectReview(await snapshot())
        .cases.find((c) => c.caseId === caseId)!
        .exceptions.map((e) => e.code),
    ).toContain('SOURCE_CHANGED');
    expect(
      projectReview(await snapshot())
        .cases.find((c) => c.caseId === caseId)!
        .exceptions.find((e) => e.code === 'SOURCE_CHANGED')!.blocking,
    ).toBe(false);
    const next = await review();
    expect(next.result.case.status).toBe('CLOSED_VERIFIED');
    expect(next.result.sourceFingerprint).not.toBe(original.result.sourceFingerprint);
    await prisma.documentPayment.update({ where: { id: p.id }, data: { documentAmountMinor: 99 } });
    await expect(review()).rejects.toMatchObject({ response: { code: 'REVIEW_BLOCKED' } });
  });
  it('a later source party mismatch cannot be reverified or accepted', async () => {
    await project('COMPANY', false);
    const d = await doc();
    await payment(d.id);
    await link(d.id);
    await review();
    await prisma.documentInstance.update({
      where: { id: d.id },
      data: { data: { ...(d.data as object), client: partnerId } },
    });
    expect(
      projectReview(await snapshot())
        .cases.find((c) => c.caseId === caseId)!
        .exceptions.map((e) => e.code),
    ).toContain('DOCUMENT_IDENTITY_CHANGED');
    await expect(review()).rejects.toMatchObject({ response: { code: 'REVIEW_BLOCKED' } });
    await expect(review('ACCEPT_EXCEPTIONS')).rejects.toMatchObject({ response: { code: 'REVIEW_BLOCKED' } });
  });
  it('a known changed source currency cannot be accepted as unavailable historical support', async () => {
    await project('COMPANY', false);
    const d = await doc();
    await payment(d.id);
    await link(d.id);
    await prisma.documentInstance.update({
      where: { id: d.id },
      data: { data: { ...(d.data as object), currency: 'USD' } },
    });
    expect(
      projectReview(await snapshot())
        .cases.find((c) => c.caseId === caseId)!
        .exceptions.map((e) => e.code),
    ).toContain('CURRENCY_MISMATCH');
    await expect(review('ACCEPT_EXCEPTIONS')).rejects.toMatchObject({ response: { code: 'REVIEW_BLOCKED' } });
  });
  it('does not block one case on another case outstanding, but unallocated own payables block both closure types', async () => {
    await project('COMPANY', false);
    const own = await doc();
    await payment(own.id);
    await link(own.id);
    const other = (
      await core.createCase(
        companyId,
        projectId,
        { ...caseInput, title: 'Invented other stage' },
        await context(),
      )
    ).result.id;
    await link((await doc()).id, 'CUSTOMER_INVOICE', 'invoice', other);
    expect((await review()).result.case.status).toBe('CLOSED_VERIFIED');
    const bill = await doc('received-invoice', 'received', { grossAmount: 1 });
    await payment(bill.id, 99);
    await link(bill.id, 'PROJECT_COST', 'received-invoice', null);
    for (const mode of ['VERIFY', 'ACCEPT_EXCEPTIONS'] as const)
      await expect(review(mode)).rejects.toMatchObject({ response: { code: 'REVIEW_BLOCKED' } });
  });
  it('locks the deduplicated candidate and existing source union in sorted order', async () => {
    const documents = [];
    for (const prefix of ['z', 'a'])
      documents.push(
        await prisma.documentInstance.create({
          data: {
            id: `${prefix}-${randomUUID()}`,
            companyId,
            typeId: 'expense',
            status: 'draft',
            data: { currency: 'NZD', grossAmount: 1 },
          },
        }),
      );
    await link(documents[0].id, 'PROJECT_COST', 'expense');
    const locked: string[] = [];
    const db = new Proxy(prisma, {
      get(target, property) {
        if (property !== '$transaction') return Reflect.get(target, property);
        return (apply: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          target.$transaction((tx) =>
            apply(
              new Proxy(tx, {
                get(transaction, key) {
                  if (key !== '$queryRaw') return Reflect.get(transaction, key);
                  return (sql: TemplateStringsArray, ...values: unknown[]) => {
                    if (sql.join('').includes('"DocumentInstance"') && sql.join('').includes('FOR UPDATE'))
                      locked.push(String(values[1]));
                    return transaction.$queryRaw(sql, ...values);
                  };
                },
              }),
            ),
          );
      },
    });
    await new ReconciliationService(financial, db).linkDocument(
      companyId,
      projectId,
      { documentId: documents[1].id, typeId: 'expense', caseId, role: 'PROJECT_COST' },
      await context(),
    );
    expect(locked).toEqual([documents[1].id, documents[0].id]);
  });
  it('checks missing or foreign candidate ownership before stale version validation', async () => {
    const stale = await context();
    await core.updateProject(companyId, projectId, { description: 'New revision' }, await context());
    const foreign = await prisma.documentInstance.create({
      data: { companyId: foreignId, typeId: 'invoice', status: 'draft', data: {} },
    });
    for (const documentId of ['missing-candidate', foreign.id])
      await expect(
        core.linkDocument(
          companyId,
          projectId,
          { documentId, typeId: 'invoice', caseId, role: 'CUSTOMER_INVOICE' },
          { ...stale, requestKey: randomUUID() },
        ),
      ).rejects.toMatchObject({ status: 404 });
  });
  it('requires an external invoice issue date forVERIFIED but permits exact historical date acceptance without filling it', async () => {
    await project('PARTNER');
    const inv = await externalInvoice();
    await external.saveExternalInvoice(
      companyId,
      projectId,
      { caseId, invoiceId: inv.id, issueDate: null },
      await context(),
    );
    const receipt = (
      await external.recordExternalReceipt(
        companyId,
        projectId,
        {
          amountMinor: 100,
          currency: 'NZD',
          paidOn: '2026-11-01',
          evidenceClass: 'EVIDENCE_CHECKED',
          attested: true,
          evidenceReference: 'Invented checked statement',
          evidenceUrl: null,
          reason: 'Checked set',
        },
        await context(),
      )
    ).result;
    await external.replaceReceiptAllocations(
      companyId,
      projectId,
      { receiptId: receipt.id, allocations: [{ customerInvoiceId: inv.id, amountMinor: 100 }] },
      await context(),
    );
    await core.updateCase(
      companyId,
      projectId,
      caseId,
      { agreedGrossMinor: 100, agreementReference: 'Invented explicit agreement' },
      await context(),
    );
    const own = await doc('invoice', 'sent', { client: partnerId });
    await payment(own.id);
    await link(own.id, 'SETTLEMENT_INCOME');
    await core.attestEvidenceCoverage(
      companyId,
      projectId,
      {
        customerInvoiceIds: [inv.id],
        sourceAsOf: '2026-11-10T00:00:00Z',
        evidenceReference: 'Invented full set',
        attested: true,
      },
      await context(),
    );
    expect(
      projectReview(await snapshot())
        .cases.find((c) => c.caseId === caseId)!
        .exceptions.map((e) => e.code),
    ).toEqual(['INVOICE_DATE_MISSING']);
    await expect(review()).rejects.toMatchObject({ response: { code: 'REVIEW_BLOCKED' } });
    expect((await review('ACCEPT_EXCEPTIONS')).result.case.status).toBe('CLOSED_WITH_EXCEPTIONS');
    expect(
      (await prisma.customerInvoiceReference.findUniqueOrThrow({ where: { id: inv.id } })).issueDate,
    ).toBeNull();
  });
  it('returns503 for a first candidate read outage after empty reads succeed and rolls back all link state', async () => {
    const document = await doc();
    const ctx = await context();
    const beforeProject = await prisma.reconciliationProject.findUniqueOrThrow({ where: { id: projectId } });
    const beforeAudit = await prisma.reconciliationAuditEvent.findMany({
      where: { companyId, projectId },
      orderBy: { id: 'asc' },
    });
    const beforeSources = await sourceState();
    const candidateReader = new FinancialReadService();
    const canonicalRead = candidateReader.readMany.bind(candidateReader);
    candidateReader.readMany = async (company, refs, tx) => {
      if (refs.some((ref) => ref.id === document.id)) throw new Error('Invented candidate-only outage');
      return canonicalRead(company, refs, tx);
    };
    await expect(
      new ReconciliationService(candidateReader, prisma).linkDocument(
        companyId,
        projectId,
        { documentId: document.id, typeId: 'invoice', caseId, role: 'CUSTOMER_INVOICE' },
        ctx,
      ),
    ).rejects.toMatchObject({ status: 503, response: { code: 'FINANCIAL_READ_UNAVAILABLE' } });
    expect(await prisma.projectDocumentLink.count({ where: { companyId, projectId } })).toBe(0);
    expect(await prisma.customerInvoiceReference.count({ where: { companyId, projectId } })).toBe(0);
    expect(await prisma.reconciliationProject.findUniqueOrThrow({ where: { id: projectId } })).toEqual(
      beforeProject,
    );
    expect(
      await prisma.reconciliationAuditEvent.findMany({
        where: { companyId, projectId },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(beforeAudit);
    expect(await sourceState()).toEqual(beforeSources);
  });
  it('returns explicit unknown report facts during canonical outage and never stale successful balances', async () => {
    const d = await doc();
    await link(d.id);
    const unavailable = new FinancialReadService();
    unavailable.readMany = async () => {
      throw new Error('Invented source outage');
    };
    const view = await new ReconciliationService(unavailable, prisma).getProject(companyId, projectId);
    expect(view.summary.ownOutstanding.completeness).toBe('UNKNOWN');
    expect(view.effectiveReviewState).toBe('OPEN');
    expect(view.warnings.some((warning) => warning.code === 'FINANCIAL_READ_UNAVAILABLE')).toBe(true);
  });
  it('a concurrent JSON credit cannot attach a new fingerprint to old evaluated balances', async () => {
    await project('COMPANY', false);
    const d = await doc();
    await payment(d.id);
    await link(d.id);
    const evaluated = gate(),
      resume = gate();
    let calls = 0;
    const reader = new FinancialReadService();
    const original = reader.readMany.bind(reader);
    reader.readMany = async (...args) => {
      const result = await original(...args);
      calls++;
      if (calls === 2) {
        evaluated.release();
        await resume.promise;
      }
      return result;
    };
    const ctx = await context();
    const accepting = new ReconciliationService(reader, prisma).reviewCase(
      companyId,
      projectId,
      { caseId, mode: 'VERIFY', exceptions: [], reason: 'Concurrent credit test' },
      ctx,
    );
    await evaluated.promise;
    try {
      await prisma.documentInstance.create({
        data: {
          companyId,
          typeId: 'credit-note',
          status: 'sent',
          data: { invoice: d.id, currency: 'NZD', correctedLines: ['a'] },
        },
      });
    } finally {
      resume.release();
    }
    await expect(accepting).rejects.toMatchObject({ response: { code: 'RECONCILIATION_CHANGED' } });
    expect((await prisma.reconciliationCase.findUniqueOrThrow({ where: { id: caseId } })).status).toBe(
      'OPEN',
    );
  });
});
