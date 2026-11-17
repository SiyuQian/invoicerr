import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import prisma from '@/prisma/prisma.service';
import { AuthGuard } from '@/guards/auth.guard';
import { RolesGuard } from '@/guards/roles.guard';
import { generateApiKey, hashApiKey } from '@/utils/api-key';
import { sessionCache } from '@/lib/session-cache';
import { ProjectReconciliationModule } from './module';
import { purgeReconciliationForCompany } from './persistence';
import { parse, schemas } from './validation';
import { FinancialReadService } from '../documents/settlement/financial-read.service';

describe('document-links and review authenticated HTTP', () => {
  let app: INestApplication, base: string, companyId: string, partnerId: string;
  const users: string[] = [],
    keys: Record<string, string> = {};
  async function http(path: string, method = 'GET', body?: unknown, role = 'OWNER') {
    const response = await fetch(`${base}/api/project-reconciliation/${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(role ? { 'x-api-key': keys[role] } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  beforeAll(async () => {
    companyId = (
      await prisma.company.create({
        data: {
          name: 'Invented HTTP receipts',
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
      await prisma.client.create({ data: { companyId, name: 'Invented collector', country: 'New Zealand' } })
    ).id;
    for (const role of ['OWNER', 'MEMBER'] as const) {
      const id = randomUUID();
      users.push(id);
      await prisma.user.create({
        data: { id, email: `${id}@example.test`, firstname: 'Invented', lastname: role, emailVerified: true },
      });
      await prisma.userCompany.create({ data: { userId: id, companyId, role } });
      keys[role] = generateApiKey();
      await prisma.apiKey.create({
        data: {
          name: 'Invented receipt key',
          keyPrefix: keys[role].slice(0, 12),
          keyHash: hashApiKey(keys[role]),
          companyId,
          userId: id,
          scopes: [
            'project-reconciliation:write',
            'invoices:read',
            'credit-notes:read',
            'expenses:read',
            'received-invoices:read',
          ],
        },
      });
    }
    const mod = await Test.createTestingModule({
      imports: [ProjectReconciliationModule],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = mod.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  });
  afterAll(async () => {
    if (app) await app.close();
    if (companyId)
      await prisma.$transaction(async (tx) => {
        await purgeReconciliationForCompany(tx, companyId);
        await tx.company.delete({ where: { id: companyId } });
      });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await sessionCache.close();
  });
  it('authenticates all T5 routes, preserves strict inputs and returns auditable retry results', async () => {
    const create = await http('projects', 'POST', {
      name: 'Invented direct work',
      endCustomerName: 'Invented customer',
      currency: 'NZD',
      collectionMode: 'COMPANY',
      endCustomerClientId: partnerId,
      partnerClientId: null,
      timeProjectId: null,
      description: null,
      requestKey: randomUUID(),
      expectedVersion: 'new',
    });
    const id = create.body.result.id,
      prefix = `projects/${id}`;
    const stage = await http(`${prefix}/cases`, 'POST', {
      title: 'Invented stage',
      periodStart: null,
      periodEnd: null,
      agreedGrossMinor: null,
      agreedNetMinor: null,
      agreedVatMinor: null,
      agreementReference: null,
      requestKey: randomUUID(),
      expectedVersion: create.body.versionToken,
    });
    const caseId = stage.body.result.id;
    const document = await prisma.documentInstance.create({
      data: {
        companyId,
        typeId: 'invoice',
        status: 'sent',
        data: { currency: 'NZD', client: partnerId, lines: [{ quantity: 1, unitPrice: 1, vatRate: '0' }] },
      },
    });
    await prisma.documentPayment.create({
      data: {
        companyId,
        documentId: document.id,
        amountMinor: 100,
        documentAmountMinor: 100,
        currency: 'NZD',
        paidAt: new Date('2026-11-01'),
      },
    });
    const path = `${prefix}/document-links`;
    const body = {
      documentId: document.id,
      typeId: 'invoice',
      caseId,
      role: 'CUSTOMER_INVOICE',
      requestKey: randomUUID(),
      expectedVersion: stage.body.versionToken,
    };
    expect((await http(path, 'POST', body, '')).status).toBe(401);
    expect((await http(path, 'POST', body, 'MEMBER')).status).toBe(403);
    expect((await http(path, 'POST', { ...body, actor: 'forged' })).status).toBe(400);
    expect((await http(path, 'POST', { ...body, sourceFingerprint: 'forged' })).status).toBe(400);
    const linked = await http(path, 'POST', body);
    expect(linked.status).toBe(201);
    parse(schemas.documentLink, linked.body.result);
    const retry = await http(path, 'POST', body);
    expect(retry.status).toBe(200);
    expect(retry.body.result).toEqual(linked.body.result);
    const decision = {
      mode: 'VERIFY',
      exceptions: [],
      reason: 'Checked direct work',
      requestKey: randomUUID(),
      expectedVersion: linked.body.versionToken,
    };
    const reviewed = await http(`${prefix}/cases/${caseId}/review`, 'POST', decision);
    expect(reviewed.status).toBe(201);
    parse(schemas.reviewResult, reviewed.body.result);
    expect(reviewed.body.result.case.status).toBe('CLOSED_VERIFIED');
    expect((await http(`${prefix}/cases/${caseId}/review`, 'POST', decision)).body.result).toEqual(
      reviewed.body.result,
    );
    const unlinked = await http(`${path}/${linked.body.result.id}/unlink`, 'POST', {
      reason: 'Correct relationship',
      requestKey: randomUUID(),
      expectedVersion: reviewed.body.versionToken,
    });
    expect(unlinked.status).toBe(201);
    expect(unlinked.body.result).toEqual(linked.body.result);
    expect((await http(`${prefix}`)).body.cases.items[0].status).toBe('OPEN');
    const partner = await http('projects', 'POST', {
      name: 'Invented collection',
      endCustomerName: 'Invented customer',
      currency: 'NZD',
      collectionMode: 'PARTNER',
      endCustomerClientId: null,
      partnerClientId: partnerId,
      timeProjectId: null,
      description: null,
      requestKey: randomUUID(),
      expectedVersion: 'new',
    });
    const pid = partner.body.result.id,
      pp = `projects/${pid}`;
    const pc = await http(`${pp}/cases`, 'POST', {
      title: 'Invented stage',
      periodStart: null,
      periodEnd: null,
      agreedGrossMinor: null,
      agreedNetMinor: null,
      agreedVatMinor: null,
      agreementReference: null,
      requestKey: randomUUID(),
      expectedVersion: partner.body.versionToken,
    });
    const inv = await http(`${pp}/cases/${pc.body.result.id}/customer-invoices`, 'POST', {
      issuer: 'Invented collector',
      recipient: 'Invented customer',
      number: 'Invented-1',
      issueDate: null,
      dueDate: null,
      currency: 'NZD',
      grossMinor: 100,
      netMinor: null,
      vatMinor: null,
      reportedStatus: 'Paid',
      sourceSystem: null,
      sourceId: null,
      sourceAsOf: null,
      sourceReference: 'Invented export',
      requestKey: randomUUID(),
      expectedVersion: pc.body.versionToken,
    });
    const coverage = {
      customerInvoiceIds: [inv.body.result.id],
      sourceAsOf: '2026-11-10T00:00:00Z',
      evidenceReference: 'Invented reviewed set',
      attested: true,
      requestKey: randomUUID(),
      expectedVersion: inv.body.versionToken,
    };
    expect((await http(`${pp}/evidence-coverage`, 'POST', { ...coverage, attested: false })).status).toBe(
      400,
    );
    const covered = await http(`${pp}/evidence-coverage`, 'POST', coverage);
    expect(covered.status).toBe(201);
    parse(schemas.coverageResult, covered.body.result);
    expect((await http(`${pp}/evidence-coverage`, 'POST', coverage)).body.result).toEqual(
      covered.body.result,
    );
  });
  it('returns the stable503 candidate-outage response without saving a first link', async () => {
    const created = await http('projects', 'POST', {
      name: 'Invented candidate outage',
      endCustomerName: 'Invented customer',
      currency: 'NZD',
      collectionMode: 'COMPANY',
      endCustomerClientId: partnerId,
      partnerClientId: null,
      timeProjectId: null,
      description: null,
      requestKey: randomUUID(),
      expectedVersion: 'new',
    });
    expect(created.status).toBe(201);
    const id = created.body.result.id,
      prefix = `projects/${id}`;
    const stage = await http(`${prefix}/cases`, 'POST', {
      title: 'Invented outage stage',
      periodStart: null,
      periodEnd: null,
      agreedGrossMinor: null,
      agreedNetMinor: null,
      agreedVatMinor: null,
      agreementReference: null,
      requestKey: randomUUID(),
      expectedVersion: created.body.versionToken,
    });
    expect(stage.status).toBe(201);
    const document = await prisma.documentInstance.create({
      data: {
        companyId,
        typeId: 'invoice',
        status: 'sent',
        data: { currency: 'NZD', client: partnerId, lines: [{ quantity: 1, unitPrice: 1, vatRate: '0' }] },
      },
    });
    const beforeProject = await prisma.reconciliationProject.findUniqueOrThrow({ where: { id } });
    const beforeAudit = await prisma.reconciliationAuditEvent.findMany({
      where: { companyId, projectId: id },
      orderBy: { id: 'asc' },
    });
    const financial = app.get(FinancialReadService);
    const original = financial.readMany;
    financial.readMany = async (company, refs, tx) => {
      if (refs.some((ref) => ref.id === document.id)) throw new Error('Invented HTTP candidate-only outage');
      return original.call(financial, company, refs, tx);
    };
    try {
      const failed = await http(`${prefix}/document-links`, 'POST', {
        documentId: document.id,
        typeId: 'invoice',
        caseId: stage.body.result.id,
        role: 'CUSTOMER_INVOICE',
        requestKey: randomUUID(),
        expectedVersion: stage.body.versionToken,
      });
      expect(failed.status).toBe(503);
      expect(failed.body.code).toBe('FINANCIAL_READ_UNAVAILABLE');
      expect(await prisma.projectDocumentLink.count({ where: { companyId, projectId: id } })).toBe(0);
      expect(await prisma.customerInvoiceReference.count({ where: { companyId, projectId: id } })).toBe(0);
      expect(await prisma.reconciliationProject.findUniqueOrThrow({ where: { id } })).toEqual(beforeProject);
      expect(
        await prisma.reconciliationAuditEvent.findMany({
          where: { companyId, projectId: id },
          orderBy: { id: 'asc' },
        }),
      ).toEqual(beforeAudit);
      expect(await prisma.documentInstance.findUniqueOrThrow({ where: { id: document.id } })).toEqual(
        document,
      );
      expect(await prisma.documentPayment.count({ where: { companyId, documentId: document.id } })).toBe(0);
    } finally {
      financial.readMany = original;
    }
  });
});
