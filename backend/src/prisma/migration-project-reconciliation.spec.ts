import 'dotenv/config';

import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../prisma/generated/prisma/client';
import { INSTANCE_RESET_TABLES } from '@/modules/instance/reset-tables';

const describeDatabase = process.env.MIGRATION_FRESH_TESTS === '1' ? describe : describe.skip;
const ROOT = join(__dirname, '../..');
const TABLES = [
  'ReconciliationProject',
  'ReconciliationCase',
  'CustomerInvoiceReference',
  'ExternalReceipt',
  'ExternalReceiptAllocation',
  'ProjectDocumentLink',
  'ReconciliationAuditEvent',
];
const PREFIX = 'invoicerr_reconciliation_test_';
const nonce = `${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;

function dbUrl(base: string, name: string) {
  const url = new URL(base);
  url.pathname = `/${name}`;
  url.search = '';
  return url.toString();
}

function safeName(name: string) {
  if (!name.startsWith(PREFIX) || !/^[a-z0-9_]+$/.test(name)) throw new Error('Unsafe scratch database');
  return name;
}

function deploy(url: string, config?: string) {
  execFileSync('npx', ['prisma', 'migrate', 'deploy', ...(config ? ['--config', config] : [])], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: url },
    stdio: 'pipe',
  });
}

describeDatabase('project reconciliation additive storage', () => {
  let admin: Client;
  let db: Client;
  let url: string;
  let scratch: string;
  let config: string;
  const names: string[] = [];
  let oldDocuments: unknown[];
  let oldPayments: unknown[];

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL required');
    admin = new Client({ connectionString: dbUrl(process.env.DATABASE_URL, 'postgres') });
    await admin.connect();
    const name = safeName(`${PREFIX}upgrade_${nonce}`);
    await admin.query(`CREATE DATABASE "${name}"`);
    names.push(name);
    url = dbUrl(process.env.DATABASE_URL, name);
    scratch = mkdtempSync(join(tmpdir(), 'invoicerr-reconciliation-'));
    cpSync(join(ROOT, 'prisma'), scratch, { recursive: true });
    for (const entry of readdirSync(join(scratch, 'migrations'))) {
      if (entry.endsWith('_project_reconciliation'))
        rmSync(join(scratch, 'migrations', entry), { recursive: true });
    }
    config = join(ROOT, `.reconciliation-migration-${nonce}.ts`);
    writeFileSync(
      config,
      `import { defineConfig, env } from 'prisma/config';\nexport default defineConfig({ schema: ${JSON.stringify(join(scratch, 'schema.prisma'))}, migrations: { path: ${JSON.stringify(join(scratch, 'migrations'))} }, datasource: { url: env('DATABASE_URL') } });\n`,
    );
    deploy(url, config);
    db = new Client({ connectionString: url });
    await db.connect();
    await db.query(`INSERT INTO "Company" (id,name,"foundedAt",address,"postalCode",city,country,phone,email)
      VALUES ('co-a','Synthetic A',now(),'Test','0000','Test','New Zealand','','a@example.test'),
      ('co-b','Synthetic B',now(),'Test','0000','Test','New Zealand','','b@example.test')`);
    await db.query(
      `INSERT INTO "Client" (id,"companyId",name,country) VALUES ('client-a','co-a','Customer','New Zealand'),('client-b','co-b','Other','New Zealand')`,
    );
    await db.query(
      `INSERT INTO "Project" (id,"companyId","clientId",name,"updatedAt") VALUES ('time-a','co-a','client-a','Existing',now()),('time-b','co-b','client-b','Existing B',now())`,
    );
    await db.query(`INSERT INTO "DocumentInstance" (id,"companyId","typeId",status,data,number,"displayNumber","createdAt","updatedAt") VALUES
      ('doc-a','co-a','invoice','paid','{"grossAmount":123.45,"currency":"NZD","issueDate":"2024-02-03","nested":{"tax":null}}',42,'INV-0042','2024-02-03','2024-02-04'),
      ('doc-b','co-b','expense','draft','{"grossAmount":9,"currency":"NZD"}',null,null,'2024-01-01','2024-01-02')`);
    await db.query(
      `INSERT INTO "DocumentPayment" (id,"companyId","documentId","amountMinor",currency,"documentAmountMinor","paidAt",method,note) VALUES ('payment-a','co-a','doc-a',12345,'NZD',12345,'2024-02-05','bank_transfer','Invented reference')`,
    );
    oldDocuments = (await db.query('SELECT * FROM "DocumentInstance" ORDER BY id')).rows;
    oldPayments = (await db.query('SELECT * FROM "DocumentPayment" ORDER BY id')).rows;
    deploy(url);
  }, 120_000);

  afterAll(async () => {
    await db?.end();
    for (const name of names) await admin.query(`DROP DATABASE "${safeName(name)}" WITH (FORCE)`);
    await admin?.end();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    if (config) rmSync(config, { force: true });
  }, 120_000);

  it('preserves existing documents and payments exactly with no financial backfill', async () => {
    expect((await db.query('SELECT * FROM "DocumentInstance" ORDER BY id')).rows).toEqual(oldDocuments);
    expect((await db.query('SELECT * FROM "DocumentPayment" ORDER BY id')).rows).toEqual(oldPayments);
    for (const table of TABLES)
      expect((await db.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n).toBe(0);
  });

  it('deploys the complete migration history to a new empty database', async () => {
    const name = safeName(`${PREFIX}fresh_${nonce}`);
    await admin.query(`CREATE DATABASE "${name}"`);
    names.push(name);
    const freshUrl = dbUrl(process.env.DATABASE_URL!, name);
    deploy(freshUrl);
    const fresh = new Client({ connectionString: freshUrl });
    await fresh.connect();
    try {
      for (const table of TABLES)
        expect((await fresh.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n).toBe(0);
    } finally {
      await fresh.end();
    }
  }, 120_000);

  it('enforces tenant/project ownership, external shapes, evidence, minor amounts and unique live links', async () => {
    await db.query(`INSERT INTO "ReconciliationProject" (id,"companyId",name,currency,"endCustomerName","partnerClientId","collectionMode","timeProjectId","updatedAt") VALUES
      ('rp-a','co-a','Partner project','NZD','End customer','client-a','PARTNER','time-a',now()),
      ('rp-a2','co-a','Other project','NZD','End customer',null,'COMPANY',null,now()),
      ('rp-b','co-b','Tenant B','NZD','B','client-b','PARTNER','time-b',now())`);
    const reject = async (sql: string, code = '23503') => {
      await expect(db.query(sql)).rejects.toMatchObject({ code });
    };
    await reject(
      `INSERT INTO "ReconciliationProject" (id,"companyId",name,currency,"endCustomerName","endCustomerClientId","collectionMode","updatedAt") VALUES ('bad-client','co-a','Bad','NZD','End','client-b','COMPANY',now())`,
    );
    await reject(
      `INSERT INTO "ReconciliationProject" (id,"companyId",name,currency,"endCustomerName","collectionMode","timeProjectId","updatedAt") VALUES ('bad-time','co-a','Bad','NZD','End','COMPANY','time-b',now())`,
    );
    await reject(
      `INSERT INTO "ReconciliationProject" (id,"companyId",name,currency,"endCustomerName","collectionMode","timeProjectId","updatedAt") VALUES ('duplicate-time','co-a','Bad','NZD','End','COMPANY','time-a',now())`,
      '23505',
    );
    await reject(
      `INSERT INTO "ReconciliationProject" (id,"companyId",name,currency,"endCustomerName","collectionMode","updatedAt") VALUES ('missing-partner','co-a','Bad','NZD','End','PARTNER',now())`,
      '23514',
    );
    await db.query(
      `INSERT INTO "ReconciliationCase" (id,"companyId","projectId",title,"updatedAt") VALUES ('case-a','co-a','rp-a','January',now()),('case-a2','co-a','rp-a2','Other',now()),('case-b','co-b','rp-b','B',now())`,
    );
    await reject(
      `INSERT INTO "ReconciliationCase" (id,"companyId","projectId",title,"updatedAt") VALUES ('bad-case','co-a','rp-b','Bad',now())`,
    );
    await reject(`UPDATE "ReconciliationCase" SET "agreedGrossMinor"=1 WHERE id='case-a2'`, '23514');
    await db.query(`UPDATE "ReconciliationProject" SET "partnerClientId"='client-a' WHERE id='rp-a2'`);
    await db.query(`UPDATE "ReconciliationCase" SET "agreedGrossMinor"=1000 WHERE id='case-a2'`);
    await reject(`UPDATE "ReconciliationProject" SET "partnerClientId"=null WHERE id='rp-a2'`, '23514');
    await db.query(`UPDATE "ReconciliationCase" SET "agreedGrossMinor"=null WHERE id='case-a2'`);
    await db.query(`UPDATE "ReconciliationProject" SET "partnerClientId"=null WHERE id='rp-a2'`);
    await reject(
      `UPDATE "ReconciliationCase" SET "reviewedSourceFingerprint"='accepted' WHERE id='case-a'`,
      '23514',
    );
    await db.query(
      `UPDATE "ReconciliationCase" SET "reviewedSourceFingerprint"='accepted',"reviewedBy"='user:synthetic',"reviewedAt"=now(),source='test',"externalId"='case-source-1' WHERE id='case-a'`,
    );
    await reject(
      `UPDATE "ReconciliationCase" SET source='test',"externalId"='case-source-1' WHERE id='case-a2'`,
      '23505',
    );
    await reject(`UPDATE "ReconciliationCase" SET "agreedGrossMinor"=-1 WHERE id='case-a'`, '23514');
    await reject(`UPDATE "ReconciliationCase" SET "agreedGrossMinor"=2147483648 WHERE id='case-a'`, '22003');
    await db.query(
      `INSERT INTO "ProjectDocumentLink" (id,"companyId","projectId","caseId","documentId",role) VALUES ('link-a','co-a','rp-a2','case-a2','doc-a','CUSTOMER_INVOICE')`,
    );
    await reject(
      `INSERT INTO "ProjectDocumentLink" (id,"companyId","projectId","documentId",role) VALUES ('bad-doc','co-a','rp-a','doc-b','PROJECT_COST')`,
    );
    await reject(`UPDATE "ProjectDocumentLink" SET "caseId"='case-a' WHERE id='link-a'`);
    await reject(
      `INSERT INTO "ProjectDocumentLink" (id,"companyId","projectId","documentId",role) VALUES ('duplicate-link','co-a','rp-a','doc-a','PROJECT_COST')`,
      '23505',
    );
    await reject(`DELETE FROM "DocumentInstance" WHERE id='doc-a'`);
    await db.query(
      `INSERT INTO "CustomerInvoiceReference" (id,"companyId","projectId","caseId","collectionMode","documentLinkId","documentLinkRole","updatedAt") VALUES ('own-ref','co-a','rp-a2','case-a2','COMPANY','link-a','CUSTOMER_INVOICE',now())`,
    );
    await reject(`UPDATE "CustomerInvoiceReference" SET issuer='Copied issuer' WHERE id='own-ref'`, '23514');
    await reject(`UPDATE "CustomerInvoiceReference" SET "caseId"='case-a' WHERE id='own-ref'`);
    await reject(`UPDATE "ProjectDocumentLink" SET role='PROJECT_COST' WHERE id='link-a'`);
    await reject(
      `INSERT INTO "CustomerInvoiceReference" (id,"companyId","projectId","caseId","collectionMode","updatedAt") VALUES ('empty-ref','co-a','rp-a','case-a','PARTNER',now())`,
      '23514',
    );
    await db.query(
      `INSERT INTO "CustomerInvoiceReference" (id,"companyId","projectId","caseId","collectionMode",issuer,recipient,"invoiceNumber",currency,"originalGrossMinor","sourceReference",source,"externalId","snapshotHash","updatedAt") VALUES ('external-a','co-a','rp-a','case-a','PARTNER','Partner','End','EXT-001','NZD',10000,'Invented export','manual','ext-001','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',now())`,
    );
    await reject(
      `INSERT INTO "CustomerInvoiceReference" (id,"companyId","projectId","caseId","collectionMode",issuer,recipient,"invoiceNumber",currency,"originalGrossMinor","sourceReference",source,"externalId","snapshotHash","updatedAt") SELECT 'duplicate-source',"companyId","projectId","caseId","collectionMode",issuer,recipient,"invoiceNumber",currency,"originalGrossMinor","sourceReference",source,"externalId","snapshotHash",now() FROM "CustomerInvoiceReference" WHERE id='external-a'`,
      '23505',
    );
    await reject(`UPDATE "CustomerInvoiceReference" SET currency='USD' WHERE id='external-a'`);
    await reject(
      `UPDATE "CustomerInvoiceReference" SET "originalGrossMinor"=-1 WHERE id='external-a'`,
      '23514',
    );
    await reject(
      `UPDATE "CustomerInvoiceReference" SET "creditAdjustmentMinor"=10001 WHERE id='external-a'`,
      '23514',
    );
    await reject(`UPDATE "CustomerInvoiceReference" SET "externalId"=null WHERE id='external-a'`, '23514');
    await db.query(
      `INSERT INTO "ExternalReceipt" (id,"companyId","projectId",collector,"grossMinor",currency,"sourceReference","enteredBy","updatedAt") VALUES ('receipt-a','co-a','rp-a','Partner',10000,'NZD','Invented receipt','user:synthetic',now())`,
    );
    expect(
      (await db.query(`SELECT "receivedAt", "reviewedAt" FROM "ExternalReceipt" WHERE id='receipt-a'`))
        .rows[0],
    ).toEqual({ receivedAt: null, reviewedAt: null });
    expect(
      (
        await db.query(
          `SELECT "issueDate", "dueDate", "netMinor", "taxMinor" FROM "CustomerInvoiceReference" WHERE id='external-a'`,
        )
      ).rows[0],
    ).toEqual({ issueDate: null, dueDate: null, netMinor: null, taxMinor: null });
    await reject(`UPDATE "ExternalReceipt" SET "companyId"='co-b' WHERE id='receipt-a'`);
    await reject(`UPDATE "ExternalReceipt" SET "projectId"='rp-a2' WHERE id='receipt-a'`);
    await reject(`UPDATE "ExternalReceipt" SET "grossMinor"=0 WHERE id='receipt-a'`, '23514');
    await reject(
      `UPDATE "ExternalReceipt" SET "evidenceClass"='EVIDENCE_CHECKED' WHERE id='receipt-a'`,
      '23514',
    );
    await reject(
      `UPDATE "ExternalReceipt" SET "evidenceUrl"='http://unsafe.test' WHERE id='receipt-a'`,
      '23514',
    );
    await db.query(
      `UPDATE "ExternalReceipt" SET "evidenceClass"='EVIDENCE_CHECKED', "reviewedBy"='user:synthetic', "reviewedAt"=now(), "humanAttestation"='I checked the invented statement', "evidenceReference"='Synthetic statement line 1', "evidenceUrl"='https://example.test/evidence' WHERE id='receipt-a'`,
    );
    await db.query(
      `INSERT INTO "ExternalReceiptAllocation" (id,"companyId","projectId","receiptId","invoiceReferenceId","amountMinor") VALUES ('allocation-a','co-a','rp-a','receipt-a','external-a',1000)`,
    );
    await reject(`UPDATE "ExternalReceiptAllocation" SET "companyId"='co-b' WHERE id='allocation-a'`);
    await reject(
      `UPDATE "ExternalReceiptAllocation" SET "invoiceReferenceId"='own-ref' WHERE id='allocation-a'`,
    );
    await reject(`UPDATE "ExternalReceiptAllocation" SET "amountMinor"=-1 WHERE id='allocation-a'`, '23514');
    await db.query(
      `INSERT INTO "ReconciliationAuditEvent" (id,"companyId","projectId",actor,operation,"requestKey","affectedRecord",reason) VALUES ('audit-a','co-a','rp-a','user:synthetic','CREATE','request-1','external:ext-001','Invented test')`,
    );
    await reject(
      `INSERT INTO "ReconciliationAuditEvent" (id,"companyId","projectId",actor,operation,"requestKey","affectedRecord") VALUES ('duplicate-request','co-a','rp-a','user:synthetic','CREATE','request-1','external:ext-001')`,
      '23505',
    );
    await db.query(
      `INSERT INTO "ReconciliationAuditEvent" (id,"companyId","projectId",actor,operation,"requestKey","affectedRecord") VALUES ('other-actor-request','co-a','rp-a','user:other','CREATE','request-1','external:ext-001')`,
    );
    await reject(`UPDATE "ReconciliationAuditEvent" SET reason='rewritten' WHERE id='audit-a'`, '23514');
  });

  it('purges only the authorised company children atomically before company deletion, preserving rollback', async () => {
    const { purgeReconciliationForCompany } = await import('@/modules/project-reconciliation/persistence');
    const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    try {
      await expect(
        prisma.$transaction(async (tx) => {
          await purgeReconciliationForCompany(tx, 'co-a');
          await tx.company.delete({ where: { id: 'co-a' } });
          throw new Error('rollback proof');
        }),
      ).rejects.toThrow('rollback proof');
      expect(
        (await db.query(`SELECT count(*)::int AS n FROM "ProjectDocumentLink" WHERE "companyId"='co-a'`))
          .rows[0].n,
      ).toBe(1);
      await prisma.$transaction(async (tx) => {
        await purgeReconciliationForCompany(tx, 'co-a');
        await db.query("SET lock_timeout = '100ms'");
        try {
          await expect(
            db.query(
              `INSERT INTO "ReconciliationProject" (id,"companyId",name,currency,"endCustomerName","collectionMode","updatedAt") VALUES ('racing-project','co-a','Race','NZD','End','COMPANY',now())`,
            ),
          ).rejects.toMatchObject({ code: '55P03' });
        } finally {
          await db.query('SET lock_timeout = DEFAULT');
        }
        // Removing links alone must leave financial facts intact.
        expect(await tx.documentPayment.count({ where: { companyId: 'co-a' } })).toBe(1);
        await tx.company.delete({ where: { id: 'co-a' } });
      });
      for (const table of TABLES)
        expect(
          (await db.query(`SELECT count(*)::int AS n FROM "${table}" WHERE "companyId"='co-a'`)).rows[0].n,
        ).toBe(0);
      expect(
        (await db.query(`SELECT id FROM "ReconciliationProject" WHERE "companyId"='co-b'`)).rows,
      ).toEqual([{ id: 'rp-b' }]);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('operational reset includes every new table without removing migration history', async () => {
    await db.query(
      `INSERT INTO "ProjectDocumentLink" (id,"companyId","projectId","caseId","documentId",role) VALUES ('link-b','co-b','rp-b','case-b','doc-b','PROJECT_COST')`,
    );
    await db.query(
      `INSERT INTO "CustomerInvoiceReference" (id,"companyId","projectId","caseId","collectionMode",issuer,recipient,"invoiceNumber",currency,"originalGrossMinor","sourceReference","snapshotHash","updatedAt") VALUES ('external-b','co-b','rp-b','case-b','PARTNER','B','End','B-1','NZD',100,'Synthetic','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',now())`,
    );
    await db.query(
      `INSERT INTO "ExternalReceipt" (id,"companyId","projectId",collector,"grossMinor",currency,"sourceReference","enteredBy","updatedAt") VALUES ('receipt-b','co-b','rp-b','B',100,'NZD','Synthetic','user:synthetic',now())`,
    );
    await db.query(
      `INSERT INTO "ExternalReceiptAllocation" (id,"companyId","projectId","receiptId","invoiceReferenceId","amountMinor") VALUES ('allocation-b','co-b','rp-b','receipt-b','external-b',100)`,
    );
    await db.query(
      `INSERT INTO "ReconciliationAuditEvent" (id,"companyId","projectId",actor,operation,"requestKey","affectedRecord") VALUES ('audit-b','co-b','rp-b','user:synthetic','CREATE','request-b','external:b')`,
    );
    for (const table of TABLES)
      expect((await db.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n).toBeGreaterThan(0);
    const migrations = (await db.query('SELECT count(*)::int AS n FROM "_prisma_migrations"')).rows[0].n;
    const list = INSTANCE_RESET_TABLES.map((name) => `"${name}"`).join(', ');
    await db.query(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
    for (const table of TABLES)
      expect((await db.query(`SELECT count(*)::int AS n FROM "${table}"`)).rows[0].n).toBe(0);
    expect((await db.query('SELECT count(*)::int AS n FROM "_prisma_migrations"')).rows[0].n).toBe(
      migrations,
    );
  });
});
