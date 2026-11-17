import 'reflect-metadata';
import { createHmac, randomUUID } from 'node:crypto';
import { text } from 'node:stream/consumers';
import { APP_GUARD } from '@nestjs/core';
import { Module } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import type { Request, Response, NextFunction } from 'express';
import { createApp } from '@/create-app';
import * as redisConnection from '@/lib/redis-connection';
import prisma from '@/prisma/prisma.service';
import { AuthGuard } from '@/guards/auth.guard';
import { RolesGuard } from '@/guards/roles.guard';
import { generateApiKey, hashApiKey } from '@/utils/api-key';
import { sessionCache } from '@/lib/session-cache';
import { ProjectReconciliationModule } from './module';
import { purgeReconciliationForCompany } from './persistence';
import { parse, schemas } from './validation';

@Module({
  imports: [ProjectReconciliationModule],
  providers: [
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
class ImportHttpTestModule {}

describe('import authenticated HTTP strict producer contract', () => {
  let app: INestApplication, base: string, companyId: string, partnerId: string, projectId: string;
  const rawBodies: Array<{ path: string; hash: string; bytes: number }> = [];
  const redisClients: ReturnType<typeof redisConnection.createLibRedisClient>[] = [];
  const hash = (body: string | Buffer) =>
    createHmac('sha256', 'invented-parser-test-secret').update(body).digest('hex');
  let redisSpy: { mockRestore(): void };
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
  const payload = {
    sourceSystem: 'ledgerly',
    sourceAsOf: '2026-11-01T00:00:00Z',
    currency: 'NZD',
    project: {
      id: 'invented-http-source',
      name: 'Invented source',
      customerIssuer: 'Invented partner',
      customerRecipient: 'Invented customer',
      shareIssuer: 'Invented company',
      shareRecipient: 'Invented partner',
    },
    invoices: [
      {
        id: 'invented-http-source-row',
        projectId: 'invented-http-source',
        number: 'HTTP-INVENTED',
        projectName: 'Invented source',
        issuer: 'Invented partner',
        recipient: 'Invented customer',
        kind: 'Customer invoice',
        status: 'Paid',
        issueDate: null,
        dueDate: null,
        paidDate: null,
        exGstAmountCents: 100,
        gstAmountCents: 15,
        totalCents: 115,
        sharePercent: null,
        sourceNumber: 'HTTP-INVENTED',
        linkedInvoiceNumber: null,
      },
    ],
  };
  beforeAll(async () => {
    companyId = (
      await prisma.company.create({
        data: {
          name: 'Invented HTTP import',
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
    for (const role of ['OWNER', 'MEMBER', 'NO_FINANCIAL', 'READ_ONLY'] as const) {
      const id = randomUUID();
      users.push(id);
      await prisma.user.create({
        data: { id, email: `${id}@example.test`, firstname: 'Invented', lastname: role, emailVerified: true },
      });
      await prisma.userCompany.create({
        data: { userId: id, companyId, role: role === 'MEMBER' ? 'MEMBER' : 'OWNER' },
      });
      keys[role] = generateApiKey();
      await prisma.apiKey.create({
        data: {
          name: 'Invented import key',
          keyPrefix: keys[role].slice(0, 12),
          keyHash: hashApiKey(keys[role]),
          companyId,
          userId: id,
          scopes: [
            role === 'READ_ONLY' ? 'project-reconciliation:read' : 'project-reconciliation:write',
            ...(role === 'NO_FINANCIAL'
              ? []
              : ['invoices:read', 'credit-notes:read', 'expenses:read', 'received-invoices:read']),
          ],
        },
      });
    }
    const makeRedis = redisConnection.createLibRedisClient;
    redisSpy = vi.spyOn(redisConnection, 'createLibRedisClient').mockImplementation((options) => {
      const client = makeRedis(options);
      redisClients.push(client);
      return client;
    });
    app = await createApp(ImportHttpTestModule);
    app.use(async (req: Request & { rawBody?: Buffer }, res: Response, next: NextFunction) => {
      if (req.path === '/api/auth/parser-probe') {
        const body = await text(req);
        res.status(200).json({ streamHash: hash(body), parsed: req.body ?? null, captured: !!req.rawBody });
        return;
      }
      if (req.path === '/api/parser-probe') {
        res.status(200).json({ rawHash: req.rawBody ? hash(req.rawBody) : null, parsed: req.body });
        return;
      }
      if (req.path.includes('/import/') && req.rawBody)
        rawBodies.push({ path: req.path, hash: hash(req.rawBody), bytes: req.rawBody.length });
      next();
    });
    await app.listen(0, '127.0.0.1');
    base = await app.getUrl();
    const project = await http('projects', 'POST', {
      name: 'Invented import project',
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
    projectId = project.body.result.id;
  });
  afterAll(async () => {
    if (app) await app.close();
    for (const client of redisClients) client.disconnect();
    redisSpy?.mockRestore();
    if (companyId)
      await prisma.$transaction(async (tx) => {
        await purgeReconciliationForCompany(tx, companyId);
        await tx.company.delete({ where: { id: companyId } });
      });
    await prisma.user.deleteMany({ where: { id: { in: users } } });
    await sessionCache.close();
  });
  it('requires administrative write and all financial scopes even for zero-write preview', async () => {
    const path = `projects/${projectId}/import/preview`,
      input = { payload, selectedMatches: [] };
    for (const [role, status] of [
      ['', 401],
      ['MEMBER', 403],
      ['NO_FINANCIAL', 403],
      ['READ_ONLY', 403],
    ] as const)
      expect((await http(path, 'POST', input, role)).status).toBe(status);
    expect((await http(`projects/${projectId}`, 'GET', undefined, 'MEMBER')).status).toBe(200);
  });
  it('publishes preview200, confirm201/retry200 with one envelope and no actor or guessed fields', async () => {
    const path = `projects/${projectId}/import`,
      input = { payload, selectedMatches: [] };
    for (const body of [
      { payload },
      { ...input, requestKey: 'unused', expectedVersion: 'unused' },
      { ...input, actor: 'spoof' },
      { ...input, payload: { ...payload, sourceUrl: 'https://ledgerly.example.test' } },
    ])
      expect((await http(`${path}/preview`, 'POST', body)).status).toBe(400);
    const preview = await http(`${path}/preview`, 'POST', input);
    expect(preview.status).toBe(200);
    parse(schemas.importPreview, preview.body);
    const confirm = {
      ...input,
      previewHash: preview.body.previewHash,
      expectedVersion: preview.body.projectVersion,
      requestKey: randomUUID(),
    };
    const result = await http(`${path}/confirm`, 'POST', confirm);
    expect(result.status).toBe(201);
    parse(schemas.importResult, result.body);
    expect(await http(`${path}/confirm`, 'POST', confirm)).toEqual({
      status: 200,
      body: { ...result.body, changed: false },
    });
    expect((await http(`${path}/confirm`, 'POST', { ...confirm, companyId: 'spoof' })).status).toBe(400);
    expect((await http(`${path}/confirm`, 'POST', { ...confirm, requestKey: randomUUID() })).body.code).toBe(
      'IMPORT_PREVIEW_STALE',
    );
    expect((await http('projects/invented-missing/import/preview', 'POST', input)).status).toBe(404);
  });
  it('rejects oversized original UTF-8 input before trims and writes nothing', async () => {
    const before = await prisma.reconciliationAuditEvent.count({ where: { companyId } });
    const response = await http(`projects/${projectId}/import/preview`, 'POST', {
      payload: { ...payload, project: { ...payload.project, name: ' '.repeat(2 * 1024 * 1024) } },
      selectedMatches: [],
    });
    expect(response.status).toBe(413);
    expect(await prisma.reconciliationAuditEvent.count({ where: { companyId } })).toBe(before);
  });
  function largeInput(rows = 25) {
    const description = 'x'.repeat(3800);
    return {
      payload: {
        ...payload,
        invoices: Array.from({ length: rows }, (_, i) => ({
          ...payload.invoices[0],
          id: `invented-large-${i}`,
          number: `LARGE-${i}`,
          sourceNumber: `LARGE-${i}`,
          status: 'Sent',
          issueDate: '2026-10-01',
          dueDate: '2026-10-31',
          sourceSnapshot: {
            lineItems: Array.from({ length: 12 }, () => ({
              category: 'Invented service',
              description,
              amountCents: 0,
              earnsReferralFee: false,
              revenueType: 'Service',
              treatment: 'Recorded',
            })),
          },
        })),
      },
      selectedMatches: [],
    };
  }
  it('uses the real factory to preview and confirm valid imports above 1MiB and below 2MiB', async () => {
    const input = largeInput(),
      serialized = JSON.stringify(input),
      bytes = Buffer.byteLength(serialized);
    expect(bytes).toBeGreaterThan(1024 * 1024);
    expect(bytes).toBeLessThan(2 * 1024 * 1024);
    parse(schemas.importPreviewInput, input);
    const before = await prisma.reconciliationAuditEvent.count({ where: { companyId } });
    const preview = await http(`projects/${projectId}/import/preview`, 'POST', input);
    expect(preview.status).toBe(200);
    parse(schemas.importPreview, preview.body);
    expect(await prisma.reconciliationAuditEvent.count({ where: { companyId } })).toBe(before);
    expect(rawBodies.at(-1)).toMatchObject({ hash: hash(serialized), bytes });
    const body = {
      ...input,
      previewHash: preview.body.previewHash,
      requestKey: randomUUID(),
      expectedVersion: preview.body.projectVersion,
    };
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(2 * 1024 * 1024);
    const confirmed = await http(`projects/${projectId}/import/confirm`, 'POST', body);
    expect(confirmed.status).toBe(201);
    parse(schemas.importResult, confirmed.body);
    expect(confirmed.body.result.cases).toHaveLength(25);
    expect(confirmed.body.result.references).toHaveLength(25);
    expect(rawBodies.at(-1)?.hash).toBe(hash(JSON.stringify(body)));
    expect((await http(`projects/${projectId}/import/confirm`, 'POST', body)).status).toBe(200);
    expect(await prisma.reconciliationAuditEvent.count({ where: { companyId } })).toBe(before + 1);
    expect((await http(`projects/${projectId}/import/preview`, 'POST', input, 'MEMBER')).status).toBe(403);
  });
  it('rejects above-2MiB imports atomically and retains the default 1MiB limit on every other path/method', async () => {
    const input = largeInput(46);
    expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(2 * 1024 * 1024);
    const old = {
      audit: await prisma.reconciliationAuditEvent.count({ where: { companyId } }),
      cases: await prisma.reconciliationCase.count({ where: { companyId } }),
      references: await prisma.customerInvoiceReference.count({ where: { companyId } }),
      project: await prisma.reconciliationProject.findUnique({ where: { id: projectId } }),
    };
    for (const suffix of ['preview', 'confirm']) {
      const body =
        suffix === 'preview'
          ? input
          : {
              ...input,
              previewHash: 'a'.repeat(64),
              requestKey: randomUUID(),
              expectedVersion: 'invented-version',
            };
      expect((await http(`projects/${projectId}/import/${suffix}`, 'POST', body)).status).toBe(413);
    }
    expect({
      audit: await prisma.reconciliationAuditEvent.count({ where: { companyId } }),
      cases: await prisma.reconciliationCase.count({ where: { companyId } }),
      references: await prisma.customerInvoiceReference.count({ where: { companyId } }),
      project: await prisma.reconciliationProject.findUnique({ where: { id: projectId } }),
    }).toEqual(old);
    const ordinary = largeInput();
    for (const [path, method] of [
      ['projects', 'POST'],
      [`projects/${projectId}/import/preview/extra`, 'POST'],
      [`projects/${projectId}/import/previewish`, 'POST'],
      [`projects/${projectId}/import/preview`, 'PUT'],
    ] as const)
      expect((await http(path, method, ordinary)).status).toBe(413);
  });
  it('preserves exact raw JSON HMAC bytes and leaves the auth subtree stream untouched', async () => {
    const body = '{\n  "invented": "original bytes", "n": 1\n}';
    const captured = await fetch(`${base}/api/parser-probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(captured.status).toBe(200);
    expect(await captured.json()).toEqual({ rawHash: hash(body), parsed: JSON.parse(body) });
    const form = 'id=tr_invented+reference&source=unit%20test';
    const formCaptured = await fetch(`${base}/api/parser-probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    expect(formCaptured.status).toBe(200);
    expect(await formCaptured.json()).toEqual({
      rawHash: hash(form),
      parsed: { id: 'tr_invented reference', source: 'unit test' },
    });
    const skipped = await fetch(`${base}/api/auth/parser-probe`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(skipped.status).toBe(200);
    expect(await skipped.json()).toEqual({ streamHash: hash(body), parsed: null, captured: false });
  });
});
