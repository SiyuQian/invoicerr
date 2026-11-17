import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import { createHmac, randomUUID } from 'node:crypto';
import prisma from '@/prisma/prisma.service';
import { AuthGuard } from '@/guards/auth.guard';
import { RolesGuard } from '@/guards/roles.guard';
import { auth, sessionCookieName } from '@/lib/auth';
import { sessionCache } from '@/lib/session-cache';
import { generateApiKey, hashApiKey } from '@/utils/api-key';
import { ApiKeysController } from '@/modules/api-keys/api-keys.controller';
import { ApiKeysService } from '@/modules/api-keys/api-keys.service';
import { ProjectReconciliationModule } from './module';
import { ReconciliationService } from './service';
import { purgeReconciliationForCompany } from './persistence';
import { schemas, parse } from './validation';

const financial = ['invoices', 'credit-notes', 'expenses', 'received-invoices'].map((r) => `${r}:read`);
const projectInput = {
  name: 'Register project',
  endCustomerName: 'Example customer',
  currency: 'NZD',
  collectionMode: 'COMPANY',
  endCustomerClientId: null,
  partnerClientId: null,
  timeProjectId: null,
  description: null,
};
const caseInput = {
  title: 'First stage',
  periodStart: null,
  periodEnd: null,
  agreedGrossMinor: null,
  agreedNetMinor: null,
  agreedVatMinor: null,
  agreementReference: null,
};
describe('reconciliation actual authenticated HTTP and Postgres', () => {
  let app: INestApplication,
    base: string,
    companyId: string,
    foreignCompanyId: string,
    projectId: string,
    version: string;
  const users: string[] = [];
  const cookies: Record<string, string> = {};
  async function http(
    path: string,
    method = 'GET',
    body?: unknown,
    headers: Record<string, string> = { cookie: cookies.OWNER },
  ) {
    const response = await fetch(`${base}/api/${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() };
  }
  async function key(scopes: string[], role = 'OWNER') {
    const raw = generateApiKey();
    await prisma.apiKey.create({
      data: {
        name: 'Test',
        keyPrefix: raw.slice(0, 12),
        keyHash: hashApiKey(raw),
        userId: users[['OWNER', 'ADMIN', 'MEMBER'].indexOf(role)],
        companyId,
        scopes,
      },
    });
    return { 'x-api-key': raw };
  }
  beforeAll(async () => {
    for (const name of ['Register test', 'Foreign register test']) {
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
      else foreignCompanyId = company.id;
    }
    const secret = (await auth.$context).secret;
    for (const role of ['OWNER', 'ADMIN', 'MEMBER'] as const) {
      const id = randomUUID();
      users.push(id);
      await prisma.user.create({
        data: { id, email: `${id}@example.test`, firstname: 'Register', lastname: role, emailVerified: true },
      });
      await prisma.userCompany.createMany({
        data: [
          { userId: id, companyId, role },
          { userId: id, companyId: foreignCompanyId, role },
        ],
      });
      const token = randomUUID();
      await prisma.session.create({
        data: {
          id: randomUUID(),
          token,
          userId: id,
          expiresAt: new Date(Date.now() + 3600000),
          activeCompanyId: companyId,
        },
      });
      const signature = createHmac('sha256', secret).update(token).digest('base64');
      cookies[role] = `${await sessionCookieName()}=${encodeURIComponent(`${token}.${signature}`)}`;
    }
    const module = await Test.createTestingModule({
      imports: [ProjectReconciliationModule],
      controllers: [ApiKeysController],
      providers: [
        ApiKeysService,
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    app.setGlobalPrefix('api');
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
  }, 30000);
  afterAll(async () => {
    if (app) await app.close();
    for (const id of [companyId, foreignCompanyId].filter(Boolean))
      await prisma.$transaction(async (tx) => {
        await purgeReconciliationForCompany(tx, id);
        await tx.company.delete({ where: { id } });
      });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await sessionCache.close();
  });
  it('rejects missing authentication, MEMBER writes, and includes scopes in settings options', async () => {
    expect((await http('project-reconciliation/projects', 'GET', undefined, {})).status).toBe(401);
    expect(
      (await http('project-reconciliation/projects', 'GET', undefined, { cookie: cookies.MEMBER })).status,
    ).toBe(200);
    expect(
      (
        await http(
          'project-reconciliation/projects',
          'POST',
          { ...projectInput, requestKey: randomUUID(), expectedVersion: 'new' },
          { cookie: cookies.MEMBER },
        )
      ).status,
    ).toBe(403);
    const options = await http('api-keys/options');
    expect(options.status).toBe(200);
    expect(options.body.scopes).toContain('project-reconciliation:read');
    expect(options.body.scopes).toContain('project-reconciliation:write');
  });
  it('requires every financial scope over real key authentication', async () => {
    const scopes = ['project-reconciliation:read', ...financial];
    expect((await http('project-reconciliation/projects', 'GET', undefined, await key(scopes))).status).toBe(
      200,
    );
    for (let i = 0; i < scopes.length; i++)
      expect(
        (
          await http(
            'project-reconciliation/projects',
            'GET',
            undefined,
            await key(scopes.filter((_, j) => j !== i)),
          )
        ).status,
      ).toBe(403);
    expect(
      (
        await http(
          'project-reconciliation/projects',
          'GET',
          undefined,
          await key(['project-reconciliation:read']),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await http(
          'project-reconciliation/projects',
          'GET',
          undefined,
          await key(scopes.map((s) => s.replace(':read', ':write'))),
        )
      ).status,
    ).toBe(200);
  });
  it('creates once on concurrent same-key retry and rejects changed payload before stale version', async () => {
    const body = { ...projectInput, requestKey: randomUUID(), expectedVersion: 'new' };
    const replies = await Promise.all([
      http('project-reconciliation/projects', 'POST', body),
      http('project-reconciliation/projects', 'POST', body),
    ]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 201]);
    expect(replies[0].body.result.id).toBe(replies[1].body.result.id);
    projectId = replies[0].body.result.id;
    version = replies[0].body.versionToken;
    expect(
      (await http('project-reconciliation/projects', 'POST', { ...body, expectedVersion: 'stale' })).status,
    ).toBe(200);
    const conflict = await http('project-reconciliation/projects', 'POST', { ...body, name: 'Different' });
    expect(conflict.status).toBe(409);
    expect(await prisma.reconciliationProject.count({ where: { companyId } })).toBe(1);
    expect(
      await prisma.reconciliationAuditEvent.count({ where: { companyId, requestKey: body.requestKey } }),
    ).toBe(1);
    expect(
      (
        await http('project-reconciliation/projects', 'POST', {
          ...body,
          requestKey: randomUUID(),
          companyId: foreignCompanyId,
          actor: { id: 'evil' },
        })
      ).status,
    ).toBe(400);
  });
  it('keeps missing agreements null; merges period patches and records ADMIN actor', async () => {
    const created = await http(
      `project-reconciliation/projects/${projectId}/cases`,
      'POST',
      { ...caseInput, periodStart: '2026-11-01', requestKey: randomUUID(), expectedVersion: version },
      { cookie: cookies.ADMIN },
    );
    expect(created.status).toBe(201);
    expect(created.body.result.agreedGrossMinor).toBeNull();
    version = created.body.versionToken;
    const bad = await http(
      `project-reconciliation/projects/${projectId}/cases/${created.body.result.id}`,
      'PATCH',
      { periodEnd: '2026-10-31', requestKey: randomUUID(), expectedVersion: version },
    );
    expect(bad.status).toBe(400);
    const updated = await http(
      `project-reconciliation/projects/${projectId}/cases/${created.body.result.id}`,
      'PATCH',
      { periodEnd: '2026-11-30', requestKey: randomUUID(), expectedVersion: version },
    );
    expect(updated.status).toBe(200);
    expect(updated.body.result).toMatchObject({ periodStart: '2026-11-01', periodEnd: '2026-11-30' });
    version = updated.body.versionToken;
    expect(
      (
        await http(`project-reconciliation/projects/${projectId}`, 'PATCH', {
          description: 'stale',
          requestKey: randomUUID(),
          expectedVersion: created.body.versionToken,
        })
      ).status,
    ).toBe(409);
    const audit = await prisma.reconciliationAuditEvent.findFirstOrThrow({
      where: { companyId, operation: 'case.create' },
    });
    expect(audit.actor).toBe(`user:${users[1]}`);
  });
  it('enforces active-company ownership even for dual-company members and validates associations', async () => {
    const foreign = await prisma.reconciliationProject.create({
      data: {
        companyId: foreignCompanyId,
        name: 'Foreign',
        endCustomerName: 'Foreign',
        currency: 'NZD',
        collectionMode: 'COMPANY',
      },
    });
    expect((await http(`project-reconciliation/projects/${foreign.id}`)).status).toBe(404);
    expect(
      (
        await http(`project-reconciliation/projects/${foreign.id}`, 'PATCH', {
          name: 'attack',
          requestKey: randomUUID(),
          expectedVersion: version,
        })
      ).status,
    ).toBe(404);
    const client = await prisma.client.create({
      data: { companyId: foreignCompanyId, name: 'Foreign', country: 'New Zealand' },
    });
    const time = await prisma.project.create({
      data: { companyId: foreignCompanyId, clientId: client.id, name: 'Foreign time' },
    });
    for (const association of [
      { endCustomerClientId: client.id },
      { partnerClientId: client.id },
      { timeProjectId: time.id },
    ])
      expect(
        (
          await http('project-reconciliation/projects', 'POST', {
            ...projectInput,
            ...association,
            requestKey: randomUUID(),
            expectedVersion: 'new',
          })
        ).status,
      ).toBe(404);
    const inactive = await prisma.client.create({
      data: { companyId, name: 'Inactive', country: 'New Zealand', isActive: false },
    });
    expect(
      (
        await http('project-reconciliation/projects', 'POST', {
          ...projectInput,
          endCustomerClientId: inactive.id,
          requestKey: randomUUID(),
          expectedVersion: 'new',
        })
      ).status,
    ).toBe(404);
  });
  it('rolls back data and audit together when audit persistence throws', async () => {
    const requestKey = randomUUID();
    const failing = prisma.$extends({
      query: {
        reconciliationAuditEvent: {
          async create() {
            throw new Error('forced audit failure');
          },
        },
      },
    });
    const service = new ReconciliationService(app.get(ReconciliationService).financialRead, failing as never);
    await expect(
      service.updateProject(
        companyId,
        projectId,
        { description: 'Must roll back' },
        { actor: { id: users[0], kind: 'user' }, requestKey, expectedVersion: version },
      ),
    ).rejects.toThrow('forced audit failure');
    expect(
      (await prisma.reconciliationProject.findUniqueOrThrow({ where: { id: projectId } })).description,
    ).toBeNull();
    expect(await prisma.reconciliationAuditEvent.count({ where: { companyId, requestKey } })).toBe(0);
    expect((await http(`project-reconciliation/projects/${projectId}`)).body.versionToken).toBe(version);
  });
  it('locks money identity even for zero agreements; retains inactive labels and audits spelling/archive edits', async () => {
    const partner = await prisma.client.create({
      data: { companyId, name: 'Partner original', country: 'New Zealand' },
    });
    const customer = await prisma.client.create({
      data: { companyId, name: 'Customer', country: 'New Zealand' },
    });
    const time = await prisma.project.create({
      data: { companyId, clientId: customer.id, name: 'Time project' },
    });
    const created = await http('project-reconciliation/projects', 'POST', {
      ...projectInput,
      collectionMode: 'PARTNER',
      partnerClientId: partner.id,
      endCustomerClientId: customer.id,
      timeProjectId: time.id,
      requestKey: randomUUID(),
      expectedVersion: 'new',
    });
    expect(created.status).toBe(201);
    const id = created.body.result.id;
    const agreement = await http(`project-reconciliation/projects/${id}/cases`, 'POST', {
      ...caseInput,
      agreedGrossMinor: 0,
      requestKey: randomUUID(),
      expectedVersion: created.body.versionToken,
    });
    expect(agreement.status).toBe(201);
    for (const patch of [
      { currency: 'USD' },
      { collectionMode: 'COMPANY' },
      { endCustomerClientId: null },
      { partnerClientId: null, collectionMode: 'COMPANY' },
    ])
      expect(
        (
          await http(`project-reconciliation/projects/${id}`, 'PATCH', {
            ...patch,
            requestKey: randomUUID(),
            expectedVersion: agreement.body.versionToken,
          })
        ).status,
      ).toBe(409);
    await prisma.client.update({ where: { id: partner.id }, data: { isActive: false } });
    await prisma.project.update({ where: { id: time.id }, data: { isArchived: true } });
    const detail = await http(`project-reconciliation/projects/${id}`);
    expect(detail.body.project.partnerClient.inactive).toBe(true);
    expect(detail.body.project.identityLocked).toBe(true);
    expect(detail.body.project.timeProject.inactive).toBe(true);
    const edited = await http(`project-reconciliation/projects/${id}`, 'PATCH', {
      endCustomerName: 'Correct spelling',
      description: 'Documented edit',
      status: 'ARCHIVED',
      requestKey: randomUUID(),
      expectedVersion: detail.body.versionToken,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.result.status).toBe('ARCHIVED');
    expect(
      (await http('project-reconciliation/projects')).body.items.map((item: { id: string }) => item.id),
    ).not.toContain(id);
    expect(
      (await prisma.reconciliationCase.findUniqueOrThrow({ where: { id: agreement.body.result.id } })).status,
    ).toBe('OPEN');
    expect(await prisma.client.count({ where: { companyId } })).toBe(3);
    expect(await prisma.project.count({ where: { companyId } })).toBe(1);
  });
  it('versions canonical payments/credits without parent timestamps or GET writes and rejects stale edits', async () => {
    const document = await prisma.documentInstance.create({
      data: {
        companyId,
        typeId: 'invoice',
        status: 'sent',
        data: { currency: 'NZD', lines: [{ _id: 'a', quantity: 1, unitPrice: 100, vatRate: '0' }] },
      },
    });
    await prisma.projectDocumentLink.create({
      data: { companyId, projectId, documentId: document.id, role: 'SETTLEMENT_INCOME' },
    });
    const initial = await http(`project-reconciliation/projects/${projectId}`);
    expect(initial.status).toBe(200);
    expect(parse(schemas.projectView, initial.body).project.id).toBe(projectId);
    const audits = await prisma.reconciliationAuditEvent.count({ where: { companyId } });
    await prisma.documentPayment.create({
      data: {
        companyId,
        documentId: document.id,
        amountMinor: 100,
        currency: 'NZD',
        documentAmountMinor: 100,
        paidAt: new Date('2026-11-01'),
      },
    });
    const paid = await http(`project-reconciliation/projects/${projectId}`);
    expect(paid.body.versionToken).not.toBe(initial.body.versionToken);
    await prisma.documentInstance.create({
      data: {
        companyId,
        typeId: 'credit-note',
        status: 'sent',
        data: { invoice: document.id, currency: 'NZD', lines: [{ quantity: 1, unitPrice: 1, vatRate: '0' }] },
      },
    });
    const credited = await http(`project-reconciliation/projects/${projectId}`);
    expect(credited.body.versionToken).not.toBe(paid.body.versionToken);
    expect(
      (await prisma.documentInstance.findUniqueOrThrow({ where: { id: document.id } })).updatedAt,
    ).toEqual(document.updatedAt);
    expect(await prisma.reconciliationAuditEvent.count({ where: { companyId } })).toBe(audits);
    expect(
      (
        await http(`project-reconciliation/projects/${projectId}`, 'PATCH', {
          description: 'stale financial edit',
          requestKey: randomUUID(),
          expectedVersion: paid.body.versionToken,
        })
      ).body.code,
    ).toBe('RECONCILIATION_CHANGED');
    expect(
      (
        await http(`project-reconciliation/projects/${projectId}`, 'PATCH', {
          currency: 'USD',
          requestKey: randomUUID(),
          expectedVersion: credited.body.versionToken,
        })
      ).status,
    ).toBe(409);
  });

  it('returns foreign case IDs as 404 and maps simultaneous time-project conflicts to 409', async () => {
    const foreign = await prisma.reconciliationProject.findFirstOrThrow({
      where: { companyId: foreignCompanyId },
    });
    const foreignCase = await prisma.reconciliationCase.create({
      data: { companyId: foreignCompanyId, projectId: foreign.id, title: 'Foreign stage' },
    });
    const changed = await http(
      `project-reconciliation/projects/${projectId}/cases/${foreignCase.id}`,
      'PATCH',
      { title: 'attack', requestKey: randomUUID(), expectedVersion: 'stale' },
    );
    expect(changed.status).toBe(404);
    const client = await prisma.client.create({
      data: { companyId, name: 'Race customer', country: 'New Zealand' },
    });
    const time = await prisma.project.create({
      data: { companyId, clientId: client.id, name: 'One association' },
    });
    const results = await Promise.all(
      [1, 2].map(() =>
        http('project-reconciliation/projects', 'POST', {
          ...projectInput,
          timeProjectId: time.id,
          requestKey: randomUUID(),
          expectedVersion: 'new',
        }),
      ),
    );
    expect(results.map((item) => item.status).sort()).toEqual([201, 409]);
  });

  it('uses authenticated API holder namespace and checks role plus module write scope over HTTP', async () => {
    const body = { ...projectInput, name: 'API register', requestKey: randomUUID(), expectedVersion: 'new' };
    expect(
      (
        await http(
          'project-reconciliation/projects',
          'POST',
          body,
          await key(['project-reconciliation:read', ...financial]),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await http(
          'project-reconciliation/projects',
          'POST',
          body,
          await key(['project-reconciliation:write', ...financial], 'MEMBER'),
        )
      ).status,
    ).toBe(403);
    const first = await http(
      'project-reconciliation/projects',
      'POST',
      body,
      await key(['project-reconciliation:write', ...financial]),
    );
    expect(first.status).toBe(201);
    const retry = await http(
      'project-reconciliation/projects',
      'POST',
      body,
      await key(['project-reconciliation:write', ...financial]),
    );
    expect(retry.status).toBe(200);
    expect(retry.body.result.id).toBe(first.body.result.id);
    const audit = await prisma.reconciliationAuditEvent.findFirstOrThrow({
      where: { companyId, requestKey: body.requestKey },
    });
    expect(audit.actor).toBe(`api-key:${users[0]}`);
    const human = await http('project-reconciliation/projects', 'POST', body);
    expect(human.status).toBe(201);
    expect(human.body.result.id).not.toBe(first.body.result.id);
  });
  it('pages by descending createdAt/id with default 25 and whole-project identity locks', async () => {
    const prefix = randomUUID();
    const rows = [
      { id: `${prefix}_z_old`, createdAt: new Date('2040-01-01') },
      { id: `${prefix}_a_new`, createdAt: new Date('2040-01-02') },
      { id: `${prefix}_b_new`, createdAt: new Date('2040-01-02') },
      ...Array.from({ length: 26 }, (_, i) => ({ id: `${prefix}_${i}`, createdAt: new Date('2039-01-01') })),
    ];
    await prisma.reconciliationProject.createMany({
      data: rows.map((row) => ({
        ...row,
        companyId: foreignCompanyId,
        name: 'Paging',
        endCustomerName: 'Customer',
        currency: 'NZD',
        collectionMode: 'COMPANY',
      })),
    });
    const service = app.get(ReconciliationService);
    const first = await service.listProjects(foreignCompanyId, { limit: '1' });
    expect(first.items[0].project.id).toBe(`${prefix}_b_new`);
    expect(first.items[0].project.identityLocked).toBe(false);
    const second = await service.listProjects(foreignCompanyId, { limit: '1', cursor: first.nextCursor! });
    expect(second.items[0].project.id).toBe(`${prefix}_a_new`);
    const defaults = await service.listProjects(foreignCompanyId);
    expect(defaults.items).toHaveLength(25);
    expect(defaults.nextCursor).not.toBeNull();
    expect(defaults.total).toBe(30);
    await expect(service.listProjects(companyId, { cursor: first.nextCursor! })).rejects.toMatchObject({
      status: 404,
    });
  });
  it('binds case retry identity to its parent route without bypassing ownership or changing data', async () => {
    const parents = [];
    for (const owner of [companyId, companyId, foreignCompanyId]) {
      parents.push(
        await prisma.reconciliationProject.create({
          data: {
            companyId: owner,
            name: 'Retry parent',
            endCustomerName: 'Customer',
            currency: 'NZD',
            collectionMode: 'COMPANY',
          },
        }),
      );
    }
    const [parent, other, foreign] = parents;
    const row = await prisma.reconciliationCase.create({
      data: { companyId, projectId: parent.id, title: 'Before retry' },
    });
    const current = await http(`project-reconciliation/projects/${parent.id}`);
    const body = {
      title: 'After retry',
      requestKey: randomUUID(),
      expectedVersion: current.body.versionToken,
    };
    const route = (id: string) => `project-reconciliation/projects/${id}/cases/${row.id}`;
    const first = await http(route(parent.id), 'PATCH', body);
    expect(first.status).toBe(200);
    const snapshot = async () => ({
      projects: await prisma.reconciliationProject.findMany({
        where: { id: { in: parents.map((project) => project.id) } },
        orderBy: { id: 'asc' },
      }),
      case: await prisma.reconciliationCase.findUniqueOrThrow({ where: { id: row.id } }),
      audits: await prisma.reconciliationAuditEvent.findMany({
        where: { companyId, requestKey: body.requestKey },
      }),
    });
    const before = await snapshot();
    const staleRetry = { ...body, expectedVersion: 'stale' };
    const retry = await http(route(parent.id), 'PATCH', staleRetry);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ ...first.body, changed: false });
    for (const id of [other.id, `missing-${randomUUID()}`, foreign.id]) {
      const changedParent = await http(route(id), 'PATCH', body);
      expect(changedParent.status).toBe(409);
      expect(changedParent.body.code).toBe('RECONCILIATION_CHANGED');
    }
    expect(await snapshot()).toEqual(before);
    expect(before.audits).toHaveLength(1);
  });
});
