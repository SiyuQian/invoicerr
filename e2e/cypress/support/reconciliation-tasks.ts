import assert from "node:assert/strict";
import { Client } from "pg";
import Redis from "ioredis";
import { QueueKeys } from "bullmq";

const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}";
const fixtureCompany = new RegExp(`^T10 Fixture Harness (${uuid})$`);
const queues = [
  "document-action",
  "webhook-delivery",
  "received-invoice-ocr",
  "instance-backup",
  "billing-lifecycle",
  "company-transfer",
];
const maintenance = new Set([
  "document-schedule-sweep",
  "document-conformity-sweep",
  "document-pdp-reception-sweep",
  "document-reminder-sweep",
  "archive-retry-sweep",
  "storage-erasure-sweep",
  "currency-rate-sweep",
  "log-purge-sweep",
  "backup-sweep",
  "billing-lifecycle-sweep",
  "company-transfer-expiry-sweep",
]);
type DocumentIdentity = { id: string; typeId: string; companyId: string };
type PaymentIdentity = { id: string; documentId: string };
type ScheduleIdentity = { id: string; companyId: string };
export type EventWatermark = { lastGeneratedId: string; entriesAdded: number };
type StreamEntry = [string, string[]];

export function assertReconciliationTarget(env: NodeJS.ProcessEnv) {
  const ci = env.CI === "true" && env.GITHUB_ACTIONS === "true";
  const databaseUrl = env.DATABASE_URL || "";
  const redisUrl = env.REDIS_URL || "";
  const database = new URL(databaseUrl),
    redis = new URL(redisUrl);
  assert.notEqual(env.NODE_ENV, "production", "Production target refused");
  assert(["postgres:", "postgresql:"].includes(database.protocol));
  assert.equal(redis.protocol, "redis:");
  for (const [key, value] of database.searchParams)
    assert(key === "schema" && value === "public", "Database connection overrides refused");
  assert(!redis.search && /^\/(?:[0-9]+)?$/.test(redis.pathname || "/"), "Invalid Redis namespace");
  for (const url of [database, redis])
    assert(["localhost", "127.0.0.1", "[::1]"].includes(url.hostname), "Loopback target required");
  const databaseName = database.pathname.slice(1),
    redisDatabase = Number(redis.pathname.slice(1) || 0);
  const ciTarget =
    ci &&
    (!env.NODE_ENV || env.NODE_ENV === "test") &&
    databaseName === "invoicerr_db" &&
    database.port === "5433" &&
    (redis.port || "6379") === "6379" &&
    redisDatabase === 0;
  const localTarget =
    env.NODE_ENV === "test" &&
    /^project_reconciliation_ui_[a-f0-9]{12}$/.test(databaseName) &&
    env.RECONCILIATION_E2E_DATABASE_NAME === databaseName &&
    /^[1-9]\d*$/.test(env.RECONCILIATION_E2E_REDIS_DB || "") &&
    Number(env.RECONCILIATION_E2E_REDIS_DB) === redisDatabase;
  assert(ciTarget || localTarget, "Explicit reconciliation test target required");
  return { databaseUrl, redisUrl, databaseName, redisDatabase };
}

export function classifyRemovedJob(
  id: string,
  documents: DocumentIdentity[],
  payments: PaymentIdentity[],
  schedules: ScheduleIdentity[],
): string | null {
  // Fixed wire formats from document-action-job, reporting/report-job and schedules/schedule-sweep.
  // Keep this narrow matcher aligned with those builders; importing backend TS pulls Nest into e2e-only CI.
  for (const document of documents) {
    const suffix = `-${document.typeId}-${document.id}`;
    if (id.endsWith(suffix)) {
      const action = id.slice(0, -suffix.length);
      if (action) return document.companyId;
    }
    for (const payment of [undefined, ...payments.filter((row) => row.documentId === document.id)]) {
      const ending = payment ? `-${document.id}-pay-${payment.id}` : `-${document.id}`;
      if (id.startsWith("report-") && id.endsWith(ending)) {
        const provider = id.slice("report-".length, -ending.length);
        if (provider) return document.companyId;
      }
    }
  }
  for (const schedule of schedules) {
    const prefix = `schedule-${schedule.id}-`;
    if (id.startsWith(prefix) && /^\d+$/.test(id.slice(prefix.length))) {
      const date = new Date(Number(id.slice(prefix.length)));
      if (Number.isFinite(date.getTime()) && String(date.getTime()) === id.slice(prefix.length))
        return schedule.companyId;
    }
  }
  return null;
}

function compareStreamIds(left: string, right: string) {
  assert(/^\d+-\d+$/.test(left) && /^\d+-\d+$/.test(right), "Invalid event watermark");
  const a = left.split("-").map(BigInt),
    b = right.split("-").map(BigInt);
  return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
}
export function verifyEventWindow(before: EventWatermark, after: EventWatermark, entries: StreamEntry[]) {
  for (const value of [before.entriesAdded, after.entriesAdded])
    assert(Number.isSafeInteger(value) && value >= 0, "Invalid stream counter");
  assert(compareStreamIds(after.lastGeneratedId, before.lastGeneratedId) >= 0, "Queue event stream reset");
  assert.equal(
    entries.length,
    after.entriesAdded - before.entriesAdded,
    "Queue event history incomplete or trimmed",
  );
  let previous = before.lastGeneratedId;
  for (const [id] of entries) {
    assert(compareStreamIds(id, previous) > 0, "Queue event history out of order");
    previous = id;
  }
  assert.equal(previous, after.lastGeneratedId, "Queue event history incomplete");
}

type SnapshotInput = { companyIds: string[]; since?: Record<string, EventWatermark> };
type LegacyInput = {
  companyId: string;
  fixtureNonce: string;
  invoiceIds: string[];
  undatedExpenseId: string | null;
};
type SourceRow = DocumentIdentity & {
  data: Record<string, unknown>;
  createdAt: Date;
  status: string;
  number: number | null;
  displayNumber: string | null;
};
function ids(values: unknown): asserts values is string[] {
  assert(Array.isArray(values) && values.length > 0 && values.length <= 7, "Invalid fixture IDs");
  assert(
    values.every((id) => typeof id === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(id)),
    "Invalid fixture ID",
  );
  assert.equal(new Set(values).size, values.length, "Duplicate fixture ID");
}
async function companies(client: Client, companyIds: string[]) {
  ids(companyIds);
  assert(companyIds.length <= 2, "At most two fixture companies");
  const found = (
    await client.query<{ id: string; name: string; createdAt: Date }>(
      'SELECT id,name,"createdAt" FROM "Company" WHERE id=ANY($1::text[]) ORDER BY id',
      [companyIds],
    )
  ).rows;
  assert.equal(found.length, companyIds.length, "Fixture company not found");
  assert(
    found.every((row) => fixtureCompany.test(row.name)),
    "Only dedicated fixture companies allowed",
  );
  return found;
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    );
  return value;
}
async function scan(redis: Redis, pattern: string) {
  let cursor = "0";
  const result = new Set<string>();
  do {
    const page = await redis.scan(cursor, "MATCH", pattern, "COUNT", 200);
    cursor = page[0];
    page[1].forEach((key) => result.add(key));
  } while (cursor !== "0");
  return [...result].sort();
}
async function watermark(redis: Redis, key: string): Promise<EventWatermark> {
  const type = await redis.type(key);
  if (type === "none") return { lastGeneratedId: "0-0", entriesAdded: 0 };
  assert.equal(type, "stream", "Invalid queue event stream");
  const raw = (await redis.xinfo("STREAM", key)) as Array<string | number>;
  const info: Record<string, unknown> = {};
  for (let i = 0; i < raw.length; i += 2) info[String(raw[i])] = raw[i + 1];
  assert(Number.isSafeInteger(info["entries-added"]), "Queue stream counter unavailable");
  return { lastGeneratedId: String(info["last-generated-id"]), entriesAdded: Number(info["entries-added"]) };
}

export function createReconciliationTasks(env: NodeJS.ProcessEnv = process.env) {
  const startedAt = new Date();
  const knownOwners = new Map<string, string>();
  return {
    async reconciliationSourceSnapshot(input: SnapshotInput) {
      assert(
        input && Object.keys(input).every((key) => ["companyIds", "since"].includes(key)),
        "Invalid snapshot input",
      );
      const target = assertReconciliationTarget(env);
      const client = new Client({
        connectionString: target.databaseUrl,
        options: "-c default_transaction_read_only=on",
      });
      const sourceRows: Record<string, string[]> = {};
      let documents: DocumentIdentity[] = [],
        payments: PaymentIdentity[] = [],
        schedules: ScheduleIdentity[] = [];
      await client.connect();
      try {
        await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        assert.equal(
          (await client.query("SELECT current_database() AS name")).rows[0].name,
          target.databaseName,
        );
        await companies(client, input.companyIds);
        for (const table of [
          "DocumentInstance",
          "DocumentPayment",
          "DocumentSchedule",
          "DocumentReminder",
          "DocumentNumberSequence",
        ]) {
          const order = table === "DocumentNumberSequence" ? '"companyId","typeId",year' : "id";
          sourceRows[table] = (
            await client.query(
              'SELECT row_to_json(t)::text AS row FROM (SELECT * FROM "' +
                table +
                '" WHERE "companyId"=ANY($1::text[]) ORDER BY ' +
                order +
                ") t",
              [input.companyIds],
            )
          ).rows.map((row: { row: string }) => row.row);
        }
        sourceRows.CompanyNumberFormats = (
          await client.query(
            'SELECT row_to_json(t)::text AS row FROM (SELECT id,"numberFormats" FROM "Company" WHERE id=ANY($1::text[]) ORDER BY id) t',
            [input.companyIds],
          )
        ).rows.map((row: { row: string }) => row.row);
        documents = sourceRows.DocumentInstance.map((row) => JSON.parse(row) as DocumentIdentity);
        payments = sourceRows.DocumentPayment.map((row) => JSON.parse(row) as PaymentIdentity);
        schedules = sourceRows.DocumentSchedule.map((row) => JSON.parse(row) as ScheduleIdentity);
      } finally {
        await client.query("ROLLBACK");
        await client.end();
      }
      const redis = new Redis(target.redisUrl, { maxRetriesPerRequest: 1, retryStrategy: () => null });
      type JobIdentity = {
        queue: string;
        id: string;
        name: string;
        data: unknown;
        opts: unknown;
        repeatJobKey: string | null;
        states: string[];
      };
      type SchedulerIdentity = { queue: string; id: string; definition: unknown };
      const ownedJobs: JobIdentity[] = [],
        ownedSchedulers: SchedulerIdentity[] = [],
        globalSchedulers: SchedulerIdentity[] = [];
      const watermarks: Record<string, EventWatermark> = {};
      const sourceEvents: Array<{
        queue: string;
        streamId: string;
        jobId: string;
        event: string;
        companyId: string;
      }> = [];
      const scope = new Set(input.companyIds);
      const documentOwners = new Map(documents.map((row) => [row.id, row.companyId]));
      const scheduleOwners = new Map(schedules.map((row) => [row.id, row.companyId]));
      const paymentOwners = new Map(payments.map((row) => [row.id, documentOwners.get(row.documentId)]));
      const ownerOf = (id: string, data: Record<string, unknown>) => {
        const signals = [
          typeof data.companyId === "string" ? data.companyId : null,
          classifyRemovedJob(id, documents, payments, schedules),
          documentOwners.get(String(data.documentId)),
          documentOwners.get(String(data.sourceDocumentId)),
          scheduleOwners.get(String(data.scheduleId)),
          paymentOwners.get(String(data.paymentId)),
        ].filter((owner): owner is string => !!owner);
        assert(new Set(signals).size <= 1, "Queue source ownership mismatch");
        return signals[0];
      };
      try {
        const keys = await scan(redis, "bull:*");
        const names = [
          ...new Set([...queues, ...keys.map((key) => key.split(":")[1]), ...Object.keys(input.since || {})]),
        ].sort();
        for (const name of names) {
          assert(/^[a-zA-Z0-9_-]{1,120}$/.test(name), "Invalid queue name");
          const q = new QueueKeys("bull").getKeys(name),
            // Next-fire scores can reorder unchanged scheduler identities.
            schedulerIds = (await redis.zrange(q.repeat, 0, -1)).sort();
          const global = new Set<string>();
          for (const id of schedulerIds) {
            const raw = await redis.hgetall(q[""] + "repeat:" + id);
            assert(raw.name, "Scheduler changed during snapshot");
            const data = raw.data ? (JSON.parse(raw.data) as Record<string, unknown>) : {};
            const { ic: _counter, ...definition } = raw;
            const row = { queue: name, id, definition: canonical(definition) };
            const owner = ownerOf(id, data);
            if (owner && scope.has(owner)) ownedSchedulers.push(row);
            else if (Object.keys(data).length === 0 && maintenance.has(raw.name)) {
              globalSchedulers.push(row);
              global.add(id);
            } else if (!owner) throw new Error("Unattributed queue scheduler");
          }
          const states = new Map<string, string[]>();
          for (const state of [
            "active",
            "wait",
            "paused",
            "delayed",
            "completed",
            "failed",
            "prioritized",
            "waiting-children",
          ]) {
            const values = ["active", "wait", "paused"].includes(state)
              ? await redis.lrange(q[state], 0, -1)
              : await redis.zrange(q[state], 0, -1);
            for (const id of values) states.set(id, [...(states.get(id) || []), state]);
          }
          const schedulerKeys = new Set(schedulerIds.map((id) => q[""] + "repeat:" + id));
          const observed = new Set<string>();
          for (const key of keys.filter((key) => key.startsWith(q[""]))) {
            if (key === q.meta || schedulerKeys.has(key) || (await redis.type(key)) !== "hash") continue;
            const raw = await redis.hgetall(key);
            assert(raw.name && raw.data && raw.opts, "Unclassified queue hash or concurrent removal");
            const id = key.slice(q[""].length),
              data = JSON.parse(raw.data) as Record<string, unknown>;
            observed.add(id);
            const owner = ownerOf(id, data);
            if (owner) knownOwners.set(name + ":" + id, owner);
            if (owner && scope.has(owner))
              ownedJobs.push({
                queue: name,
                id,
                name: raw.name,
                data: canonical(data),
                opts: canonical(JSON.parse(raw.opts)),
                repeatJobKey: raw.rjk ?? null,
                states: (states.get(id) || []).sort(),
              });
            else if (
              !owner &&
              !(maintenance.has(raw.name) && Object.keys(data).length === 0 && global.has(raw.rjk))
            )
              throw new Error("Unattributed queue job");
          }
          for (const id of states.keys()) {
            const repeat = /^repeat:(.+):[0-9]+$/.exec(id);
            assert(observed.has(id) || (repeat && global.has(repeat[1])), "Queue changed during snapshot");
          }
          const after = await watermark(redis, q.events);
          watermarks[name] = after;
          if (input.since) {
            const before = input.since[name] || { lastGeneratedId: "0-0", entriesAdded: 0 };
            const entries =
              after.lastGeneratedId === "0-0"
                ? []
                : ((await redis.xrange(
                    q.events,
                    "(" + before.lastGeneratedId,
                    after.lastGeneratedId,
                  )) as StreamEntry[]);
            verifyEventWindow(before, after, entries);
            for (const [streamId, values] of entries) {
              const fields: Record<string, string> = {};
              for (let i = 0; i < values.length; i += 2) fields[values[i]] = values[i + 1];
              if (!fields.jobId) continue;
              const owner =
                knownOwners.get(name + ":" + fields.jobId) ||
                classifyRemovedJob(fields.jobId, documents, payments, schedules);
              if (owner && scope.has(owner))
                sourceEvents.push({
                  queue: name,
                  streamId,
                  jobId: fields.jobId,
                  event: fields.event,
                  companyId: owner,
                });
              else if (!owner && fields.event === "added") {
                const repeat = /^repeat:(.+):[0-9]+$/.exec(fields.jobId);
                assert(
                  repeat && global.has(repeat[1]) && maintenance.has(fields.name),
                  "Unattributed added queue event",
                );
              }
            }
          }
        }
      } finally {
        await redis.quit();
      }
      return {
        sourceRows,
        queues: { ownedJobs, ownedSchedulers, globalSchedulers },
        events: { watermarks, sourceEvents, historyComplete: true },
      };
    },
    async reconciliationPrepareLegacyFixtures(input: LegacyInput) {
      assert(
        input && Object.keys(input).sort().join(",") === "companyId,fixtureNonce,invoiceIds,undatedExpenseId",
        "Invalid legacy input",
      );
      assert(new RegExp("^" + uuid + "$").test(input.fixtureNonce), "Invalid fixture nonce");
      assert(Array.isArray(input.invoiceIds) && input.invoiceIds.length <= 6, "Invalid invoice fixture set");
      const candidateIds = [
        ...input.invoiceIds,
        ...(input.undatedExpenseId === null ? [] : [input.undatedExpenseId]),
      ];
      ids(candidateIds);
      const target = assertReconciliationTarget(env),
        client = new Client({ connectionString: target.databaseUrl });
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query('SELECT id FROM "Company" WHERE id=$1 FOR KEY SHARE', [input.companyId]);
        const company = (await companies(client, [input.companyId]))[0];
        assert.equal(
          company.name,
          "T10 Fixture Harness " + input.fixtureNonce,
          "Fixture company/nonce mismatch",
        );
        const found = (
          await client.query<SourceRow>(
            'SELECT * FROM "DocumentInstance" WHERE "companyId"=$1 AND id=ANY($2::text[]) ORDER BY id FOR UPDATE',
            [input.companyId, candidateIds],
          )
        ).rows;
        assert.equal(found.length, candidateIds.length, "Fixture candidate missing or foreign");
        for (const row of found) {
          assert.equal(row.status, "draft", "Only new drafts may be prepared");
          assert.equal(row.number, null);
          assert.equal(row.displayNumber, null);
          assert(
            row.createdAt >= startedAt && row.createdAt >= company.createdAt,
            "Fixture source predates creation context",
          );
          assert.equal(row.data.currency, "NZD");
          if (input.invoiceIds.includes(row.id)) {
            assert.equal(row.typeId, "invoice");
            const lines = row.data.lines as Array<Record<string, unknown>>;
            assert(Array.isArray(lines) && lines.length === 1);
            assert.equal(
              lines[0].description,
              `T10 fixture ${input.fixtureNonce}: invoice`,
              "Invoice marker mismatch",
            );
            assert.equal(lines[0].quantity, 1);
            assert([1150, 1725].includes(lines[0].unitPrice as number));
            assert.equal(lines[0].vatRate, "0");
            assert.equal(
              (
                await client.query('SELECT id FROM "Client" WHERE id=$1 AND "companyId"=$2', [
                  row.data.client,
                  input.companyId,
                ])
              ).rowCount,
              1,
            );
          } else {
            assert.equal(row.typeId, "expense");
            assert.equal(
              row.data.description,
              `T10 fixture ${input.fixtureNonce}: undated expense`,
              "Expense marker mismatch",
            );
            assert.equal(row.data.amount, 125.5);
            assert.equal(row.data.date, "2026-08-15");
            assert(!("issueDate" in row.data));
          }
        }
        const dependencies = (
          await client.query(
            `SELECT EXISTS (
          SELECT 1 FROM "DocumentPayment" WHERE "documentId"=ANY($1::text[])
          UNION ALL SELECT 1 FROM "ProjectDocumentLink" WHERE "documentId"=ANY($1::text[])
          UNION ALL SELECT 1 FROM "DocumentArchive" WHERE "documentId"=ANY($1::text[])
          UNION ALL SELECT 1 FROM "DocumentReminder" WHERE "documentId"=ANY($1::text[])
          UNION ALL SELECT 1 FROM "DocumentSchedule" WHERE "sourceDocumentId"=ANY($1::text[])
        ) AS present`,
            [candidateIds],
          )
        ).rows[0].present;
        assert.equal(dependencies, false, "Fixture already has dependents");
        for (const id of [...input.invoiceIds].sort()) {
          assert.equal(
            (
              await client.query(
                `UPDATE "DocumentInstance" SET status='sent',"displayNumber"=$1 WHERE id=$2 AND "companyId"=$3 AND "typeId"='invoice' AND status='draft'`,
                [`T10-LEGACY-${input.fixtureNonce}-${id}`, id, input.companyId],
              )
            ).rowCount,
            1,
          );
        }
        if (input.undatedExpenseId)
          assert.equal(
            (
              await client.query(
                `UPDATE "DocumentInstance" SET data=data-'date' WHERE id=$1 AND "companyId"=$2 AND "typeId"='expense' AND status='draft'`,
                [input.undatedExpenseId, input.companyId],
              )
            ).rowCount,
            1,
          );
        await client.query("COMMIT");
        return { issuedInvoiceIds: input.invoiceIds, undatedExpenseId: input.undatedExpenseId };
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        await client.end();
      }
    },
  };
}
