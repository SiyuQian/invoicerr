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

describe('external-receipts authenticated HTTP', () => {
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
  it('executes all T4 routes with envelope statuses and strict bodies; rejects anonymous and member writes', async () => {
    const project = await http('projects', 'POST', {
      name: 'Invented HTTP project',
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
    expect(project.status).toBe(201);
    const id = project.body.result.id,
      prefix = `projects/${id}`;
    let version = project.body.versionToken;
    const stage = await http(`${prefix}/cases`, 'POST', {
      title: 'Invented case',
      periodStart: null,
      periodEnd: null,
      agreedGrossMinor: null,
      agreedNetMinor: null,
      agreedVatMinor: null,
      agreementReference: null,
      requestKey: randomUUID(),
      expectedVersion: version,
    });
    expect(stage.status).toBe(201);
    version = stage.body.versionToken;
    const invoicePath = `${prefix}/cases/${stage.body.result.id}/customer-invoices`;
    const create = {
      issuer: 'Invented collector',
      recipient: 'Invented customer',
      number: 'HTTP-EXAMPLE',
      issueDate: null,
      dueDate: null,
      currency: 'NZD',
      grossMinor: 230000,
      netMinor: null,
      vatMinor: null,
      reportedStatus: 'Paid',
      sourceSystem: null,
      sourceId: null,
      sourceAsOf: null,
      sourceReference: 'Invented export',
      requestKey: randomUUID(),
      expectedVersion: version,
    };
    expect((await http(invoicePath, 'POST', create, '')).status).toBe(401);
    expect((await http(invoicePath, 'POST', create, 'MEMBER')).status).toBe(403);
    const inv = await http(invoicePath, 'POST', create);
    expect(inv.status).toBe(201);
    parse(schemas.externalInvoiceRecord, inv.body.result);
    version = inv.body.versionToken;
    for (const evidence of [
      {
        duplicateReview: {
          invoiceIds: [inv.body.result.id],
          fingerprint: 'a'.repeat(64),
          evidenceReference: 'API claim',
          reason: 'Not a human review',
          attested: true,
        },
      },
      { creditResolution: { evidenceReference: 'API claim', reason: 'Not a human review', attested: true } },
    ]) {
      const blocked = await http(`${invoicePath}/${inv.body.result.id}`, 'PATCH', {
        ...evidence,
        requestKey: randomUUID(),
        expectedVersion: version,
      });
      expect(blocked.status).toBe(403);
      expect(blocked.body.code).toBe('RECONCILIATION_FORBIDDEN');
    }
    const retried = await http(invoicePath, 'POST', create);
    expect(retried.status).toBe(200);
    expect(retried.body).toEqual({ ...inv.body, changed: false });
    const record = {
      amountMinor: 100000,
      currency: 'NZD',
      paidOn: null,
      evidenceClass: 'PARTNER_REPORTED',
      evidenceReference: null,
      evidenceUrl: null,
      reason: 'Invented report',
      requestKey: randomUUID(),
      expectedVersion: version,
    };
    expect((await http(`${prefix}/receipts`, 'POST', { ...record, actor: { id: 'spoof' } })).status).toBe(
      400,
    );
    const receipt = await http(`${prefix}/receipts`, 'POST', record);
    expect(receipt.status).toBe(201);
    parse(schemas.receiptRecord, receipt.body.result);
    version = receipt.body.versionToken;
    expect((await http(`${prefix}/receipts`, 'POST', record)).status).toBe(200);
    const receiptPath = `${prefix}/receipts/${receipt.body.result.id}`;
    const edit = {
      evidenceClass: 'EVIDENCE_CHECKED',
      evidenceReference: 'Invented checked ref',
      reason: 'Reviewed',
      requestKey: randomUUID(),
      expectedVersion: version,
    };
    expect((await http(receiptPath, 'PATCH', edit)).status).toBe(400);
    const checked = await http(receiptPath, 'PATCH', { ...edit, attested: true });
    expect(checked.status).toBe(200);
    expect(checked.body.result.id).toBe(receipt.body.result.id);
    version = checked.body.versionToken;
    const allocated = await http(`${receiptPath}/allocations`, 'PUT', {
      allocations: [{ customerInvoiceId: inv.body.result.id, amountMinor: 100000 }],
      requestKey: randomUUID(),
      expectedVersion: version,
    });
    expect(allocated.status).toBe(200);
    parse(schemas.receiptAllocationsRecord, allocated.body.result);
    version = allocated.body.versionToken;
    const creditPath = `${prefix}/customer-invoices/${inv.body.result.id}/credit-adjustments`;
    const credit = await http(creditPath, 'POST', {
      amountMinor: 20000,
      sourceReference: 'Invented credit',
      reason: 'Credit correction',
      requestKey: randomUUID(),
      expectedVersion: version,
    });
    expect(credit.status).toBe(201);
    version = credit.body.versionToken;
    const patched = await http(`${invoicePath}/${inv.body.result.id}`, 'PATCH', {
      number: 'HTTP-CORRECTED',
      requestKey: randomUUID(),
      expectedVersion: version,
    });
    expect(patched.status).toBe(200);
    expect(patched.body.result.creditAdjustmentMinor).toBe(20000);
    version = patched.body.versionToken;
    const voidBody = { reason: 'Duplicate evidence', requestKey: randomUUID(), expectedVersion: version };
    const voided = await http(`${receiptPath}/void`, 'POST', voidBody);
    expect(voided.status).toBe(200);
    expect(voided.body.result.voidReason).toBe('Duplicate evidence');
    expect((await http(`${receiptPath}/void`, 'POST', voidBody)).body).toEqual({
      ...voided.body,
      changed: false,
    });
  });
});
