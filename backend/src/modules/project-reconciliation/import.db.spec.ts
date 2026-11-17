import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import prisma from '@/prisma/prisma.service';
import { createLibRedisClient } from '@/lib/redis-connection';
import type { Prisma } from '../../../prisma/generated/prisma/client';
import { ROW_ID_KEY } from '../documents/row-selection/row-selection';
import { updateDocumentStatus, upsertDocument } from '../documents/persistence';
import { FinancialReadService } from '../documents/settlement/financial-read.service';
import { ReconciliationService, reconciliationHash } from './service';
import { ExternalReceiptsService } from './external-receipts';
import { purgeReconciliationForCompany } from './persistence';
import { parse, schemas } from './validation';
import type { ImportPreviewInput, MutationContext } from './types';

const actor = { id: 'invented-import-reviewer', kind: 'user' as const };
describe('import real Postgres preview and atomic confirmation', () => {
  const core = new ReconciliationService(new FinancialReadService(), prisma);
  const redis = createLibRedisClient({ lazyConnect: true });
  let companyId: string, partnerId: string, customerId: string, projectId: string;
  function input(suffix = '', mode: 'COMPANY' | 'PARTNER' = 'PARTNER'): ImportPreviewInput {
    const source = {
      id: 'invented-source-project',
      name: 'Invented project',
      customerIssuer: mode === 'PARTNER' ? 'Invented partner' : 'Invented company',
      customerRecipient: 'Invented customer',
      shareIssuer: mode === 'PARTNER' ? 'Invented company' : 'Invented partner',
      shareRecipient: mode === 'PARTNER' ? 'Invented partner' : 'Invented company',
    };
    const common = {
      projectId: source.id,
      projectName: source.name,
      status: 'Paid' as const,
      issueDate: null,
      dueDate: null,
      paidDate: '2026-10-01',
      sharePercent: 99,
    };
    return {
      payload: {
        sourceSystem: 'ledgerly',
        sourceAsOf: '2026-11-01T00:00:00Z',
        currency: 'NZD',
        project: source,
        invoices: [
          {
            ...common,
            id: `invented-customer${suffix}`,
            number: `EX-CUSTOMER${suffix}`,
            kind: 'Customer invoice',
            issuer: source.customerIssuer,
            recipient: source.customerRecipient,
            exGstAmountCents: 10000,
            gstAmountCents: 1500,
            totalCents: 11500,
            sourceNumber: `EX-CUSTOMER${suffix}`,
            linkedInvoiceNumber: `EX-SHARE${suffix}`,
          },
          {
            ...common,
            id: `invented-share${suffix}`,
            number: `EX-SHARE${suffix}`,
            kind: 'Internal share',
            issuer: source.shareIssuer,
            recipient: source.shareRecipient,
            exGstAmountCents: 4000,
            gstAmountCents: 600,
            totalCents: 4600,
            sourceNumber: `EX-CUSTOMER${suffix}`,
            linkedInvoiceNumber: `EX-CUSTOMER${suffix}`,
          },
        ],
      },
      selectedMatches: [],
    };
  }
  async function project(mode: 'COMPANY' | 'PARTNER' = 'PARTNER') {
    return (
      await core.createProject(
        companyId,
        {
          name: 'Invented destination',
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
  }
  async function context(id = projectId): Promise<MutationContext> {
    return {
      actor,
      requestKey: randomUUID(),
      expectedVersion: (await core.getProject(companyId, id)).versionToken,
    };
  }
  async function preview(data = input(), id = projectId) {
    return core.previewImport(companyId, id, data);
  }
  async function confirm(data = input(), id = projectId) {
    const p = await preview(data, id);
    return core.confirmImport(companyId, id, { ...data, previewHash: p.previewHash }, await context(id));
  }
  async function own(number = 'EX-SHARE', typeId = 'invoice', party = partnerId, currency = 'NZD') {
    return prisma.documentInstance.create({
      data: {
        companyId,
        typeId,
        status: typeId === 'invoice' ? 'sent' : 'received',
        displayNumber: number,
        data: {
          currency,
          client: party,
          supplierClient: party,
          exGstAmount: 87,
          gstAmount: 0,
          totalAmount: 87,
          lines: [{ [ROW_ID_KEY]: 'invented-line', quantity: 1, unitPrice: 87, vatRate: '0' }],
        },
      },
    });
  }
  async function state() {
    return {
      cases: await prisma.reconciliationCase.findMany({ where: { companyId }, orderBy: { id: 'asc' } }),
      refs: await prisma.customerInvoiceReference.findMany({ where: { companyId }, orderBy: { id: 'asc' } }),
      links: await prisma.projectDocumentLink.findMany({ where: { companyId }, orderBy: { id: 'asc' } }),
      audit: await prisma.reconciliationAuditEvent.findMany({ where: { companyId }, orderBy: { id: 'asc' } }),
      projects: await prisma.reconciliationProject.findMany({ where: { companyId }, orderBy: { id: 'asc' } }),
    };
  }
  async function canonical() {
    const queues: Record<string, string | null> = {};
    for (const key of (await redis.keys('bull:*')).sort()) queues[key] = await redis.dump(key);
    return {
      documents: await prisma.documentInstance.findMany({ where: { companyId }, orderBy: { id: 'asc' } }),
      payments: await prisma.documentPayment.findMany({ where: { companyId }, orderBy: { id: 'asc' } }),
      reminders: await prisma.documentReminder.findMany({ where: { companyId }, orderBy: { id: 'asc' } }),
      queues,
    };
  }
  beforeAll(async () => {
    companyId = (
      await prisma.company.create({
        data: {
          name: 'Invented import company',
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
    partnerId = (
      await prisma.client.create({ data: { companyId, name: 'Invented partner', country: 'New Zealand' } })
    ).id;
    customerId = (
      await prisma.client.create({ data: { companyId, name: 'Invented customer', country: 'New Zealand' } })
    ).id;
  });
  beforeEach(async () => {
    projectId = await project();
  });
  afterAll(async () => {
    await redis.quit();
    if (companyId)
      await prisma.$transaction(async (tx) => {
        await purgeReconciliationForCompany(tx, companyId);
        await tx.company.delete({ where: { id: companyId } });
      });
  });
  it('blocks preview and confirm when another source ID has the same contextual invoice identity', async () => {
    const data = input('-duplicate-' + randomUUID());
    await confirm(data);
    const second = await project();
    const duplicate = structuredClone(data);
    duplicate.payload.invoices[0].id += '-distinct-source';
    duplicate.payload.invoices[1].id += '-distinct-source';
    const p = await preview(duplicate, second);
    expect(p.errors).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'DUPLICATE_INVOICE_REVIEW_REQUIRED' })]),
    );
    const before = await state();
    await expect(
      core.confirmImport(
        companyId,
        second,
        { ...duplicate, previewHash: p.previewHash },
        await context(second),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await state()).toEqual(before);
    const repeated = await preview(data);
    expect(repeated.proposedReferences[0].action).toBe('REUSE');
  });
  it('previews explicit source facts with zero writes, source Paid never becomes cash', async () => {
    const before = await state(),
      old = await canonical();
    const p = await preview();
    parse(schemas.importPreview, p);
    expect(p.errors).toEqual([]);
    expect(p.proposedCases[0].proposed.agreedGrossMinor).toBe(4600);
    expect(p.proposedReferences[0].proposed).toMatchObject({
      grossMinor: 11500,
      netMinor: 10000,
      vatMinor: 1500,
      reportedStatus: 'Paid',
    });
    expect(p.proposedLinks[0]).toMatchObject({ role: 'SETTLEMENT_INCOME', action: 'UNRESOLVED' });
    expect(p.unresolved.some((x) => !x.blocking)).toBe(true);
    expect(await state()).toEqual(before);
    expect(await canonical()).toEqual(old);
    const result = await confirm();
    parse(schemas.importResult, result);
    expect(result.result.cases).toHaveLength(1);
    expect(await prisma.externalReceipt.count({ where: { companyId, projectId } })).toBe(0);
    expect(await canonical()).toEqual(old);
  });
  it('pins invented 15 reciprocal pairs and 4 unpaired chains without treating linkedInvoiceNumber as an own ID', async () => {
    const data = input('-pair-0');
    data.payload.invoices = [];
    for (let i = 0; i < 19; i++) {
      const pair = input(`-pair-${i}`).payload.invoices;
      if (i >= 15) {
        pair[0].linkedInvoiceNumber = null;
        pair[1].linkedInvoiceNumber = null;
        pair[1].sourceNumber = pair[1].number;
        pair[1].sourceSnapshot = {
          customerCard: {
            label: '',
            issuer: '',
            recipient: '',
            number: null,
            pending: true,
            amountCents: 0,
            totalCents: 0,
          },
        };
      }
      if (i >= 17) {
        pair[1].projectId = null;
        pair[1].projectName = '';
      }
      data.payload.invoices.push(...pair);
    }
    const p = await preview(data);
    expect(p.counts.sourceRows).toBe(38);
    expect(p.proposedCases).toHaveLength(19);
    expect(p.unresolved.filter((issue) => issue.code === 'IMPORT_SOURCE_ANCHOR')).toHaveLength(4);
    expect(p.unresolved.filter((issue) => issue.code === 'IMPORT_SOURCE_MEMBERSHIP')).toHaveLength(2);
    expect(p.proposedCases.filter((item) => item.proposed.agreedGrossMinor === 4600)).toHaveLength(15);
    expect(p.proposedLinks.every((item) => item.selectedMatch === null)).toBe(true);
  });
  it('stores exactly the reviewed case/reference snapshot hashes independent of source ID order', async () => {
    const data = input('-hash');
    data.payload.invoices[1].id = 'a-invented-share-before-customer';
    const p = await preview(data),
      saved = await confirm(data);
    const row = await prisma.reconciliationCase.findUniqueOrThrow({
      where: { id: saved.result.cases[0].caseId },
    });
    const ref = await prisma.customerInvoiceReference.findUniqueOrThrow({
      where: { id: saved.result.references[0].referenceId },
    });
    expect(row.snapshotHash).toBe(p.proposedCases[0].proposedSnapshotHash);
    expect(ref.snapshotHash).toBe(p.proposedReferences[0].proposedSnapshotHash);
  });
  it('returns an explicit financial-read failure when unlinked candidate sources cannot be read', async () => {
    const data = input('-unavailable');
    await own('EX-SHARE-unavailable');
    const financial = new FinancialReadService(),
      read = financial.readMany.bind(financial);
    vi.spyOn(financial, 'readMany').mockImplementation((company, refs, tx) =>
      refs.length ? Promise.reject(new Error('invented financial read failure')) : read(company, refs, tx),
    );
    const failing = new ReconciliationService(financial, prisma);
    await expect(failing.previewImport(companyId, projectId, data)).rejects.toMatchObject({
      response: { code: 'FINANCIAL_READ_UNAVAILABLE' },
    });
  });
  it('retries exactly before freshness and reuses IDs on new requests without duplicate totals', async () => {
    const data = input('-retry');
    const p = await preview(data),
      ctx = await context();
    const body = { ...data, previewHash: p.previewHash };
    const first = await core.confirmImport(companyId, projectId, body, ctx);
    const retry = await core.confirmImport(companyId, projectId, body, ctx);
    expect(retry).toEqual({ ...first, changed: false });
    await expect(
      core.confirmImport(
        companyId,
        projectId,
        {
          ...body,
          selectedMatches: [
            {
              sourceId: 'different',
              documentId: 'invented-doc',
              typeId: 'invoice',
              caseSourceId: 'different',
            },
          ],
        },
        ctx,
      ),
    ).rejects.toMatchObject({ status: 409 });
    const again = await confirm(data);
    expect(again.result.cases[0].caseId).toBe(first.result.cases[0].caseId);
    expect(again.result.references[0].referenceId).toBe(first.result.references[0].referenceId);
    expect(await prisma.reconciliationCase.count({ where: { companyId, projectId } })).toBe(1);
    expect(await prisma.customerInvoiceReference.count({ where: { companyId, projectId } })).toBe(1);
    expect(
      await prisma.reconciliationAuditEvent.count({
        where: { companyId, projectId, operation: 'import.confirm' },
      }),
    ).toBe(2);
  });
  it('preserves owner edits and opaque old snapshots; meaningful changes block, asOf-only reuse does not refresh records', async () => {
    const data = input('-revision');
    const saved = await confirm(data);
    const caseId = saved.result.cases[0].caseId,
      refId = saved.result.references[0].referenceId;
    const prior = await prisma.customerInvoiceReference.findUniqueOrThrow({ where: { id: refId } });
    const opaque = { ...(prior.sourceSnapshot as object), oldOpaque: { keep: 'invented history' } };
    await prisma.customerInvoiceReference.update({
      where: { id: refId },
      data: { sourceSnapshot: opaque, snapshotHash: reconciliationHash(opaque) },
    });
    await core.updateCase(
      companyId,
      projectId,
      caseId,
      { agreedGrossMinor: 9000, agreedNetMinor: null, agreedVatMinor: null },
      await context(),
    );
    const later = structuredClone(data);
    later.payload.sourceAsOf = '2026-11-02T00:00:00Z';
    const p = await preview(later);
    expect(p.errors).toEqual([]);
    await confirm(later);
    expect(
      (await prisma.customerInvoiceReference.findUniqueOrThrow({ where: { id: refId } })).sourceSnapshot,
    ).toEqual(opaque);
    expect(
      (await prisma.reconciliationCase.findUniqueOrThrow({ where: { id: caseId } })).agreedGrossMinor,
    ).toBe(9000);
    later.payload.invoices[0].totalCents += 100;
    later.payload.invoices[0].exGstAmountCents += 100;
    const changed = await preview(later);
    expect(changed.proposedReferences[0].action).toBe('REVISION');
    expect(changed.errors.some((x) => x.code === 'IMPORT_SOURCE_REVISION')).toBe(true);
    const before = await state();
    await expect(
      core.confirmImport(
        companyId,
        projectId,
        { ...later, previewHash: changed.previewHash },
        await context(),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await state()).toEqual(before);
    const external = new ExternalReceiptsService(core);
    await external.saveExternalInvoice(
      companyId,
      projectId,
      { caseId, invoiceId: refId, grossMinor: 11600, netMinor: 10100 },
      await context(),
    );
    expect((await preview(later)).proposedReferences[0].action).toBe('REUSE');
  });
  it('blocks introduction or rebinding of raw share identity through REUSE even when owner facts match', async () => {
    const original = input('-reuse-identity');
    original.payload.invoices = original.payload.invoices.filter((row) => row.kind === 'Customer invoice');
    original.payload.invoices[0].linkedInvoiceNumber = null;
    const first = await confirm(original),
      caseId = first.result.cases[0].caseId;
    const prior = await prisma.reconciliationCase.findUniqueOrThrow({ where: { id: caseId } });
    const opaque = { ...(prior.sourceSnapshot as object), oldOpaque: { keep: 'invented immutable source' } };
    await prisma.reconciliationCase.update({
      where: { id: caseId },
      data: { sourceSnapshot: opaque, snapshotHash: reconciliationHash(opaque) },
    });
    const changed = input('-reuse-identity'),
      share = changed.payload.invoices[1];
    await core.updateCase(
      companyId,
      projectId,
      caseId,
      {
        agreedGrossMinor: 4600,
        agreedNetMinor: 4000,
        agreedVatMinor: 600,
        agreementReference: `Ledgerly project invented-source-project; row ${share.id}; invoice ${share.number}`,
      },
      await context(),
    );
    const p = await preview(changed);
    expect(p.proposedCases[0].action).toBe('REVISION');
    expect(p.errors.some((issue) => issue.code === 'IMPORT_SOURCE_REVISION')).toBe(true);
    const old = await state();
    await expect(
      core.confirmImport(companyId, projectId, { ...changed, previewHash: p.previewHash }, await context()),
    ).rejects.toMatchObject({ response: { code: 'IMPORT_REVIEW_REQUIRED' } });
    expect(await state()).toEqual(old);
    expect(
      (await prisma.reconciliationCase.findUniqueOrThrow({ where: { id: caseId } })).sourceSnapshot,
    ).toEqual(opaque);
    const secondProject = await project(),
      other = input('-other-identity');
    other.payload.invoices[1].id = share.id;
    const second = await confirm(other, secondProject);
    expect(second.result.cases).toHaveLength(1);
    expect(
      (await preview(changed)).errors.some((issue) => issue.code === 'IMPORT_SOURCE_IDENTITY_CONFLICT'),
    ).toBe(true);
    const rebound = structuredClone(other);
    rebound.payload.invoices[1].id = 'invented-rebound-share';
    await core.updateCase(
      companyId,
      secondProject,
      second.result.cases[0].caseId,
      {
        agreementReference:
          'Ledgerly project invented-source-project; row invented-rebound-share; invoice EX-SHARE-other-identity',
      },
      await context(secondProject),
    );
    expect((await preview(rebound, secondProject)).proposedCases[0].action).toBe('REVISION');
  });
  it('allows current-facts matching on REUSE when original share identity stays unchanged', async () => {
    const data = input('-known-share');
    const saved = await confirm(data),
      caseId = saved.result.cases[0].caseId;
    const old = await prisma.reconciliationCase.findUniqueOrThrow({ where: { id: caseId } });
    data.payload.invoices[1].exGstAmountCents = 5000;
    data.payload.invoices[1].gstAmountCents = 750;
    data.payload.invoices[1].totalCents = 5750;
    await core.updateCase(
      companyId,
      projectId,
      caseId,
      { agreedGrossMinor: 5750, agreedNetMinor: 5000, agreedVatMinor: 750 },
      await context(),
    );
    const p = await preview(data);
    expect(p.errors).toEqual([]);
    expect(p.proposedCases[0].action).toBe('REUSE');
    await confirm(data);
    const after = await prisma.reconciliationCase.findUniqueOrThrow({ where: { id: caseId } });
    expect(after.sourceSnapshot).toEqual(old.sourceSnapshot);
    expect(after.snapshotHash).toBe(old.snapshotHash);
  });
  it('requires explicit contextual candidate choice and keeps canonical own amount/status authoritative', async () => {
    const data = input('-own');
    const doc = await own('EX-SHARE-own');
    const p = await preview(data);
    expect(p.proposedLinks[0].candidates.map((x) => x.documentId)).toContain(doc.id);
    expect(p.proposedLinks[0].selectedMatch).toBeNull();
    data.selectedMatches = [
      {
        sourceId: 'invented-share-own',
        caseSourceId: 'invented-customer-own',
        documentId: doc.id,
        typeId: 'invoice',
      },
    ];
    const old = await canonical();
    const result = await confirm(data);
    expect(result.result.links).toHaveLength(1);
    expect(await canonical()).toEqual(old);
    const same = await confirm(data);
    expect(same.result.links[0].linkId).toBe(result.result.links[0].linkId);
    expect((await prisma.documentInstance.findUniqueOrThrow({ where: { id: doc.id } })).status).toBe('sent');
    expect(
      (await core.getProject(companyId, projectId)).exceptions.some(
        (x) => x.code === 'SETTLEMENT_DIFFERENCE',
      ),
    ).toBe(true);
  });
  it('links COMPANY customer once and COMPANY share as partner bill without external references', async () => {
    projectId = await project('COMPANY');
    const data = input('-company', 'COMPANY');
    const customer = await own('EX-CUSTOMER-company', 'invoice', customerId),
      share = await own('EX-SHARE-company', 'received-invoice');
    data.selectedMatches = [
      {
        sourceId: 'invented-customer-company',
        caseSourceId: 'invented-customer-company',
        documentId: customer.id,
        typeId: 'invoice',
      },
      {
        sourceId: 'invented-share-company',
        caseSourceId: 'invented-customer-company',
        documentId: share.id,
        typeId: 'received-invoice',
      },
    ];
    const old = await canonical();
    const saved = await confirm(data);
    expect(saved.result.references).toEqual([]);
    expect(saved.result.links).toHaveLength(2);
    const refs = await prisma.customerInvoiceReference.findMany({ where: { companyId, projectId } });
    expect(refs).toHaveLength(1);
    expect(refs[0]).toMatchObject({ source: null, externalId: null, issuer: null, originalGrossMinor: null });
    expect(await canonical()).toEqual(old);
  });
  it('discloses strict COMPANY historical customer facts beside authoritative canonical candidates', async () => {
    projectId = await project('COMPANY');
    const data = input('-company-history', 'COMPANY');
    Object.assign(data.payload.invoices[0], {
      exGstAmountCents: 900000,
      gstAmountCents: 87654,
      totalCents: 987654,
      status: 'Needs review',
      issueDate: '2026-03-02',
      dueDate: '2026-04-02',
    });
    const customer = await own('EX-CUSTOMER-company-history', 'invoice', customerId);
    data.selectedMatches = [
      {
        sourceId: 'invented-customer-company-history',
        caseSourceId: 'invented-customer-company-history',
        documentId: customer.id,
        typeId: 'invoice',
      },
    ];
    const old = await canonical(),
      p = await preview(data),
      proposal = p.proposedLinks.find((link) => link.role === 'CUSTOMER_INVOICE')!;
    expect(p.proposedReferences).toEqual([]);
    expect(p.errors).toEqual([]);
    expect(proposal.historical).toMatchObject({
      number: 'EX-CUSTOMER-company-history',
      currency: 'NZD',
      grossMinor: 987654,
      netMinor: 900000,
      vatMinor: 87654,
      reportedStatus: 'Needs review',
      issueDate: '2026-03-02',
      dueDate: '2026-04-02',
      sourceSystem: 'ledgerly',
      sourceId: 'invented-customer-company-history',
    });
    expect(proposal.candidates[0].financial).toMatchObject({
      documentId: customer.id,
      status: 'sent',
      grossMinor: 8700,
    });
    parse(schemas.importLinkProposal, proposal);
    await confirm(data);
    expect(await canonical()).toEqual(old);
    const ref = await prisma.customerInvoiceReference.findFirstOrThrow({ where: { companyId, projectId } });
    expect(ref).toMatchObject({
      collectionMode: 'COMPANY',
      issuer: null,
      recipient: null,
      originalGrossMinor: null,
      source: null,
      externalId: null,
    });
  });
  it('rejects missing membership, unpaired/ambiguous source anchors and invalid source splits atomically', async () => {
    for (const variant of ['membership', 'unpaired', 'split', 'duplicate'] as const) {
      const data = input(`-${variant}`);
      if (variant === 'membership') data.payload.invoices[1].projectId = null;
      if (variant === 'unpaired') {
        data.payload.invoices[1].sourceNumber = data.payload.invoices[1].number;
        data.payload.invoices[1].linkedInvoiceNumber = null;
        data.payload.invoices[0].linkedInvoiceNumber = null;
      }
      if (variant === 'split') data.payload.invoices[1].totalCents++;
      if (variant === 'duplicate') data.payload.invoices.push({ ...data.payload.invoices[0] });
      const p = await preview(data);
      expect([...p.errors, ...p.unresolved].some((x) => x.blocking)).toBe(true);
      const old = await state();
      await expect(
        core.confirmImport(companyId, projectId, { ...data, previewHash: p.previewHash }, await context()),
      ).rejects.toBeDefined();
      expect(await state()).toEqual(old);
    }
  });
  it('rejects selected IDs that violate role, recipient, currency, source or case binding', async () => {
    const wrongParty = await own('EX-SHARE-invalid', 'invoice', customerId),
      wrongCurrency = await own('EX-SHARE-invalid', 'invoice', partnerId, 'EUR');
    for (const selection of [
      {
        sourceId: 'invented-share-invalid',
        caseSourceId: 'invented-customer-invalid',
        documentId: wrongParty.id,
        typeId: 'invoice' as const,
      },
      {
        sourceId: 'invented-share-invalid',
        caseSourceId: 'invented-customer-invalid',
        documentId: wrongCurrency.id,
        typeId: 'invoice' as const,
      },
      {
        sourceId: 'invented-share-invalid',
        caseSourceId: 'different',
        documentId: wrongParty.id,
        typeId: 'invoice' as const,
      },
      {
        sourceId: 'missing',
        caseSourceId: 'invented-customer-invalid',
        documentId: 'missing',
        typeId: 'expense' as const,
      },
    ]) {
      const data = input('-invalid');
      data.selectedMatches = [selection];
      const p = await preview(data);
      expect(p.errors.length).toBeGreaterThan(0);
      const old = await state();
      await expect(
        core.confirmImport(companyId, projectId, { ...data, previewHash: p.previewHash }, await context()),
      ).rejects.toBeDefined();
      expect(await state()).toEqual(old);
    }
  });
  it('keeps foreign company targets and historical IDs out of live own document associations', async () => {
    const foreign = (
      await prisma.company.create({
        data: {
          name: 'Invented foreign importer',
          foundedAt: new Date('2020-01-01'),
          address: '2 Invented St',
          postalCode: '1010',
          city: 'Auckland',
          country: 'New Zealand',
          countryCode: 'NZ',
          phone: '+6400000000',
          email: `${randomUUID()}@example.test`,
        },
      })
    ).id;
    try {
      const foreignDoc = await prisma.documentInstance.create({
        data: {
          companyId: foreign,
          typeId: 'invoice',
          status: 'sent',
          displayNumber: 'EX-SHARE-foreign',
          data: { currency: 'NZD', client: partnerId, lines: [{ quantity: 1, unitPrice: 1, vatRate: '0' }] },
        },
      });
      const foreignProject = (
        await core.createProject(
          foreign,
          {
            name: 'Invented foreign project',
            endCustomerName: 'Invented customer',
            currency: 'NZD',
            collectionMode: 'COMPANY',
            endCustomerClientId: null,
            partnerClientId: null,
            timeProjectId: null,
            description: null,
          },
          { actor, requestKey: randomUUID(), expectedVersion: 'new' },
        )
      ).result.id;
      const data = input('-foreign');
      data.selectedMatches = [
        {
          sourceId: 'invented-share-foreign',
          caseSourceId: 'invented-customer-foreign',
          documentId: foreignDoc.id,
          typeId: 'invoice',
        },
      ];
      const p = await preview(data);
      expect(p.errors.some((issue) => issue.code === 'IMPORT_INVALID_SELECTION')).toBe(true);
      expect(
        p.proposedLinks
          .flatMap((link) => link.candidates)
          .some((candidate) => candidate.documentId === foreignDoc.id),
      ).toBe(false);
      await expect(preview(data, foreignProject)).rejects.toMatchObject({ status: 404 });
      const old = await state();
      await expect(
        core.confirmImport(companyId, projectId, { ...data, previewHash: p.previewHash }, await context()),
      ).rejects.toBeDefined();
      expect(await state()).toEqual(old);
      const ownDoc = await own('EX-UNRELATED-NUMBER');
      const historical = input('-historical-id');
      historical.payload.invoices[1].id = ownDoc.id;
      const saved = await confirm(historical);
      expect(saved.result.links).toEqual([]);
      expect(await prisma.projectDocumentLink.count({ where: { companyId, projectId } })).toBe(0);
      expect(await prisma.documentInstance.findUnique({ where: { id: foreignDoc.id } })).not.toBeNull();
    } finally {
      await prisma.$transaction(async (tx) => {
        await purgeReconciliationForCompany(tx, foreign);
        await tx.company.delete({ where: { id: foreign } });
      });
    }
  });
  it('invalidates preview on unlinked nonselected candidate payments, credits, candidate membership and party state', async () => {
    for (const change of ['payment', 'credit', 'membership', 'company', 'party'] as const) {
      const data = input(`-stale-${change}`);
      const doc = await own(`EX-SHARE-stale-${change}`);
      const p = await preview(data),
        ctx = await context();
      if (change === 'payment')
        await prisma.documentPayment.create({
          data: {
            companyId,
            documentId: doc.id,
            amountMinor: 100,
            documentAmountMinor: 100,
            currency: 'NZD',
            paidAt: new Date('2026-11-01'),
          },
        });
      if (change === 'credit')
        await prisma.documentInstance.create({
          data: {
            companyId,
            typeId: 'credit-note',
            status: 'draft',
            data: { invoice: doc.id, currency: 'NZD' },
          },
        });
      if (change === 'membership') await own(`EX-SHARE-stale-${change}`);
      if (change === 'company')
        await prisma.company.update({ where: { id: companyId }, data: { name: 'Invented changed company' } });
      if (change === 'party')
        await prisma.client.update({ where: { id: partnerId }, data: { name: 'Invented changed partner' } });
      const old = await state(),
        financial = await canonical();
      await expect(
        core.confirmImport(companyId, projectId, { ...data, previewHash: p.previewHash }, ctx),
      ).rejects.toMatchObject({ response: { code: 'IMPORT_PREVIEW_STALE' } });
      expect(await state()).toEqual(old);
      expect(await canonical()).toEqual(financial);
    }
  });
  it('takes the initial company lock and sorted candidate locks after a concurrent payment writer', async () => {
    const data = input('-locked-candidate');
    const selected = await own('EX-SHARE-locked-candidate');
    const candidate = await own('EX-SHARE-locked-candidate');
    data.selectedMatches = [
      {
        sourceId: 'invented-share-locked-candidate',
        caseSourceId: 'invented-customer-locked-candidate',
        documentId: selected.id,
        typeId: 'invoice',
      },
    ];
    const p = await preview(data),
      ctx = await context(),
      before = await state();
    let writerReady!: () => void, releaseWriter!: () => void, lockAttempt!: () => void;
    const ready = new Promise<void>((r) => {
        writerReady = r;
      }),
      release = new Promise<void>((r) => {
        releaseWriter = r;
      }),
      attempted = new Promise<void>((r) => {
        lockAttempt = r;
      });
    const pids = new Set<number>(),
      locked: string[] = [];
    const writer = prisma.$transaction(async (tx) => {
      const [pid] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      pids.add(pid.pid);
      await tx.$queryRaw`SELECT id FROM "DocumentInstance" WHERE id=${candidate.id} FOR UPDATE`;
      await tx.documentPayment.create({
        data: {
          companyId,
          documentId: candidate.id,
          amountMinor: 100,
          documentAmountMinor: 80,
          currency: 'EUR',
          paidAt: new Date('2026-11-01'),
        },
      });
      writerReady();
      await release;
    });
    await ready;
    const db = new Proxy(prisma, {
      get(target, key) {
        if (key !== '$transaction') return Reflect.get(target, key);
        return (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          target.$transaction(async (tx) => {
            const [pid] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            pids.add(pid.pid);
            return run(
              new Proxy(tx, {
                get(t, k) {
                  if (k !== '$queryRaw') return Reflect.get(t, k);
                  return (...args: unknown[]) => {
                    const sql = (args[0] as TemplateStringsArray).join('?');
                    if (sql.includes('Company') && sql.includes('FOR UPDATE')) lockAttempt();
                    if (sql.includes('DocumentInstance') && sql.includes('FOR UPDATE'))
                      locked.push(args[2] as string);
                    return Reflect.apply(t.$queryRaw, t, args);
                  };
                },
              }),
            );
          });
      },
    });
    const confirming = new ReconciliationService(new FinancialReadService(), db).confirmImport(
      companyId,
      projectId,
      { ...data, previewHash: p.previewHash },
      ctx,
    );
    const outcome = expect(confirming).rejects.toMatchObject({ response: { code: 'IMPORT_PREVIEW_STALE' } });
    await attempted;
    releaseWriter();
    await writer;
    await outcome;
    expect(pids.size).toBe(2);
    expect(locked).toContain(selected.id);
    expect(locked).toContain(candidate.id);
    expect(locked).toEqual([...locked].sort());
    expect(await state()).toEqual(before);
  });
  it.each(['status-selected', 'status-unselected', 'membership-unselected', 'insert-unselected'] as const)(
    'serializes credit input race after preview recomputation: %s',
    async (mode) => {
      const data = input(`-credit-race-${mode}`),
        selected = await own(`EX-SHARE-credit-race-${mode}`);
      const candidate = mode === 'status-selected' ? selected : await own(`EX-SHARE-credit-race-${mode}`);
      const unrelated = await own(`UNRELATED-credit-race-${mode}`);
      data.selectedMatches = [
        {
          sourceId: `invented-share-credit-race-${mode}`,
          caseSourceId: `invented-customer-credit-race-${mode}`,
          documentId: selected.id,
          typeId: 'invoice',
        },
      ];
      const note =
        mode === 'insert-unselected'
          ? null
          : await prisma.documentInstance.create({
              data: {
                companyId,
                typeId: 'credit-note',
                status: 'sending',
                data: {
                  invoice: mode === 'membership-unselected' ? unrelated.id : candidate.id,
                  currency: 'NZD',
                  correctedLines: ['invented-line'],
                },
              },
            });
      const p = await preview(data),
        ctx = await context();
      let pause!: () => void, resume!: () => void;
      const paused = new Promise<void>((r) => {
          pause = r;
        }),
        released = new Promise<void>((r) => {
          resume = r;
        });
      let importerPid = 0;
      const locked: string[] = [];
      const db = new Proxy(prisma, {
        get(target, key) {
          if (key !== '$transaction') return Reflect.get(target, key);
          return (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
            target.$transaction(async (tx) => {
              const [pid] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
              importerPid = pid.pid;
              return run(
                new Proxy(tx, {
                  get(t, k) {
                    if (k === 'reconciliationCase')
                      return new Proxy(t.reconciliationCase, {
                        get(delegate, op) {
                          if (op !== 'create') return Reflect.get(delegate, op);
                          return async (args: Parameters<typeof delegate.create>[0]) => {
                            pause();
                            await released;
                            return delegate.create(args);
                          };
                        },
                      });
                    if (k === '$queryRaw')
                      return (...args: unknown[]) => {
                        const sql = (args[0] as TemplateStringsArray).join('?');
                        if (sql.includes('DocumentInstance') && sql.includes('FOR UPDATE'))
                          locked.push(args[2] as string);
                        return Reflect.apply(t.$queryRaw, t, args);
                      };
                    return Reflect.get(t, k);
                  },
                }),
              );
            });
        },
      });
      const confirmation = new ReconciliationService(new FinancialReadService(), db).confirmImport(
        companyId,
        projectId,
        { ...data, previewHash: p.previewHash },
        ctx,
      );
      const confirmed = confirmation.then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason) => ({ status: 'rejected' as const, reason }),
      );
      await paused;
      let writerDone = false;
      const writing =
        mode === 'insert-unselected'
          ? prisma.documentInstance.create({
              data: {
                companyId,
                typeId: 'credit-note',
                status: 'sent',
                data: { invoice: candidate.id, currency: 'NZD', correctedLines: ['invented-line'] },
              },
            })
          : mode === 'membership-unselected'
            ? upsertDocument(companyId, 'credit-note', note!.id, 'sending', {
                invoice: candidate.id,
                currency: 'NZD',
                correctedLines: ['invented-line'],
              })
            : updateDocumentStatus(companyId, 'credit-note', note!.id, 'sent');
      const written = Promise.resolve(writing).then(
        (value) => {
          writerDone = true;
          return { status: 'fulfilled' as const, value };
        },
        (reason) => {
          writerDone = true;
          return { status: 'rejected' as const, reason };
        },
      );
      let writerPid: number | null = null;
      try {
        const deadline = Date.now() + 2000;
        while (!writerDone && Date.now() < deadline) {
          const waiting = await prisma.$queryRaw<
            Array<{ pid: number }>
          >`SELECT pid FROM pg_stat_activity WHERE ${importerPid}=ANY(pg_blocking_pids(pid))`;
          if (waiting.length) {
            writerPid = waiting[0].pid;
            break;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 5));
        }
      } finally {
        resume();
      }
      const [importResult, writerResult] = await Promise.all([confirmed, written]);
      expect(writerPid, 'canonical writer must block behind the checked import snapshot').not.toBeNull();
      expect(writerPid).not.toBe(importerPid);
      expect(importResult.status).toBe('fulfilled');
      expect(writerResult.status).toBe('fulfilled');
      expect(locked).toContain(selected.id);
      expect(locked).toContain(candidate.id);
      if (note) expect(locked).toContain(note.id);
      if (candidate.id !== selected.id)
        expect(
          await prisma.projectDocumentLink.count({ where: { companyId, documentId: candidate.id } }),
        ).toBe(0);
      expect(locked).toEqual([...locked].sort());
      if (writerResult.status === 'fulfilled') {
        const after = await prisma.documentInstance.findUniqueOrThrow({
          where: { id: writerResult.value.id },
        });
        expect(after.status).toBe(mode === 'membership-unselected' ? 'sending' : 'sent');
        expect((after.data as { invoice: string }).invoice).toBe(candidate.id);
        const latest = await prisma.$transaction((tx) =>
          core.financialRead.readMany(companyId, [{ id: candidate.id, typeId: 'invoice' }], tx),
        );
        const beforeRead = p.proposedLinks[0].candidates.find(
          (value) => value.documentId === candidate.id,
        )!.financial;
        expect(latest.get(`invoice:${candidate.id}`)!.sourceVersion).not.toBe(beforeRead.sourceVersion);
        expect(latest.get(`invoice:${candidate.id}`)!.settlement!.creditedMinor).toBe(
          mode === 'membership-unselected' ? 0 : 8700,
        );
      }
    },
    10000,
  );
  it('rolls all rows back if the single root audit insert fails', async () => {
    const data = input('-rollback'),
      p = await preview(data),
      ctx = await context(),
      old = await state();
    const db = new Proxy(prisma, {
      get(target, key) {
        if (key !== '$transaction') return Reflect.get(target, key);
        return (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          target.$transaction((tx) =>
            run(
              new Proxy(tx, {
                get(t, k) {
                  if (k !== 'reconciliationAuditEvent') return Reflect.get(t, k);
                  return new Proxy(t.reconciliationAuditEvent, {
                    get(a, op) {
                      if (op === 'create')
                        return () => {
                          throw new Error('invented audit failure');
                        };
                      return Reflect.get(a, op);
                    },
                  });
                },
              }),
            ),
          );
      },
    });
    const failing = new ReconciliationService(new FinancialReadService(), db);
    await expect(
      failing.confirmImport(companyId, projectId, { ...data, previewHash: p.previewHash }, ctx),
    ).rejects.toThrow('invented audit failure');
    expect(await state()).toEqual(old);
  });
  it('blocks share identity already claimed by an external source tuple without importer metadata', async () => {
    const data = input('-legacy-source');
    const existing = (
      await core.createCase(
        companyId,
        projectId,
        {
          title: 'Invented manually reviewed case',
          periodStart: null,
          periodEnd: null,
          agreedGrossMinor: null,
          agreedNetMinor: null,
          agreedVatMinor: null,
          agreementReference: null,
        },
        await context(),
      )
    ).result;
    await new ExternalReceiptsService(core).saveExternalInvoice(
      companyId,
      projectId,
      {
        caseId: existing.id,
        issuer: 'Invented partner',
        recipient: 'Invented customer',
        number: 'EX-LEGACY-REFERENCE',
        issueDate: null,
        dueDate: null,
        currency: 'NZD',
        grossMinor: 100,
        netMinor: null,
        vatMinor: null,
        reportedStatus: null,
        sourceSystem: 'ledgerly',
        sourceId: data.payload.invoices[1].id,
        sourceAsOf: null,
        sourceReference: 'Invented existing source claim',
      },
      await context(),
    );
    const p = await preview(data);
    expect(p.errors.some((issue) => issue.code === 'IMPORT_SOURCE_IDENTITY_CONFLICT')).toBe(true);
    const old = await state();
    await expect(
      core.confirmImport(companyId, projectId, { ...data, previewHash: p.previewHash }, await context()),
    ).rejects.toMatchObject({ status: 409 });
    expect(await state()).toEqual(old);
  });
  it('serializes cross-project raw share identity and exact retries on distinct real connections', async () => {
    const second = await project();
    const a = input('-race-a'),
      b = input('-race-b');
    b.payload.invoices[1].id = a.payload.invoices[1].id;
    const pa = await preview(a),
      pb = await preview(b, second),
      ca = await context(),
      cb = await context(second);
    const pids = new Set<number>();
    let arrivals = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const db = new Proxy(prisma, {
      get(target, key) {
        if (key !== '$transaction') return Reflect.get(target, key);
        return (run: (tx: Prisma.TransactionClient) => Promise<unknown>) =>
          target.$transaction(async (tx) => {
            const [pid] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
            pids.add(pid.pid);
            if (++arrivals === 2) release();
            await gate;
            return run(tx);
          });
      },
    });
    const racing = new ReconciliationService(new FinancialReadService(), db);
    const results = await Promise.allSettled([
      racing.confirmImport(companyId, projectId, { ...a, previewHash: pa.previewHash }, ca),
      racing.confirmImport(companyId, second, { ...b, previewHash: pb.previewHash }, cb),
    ]);
    expect(pids.size).toBe(2);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    const retryData = input('-concurrent-retry'),
      pp = await preview(retryData),
      cc = await context();
    const body = { ...retryData, previewHash: pp.previewHash };
    const both = await Promise.all([
      racing.confirmImport(companyId, projectId, body, cc),
      racing.confirmImport(companyId, projectId, body, cc),
    ]);
    expect(both.map((x) => x.changed).sort()).toEqual([false, true]);
    expect(both[0].result).toEqual(both[1].result);
  });
  it('confirms the complete 1000-row boundary without truncation', async () => {
    const data = input('-limit');
    data.payload.invoices = [];
    for (let i = 0; i < 500; i++) data.payload.invoices.push(...input(`-limit-${i}`).payload.invoices);
    const p = await preview(data);
    expect(p.counts.sourceRows).toBe(1000);
    expect(p.proposedCases).toHaveLength(500);
    const old = await canonical();
    const saved = await core.confirmImport(
      companyId,
      projectId,
      { ...data, previewHash: p.previewHash },
      await context(),
    );
    expect(saved.result.cases).toHaveLength(500);
    expect(saved.result.references).toHaveLength(500);
    expect(
      await prisma.reconciliationAuditEvent.count({
        where: { companyId, projectId, operation: 'import.confirm' },
      }),
    ).toBe(1);
    expect(await canonical()).toEqual(old);
  }, 15000);
});
