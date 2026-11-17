import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query"
import { act, renderHook, waitFor } from "@testing-library/react"
import { createElement, type ReactNode } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "@/hooks/use-api-query"
import { queryKeys } from "@/lib/query-keys"
import {
  useCreateReconciliationProject,
  useReconciliationClients,
  useReconciliationProjects,
  useUpdateReconciliationProject,
} from "./use-project-reconciliation"

const session = vi.hoisted(() => ({
  activeCompanyId: "company-a" as string | null,
  activeRole: "OWNER" as string | null,
}))
vi.mock("./use-companies", () => ({ useCompanies: () => session }))
afterEach(() => {
  vi.unstubAllGlobals()
  session.activeCompanyId = "company-a"
  session.activeRole = "OWNER"
})
function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
  return { client, wrapper }
}
const body = {
  name: "Delivery",
  endCustomerName: "Customer",
  currency: "NZD" as const,
  collectionMode: "COMPANY" as const,
  endCustomerClientId: null,
  partnerClientId: null,
  timeProjectId: null,
  description: null,
  expectedVersion: "new",
  requestKey: "create-1",
}

describe("project reconciliation transport", () => {
  it("sends server filters before pagination and uses company-scoped keys", async () => {
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL) =>
        new Response(JSON.stringify({ items: [], total: 47, nextCursor: null })),
    )
    vi.stubGlobal("fetch", fetcher)
    const { wrapper, client } = setup()
    const filters = {
      search: "Delivery & Co",
      status: "ALL" as const,
      collectionMode: "PARTNER" as const,
      needsAttention: "true" as const,
      cursor: "row-25",
    }
    const { result } = renderHook(() => useReconciliationProjects(filters), { wrapper })
    await waitFor(() => expect(result.current.data?.total).toBe(47))
    expect(String(fetcher.mock.calls[0]?.[0])).toContain(
      "/api/project-reconciliation/projects?search=Delivery+%26+Co&status=ALL&collectionMode=PARTNER&needsAttention=true&cursor=row-25&limit=25",
    )
    expect(client.getQueryCache().getAll()[0].queryKey).toEqual([
      "project-reconciliation",
      "company-a",
      "projects",
      filters,
    ])
    expect(queryKeys.projectReconciliation.all("company-a")).toEqual(["project-reconciliation", "company-a"])
  })
  it("never displays company A cache while switching to B and disables without a company", async () => {
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL) =>
        new Response(
          JSON.stringify({
            items: [
              {
                project: {
                  ...body,
                  requestKey: undefined,
                  expectedVersion: undefined,
                  id: "project-a",
                  companyId: "company-a",
                  status: "ACTIVE",
                  version: 1,
                  identityLocked: false,
                  createdAt: "2026-11-17T00:00:00Z",
                  updatedAt: "2026-11-17T00:00:00Z",
                  endCustomerClient: null,
                  partnerClient: null,
                  timeProject: null,
                },
                versionToken: "1:source",
                asOf: "2026-11-17T00:00:00Z",
                sourceFingerprint: "a".repeat(64),
                effectiveReviewState: "OPEN",
                attentionCount: 0,
                summary: Object.fromEntries(
                  [
                    "customerInvoiced",
                    "customerCredits",
                    "customerCollectible",
                    "customerRemaining",
                    "agreedSettlement",
                    "unbilledDifference",
                    "settlementInvoiced",
                    "ownRecordedReceipts",
                    "ownOutstanding",
                    "partnerBills",
                    "partnerPaid",
                    "partnerOutstanding",
                    "projectCosts",
                  ].map((key) => [key, { knownMinor: 0, missingCount: 0, completeness: "COMPLETE" }]),
                ),
              },
            ],
            total: 1,
            nextCursor: null,
          }),
        ),
    )
    vi.stubGlobal("fetch", fetcher)
    const { wrapper } = setup()
    const { result, rerender } = renderHook(() => useReconciliationProjects(), { wrapper })
    await waitFor(() => expect(result.current.data?.total).toBe(1))
    fetcher.mockImplementation(() => new Promise<Response>(() => {}))
    session.activeCompanyId = "company-b"
    rerender()
    expect(result.current.data).toBeUndefined()
    session.activeCompanyId = null
    rerender()
    expect(result.current.data).toBeUndefined()
    const calls = fetcher.mock.calls.length
    await act(async () => {
      await Promise.resolve()
    })
    expect(fetcher).toHaveBeenCalledTimes(calls)
  })
  it("scopes active client search and sends no request without a company", async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL) => new Response("[]"))
    vi.stubGlobal("fetch", fetcher)
    const { wrapper, client } = setup()
    const { result, rerender } = renderHook(() => useReconciliationClients("Acme & Sons", true), { wrapper })
    await waitFor(() => expect(result.current.data).toEqual([]))
    expect(String(fetcher.mock.calls[0]?.[0])).toContain("/api/clients/search?query=Acme%20%26%20Sons")
    expect(client.getQueryCache().getAll()[0].queryKey.slice(0, 2)).toEqual([
      "project-reconciliation",
      "company-a",
    ])
    session.activeCompanyId = null
    rerender()
    expect(result.current.data).toBeUndefined()
    expect(fetcher).toHaveBeenCalledTimes(1)
  })
  it("serializes DTO-only create/patch bodies, retains exact retry input and exposes 409", async () => {
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ code: "RECONCILIATION_CHANGED", message: "Changed" }), { status: 409 }),
    )
    vi.stubGlobal("fetch", fetcher)
    const { wrapper } = setup()
    const { result } = renderHook(
      () => ({
        create: useCreateReconciliationProject("company-a"),
        update: useUpdateReconciliationProject("company-a", "project-1"),
      }),
      { wrapper },
    )
    await act(async () => {
      await expect(result.current.create.mutateAsync(body)).rejects.toMatchObject({
        status: 409,
        body: { code: "RECONCILIATION_CHANGED" },
      })
      await expect(result.current.create.mutateAsync(body)).rejects.toBeInstanceOf(ApiError)
      await expect(
        result.current.update.mutateAsync({
          status: "ARCHIVED",
          requestKey: "archive-1",
          expectedVersion: "7:fingerprint",
        }),
      ).rejects.toMatchObject({ status: 409 })
    })
    expect(fetcher.mock.calls.map((call) => JSON.parse(String(call[1]?.body)))).toEqual([
      body,
      body,
      { status: "ARCHIVED", requestKey: "archive-1", expectedVersion: "7:fingerprint" },
    ])
    expect(fetcher.mock.calls[2][0]).toContain("/projects/project-1")
    expect(fetcher.mock.calls[2][1]?.method).toBe("PATCH")
  })
  it.each(["MEMBER", null])("refuses writes with role %s", async (role) => {
    session.activeRole = role
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    const { wrapper } = setup()
    const { result } = renderHook(() => useCreateReconciliationProject("company-a"), { wrapper })
    await act(async () => {
      await expect(result.current.mutateAsync(body)).rejects.toMatchObject({ status: 403 })
    })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("refuses an old company submission after a switch", async () => {
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    const { wrapper } = setup()
    const { result, rerender } = renderHook(() => useCreateReconciliationProject("company-a"), { wrapper })
    session.activeCompanyId = "company-b"
    rerender()
    await act(async () => {
      await expect(result.current.mutateAsync(body)).rejects.toMatchObject({ status: 403 })
    })
    expect(fetcher).not.toHaveBeenCalled()
  })
  it("does not fetch or write without an active company", async () => {
    session.activeCompanyId = null
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    const { wrapper } = setup()
    const { result } = renderHook(
      () => ({ query: useReconciliationProjects(), create: useCreateReconciliationProject("company-a") }),
      { wrapper },
    )
    expect(result.current.query.data).toBeUndefined()
    await act(async () => {
      await expect(result.current.create.mutateAsync(body)).rejects.toMatchObject({ status: 403 })
    })
    expect(fetcher).not.toHaveBeenCalled()
  })
})

import {
  useCreateReconciliationCase,
  useUpdateReconciliationCase,
  useCreateExternalInvoice,
  useUpdateExternalInvoice,
  useExternalCreditAdjustment,
  useCreateExternalReceipt,
  useUpdateExternalReceipt,
  useVoidExternalReceipt,
  useLinkReconciliationDocument,
  useUnlinkReconciliationDocument,
  useAttestReconciliationCoverage,
  useReviewReconciliationCase,
} from "./use-project-reconciliation"

function useDetailWrites() {
  return [
    useCreateReconciliationCase("company-a", "project /1"),
    useUpdateReconciliationCase("company-a", "project /1", "case /1"),
    useCreateExternalInvoice("company-a", "project /1", "case /1"),
    useUpdateExternalInvoice("company-a", "project /1", "case /1", "invoice /1"),
    useExternalCreditAdjustment("company-a", "project /1", "invoice /1"),
    useCreateExternalReceipt("company-a", "project /1"),
    useUpdateExternalReceipt("company-a", "project /1", "receipt /1"),
    useVoidExternalReceipt("company-a", "project /1", "receipt /1"),
    useLinkReconciliationDocument("company-a", "project /1"),
    useUnlinkReconciliationDocument("company-a", "project /1", "link /1"),
    useAttestReconciliationCoverage("company-a", "project /1"),
    useReviewReconciliationCase("company-a", "project /1", "case /1"),
  ]
}
const detailRoutes = [
  ["POST", "cases"],
  ["PATCH", "cases/case%20%2F1"],
  ["POST", "cases/case%20%2F1/customer-invoices"],
  ["PATCH", "cases/case%20%2F1/customer-invoices/invoice%20%2F1"],
  ["POST", "customer-invoices/invoice%20%2F1/credit-adjustments"],
  ["POST", "receipts"],
  ["PATCH", "receipts/receipt%20%2F1"],
  ["POST", "receipts/receipt%20%2F1/void"],
  ["POST", "document-links"],
  ["POST", "document-links/link%20%2F1/unlink"],
  ["POST", "evidence-coverage"],
  ["POST", "cases/case%20%2F1/review"],
]
const detailInputs = [
  {
    title: "Case A",
    periodStart: null,
    periodEnd: null,
    agreedGrossMinor: null,
    agreedNetMinor: null,
    agreedVatMinor: null,
    agreementReference: null,
  },
  { title: "Revised case" },
  {
    issuer: "Partner",
    recipient: "Customer",
    number: "EXT-1",
    issueDate: null,
    dueDate: null,
    currency: "NZD",
    grossMinor: 1000,
    netMinor: null,
    vatMinor: null,
    reportedStatus: "Paid",
    sourceSystem: null,
    sourceId: null,
    sourceAsOf: null,
    sourceReference: "Source 1",
  },
  { sourceReference: "Revised reference" },
  { amountMinor: 100, sourceReference: "Credit 1", reason: "Correction" },
  {
    amountMinor: 1000,
    currency: "NZD",
    paidOn: null,
    evidenceClass: "PARTNER_REPORTED",
    evidenceReference: null,
    evidenceUrl: null,
    reason: "Partner statement",
  },
  { paidOn: null, reason: "Date remains unknown" },
  { reason: "Duplicate receipt" },
  { documentId: "doc-1", typeId: "invoice", caseId: "case-1", role: "CUSTOMER_INVOICE" },
  { reason: "Wrong project" },
  {
    customerInvoiceIds: ["invoice-1"],
    sourceAsOf: "2026-01-01T00:00:00Z",
    evidenceReference: "Statement 1",
    attested: true,
  },
  { mode: "REOPEN", exceptions: [], reason: "Review source changes" },
]
const caseResult = {
  ...detailInputs[0],
  id: "case-1",
  companyId: "company-a",
  projectId: "project /1",
  status: "OPEN",
  version: 1,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}
const invoiceResult = {
  id: "invoice-1",
  companyId: "company-a",
  projectId: "project /1",
  caseId: "case /1",
  documentLinkId: null,
  external: detailInputs[2],
  originalGrossMinor: 1000,
  creditAdjustmentMinor: 0,
  adjustedGrossMinor: 1000,
  sourceSnapshot: {},
  snapshotHash: "a".repeat(64),
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}
const receiptResult = {
  ...detailInputs[5],
  id: "receipt-1",
  companyId: "company-a",
  projectId: "project /1",
  collector: "Partner",
  sourceReference: "Partner statement",
  sourceSystem: null,
  sourceId: null,
  enteredBy: "user:1",
  reviewedBy: null,
  reviewedAt: null,
  humanAttestation: null,
  version: 1,
  voidedAt: null,
  voidedBy: null,
  voidReason: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}
const linkResult = { id: "link-1", ...detailInputs[8] }
const detailResults = [
  caseResult,
  caseResult,
  invoiceResult,
  invoiceResult,
  invoiceResult,
  receiptResult,
  receiptResult,
  { ...receiptResult, voidedAt: "2026-01-02T00:00:00Z", voidedBy: "user:1", voidReason: "Duplicate receipt" },
  linkResult,
  linkResult,
  {
    ...detailInputs[10],
    receiptIds: ["receipt-1"],
    allocationIds: [],
    sourceFingerprint: "a".repeat(64),
    attestedBy: "user:1",
    attestedAt: "2026-01-01T00:00:00Z",
  },
  {
    case: caseResult,
    ...detailInputs[11],
    sourceFingerprint: "a".repeat(64),
    reviewedBy: "user:1",
    reviewedAt: "2026-01-01T00:00:00Z",
  },
]
describe("accepted detail mutation routes", () => {
  it("uses encoded nested targets and invalidates only the bound company after success", async () => {
    let responseIndex = 0
    const fetcher = vi.fn(
      async (_url: RequestInfo | URL, _init?: RequestInit) =>
        new Response(
          JSON.stringify({ result: detailResults[responseIndex++], versionToken: "next", changed: true }),
        ),
    )
    vi.stubGlobal("fetch", fetcher)
    const { wrapper, client } = setup()
    client.setQueryData(["project-reconciliation", "company-a", "project", "x"], "old-a")
    client.setQueryData(["project-reconciliation", "company-b", "project", "x"], "old-b")
    const { result } = renderHook(useDetailWrites, { wrapper })
    const envelope = { expectedVersion: "7:canonical", requestKey: "exact-attempt" }
    for (const [index, mutation] of result.current.entries())
      await act(async () => {
        await mutation.mutateAsync({ ...detailInputs[index], ...envelope } as never)
      })
    expect(
      fetcher.mock.calls.map(([url, init]) => [
        String(url).split("/projects/")[1],
        init?.method,
        JSON.parse(String(init?.body)),
      ]),
    ).toEqual(
      detailRoutes.map(([method, suffix], index) => [
        `project%20%2F1/${suffix}`,
        method,
        { ...detailInputs[index], ...envelope },
      ]),
    )
    expect(client.getQueryState(["project-reconciliation", "company-a", "project", "x"])?.isInvalidated).toBe(
      true,
    )
    expect(client.getQueryState(["project-reconciliation", "company-b", "project", "x"])?.isInvalidated).toBe(
      false,
    )
  })
  it.each([
    "MEMBER",
    null,
    "old-company",
  ])("rejects every detail write for %s before transport", async (state) => {
    const { wrapper } = setup()
    const fetcher = vi.fn()
    vi.stubGlobal("fetch", fetcher)
    const { result, rerender } = renderHook(useDetailWrites, { wrapper })
    if (state === "old-company") session.activeCompanyId = "company-b"
    else session.activeRole = state
    rerender()
    for (const mutation of result.current)
      await act(async () => {
        await expect(
          mutation.mutateAsync({ requestKey: "x", expectedVersion: "v" } as never),
        ).rejects.toMatchObject({ status: 403 })
      })
    expect(fetcher).not.toHaveBeenCalled()
  })
})

import {
  useReconciliationProject,
  useReconciliationReceipts,
  useReconciliationInvoiceChoices,
  useReconciliationHistory,
  useReplaceReceiptAllocations,
  useExportReconciliationCsv,
} from "./use-project-reconciliation"
describe("accepted T6 detail read transport", () => {
  it("uses independent company/project/cursor keys and exact civil report query bounds", async () => {
    const urls: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url)
        return new Response(JSON.stringify({ items: [], nextCursor: null, total: 0 }))
      }),
    )
    const { wrapper, client } = setup()
    client.setDefaultOptions({ queries: { retry: false, staleTime: 30000 } })
    renderHook(
      () => ({
        detail: useReconciliationProject("p /1", {
          cursor: "case-25",
          invoiceFrom: "2026-01-01",
          cashTo: "2026-11-17",
        }),
        receipts: useReconciliationReceipts("p /1", { cursor: "receipt-25" }),
        choices: useReconciliationInvoiceChoices("p /1", { search: "EXT & Co", cursor: "invoice-25" }),
        history: useReconciliationHistory("p /1", { cursor: "audit-25" }),
      }),
      { wrapper },
    )
    await waitFor(() => expect(urls).toHaveLength(4))
    expect(urls).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "/projects/p%20%2F1?cursor=case-25&invoiceFrom=2026-01-01&cashTo=2026-11-17&limit=25",
        ),
        expect.stringContaining("/projects/p%20%2F1/receipts?cursor=receipt-25&limit=25"),
        expect.stringContaining(
          "/projects/p%20%2F1/customer-invoices?search=EXT+%26+Co&cursor=invoice-25&limit=25",
        ),
        expect.stringContaining("/projects/p%20%2F1/history?cursor=audit-25&limit=25"),
      ]),
    )
    for (const query of client.getQueryCache().getAll())
      expect(query.queryKey.slice(0, 2)).toEqual(["project-reconciliation", "company-a"])
    await act(async () => {
      focusManager.setFocused(false)
      focusManager.setFocused(true)
    })
    await waitFor(() => expect(urls.filter((url) => url.includes("/projects/p%20%2F1?"))).toHaveLength(2))
  })
  it("replaces the complete allocation set on the receipt endpoint with the aggregate token", async () => {
    const calls: { url: string; init: RequestInit }[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init })
        return new Response(
          JSON.stringify({
            result: { receiptId: "r /1", allocations: [], allocatedMinor: 0, unallocatedMinor: 100 },
            versionToken: "2:source",
            changed: true,
          }),
        )
      }),
    )
    const { wrapper } = setup()
    const { result } = renderHook(() => useReplaceReceiptAllocations("company-a", "p /1", "r /1"), {
      wrapper,
    })
    await act(async () => {
      await result.current.mutateAsync({
        allocations: [],
        requestKey: "reverse",
        expectedVersion: "1:canonical",
      })
    })
    expect(calls[0].url).toContain("/projects/p%20%2F1/receipts/r%20%2F1/allocations")
    expect(calls[0].init.method).toBe("PUT")
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      allocations: [],
      requestKey: "reverse",
      expectedVersion: "1:canonical",
    })
  })
  it("exports all server cases using exactly the active report date filters without a case cursor", async () => {
    const urls: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url)
        return new Response("section,label,amount\nsummary,overall,1", {
          headers: { "content-type": "text/csv" },
        })
      }),
    )
    const { wrapper } = setup()
    const { result } = renderHook(
      () =>
        useExportReconciliationCsv("company-a", "p /1", {
          invoiceFrom: "2026-01-01",
          invoiceTo: "2026-02-01",
          cashFrom: "2026-03-01",
        }),
      { wrapper },
    )
    let blob!: Blob
    await act(async () => {
      blob = await result.current.mutateAsync()
    })
    expect(urls).toEqual([
      expect.stringContaining(
        "/projects/p%20%2F1/export.csv?invoiceFrom=2026-01-01&invoiceTo=2026-02-01&cashFrom=2026-03-01",
      ),
    ])
    expect(blob.size).toBeGreaterThan(0)
  })
})

import { usePreviewReconciliationImport, useConfirmReconciliationImport } from "./use-project-reconciliation"
import importFixture from "@/pages/(app)/project-reconciliation/_components/import-fixtures.json"
it("uses exact published preview input without envelope and confirm with matches/hash/envelope on project routes only", async () => {
  const requests: { url: string; body: unknown }[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, body: JSON.parse(String(init?.body)) })
      return new Response(
        JSON.stringify(url.endsWith("/preview") ? importFixture.preview : importFixture.result),
      )
    }),
  )
  const { wrapper } = setup()
  const { result } = renderHook(
    () => ({
      preview: usePreviewReconciliationImport("company-a", "project-1"),
      confirm: useConfirmReconciliationImport("company-a", "project-1"),
    }),
    { wrapper },
  )
  await act(async () => {
    await result.current.preview.mutateAsync(importFixture.previewInput as never)
    await result.current.confirm.mutateAsync(importFixture.confirmBody as never)
  })
  expect(requests).toEqual([
    { url: expect.stringContaining("/projects/project-1/import/preview"), body: importFixture.previewInput },
    { url: expect.stringContaining("/projects/project-1/import/confirm"), body: importFixture.confirmBody },
  ])
})
