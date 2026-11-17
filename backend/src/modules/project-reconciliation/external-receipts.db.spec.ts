import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import prisma from '@/prisma/prisma.service';
import type { Prisma } from '../../../prisma/generated/prisma/client';
import { createLibRedisClient } from '@/lib/redis-connection';
import { FinancialReadService } from '../documents/settlement/financial-read.service';
import { ReconciliationService } from './service';
import { ExternalReceiptsService } from './external-receipts';
import { purgeReconciliationForCompany } from './persistence';
import { schemas, parse } from './validation';
import type { ExternalInvoiceInput, ReceiptInput, MutationContext } from './types';

const invoiceInput: ExternalInvoiceInput = {
  issuer: 'Invented Partner',
  recipient: 'Invented Customer',
  number: 'INV-EXAMPLE',
  issueDate: null,
  dueDate: null,
  currency: 'NZD',
  grossMinor: 230000,
  netMinor: null,
  vatMinor: null,
  reportedStatus: 'Paid',
  sourceSystem: null,
  sourceId: null,
  sourceAsOf: '2026-11-01T00:00:00Z',
  sourceReference: 'Invented export',
};
const receiptInput: ReceiptInput = {
  amountMinor: 100000,
  currency: 'NZD',
  paidOn: null,
  evidenceClass: 'PARTNER_REPORTED',
  evidenceReference: null,
  evidenceUrl: null,
  reason: 'Invented partner report',
};
const caseInput = {
  title: 'Invented stage',
  periodStart: null,
  periodEnd: null,
  agreedGrossMinor: null,
  agreedNetMinor: null,
  agreedVatMinor: null,
  agreementReference: null,
};

describe('external-receipts real Postgres', () => {
  const core = new ReconciliationService(new FinancialReadService(), prisma);
  const service = new ExternalReceiptsService(core);
  let companyId: string, foreignId: string, partnerId: string, projectId: string, caseId: string;
  let unchanged: unknown;
  const redis = createLibRedisClient({ lazyConnect: true });
  const actor = { id: 'invented-receipt-reviewer', kind: 'user' as const };
  async function context(id = projectId): Promise<MutationContext> {
    return {
      actor,
      requestKey: randomUUID(),
      expectedVersion: (await core.getProject(companyId, id)).versionToken,
    };
  }
  function synchronisedService(parties: number) {
    const pids = new Set<number>();
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const db = new Proxy(prisma, {
      get(target, property) {
        if (property !== '$transaction') return Reflect.get(target, property);
        return (apply: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          target.$transaction(async (tx) => {
            const [connection] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            pids.add(connection.pid);
            arrivals++;
            if (arrivals === parties) release();
            await gate;
            return apply(tx);
          });
      },
    });
    return {
      service: new ExternalReceiptsService(new ReconciliationService(new FinancialReadService(), db)),
      pids,
    };
  }
  async function invoice(grossMinor = 230000) {
    return (
      await service.saveExternalInvoice(
        companyId,
        projectId,
        { ...invoiceInput, number: randomUUID(), grossMinor, caseId },
        await context(),
      )
    ).result;
  }
  async function receipt(amountMinor = 100000) {
    return (
      await service.recordExternalReceipt(
        companyId,
        projectId,
        { ...receiptInput, amountMinor },
        await context(),
      )
    ).result;
  }
  async function allocate(
    receiptId: string,
    allocations: Array<{ customerInvoiceId: string; amountMinor: number }>,
  ) {
    return service.replaceReceiptAllocations(
      companyId,
      projectId,
      { receiptId, allocations },
      await context(),
    );
  }
  async function legacyState() {
    return {
      documents: await prisma.documentInstance.findMany({ where: { companyId }, orderBy: { id: 'asc' } }),
      payments: await prisma.documentPayment.findMany({ where: { companyId }, orderBy: { id: 'asc' } }),
      outgoingQueues: await queueState(),
    };
  }
  async function queueState() {
    const state: Record<string, string | null> = {};
    for (const key of (await redis.keys('bull:*')).sort()) state[key] = await redis.dump(key);
    return state;
  }
  beforeAll(async () => {
    for (const name of ['Invented external evidence', 'Invented foreign evidence']) {
      const company = await prisma.company.create({
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
      if (!companyId) companyId = company.id;
      else foreignId = company.id;
    }
    partnerId = (
      await prisma.client.create({ data: { companyId, name: 'Invented Partner', country: 'New Zealand' } })
    ).id;
    const document = await prisma.documentInstance.create({
      data: { companyId, typeId: 'invoice', status: 'paid', data: { invented: true, gross: 321 } },
    });
    await prisma.documentPayment.create({
      data: {
        companyId,
        documentId: document.id,
        amountMinor: 123,
        currency: 'NZD',
        documentAmountMinor: 123,
        paidAt: new Date('2026-10-10'),
      },
    });
    unchanged = await legacyState();
  });
  beforeEach(async () => {
    projectId = (
      await core.createProject(
        companyId,
        {
          name: 'Invented project',
          endCustomerName: 'Invented Customer',
          currency: 'NZD',
          collectionMode: 'PARTNER',
          endCustomerClientId: null,
          partnerClientId: partnerId,
          timeProjectId: null,
          description: null,
        },
        { actor, requestKey: randomUUID(), expectedVersion: 'new' },
      )
    ).result.id;
    caseId = (await core.createCase(companyId, projectId, caseInput, await context())).result.id;
  });
  afterEach(async () => {
    expect(await legacyState()).toEqual(unchanged);
  });
  afterAll(async () => {
    await redis.quit();
    for (const id of [companyId, foreignId].filter(Boolean))
      await prisma.$transaction(async (tx) => {
        await purgeReconciliationForCompany(tx, id);
        await tx.company.delete({ where: { id } });
      });
  });
  it('requires contextual review for same issuer/number/year, including PATCH and distinct source IDs', async () => {
    const input = { ...invoiceInput, number: randomUUID(), issueDate: '2026-01-01', caseId };
    const first = await service.saveExternalInvoice(companyId, projectId, input, await context());
    for (const source of [
      { sourceSystem: null, sourceId: null },
      { sourceSystem: 'other', sourceId: randomUUID() },
    ])
      await expect(
        service.saveExternalInvoice(companyId, projectId, { ...input, ...source }, await context()),
      ).rejects.toMatchObject({ response: { code: 'DUPLICATE_INVOICE_REVIEW_REQUIRED' } });
    const other = await service.saveExternalInvoice(
      companyId,
      projectId,
      { ...input, number: randomUUID() },
      await context(),
    );
    await expect(
      service.saveExternalInvoice(
        companyId,
        projectId,
        { caseId, invoiceId: other.result.id, number: input.number },
        await context(),
      ),
    ).rejects.toMatchObject({ response: { code: 'DUPLICATE_INVOICE_REVIEW_REQUIRED' } });
    await service.saveExternalInvoice(
      companyId,
      projectId,
      { ...input, issueDate: '2027-01-01' },
      await context(),
    );
    let fingerprint = '';
    try {
      await service.saveExternalInvoice(companyId, projectId, input, await context());
    } catch (error) {
      fingerprint = (error as { response: { params: { fingerprint: string } } }).response.params.fingerprint;
    }
    const reviewed = await service.saveExternalInvoice(
      companyId,
      projectId,
      {
        ...input,
        duplicateReview: {
          invoiceIds: [first.result.id],
          fingerprint,
          reason: 'Distinct legal issuers share a display name',
          evidenceReference: 'Issuer registry comparison',
          attested: true,
        },
      } as never,
      await context(),
    );
    expect(reviewed.result.sourceSnapshot.duplicateReview).toMatchObject({ invoiceIds: [first.result.id] });
    expect(await prisma.customerInvoiceReference.count({ where: { projectId } })).toBe(4);
  });
  it('keeps contextual identity tenant scoped and requires fresh matching context for a reviewed exception', async () => {
    const input = { ...invoiceInput, caseId, number: randomUUID(), issueDate: '2026-01-01' };
    const first = await service.saveExternalInvoice(companyId, projectId, input, await context());
    let fingerprint = '';
    try {
      await service.saveExternalInvoice(companyId, projectId, input, await context());
    } catch (error) {
      fingerprint = (error as { response: { params: { fingerprint: string } } }).response.params.fingerprint;
    }
    await service.saveExternalInvoice(
      companyId,
      projectId,
      { caseId, invoiceId: first.result.id, recipient: 'Corrected customer' },
      await context(),
    );
    await expect(
      service.saveExternalInvoice(
        companyId,
        projectId,
        {
          ...input,
          duplicateReview: {
            invoiceIds: [first.result.id],
            fingerprint,
            evidenceReference: 'Old comparison',
            reason: 'Stale evidence',
            attested: true,
          },
        } as never,
        await context(),
      ),
    ).rejects.toMatchObject({ response: { code: 'DUPLICATE_INVOICE_REVIEW_REQUIRED' } });
    const partner = await prisma.client.create({
      data: { companyId: foreignId, name: 'Foreign', country: 'NZ' },
    });
    const foreignProject = await core.createProject(
      foreignId,
      {
        name: 'Foreign project',
        endCustomerName: 'Customer',
        currency: 'NZD',
        collectionMode: 'PARTNER',
        endCustomerClientId: null,
        partnerClientId: partner.id,
        timeProjectId: null,
        description: null,
      },
      { actor, requestKey: randomUUID(), expectedVersion: 'new' },
    );
    const foreignContext = async () => ({
      actor,
      requestKey: randomUUID(),
      expectedVersion: (await core.getProject(foreignId, foreignProject.result.id)).versionToken,
    });
    const c = await core.createCase(foreignId, foreignProject.result.id, caseInput, await foreignContext());
    const saved = await service.saveExternalInvoice(
      foreignId,
      foreignProject.result.id,
      { ...input, caseId: c.result.id },
      await foreignContext(),
    );
    expect(saved.result.companyId).toBe(foreignId);
  });
  it('serialises the duplicate identity predicate across projects on distinct connections', async () => {
    const original = await prisma.reconciliationProject.findUniqueOrThrow({ where: { id: projectId } });
    const second = await core.createProject(
      companyId,
      {
        name: 'Second',
        endCustomerName: 'Customer',
        currency: 'NZD',
        collectionMode: 'PARTNER',
        endCustomerClientId: null,
        partnerClientId: original.partnerClientId,
        timeProjectId: null,
        description: null,
      },
      { actor, requestKey: randomUUID(), expectedVersion: 'new' },
    );
    const otherCase = await core.createCase(
      companyId,
      second.result.id,
      caseInput,
      await context(second.result.id),
    );
    const input = { ...invoiceInput, number: randomUUID(), issueDate: '2026-01-01' };
    const race = synchronisedService(2);
    const results = await Promise.allSettled([
      race.service.saveExternalInvoice(companyId, projectId, { ...input, caseId }, await context()),
      race.service.saveExternalInvoice(
        companyId,
        second.result.id,
        { ...input, caseId: otherCase.result.id },
        await context(second.result.id),
      ),
    ]);
    expect(race.pids.size).toBe(2);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { response: { code: 'DUPLICATE_INVOICE_REVIEW_REQUIRED' } },
    });
  });
  it('keeps paid credit disposition open after fresh coverage, then records explicit resolution without erasing history', async () => {
    await core.updateCase(
      companyId,
      projectId,
      caseId,
      { agreedGrossMinor: 0, agreementReference: 'No settlement owed' },
      await context(),
    );
    const i = (
      await service.saveExternalInvoice(
        companyId,
        projectId,
        { ...invoiceInput, caseId, number: randomUUID(), issueDate: '2026-01-01', grossMinor: 10000 },
        await context(),
      )
    ).result;
    const r = (
      await service.recordExternalReceipt(
        companyId,
        projectId,
        {
          ...receiptInput,
          amountMinor: 10000,
          paidOn: '2026-01-02',
          evidenceClass: 'EVIDENCE_CHECKED',
          evidenceReference: 'Bank receipt',
          attested: true,
        },
        await context(),
      )
    ).result;
    await allocate(r.id, [{ customerInvoiceId: i.id, amountMinor: 10000 }]);
    await allocate(r.id, [{ customerInvoiceId: i.id, amountMinor: 8000 }]);
    await service.applyExternalCreditAdjustment(
      companyId,
      projectId,
      { invoiceId: i.id, amountMinor: 2000, sourceReference: 'Credit 1', reason: 'Returned work' },
      await context(),
    );
    const coverage = async () =>
      core.attestEvidenceCoverage(
        companyId,
        projectId,
        {
          customerInvoiceIds: [i.id],
          sourceAsOf: '2026-11-01T00:00:00Z',
          evidenceReference: 'Complete set',
          attested: true,
        },
        await context(),
      );
    await coverage();
    const review = async () =>
      core.reviewCase(
        companyId,
        projectId,
        { caseId, mode: 'VERIFY', reason: 'Checked', exceptions: [] },
        await context(),
      );
    expect((await core.getProject(companyId, projectId)).exceptions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'EXTERNAL_CREDIT_DISPOSITION_UNRESOLVED', blocking: true }),
      ]),
    );
    await expect(review()).rejects.toMatchObject({ response: { code: 'REVIEW_BLOCKED' } });
    const history = await prisma.reconciliationAuditEvent.findMany({
      where: { projectId },
      orderBy: { id: 'asc' },
    });
    const resolved = await service.saveExternalInvoice(
      companyId,
      projectId,
      {
        caseId,
        invoiceId: i.id,
        creditResolution: {
          evidenceReference: 'Partner refund confirmation RF-1',
          reason: 'Customer received the released 2000',
          attested: true,
        },
      } as never,
      await context(),
    );
    expect(resolved.result.sourceSnapshot.creditResolution).toMatchObject({
      creditAdjustmentMinor: 2000,
      collectedPeakMinor: 10000,
    });
    await coverage();
    expect((await review()).result.case.status).toBe('CLOSED_VERIFIED');
    await allocate(r.id, [{ customerInvoiceId: i.id, amountMinor: 7000 }]);
    await service.applyExternalCreditAdjustment(
      companyId,
      projectId,
      {
        invoiceId: i.id,
        amountMinor: 1000,
        sourceReference: 'Further credit',
        reason: 'New disposition needed',
      },
      await context(),
    );
    await coverage();
    await expect(review()).rejects.toMatchObject({ response: { code: 'REVIEW_BLOCKED' } });
    expect(
      await prisma.reconciliationAuditEvent.findMany({
        where: { id: { in: history.map((a) => a.id) } },
        orderBy: { id: 'asc' },
      }),
    ).toEqual(history);
    expect(
      (await prisma.customerInvoiceReference.findUniqueOrThrow({ where: { id: i.id } })).originalGrossMinor,
    ).toBe(10000);
  });
  it('does not confuse an unpaid credit or unrelated advance with released collected money', async () => {
    const i = await invoice(10000);
    await receipt(2000);
    await service.applyExternalCreditAdjustment(
      companyId,
      projectId,
      { invoiceId: i.id, amountMinor: 2000, sourceReference: 'Unpaid credit', reason: 'Never collected' },
      await context(),
    );
    expect(
      (await core.getProject(companyId, projectId)).exceptions.some(
        (e) => e.code === 'EXTERNAL_CREDIT_DISPOSITION_UNRESOLVED',
      ),
    ).toBe(false);
  });
  it('does not sum sequential receipt peaks when funds are reassigned or voided', async () => {
    const i = await invoice(10000),
      a = await receipt(4000),
      b = await receipt(4000);
    await allocate(a.id, [{ customerInvoiceId: i.id, amountMinor: 4000 }]);
    await allocate(a.id, []);
    await allocate(b.id, [{ customerInvoiceId: i.id, amountMinor: 4000 }]);
    await service.voidExternalReceipt(
      companyId,
      projectId,
      { receiptId: b.id, reason: 'Reassigned evidence was incorrect' },
      await context(),
    );
    await service.applyExternalCreditAdjustment(
      companyId,
      projectId,
      {
        invoiceId: i.id,
        amountMinor: 5000,
        sourceReference: 'Uncollected portion',
        reason: 'Only 4000 was ever allocated at once',
      },
      await context(),
    );
    expect(
      (await core.getProject(companyId, projectId)).exceptions.some(
        (e) => e.code === 'EXTERNAL_CREDIT_DISPOSITION_UNRESOLVED',
      ),
    ).toBe(false);
    await service.applyExternalCreditAdjustment(
      companyId,
      projectId,
      {
        invoiceId: i.id,
        amountMinor: 2000,
        sourceReference: 'Collected portion',
        reason: 'History must survive void',
      },
      await context(),
    );
    expect(
      (await core.getProject(companyId, projectId)).exceptions.some(
        (e) => e.code === 'EXTERNAL_CREDIT_DISPOSITION_UNRESOLVED',
      ),
    ).toBe(true);
  });
  it('rejects API-key identity and disposition attestations before persistence', async () => {
    await expect(
      service.saveExternalInvoice(
        companyId,
        projectId,
        {
          ...invoiceInput,
          caseId,
          duplicateReview: {
            invoiceIds: ['other'],
            fingerprint: 'a'.repeat(64),
            reason: 'Claim',
            evidenceReference: 'Claim',
            attested: true,
          },
        } as never,
        { ...(await context()), actor: { kind: 'api-key', id: 'key' } },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it('rejects a reference-only agreement without a partner at the service boundary', () => {
    expect(() =>
      core.checkAgreement({ partnerClientId: null } as never, {
        ...caseInput,
        agreementReference: 'Unsupported',
      }),
    ).toThrow('A settlement agreement requires a partner client.');
    expect(() =>
      core.checkAgreement({ partnerClientId: null } as never, {
        ...caseInput,
        agreementReason: 'Unsupported',
      }),
    ).toThrow('A settlement agreement requires a partner client.');
  });
  it('Paid is only a source label, never a receipt or checked cash; null dates remain null', async () => {
    const saved = await invoice();
    expect(saved.external.grossMinor).toBe(230000);
    expect(saved.external.issueDate).toBeNull();
    expect(await prisma.externalReceipt.count({ where: { companyId, projectId } })).toBe(0);
    expect(await prisma.documentPayment.count({ where: { companyId } })).toBe(1);
    const view = await core.getProject(companyId, projectId);
    expect(view.sourceMarkedPaid.knownMinor).toBe(230000);
    expect(view.checkedReceipts.completeness).toBe('UNKNOWN');
    expect(view.summary.ownRecordedReceipts.knownMinor).toBe(0);
  });
  it('promotes the same receipt with fresh explicit attestation and audits before/after facts', async () => {
    const r = await receipt();
    expect(r.paidOn).toBeNull();
    expect(r.collector).toBe('Invented Partner');
    expect(r.sourceReference).toBe(receiptInput.reason);
    await expect(
      service.updateExternalReceipt(
        companyId,
        projectId,
        {
          receiptId: r.id,
          evidenceClass: 'EVIDENCE_CHECKED',
          evidenceReference: 'Invented bank ref',
          reason: 'Reviewed',
        },
        await context(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    const c = await context();
    const checked = await service.updateExternalReceipt(
      companyId,
      projectId,
      {
        receiptId: r.id,
        evidenceClass: 'EVIDENCE_CHECKED',
        evidenceReference: 'Invented bank ref',
        attested: true,
        reason: 'Reviewed',
      },
      c,
    );
    expect(checked.result.id).toBe(r.id);
    expect(checked.result.version).toBe(2);
    expect(checked.result.paidOn).toBeNull();
    expect(checked.result.reviewedBy).toBe('user:invented-receipt-reviewer');
    expect(checked.result.humanAttestation).toContain('explicit');
    await expect(
      service.updateExternalReceipt(
        companyId,
        projectId,
        { receiptId: r.id, paidOn: '2026-11-02', reason: 'Date corrected' },
        await context(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    const corrected = await service.updateExternalReceipt(
      companyId,
      projectId,
      { receiptId: r.id, paidOn: '2026-11-02', reason: 'Date corrected', attested: true },
      await context(),
    );
    expect(corrected.result.id).toBe(r.id);
    expect(corrected.result.paidOn).toBe('2026-11-02');
    const audit = await prisma.reconciliationAuditEvent.findUniqueOrThrow({
      where: {
        companyId_actor_requestKey: {
          companyId,
          actor: 'user:invented-receipt-reviewer',
          requestKey: c.requestKey,
        },
      },
    });
    expect((audit.before as { state: { paidOn: null } }).state.paidOn).toBeNull();
    expect((audit.after as { result: { evidenceClass: string } }).result.evidenceClass).toBe(
      'EVIDENCE_CHECKED',
    );
    expect(await prisma.externalReceipt.count({ where: { companyId, projectId } })).toBe(1);
    parse(schemas.receiptRecord, corrected.result);
  });
  it('validates merged source pairs, checked references, URLs, dates and matching currency', async () => {
    const r = await receipt();
    await expect(
      service.updateExternalReceipt(
        companyId,
        projectId,
        { receiptId: r.id, sourceSystem: 'invented', reason: 'Pair' },
        await context(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.recordExternalReceipt(
        companyId,
        projectId,
        { ...receiptInput, currency: 'USD' },
        await context(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.recordExternalReceipt(
        companyId,
        projectId,
        { ...receiptInput, paidOn: '2026-02-30' },
        await context(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.recordExternalReceipt(
        companyId,
        projectId,
        { ...receiptInput, evidenceUrl: 'https://device.local./proof' },
        await context(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    const credited = await service.updateExternalReceipt(
      companyId,
      projectId,
      {
        receiptId: r.id,
        evidenceClass: 'EVIDENCE_CHECKED',
        attested: true,
        evidenceReference: 'Ref',
        sourceSystem: 'invented',
        sourceId: 'receipt-a',
        reason: 'Reviewed',
      },
      await context(),
    );
    await expect(
      service.updateExternalReceipt(
        companyId,
        projectId,
        { receiptId: r.id, evidenceReference: null, attested: true, reason: 'Remove' },
        await context(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    expect(credited.result.sourceSystem).toBe('invented');
    const changed = await service.updateExternalReceipt(
      companyId,
      projectId,
      { receiptId: r.id, reason: 'Keep provenance', attested: true },
      await context(),
    );
    expect(changed.result.sourceId).toBe('receipt-a');
    const i = await invoice();
    await allocate(r.id, [{ customerInvoiceId: i.id, amountMinor: 50000 }]);
    const updatedContext = await context();
    const afterAllocation = await service.updateExternalReceipt(
      companyId,
      projectId,
      { receiptId: r.id, paidOn: '2026-11-03', reason: 'Date after allocation', attested: true },
      updatedContext,
    );
    expect(afterAllocation.result.sourceSystem).toBe('invented');
    expect(afterAllocation.result.sourceId).toBe('receipt-a');
    const retry = await service.updateExternalReceipt(
      companyId,
      projectId,
      { receiptId: r.id, paidOn: '2026-11-03', reason: 'Date after allocation', attested: true },
      updatedContext,
    );
    expect(retry).toEqual({ ...afterAllocation, changed: false });
  });
  it('fully allocates two receipts, rejects one extra minor unit, and rolls replacement back atomically', async () => {
    const i = await invoice(),
      a = await receipt(),
      b = await receipt(130000),
      extra = await receipt(1);
    await allocate(a.id, [{ customerInvoiceId: i.id, amountMinor: 100000 }]);
    await allocate(b.id, [{ customerInvoiceId: i.id, amountMinor: 130000 }]);
    await expect(allocate(extra.id, [{ customerInvoiceId: i.id, amountMinor: 1 }])).rejects.toMatchObject({
      response: { code: 'ALLOCATION_EXCEEDS_AVAILABLE' },
    });
    const before = await prisma.externalReceiptAllocation.findMany({ where: { receiptId: a.id } });
    await expect(allocate(a.id, [{ customerInvoiceId: i.id, amountMinor: 100001 }])).rejects.toMatchObject({
      status: 409,
    });
    expect(await prisma.externalReceiptAllocation.findMany({ where: { receiptId: a.id } })).toEqual(before);
    await expect(
      allocate(a.id, [
        { customerInvoiceId: i.id, amountMinor: 1 },
        { customerInvoiceId: i.id, amountMinor: 1 },
      ]),
    ).rejects.toMatchObject({ status: 400 });
  });
  it('splits an advance and void releases allocations while retaining receipt and audit', async () => {
    const a = await invoice(60000),
      b = await invoice(70000),
      r = await receipt(150000);
    const split = await allocate(r.id, [
      { customerInvoiceId: b.id, amountMinor: 70000 },
      { customerInvoiceId: a.id, amountMinor: 60000 },
    ]);
    expect(split.result.unallocatedMinor).toBe(20000);
    expect(split.result.allocations).toHaveLength(2);
    const v = await service.voidExternalReceipt(
      companyId,
      projectId,
      { receiptId: r.id, reason: 'Reported twice' },
      await context(),
    );
    expect(v.result.voidReason).toBe('Reported twice');
    expect(v.result.voidedAt).toBeTruthy();
    expect(await prisma.externalReceiptAllocation.count({ where: { receiptId: r.id } })).toBe(0);
    expect(await prisma.externalReceipt.findUnique({ where: { id: r.id } })).toBeTruthy();
    await expect(allocate(r.id, [{ customerInvoiceId: a.id, amountMinor: 1 }])).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      service.updateExternalReceipt(
        companyId,
        projectId,
        { receiptId: r.id, reason: 'Edit void' },
        await context(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    const audit = await prisma.reconciliationAuditEvent.findFirstOrThrow({
      where: { companyId, projectId, operation: 'receipt.void' },
    });
    expect((audit.before as { state: { allocations: unknown[] } }).state.allocations).toHaveLength(2);
  });
  it('keeps original gross and cumulative credit history and protects allocated ceilings on edits', async () => {
    const i = await invoice(230000),
      r = await receipt(100000);
    await allocate(r.id, [{ customerInvoiceId: i.id, amountMinor: 100000 }]);
    await expect(
      service.updateExternalReceipt(
        companyId,
        projectId,
        { receiptId: r.id, amountMinor: 99999, reason: 'Too small' },
        await context(),
      ),
    ).rejects.toMatchObject({ response: { code: 'ALLOCATION_EXCEEDS_AVAILABLE' } });
    await expect(
      service.saveExternalInvoice(
        companyId,
        projectId,
        { caseId, invoiceId: i.id, grossMinor: 99999 },
        await context(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    const correction = await service.saveExternalInvoice(
      companyId,
      projectId,
      { caseId, invoiceId: i.id, grossMinor: 220000 },
      await context(),
    );
    expect(correction.result.external.grossMinor).toBe(220000);
    const credit = {
      invoiceId: i.id,
      amountMinor: 20000,
      sourceReference: 'Invented credit A',
      reason: 'Correction',
    };
    const first = await service.applyExternalCreditAdjustment(companyId, projectId, credit, await context());
    expect(first.result.originalGrossMinor).toBe(220000);
    expect(first.result.creditAdjustmentMinor).toBe(20000);
    const second = await service.applyExternalCreditAdjustment(
      companyId,
      projectId,
      { ...credit, amountMinor: 30000 },
      await context(),
    );
    expect(second.result.adjustedGrossMinor).toBe(170000);
    expect(second.result.creditAdjustmentMinor).toBe(50000);
    await expect(
      service.saveExternalInvoice(
        companyId,
        projectId,
        { caseId, invoiceId: i.id, grossMinor: 240000 },
        await context(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.applyExternalCreditAdjustment(
        companyId,
        projectId,
        { ...credit, amountMinor: 70001 },
        await context(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await allocate(r.id, []);
    await service.applyExternalCreditAdjustment(
      companyId,
      projectId,
      { ...credit, amountMinor: 70001 },
      await context(),
    );
    expect(
      (await prisma.customerInvoiceReference.findUniqueOrThrow({ where: { id: i.id } })).originalGrossMinor,
    ).toBe(220000);
  });
  it('merges invoice date/source fields and audits snapshot revisions without erasing provenance', async () => {
    const i = await invoice();
    const c = await context();
    const updated = await service.saveExternalInvoice(
      companyId,
      projectId,
      {
        caseId,
        invoiceId: i.id,
        sourceSystem: 'ledgerly',
        sourceId: 'invented-invoice',
        issueDate: '2026-11-01',
        dueDate: '2026-11-30',
      },
      c,
    );
    expect(updated.result.external.sourceAsOf).toBe(invoiceInput.sourceAsOf);
    await expect(
      service.saveExternalInvoice(
        companyId,
        projectId,
        { caseId, invoiceId: i.id, sourceId: null },
        await context(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.saveExternalInvoice(
        companyId,
        projectId,
        { caseId, invoiceId: i.id, issueDate: '2026-12-01' },
        await context(),
      ),
    ).rejects.toMatchObject({ status: 400 });
    const audit = await prisma.reconciliationAuditEvent.findUniqueOrThrow({
      where: {
        companyId_actor_requestKey: {
          companyId,
          actor: 'user:invented-receipt-reviewer',
          requestKey: c.requestKey,
        },
      },
    });
    expect(
      (audit.before as { state: { external: { sourceSystem: null } } }).state.external.sourceSystem,
    ).toBeNull();
    parse(schemas.externalInvoiceRecord, updated.result);
  });
  it('rejects COMPANY external writes and foreign nested IDs before stale checks', async () => {
    const own = await core.createProject(
      companyId,
      {
        name: 'Own',
        endCustomerName: 'Own customer',
        currency: 'NZD',
        collectionMode: 'COMPANY',
        endCustomerClientId: null,
        partnerClientId: null,
        timeProjectId: null,
        description: null,
      },
      { actor, requestKey: randomUUID(), expectedVersion: 'new' },
    );
    const ownCase = await core.createCase(companyId, own.result.id, caseInput, await context(own.result.id));
    await expect(
      service.recordExternalReceipt(companyId, own.result.id, receiptInput, await context(own.result.id)),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.saveExternalInvoice(
        companyId,
        own.result.id,
        { ...invoiceInput, caseId: ownCase.result.id },
        await context(own.result.id),
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.saveExternalInvoice(
        companyId,
        projectId,
        { ...invoiceInput, caseId: ownCase.result.id },
        { ...(await context()), expectedVersion: 'stale' },
      ),
    ).rejects.toMatchObject({ status: 404 });
    const foreignPartner = await prisma.client.create({
      data: { companyId: foreignId, name: 'Foreign partner', country: 'New Zealand' },
    });
    const foreignProject = await prisma.reconciliationProject.create({
      data: {
        companyId: foreignId,
        name: 'Foreign project',
        endCustomerName: 'Foreign customer',
        currency: 'NZD',
        collectionMode: 'PARTNER',
        partnerClientId: foreignPartner.id,
      },
    });
    const foreignReceipt = await prisma.externalReceipt.create({
      data: {
        companyId: foreignId,
        projectId: foreignProject.id,
        currency: 'NZD',
        collector: 'Foreign partner',
        grossMinor: 1,
        sourceReference: 'Foreign source',
        enteredBy: 'user:invented',
      },
    });
    await expect(
      service.updateExternalReceipt(
        companyId,
        projectId,
        { receiptId: foreignReceipt.id, reason: 'Wrong tenant' },
        { ...(await context()), expectedVersion: 'stale' },
      ),
    ).rejects.toMatchObject({ status: 404 });
    const r = await receipt();
    await expect(
      allocate(r.id, [{ customerInvoiceId: 'foreign-or-missing', amountMinor: 1 }]),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('retries return original IDs, conflicting payloads/route IDs fail, and audit failure rolls back', async () => {
    const c = await context();
    const a = await service.recordExternalReceipt(companyId, projectId, receiptInput, c);
    expect(await service.recordExternalReceipt(companyId, projectId, receiptInput, c)).toEqual({
      ...a,
      changed: false,
    });
    await expect(
      service.recordExternalReceipt(companyId, projectId, { ...receiptInput, amountMinor: 1 }, c),
    ).rejects.toMatchObject({ status: 409 });
    const i = await invoice(),
      other = (await core.createCase(companyId, projectId, caseInput, await context())).result;
    const editContext = await context();
    await service.saveExternalInvoice(
      companyId,
      projectId,
      { caseId, invoiceId: i.id, number: 'Edited' },
      editContext,
    );
    await expect(
      service.saveExternalInvoice(
        companyId,
        projectId,
        { caseId: other.id, invoiceId: i.id, number: 'Edited' },
        editContext,
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await prisma.externalReceipt.count({ where: { companyId, projectId } })).toBe(1);
    const original = prisma.$extends({
      query: {
        reconciliationAuditEvent: {
          create() {
            throw new Error('Invented audit failure');
          },
        },
      },
    });
    const broken = new ExternalReceiptsService(
      new ReconciliationService(new FinancialReadService(), original),
    );
    const before = await prisma.reconciliationProject.findUniqueOrThrow({ where: { id: projectId } });
    await expect(
      broken.recordExternalReceipt(companyId, projectId, receiptInput, await context()),
    ).rejects.toThrow('Invented audit failure');
    expect(await prisma.reconciliationProject.findUniqueOrThrow({ where: { id: projectId } })).toEqual(
      before,
    );
    expect(await prisma.externalReceipt.count({ where: { companyId, projectId } })).toBe(1);
  });
  it('serialises competing independent connections; no receipt or invoice can be over-allocated', async () => {
    const i = await invoice(100000),
      a = await receipt(60000),
      b = await receipt(60000);
    const one = await context(),
      two = { ...one, requestKey: randomUUID() };
    const synchronised = synchronisedService(2);
    const results = await Promise.allSettled([
      synchronised.service.replaceReceiptAllocations(
        companyId,
        projectId,
        { receiptId: a.id, allocations: [{ customerInvoiceId: i.id, amountMinor: 60000 }] },
        one,
      ),
      synchronised.service.replaceReceiptAllocations(
        companyId,
        projectId,
        { receiptId: b.id, allocations: [{ customerInvoiceId: i.id, amountMinor: 60000 }] },
        two,
      ),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(synchronised.pids.size).toBe(2);
    expect(
      (
        await prisma.externalReceiptAllocation.aggregate({
          where: { invoiceReferenceId: i.id },
          _sum: { amountMinor: true },
        })
      )._sum.amountMinor,
    ).toBe(60000);
    const rejected = results[0].status === 'rejected' ? a : b;
    await expect(
      allocate(rejected.id, [{ customerInvoiceId: i.id, amountMinor: 60000 }]),
    ).rejects.toMatchObject({ response: { code: 'ALLOCATION_EXCEEDS_AVAILABLE' } });
    const active = results[0].status === 'fulfilled' ? a : b;
    const same = await context();
    const synchronisedThree = synchronisedService(3);
    const races = await Promise.allSettled([
      synchronisedThree.service.updateExternalReceipt(
        companyId,
        projectId,
        { receiptId: active.id, amountMinor: 1, reason: 'Concurrent edit' },
        same,
      ),
      synchronisedThree.service.applyExternalCreditAdjustment(
        companyId,
        projectId,
        {
          invoiceId: i.id,
          amountMinor: 50000,
          sourceReference: 'Invented concurrent credit',
          reason: 'Credit',
        },
        { ...same, requestKey: randomUUID() },
      ),
      synchronisedThree.service.voidExternalReceipt(
        companyId,
        projectId,
        { receiptId: active.id, reason: 'Concurrent void' },
        { ...same, requestKey: randomUUID() },
      ),
    ]);
    expect(races.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(synchronisedThree.pids.size).toBe(3);
    expect(await prisma.externalReceiptAllocation.count({ where: { invoiceReferenceId: i.id } })).toBe(0);
  });
  it('serialises shared-receipt replacements and simultaneous same-key creation on real connections', async () => {
    const a = await invoice(100000),
      b = await invoice(100000),
      r = await receipt(100000);
    const shared = await context();
    const race = synchronisedService(2);
    const results = await Promise.allSettled([
      race.service.replaceReceiptAllocations(
        companyId,
        projectId,
        { receiptId: r.id, allocations: [{ customerInvoiceId: a.id, amountMinor: 80000 }] },
        shared,
      ),
      race.service.replaceReceiptAllocations(
        companyId,
        projectId,
        { receiptId: r.id, allocations: [{ customerInvoiceId: b.id, amountMinor: 80000 }] },
        { ...shared, requestKey: randomUUID() },
      ),
    ]);
    expect(race.pids.size).toBe(2);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(
      (
        await prisma.externalReceiptAllocation.aggregate({
          where: { receiptId: r.id },
          _sum: { amountMinor: true },
        })
      )._sum.amountMinor,
    ).toBe(80000);
    const createContext = await context();
    const creates = synchronisedService(2);
    const created = await Promise.all([
      creates.service.recordExternalReceipt(companyId, projectId, receiptInput, createContext),
      creates.service.recordExternalReceipt(companyId, projectId, receiptInput, createContext),
    ]);
    expect(creates.pids.size).toBe(2);
    expect(created[0].result.id).toBe(created[1].result.id);
    expect(created.filter((result) => result.changed)).toHaveLength(1);
    expect(await prisma.externalReceipt.count({ where: { companyId, projectId } })).toBe(2);
  });
});
