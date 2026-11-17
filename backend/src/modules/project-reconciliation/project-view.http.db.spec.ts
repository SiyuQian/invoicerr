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

describe('project-view authenticated HTTP', () => {
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
  it('authorises all read routes and validates exact paged/report contracts', async () => {
    const created = await http('projects', 'POST', {
      name: 'Invented report HTTP',
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
    const prefix = `projects/${created.body.result.id}`;
    for (const path of [prefix, `${prefix}/receipts`, `${prefix}/customer-invoices`, `${prefix}/history`]) {
      expect((await http(path, 'GET', undefined, '')).status).toBe(401);
      const member = await http(path, 'GET', undefined, 'MEMBER');
      expect(member.status).toBe(200);
      if (path === prefix) parse(schemas.projectView, member.body);
      else if (path.endsWith('/receipts')) parse(schemas.receiptPage, member.body);
      else if (path.endsWith('/customer-invoices')) parse(schemas.externalInvoicePage, member.body);
      else parse(schemas.historyPage, member.body);
      expect((await http(`${path}?limit=101`)).status).toBe(400);
      expect((await http(`${path}?forged=true`)).status).toBe(400);
      const foreign = path.replace(created.body.result.id, 'missing-or-foreign-project');
      expect((await http(foreign)).status).toBe(404);
    }
    expect((await http(`${prefix}?invoiceFrom=2026-02-30`)).status).toBe(400);
    expect((await http(`${prefix}?cashFrom=2026-11-02&cashTo=2026-11-01`)).status).toBe(400);
    for (const suffix of ['/receipts', '/customer-invoices', '/history'])
      expect((await http(`${prefix}${suffix}?cursor=missing`)).status).toBe(404);
    expect(
      (await http('projects?status=ALL&needsAttention=false&search=report&collectionMode=PARTNER')).body
        .total,
    ).toBe(1);
    expect((await http('projects?needsAttention=true')).body.total).toBe(0);
    const history = await http(`${prefix}/history?limit=1`);
    expect(history.body.items[0]).toMatchObject({
      operation: 'project.create',
      actor: expect.stringMatching(/^api-key:/),
    });
    const download = await fetch(
      `${base}/api/project-reconciliation/${prefix}/export.csv?cashFrom=2026-11-01`,
      { headers: { 'x-api-key': keys.MEMBER } },
    );
    expect(download.status).toBe(200);
    expect(download.headers.get('content-type')).toContain('text/csv');
    expect(download.headers.get('content-disposition')).toContain('attachment');
    expect(await download.text()).toContain('in period: cash date');
    const forbidden = generateApiKey();
    await prisma.apiKey.create({
      data: {
        name: 'Insufficient document scope',
        keyPrefix: forbidden.slice(0, 12),
        keyHash: hashApiKey(forbidden),
        companyId,
        userId: users[0],
        scopes: ['project-reconciliation:read'],
      },
    });
    for (const suffix of ['', '/receipts', '/customer-invoices', '/history', '/export.csv']) {
      const denied = await fetch(`${base}/api/project-reconciliation/${prefix}${suffix}`, {
        headers: { 'x-api-key': forbidden },
      });
      expect(denied.status).toBe(403);
    }
  });
});
