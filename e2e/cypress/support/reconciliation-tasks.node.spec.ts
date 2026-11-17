import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { assertReconciliationTarget, classifyRemovedJob, verifyEventWindow } from "./reconciliation-tasks";

const local = {
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://fixture@127.0.0.1:5438/project_reconciliation_ui_123456abcdef",
  REDIS_URL: "redis://127.0.0.1:6388/1",
  RECONCILIATION_E2E_DATABASE_NAME: "project_reconciliation_ui_123456abcdef",
  RECONCILIATION_E2E_REDIS_DB: "1",
};

test("requires explicit matching local test targets and rejects every unsafe boundary", () => {
  assert.equal(assertReconciliationTarget(local).databaseName, local.RECONCILIATION_E2E_DATABASE_NAME);
  for (const change of [
    { NODE_ENV: "production" },
    { RECONCILIATION_E2E_DATABASE_NAME: undefined },
    { RECONCILIATION_E2E_DATABASE_NAME: "another-database" },
    { RECONCILIATION_E2E_REDIS_DB: "0" },
    { RECONCILIATION_E2E_REDIS_DB: "2" },
    { DATABASE_URL: "postgresql://fixture@remote.invalid:5438/project_reconciliation_ui_123456abcdef" },
    { DATABASE_URL: "postgresql://fixture@127.0.0.1:5438/production" },
    { REDIS_URL: "redis://remote.invalid:6388/1" },
    { DATABASE_URL: local.DATABASE_URL + "?host=remote.invalid" },
    { REDIS_URL: "redis://127.0.0.1:6388/0x1" },
  ])
    assert.throws(() => assertReconciliationTarget({ ...local, ...change }));
});

test("accepts only existing exact GitHub Cypress service defaults without adding CI configuration", () => {
  const ci = {
    CI: "true",
    GITHUB_ACTIONS: "true",
    DATABASE_URL: "postgresql://fixture@127.0.0.1:5433/invoicerr_db",
    REDIS_URL: "redis://127.0.0.1:6379",
  };
  const target = assertReconciliationTarget(ci);
  assert.equal(target.databaseName, "invoicerr_db");
  assert.equal(target.redisDatabase, 0);
  assert.throws(() =>
    assertReconciliationTarget({ ...ci, DATABASE_URL: "postgresql://fixture@127.0.0.1:5434/invoicerr_db" }),
  );
  assert.throws(() => assertReconciliationTarget({ CI: "true" }));
  assert.throws(() => assertReconciliationTarget({ ...ci, NODE_ENV: "production" }));
});

test("keeps removed fixture action/report jobs attributable from immutable source IDs", () => {
  const documents = [{ id: "fixture-document", typeId: "invoice", companyId: "fixture-company" }];
  assert.equal(
    classifyRemovedJob("fixture-action-invoice-fixture-document", documents, [], []),
    "fixture-company",
  );
  assert.equal(
    classifyRemovedJob(
      "report-provider-fixture-document-pay-fixture-payment",
      documents,
      [{ id: "fixture-payment", documentId: "fixture-document" }],
      [],
    ),
    "fixture-company",
  );
  assert.equal(
    classifyRemovedJob(
      "schedule-fixture-schedule-1760000000000",
      [],
      [],
      [{ id: "fixture-schedule", companyId: "fixture-company" }],
    ),
    "fixture-company",
  );
  assert.equal(classifyRemovedJob("foreign-job", documents, [], []), null);
  for (const id of ["-invoice-fixture-document", "action-quote-fixture-document", "report--fixture-document"])
    assert.equal(classifyRemovedJob(id, documents, [], []), null);
  for (const timestamp of ["01760000000000", "99999999999999999", "NaN", "1760000000000x"])
    assert.equal(
      classifyRemovedJob(
        `schedule-fixture-schedule-${timestamp}`,
        [],
        [],
        [{ id: "fixture-schedule", companyId: "fixture-company" }],
      ),
      null,
    );
});

test("rejects trimmed, reset or incomplete stream history instead of silently losing removed jobs", () => {
  const before = { lastGeneratedId: "10-0", entriesAdded: 4 };
  verifyEventWindow(before, { lastGeneratedId: "12-0", entriesAdded: 6 }, [
    ["11-0", ["event", "added"]],
    ["12-0", ["event", "removed"]],
  ]);
  assert.throws(() =>
    verifyEventWindow(before, { lastGeneratedId: "12-0", entriesAdded: 6 }, [["12-0", ["event", "removed"]]]),
  );
  assert.throws(() => verifyEventWindow(before, { lastGeneratedId: "12-0", entriesAdded: 3 }, []));
  assert.throws(() => verifyEventWindow(before, { lastGeneratedId: "9-0", entriesAdded: 4 }, []));
  verifyEventWindow(before, { lastGeneratedId: "10-0", entriesAdded: 4 }, []);
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Client } from "pg";
import { Queue } from "bullmq";
import Redis from "ioredis";
import { createReconciliationTasks } from "./reconciliation-tasks";

type FixtureCompany = { id: string; nonce: string; clientId: string; name: string };
type FixtureContext = {
  cookie: string;
  accountId: string;
  email: string;
  apiUrl: string;
  frontendUrl: string;
  companies: FixtureCompany[];
  createdDocumentIds?: string[];
};
assert(!process.env.RECONCILIATION_FIXTURE_CONTEXT, "Restored fixture context is not supported");
let contextPath: string;
let context: FixtureContext | null = null;
const integration = test;
const tasks = createReconciliationTasks();

before(async () => {
  assertReconciliationTarget(process.env);
  const api = new URL(process.env.VITE_BACKEND_URL || "");
  assert(["localhost", "127.0.0.1", "[::1]"].includes(api.hostname), "Local fixture API required");
  const frontendUrl = process.env.FRONTEND_URL || "";
  const nonce = randomUUID(),
    email = `reconciliation-fixtures-${nonce}@example.com`,
    password = randomBytes(24).toString("hex") + "Aa1!";
  let cookie = "";
  async function post(route: string, body: Record<string, unknown>) {
    const response = await fetch(api.origin + route, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Origin: frontendUrl,
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
    assert([200, 201].includes(response.status), `Fixture API ${route}: ${response.status}`);
    const set = response.headers.getSetCookie();
    if (set.length) cookie = set.map((row) => row.split(";")[0]).join("; ");
    return response.json();
  }
  await post("/api/auth/sign-up/email", {
    name: "T10 Fixture Harness",
    firstname: "Synthetic",
    lastname: "Fixture",
    email,
    password,
    acceptLegal: true,
  });
  const signed = (await post("/api/auth/sign-in/email", { email, password })) as { user: { id: string } };
  const companies: FixtureCompany[] = [];
  for (const value of [nonce, randomUUID()]) {
    const company = (await post("/api/companies", {
      name: `T10 Fixture Harness ${value}`,
      description: "Disposable node fixture harness",
      phone: "+6400000000",
      email: `fixture-${value}@example.com`,
      address: "1 Invented St",
      city: "Auckland",
      postalCode: "1010",
      country: "New Zealand",
      countryCode: "NZ",
      currency: "NZD",
    })) as { id: string; name: string };
    await post("/api/companies/switch", { companyId: company.id });
    const client = (await post("/api/clients", {
      name: `T10 Fixture Client ${value}`,
      contactEmail: `client-${value}@example.com`,
      country: "New Zealand",
      countryCode: "NZ",
      currency: "NZD",
      address: "2 Invented St",
      city: "Auckland",
      postalCode: "1010",
      isActive: true,
      type: "COMPANY",
    })) as { id: string };
    companies.push({ id: company.id, name: company.name, nonce: value, clientId: client.id });
  }
  context = { accountId: signed.user.id, email, cookie, apiUrl: api.origin, frontendUrl, companies };
  contextPath = join(mkdtempSync(join(tmpdir(), "reconciliation-fixtures-")), "context.json");
  writeFileSync(contextPath, JSON.stringify({ ...context, password }, null, 2), { mode: 0o600 });
  console.log(
    "Dedicated fixture identities recorded before legacy setup:",
    companies.map((row) => row.id).join(","),
  );
});

async function request(company: FixtureCompany, action: string, data: Record<string, unknown>) {
  assert(context);
  const headers = { "content-type": "application/json", Origin: context.frontendUrl, Cookie: context.cookie };
  const switched = await fetch(`${context.apiUrl}/api/companies/switch`, {
    method: "POST",
    headers,
    body: JSON.stringify({ companyId: company.id }),
  });
  assert.equal(switched.status, 201);
  const response = await fetch(`${context.apiUrl}/api/documents/types/${action}/actions/save-draft`, {
    method: "POST",
    headers,
    body: JSON.stringify({ data }),
  });
  assert.equal(response.status, 201);
  const result = (await response.json()) as {
    document: { id: string; data: Record<string, unknown>; createdAt: string };
  };
  context.createdDocumentIds = [...(context.createdDocumentIds || []), result.document.id];
  writeFileSync(contextPath!, JSON.stringify(context, null, 2), { mode: 0o600 });
  return result.document;
}
async function invoice(company: FixtureCompany, marked = true) {
  return request(company, "invoice", {
    client: company.clientId,
    currency: "NZD",
    issueDate: "2026-08-15",
    dueDate: "2026-09-15",
    lines: [
      {
        description: marked ? `T10 fixture ${company.nonce}: invoice` : "Unmarked invented invoice",
        quantity: 1,
        unit: "unit",
        unitPrice: 1150,
        vatRate: "0",
      },
    ],
  });
}
async function expense(company: FixtureCompany) {
  return request(company, "expense", {
    description: `T10 fixture ${company.nonce}: undated expense`,
    amount: 125.5,
    currency: "NZD",
    date: "2026-08-15",
  });
}
async function rows(ids: string[]) {
  assertReconciliationTarget(process.env);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return (
      await client.query(
        'SELECT row_to_json(t)::text AS row FROM (SELECT * FROM "DocumentInstance" WHERE id=ANY($1::text[]) ORDER BY id) t',
        [ids],
      )
    ).rows.map((row: { row: string }) => row.row);
  } finally {
    await client.end();
  }
}
function input(company: FixtureCompany, ids: string[], undatedExpenseId: string | null = null) {
  return { companyId: company.id, fixtureNonce: company.nonce, invoiceIds: ids, undatedExpenseId };
}

integration(
  "fixed legacy setup changes only fresh marked source status/display number or Expense date",
  async () => {
    const company = context!.companies[0],
      own = await invoice(company),
      cost = await expense(company);
    const before = (await rows([own.id, cost.id])).map((row) => JSON.parse(row));
    const result = await tasks.reconciliationPrepareLegacyFixtures(input(company, [own.id], cost.id));
    assert.deepEqual(result.issuedInvoiceIds, [own.id]);
    const after = (await rows([own.id, cost.id])).map((row) => JSON.parse(row));
    const oldInvoice = before.find((row) => row.id === own.id),
      newInvoice = after.find((row) => row.id === own.id);
    assert.equal(newInvoice.status, "sent");
    assert(newInvoice.displayNumber.startsWith(`T10-LEGACY-${company.nonce}-`));
    assert.deepEqual(newInvoice.data, oldInvoice.data);
    assert.equal(newInvoice.number, oldInvoice.number);
    const oldExpense = before.find((row) => row.id === cost.id),
      newExpense = after.find((row) => row.id === cost.id);
    const { date: _date, ...undated } = oldExpense.data;
    assert.deepEqual(newExpense.data, undated);
    assert.equal(newExpense.status, "draft");
  },
);

integration("invalid ID, marker, company, type and age preserve every source row", async () => {
  const [a, b] = context!.companies,
    valid = await invoice(a),
    unmarked = await invoice(a, false),
    cost = await expense(a);
  const ids = [valid.id, unmarked.id, cost.id],
    before = await rows(ids);
  for (const bad of [
    input(a, ["missing-fixture-document"]),
    input(a, [unmarked.id]),
    input(b, [valid.id]),
    input(a, [cost.id]),
    { ...input(a, [valid.id]), fixtureNonce: randomUUID() },
  ]) {
    await assert.rejects(tasks.reconciliationPrepareLegacyFixtures(bad));
    assert.deepEqual(await rows(ids), before);
  }
  while (Date.now() <= Date.parse(valid.createdAt)) await new Promise((resolve) => setTimeout(resolve, 1));
  const newerContext = createReconciliationTasks();
  await assert.rejects(newerContext.reconciliationPrepareLegacyFixtures(input(a, [valid.id])));
  assert.deepEqual(await rows(ids), before);
});

integration(
  "mixed valid and invalid candidate sets roll back without partially issuing a source",
  async () => {
    const company = context!.companies[0],
      own = await invoice(company),
      unmarked = await invoice(company, false),
      cost = await expense(company);
    const ids = [own.id, unmarked.id, cost.id],
      before = await rows(ids);
    await assert.rejects(
      tasks.reconciliationPrepareLegacyFixtures(
        input(company, [own.id, "missing-fixture-document"], cost.id),
      ),
    );
    assert.deepEqual(await rows(ids), before);
    await assert.rejects(
      tasks.reconciliationPrepareLegacyFixtures(input(company, [own.id, unmarked.id], cost.id)),
    );
    assert.deepEqual(await rows(ids), before);
  },
);

integration("snapshot preserves full source JSON and detects an already removed business job", async () => {
  const company = context!.companies[0],
    own = await invoice(company),
    target = assertReconciliationTarget(process.env);
  const queueName = `reconciliation-harness-${randomUUID()}`;
  const queue = new Queue(queueName, { connection: { url: target.redisUrl }, skipMetasUpdate: true });
  try {
    const before = await tasks.reconciliationSourceSnapshot({ companyIds: [company.id] });
    const job = await queue.add(
      "fixture-observation",
      { companyId: company.id, documentId: own.id },
      { jobId: `fixture-observation-invoice-${own.id}` },
    );
    await job.remove();
    const after = await tasks.reconciliationSourceSnapshot({
      companyIds: [company.id],
      since: before.events.watermarks,
    });
    assert.deepEqual(after.sourceRows, before.sourceRows);
    assert(after.events.sourceEvents.some((event) => event.jobId === job.id && event.event === "added"));
    assert(!after.queues.ownedJobs.some((job) => job.id === `fixture-observation-invoice-${own.id}`));
  } finally {
    assert(/^reconciliation-harness-[a-f0-9-]{36}$/.test(queueName));
    await queue.obliterate({ force: true });
    await queue.close();
  }
});

integration(
  "retained jobs reject conflicting payload source, deterministic ID and tenant ownership",
  async () => {
    const [company, foreign] = context!.companies;
    const own = await invoice(company),
      other = await invoice(foreign);
    const target = assertReconciliationTarget(process.env),
      queueName = `reconciliation-harness-${randomUUID()}`;
    const queue = new Queue(queueName, { connection: { url: target.redisUrl }, skipMetasUpdate: true });
    try {
      for (const [id, data] of [
        [`conformity-${own.id}-1`, { companyId: foreign.id, documentId: own.id }],
        [`opaque-${randomUUID()}`, { companyId: foreign.id, sourceDocumentId: own.id }],
        [`observe-invoice-${own.id}`, { companyId: company.id, documentId: other.id }],
      ] as const) {
        const job = await queue.add("fixture-observation", data, { jobId: id });
        try {
          await assert.rejects(
            tasks.reconciliationSourceSnapshot({ companyIds: [company.id, foreign.id] }),
            /ownership mismatch/i,
          );
        } finally {
          await job.remove();
        }
      }
      const job = await queue.add(
        "fixture-observation",
        { documentId: own.id },
        { jobId: `opaque-${randomUUID()}` },
      );
      const snapshot = await tasks.reconciliationSourceSnapshot({ companyIds: [company.id] });
      assert(snapshot.queues.ownedJobs.some((row) => row.id === job.id));
    } finally {
      assert(/^reconciliation-harness-[a-f0-9-]{36}$/.test(queueName));
      await queue.obliterate({ force: true });
      await queue.close();
    }
  },
);

integration(
  "scheduler templates reject conflicting tenant/source ownership and retain source-only ownership",
  async () => {
    const [company, foreign] = context!.companies,
      own = await invoice(company);
    const target = assertReconciliationTarget(process.env),
      queueName = `reconciliation-harness-${randomUUID()}`;
    const queue = new Queue(queueName, { connection: { url: target.redisUrl }, skipMetasUpdate: true });
    const schedulerId = randomUUID();
    try {
      const conflictingJob = await queue.upsertJobScheduler(
        schedulerId,
        { every: 3600000 },
        { name: "fixture-observation", data: { companyId: foreign.id, sourceDocumentId: own.id } },
      );
      await assert.rejects(
        tasks.reconciliationSourceSnapshot({ companyIds: [company.id] }),
        /ownership mismatch/i,
      );
      await queue.removeJobScheduler(schedulerId);
      const retained = await queue.getJob(conflictingJob.id!);
      if (retained) await retained.remove();
      await queue.upsertJobScheduler(
        schedulerId,
        { every: 3600000 },
        { name: "fixture-observation", data: { sourceDocumentId: own.id } },
      );
      const snapshot = await tasks.reconciliationSourceSnapshot({ companyIds: [company.id] });
      assert(snapshot.queues.ownedSchedulers.some((row) => row.id === schedulerId));
    } finally {
      assert(/^reconciliation-harness-[a-f0-9-]{36}$/.test(queueName));
      await queue.obliterate({ force: true });
      await queue.close();
    }
  },
);

integration("retained job identity detects a changed raw repeat-job association", async () => {
  const company = context!.companies[0],
    target = assertReconciliationTarget(process.env);
  const queueName = `reconciliation-harness-${randomUUID()}`;
  const queue = new Queue(queueName, { connection: { url: target.redisUrl }, skipMetasUpdate: true });
  const redis = new Redis(target.redisUrl);
  try {
    const job = await queue.add("fixture-observation", { companyId: company.id });
    await redis.hset(`bull:${queueName}:${job.id}`, "rjk", "own-repeat-first");
    const first = await tasks.reconciliationSourceSnapshot({ companyIds: [company.id] });
    await redis.hset(`bull:${queueName}:${job.id}`, "rjk", "own-repeat-second");
    const second = await tasks.reconciliationSourceSnapshot({ companyIds: [company.id] });
    assert.notDeepEqual(first.queues.ownedJobs, second.queues.ownedJobs);
  } finally {
    assert(/^reconciliation-harness-[a-f0-9-]{36}$/.test(queueName));
    await queue.obliterate({ force: true });
    await queue.close();
    await redis.quit();
  }
});

test("refuses restored context overrides before any fixture network or cleanup can run", () => {
  const restored = join(mkdtempSync(join(tmpdir(), "reconciliation-rejected-context-")), "context.json");
  writeFileSync(
    restored,
    JSON.stringify({ apiUrl: "https://remote.invalid", cookie: "unused", companies: [] }),
    { mode: 0o600 },
  );
  const result = spawnSync(
    process.execPath,
    [
      "--require",
      "ts-node/register",
      "-e",
      `global.fetch = () => { throw new Error('NETWORK_FORBIDDEN'); }; require(${JSON.stringify(__filename)}); process.exit(0);`,
    ],
    {
      env: { ...process.env, RECONCILIATION_FIXTURE_CONTEXT: restored },
      encoding: "utf8",
    },
  );
  assert.notEqual(result.status, 0, "restored context must fail synchronously before setup hooks");
  assert.match(result.stderr, /Restored fixture context is not supported/);
  assert(!result.stderr.includes("NETWORK_FORBIDDEN"));
});

integration("real stream trim and unattributed removed jobs fail closed", async () => {
  const company = context!.companies[0],
    target = assertReconciliationTarget(process.env),
    queueName = `reconciliation-harness-${randomUUID()}`;
  const redis = new Redis(target.redisUrl),
    queue = new Queue(queueName, { connection: { url: target.redisUrl }, skipMetasUpdate: true });
  try {
    let before = await tasks.reconciliationSourceSnapshot({ companyIds: [company.id] });
    const first = await queue.add(
      "unknown-business",
      { companyId: company.id },
      { jobId: `unknown-${randomUUID()}` },
    );
    await first.remove();
    await assert.rejects(
      tasks.reconciliationSourceSnapshot({ companyIds: [company.id], since: before.events.watermarks }),
      /[Uu]nattributed/,
    );
    before = await tasks.reconciliationSourceSnapshot({ companyIds: [company.id] });
    const second = await queue.add("unknown-business", { companyId: company.id });
    await second.remove();
    await redis.xtrim(`bull:${queueName}:events`, "MAXLEN", 0);
    await assert.rejects(
      tasks.reconciliationSourceSnapshot({ companyIds: [company.id], since: before.events.watermarks }),
      /history|trim|reset/i,
    );
  } finally {
    assert(/^reconciliation-harness-[a-f0-9-]{36}$/.test(queueName));
    await queue.obliterate({ force: true });
    await queue.close();
    await redis.quit();
  }
});

after(async () => {
  if (!context) return;
  assertReconciliationTarget(process.env);
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query("BEGIN");
    const companyIds = context.companies.map((row) => row.id);
    const actual = (
      await client.query('SELECT id,name FROM "Company" WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE', [
        companyIds,
      ])
    ).rows as Array<{ id: string; name: string }>;
    assert.equal(actual.length, companyIds.length);
    for (const row of actual)
      assert.equal(row.name, context.companies.find((company) => company.id === row.id)?.name);
    const members = (
      await client.query('SELECT "userId",role FROM user_company WHERE "companyId"=ANY($1::text[])', [
        companyIds,
      ])
    ).rows;
    assert.equal(members.length, companyIds.length);
    assert(members.every((row) => row.userId === context!.accountId && row.role === "OWNER"));
    const documents = (
      await client.query('SELECT id FROM "DocumentInstance" WHERE "companyId"=ANY($1::text[])', [companyIds])
    ).rows.map((row) => row.id as string);
    assert.deepEqual(
      [...documents].sort(),
      [...(context.createdDocumentIds || [])].sort(),
      "Unexpected source prevents cleanup",
    );
    const clients = (
      await client.query('SELECT id FROM "Client" WHERE "companyId"=ANY($1::text[])', [companyIds])
    ).rows.map((row) => row.id as string);
    assert.deepEqual(
      clients.sort(),
      context.companies.map((row) => row.clientId).sort(),
      "Unexpected client prevents cleanup",
    );
    for (const table of [
      "ReconciliationProject",
      "ProjectDocumentLink",
      "Project",
      "DocumentPayment",
      "DocumentArchive",
      "DocumentSchedule",
      "DocumentReminder",
      "DocumentNumberSequence",
      "Webhook",
    ]) {
      assert.equal(
        Number(
          (
            await client.query(`SELECT count(*) AS count FROM "${table}" WHERE "companyId"=ANY($1::text[])`, [
              companyIds,
            ])
          ).rows[0].count,
        ),
        0,
        "Unexpected dependent prevents cleanup: " + table,
      );
    }
    assert.equal(
      (await client.query('DELETE FROM "Company" WHERE id=ANY($1::text[])', [companyIds])).rowCount,
      companyIds.length,
    );
    assert.equal(
      Number(
        (
          await client.query('SELECT count(*) AS count FROM user_company WHERE "userId"=$1', [
            context.accountId,
          ])
        ).rows[0].count,
      ),
      0,
    );
    assert.equal(
      (await client.query('DELETE FROM "user" WHERE id=$1 AND email=$2', [context.accountId, context.email]))
        .rowCount,
      1,
    );
    await client.query("COMMIT");
    console.log("Removed only dedicated fixture companies/account; no reconciliation purge required.");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    await client.end();
  }
});

integration(
  "scheduler identities ignore next-fire ordering but preserve every definition and membership",
  async () => {
    const company = context!.companies[0],
      own = await invoice(company),
      target = assertReconciliationTarget(process.env),
      queueName = `reconciliation-harness-${randomUUID()}`,
      queue = new Queue(queueName, { connection: { url: target.redisUrl }, skipMetasUpdate: true }),
      redis = new Redis(target.redisUrl),
      startDate = Date.now() + 3600000,
      repeatKey = `bull:${queueName}:repeat`;
    const schedulerJobs: Record<string, string> = {};
    try {
      for (const id of ["a-owner", "z-owner", "a-global", "z-global"]) {
        const global = id.endsWith("global");
        const job = await queue.upsertJobScheduler(
          id,
          { every: 3600000, startDate },
          {
            name: global ? "document-schedule-sweep" : "fixture-observation",
            data: global ? {} : { companyId: company.id, sourceDocumentId: own.id },
          },
        );
        schedulerJobs[id] = job.id!;
      }
      await redis.zadd(
        repeatKey,
        startDate + 1000,
        "a-owner",
        startDate + 2000,
        "z-owner",
        startDate + 3000,
        "a-global",
        startDate + 4000,
        "z-global",
      );
      const before = await tasks.reconciliationSourceSnapshot({ companyIds: [company.id] });
      await redis.zadd(
        repeatKey,
        startDate + 4000,
        "a-owner",
        startDate + 3000,
        "z-owner",
        startDate + 2000,
        "a-global",
        startDate + 1000,
        "z-global",
      );
      const reordered = await tasks.reconciliationSourceSnapshot({
        companyIds: [company.id],
        since: before.events.watermarks,
      });
      assert.deepEqual(reordered.sourceRows, before.sourceRows);
      assert.deepEqual(reordered.queues, before.queues);
      assert.deepEqual(reordered.events.sourceEvents, []);
      assert.deepEqual(
        reordered.queues.ownedSchedulers.filter((row) => row.queue === queueName).map((row) => row.id),
        ["a-owner", "z-owner"],
      );
      assert.deepEqual(
        reordered.queues.globalSchedulers.filter((row) => row.queue === queueName).map((row) => row.id),
        ["a-global", "z-global"],
      );
      await redis.hset(`${repeatKey}:a-owner`, "name", "changed-fixture-definition");
      const changed = await tasks.reconciliationSourceSnapshot({ companyIds: [company.id] });
      assert.notDeepEqual(changed.queues.ownedSchedulers, before.queues.ownedSchedulers);
      await redis.hset(`${repeatKey}:a-owner`, "name", "fixture-observation");
      await queue.upsertJobScheduler(
        "extra-owner",
        { every: 3600000, startDate },
        {
          name: "fixture-observation",
          data: { companyId: company.id, sourceDocumentId: own.id },
        },
      );
      const additional = await tasks.reconciliationSourceSnapshot({ companyIds: [company.id] });
      assert.equal(additional.queues.ownedSchedulers.filter((row) => row.queue === queueName).length, 3);
      assert.notDeepEqual(additional.queues.ownedSchedulers, before.queues.ownedSchedulers);
      await queue.removeJobScheduler("extra-owner");
      await queue.removeJobScheduler("a-global");
      const retained = await queue.getJob(schedulerJobs["a-global"]);
      if (retained) await retained.remove();
      const removed = await tasks.reconciliationSourceSnapshot({ companyIds: [company.id] });
      assert.notDeepEqual(removed.queues.globalSchedulers, before.queues.globalSchedulers);
    } finally {
      assert(/^reconciliation-harness-[a-f0-9-]{36}$/.test(queueName));
      await queue.obliterate({ force: true });
      await queue.close();
      await redis.quit();
    }
  },
);
