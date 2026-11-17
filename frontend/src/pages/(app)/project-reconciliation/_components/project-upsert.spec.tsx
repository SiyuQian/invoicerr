import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { ProjectUpsert, buildProjectSchema } from "./project-upsert"
import i18n from "i18next"
import type { ProjectListRow, ProjectSummary } from "@/types/project-reconciliation"

vi.mock("@/hooks/queries/use-companies", () => ({
  useCompanies: () => ({ activeCompanyId: "company-a", activeRole: "OWNER" }),
}))
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})
afterEach(() => vi.unstubAllGlobals())
const input = {
  name: "Delivery",
  endCustomerName: "Example customer",
  currency: "NZD",
  collectionMode: "COMPANY",
  endCustomerClientId: null,
  partnerClientId: null,
  timeProjectId: null,
  description: null,
}
function existingRow(locked = false): ProjectListRow {
  const measure = { knownMinor: 0, missingCount: 0, completeness: "COMPLETE" as const }
  const summary: ProjectSummary = {
    customerInvoiced: measure,
    customerCredits: measure,
    customerCollectible: measure,
    customerRemaining: measure,
    agreedSettlement: measure,
    unbilledDifference: measure,
    settlementInvoiced: measure,
    ownRecordedReceipts: measure,
    ownOutstanding: measure,
    partnerBills: measure,
    partnerPaid: measure,
    partnerOutstanding: measure,
    projectCosts: measure,
  }
  return {
    project: {
      ...input,
      currency: "NZD",
      collectionMode: "COMPANY",
      id: "project-1",
      companyId: "company-a",
      partnerClientId: "old-partner",
      partnerClient: { id: "old-partner", name: "Historic partner", inactive: true },
      endCustomerClientId: "current-customer",
      endCustomerClient: { id: "current-customer", name: "Current customer", inactive: false },
      timeProjectId: "current-billing",
      timeProject: { id: "current-billing", name: "Current billing", inactive: false },
      identityLocked: locked,
      status: "ACTIVE",
      version: 9,
      createdAt: "2026-11-17T00:00:00Z",
      updatedAt: "2026-11-17T00:00:00Z",
    },
    summary,
    versionToken: "9:source-fingerprint",
    sourceFingerprint: "a".repeat(64),
    asOf: "2026-11-17T00:00:00Z",
    attentionCount: 0,
    effectiveReviewState: "OPEN",
  }
}
const selectorCases = [
  { label: /^Currency/, current: /NZD/, next: /AUD/, field: "currency", value: "AUD" },
  {
    label: /^Collector/,
    current: "Company collects",
    next: "Partner collects",
    field: "collectionMode",
    value: "PARTNER",
  },
  {
    label: /^End customer client/,
    current: "Current customer",
    next: "None selected",
    field: "endCustomerClientId",
    value: null,
  },
  {
    label: /^Partner client/,
    current: "Historic partner (Inactive)",
    next: "None selected",
    field: "partnerClientId",
    value: null,
  },
  {
    label: /^Time-tracking project/,
    current: "Current billing",
    next: "None selected",
    field: "timeProjectId",
    value: null,
  },
]
function mountExisting(row: ProjectListRow, onReload = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <ProjectUpsert row={row} companyId="company-a" open onOpenChange={vi.fn()} onReload={onReload} />
    </QueryClientProvider>,
  )
}
describe("project register form", () => {
  it("accepts explicit nulls without adding agreement fields, validates direction, currency and distinct parties", () => {
    const schema = buildProjectSchema(i18n.t)
    expect(schema.parse(input)).toEqual(input)
    expect(schema.safeParse({ ...input, collectionMode: "PARTNER" }).success).toBe(false)
    expect(
      schema.safeParse({ ...input, collectionMode: "PARTNER", partnerClientId: "partner-1" }).success,
    ).toBe(true)
    expect(schema.safeParse({ ...input, partnerClientId: "same", endCustomerClientId: "same" }).success).toBe(
      false,
    )
    expect(schema.safeParse({ ...input, currency: "ZZZ" }).success).toBe(false)
    expect(schema.safeParse({ ...input, agreedGrossMinor: 0 }).success).toBe(false)
  })
  it("keeps exact create retries through picker search and reselection, with new keys after field edits", async () => {
    const requests: Record<string, unknown>[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          requests.push(JSON.parse(String(init.body)))
          throw new TypeError("Response lost after create")
        }
        return new Response(JSON.stringify(url.includes("/api/projects") ? [] : []))
      }),
    )
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    })
    render(
      <QueryClientProvider client={client}>
        <ProjectUpsert companyId="company-a" open onOpenChange={vi.fn()} onReload={vi.fn()} />
      </QueryClientProvider>,
    )
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: "Delivery" } })
    fireEvent.change(screen.getByLabelText(/End customer name/), { target: { value: "Example customer" } })
    fireEvent.click(screen.getByRole("button", { name: /^Currency/ }))
    fireEvent.change(screen.getByPlaceholderText("Search currencies"), { target: { value: "NZD" } })
    fireEvent.click(await screen.findByRole("option", { name: /NZD/ }))
    fireEvent.click(screen.getByRole("button", { name: "Create project" }))
    await screen.findByRole("alert")
    for (const { label, current, field } of selectorCases) {
      fireEvent.click(screen.getByRole("button", { name: label }))
      fireEvent.click(
        await screen.findByRole("option", { name: field.endsWith("Id") ? "None selected" : current }),
      )
    }
    fireEvent.click(screen.getByRole("button", { name: "Create project" }))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[0]).toEqual(requests[1])
    expect(requests[0]).toMatchObject({ ...input, expectedVersion: "new" })
    fireEvent.click(screen.getByRole("button", { name: /^Currency/ }))
    fireEvent.change(screen.getByPlaceholderText("Search currencies"), { target: { value: "AUD" } })
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" })
    fireEvent.click(screen.getByRole("button", { name: "Create project" }))
    await waitFor(() => expect(requests).toHaveLength(3))
    expect(requests[2]).toEqual(requests[0])
    await screen.findByRole("alert")
    fireEvent.click(screen.getByRole("button", { name: /^End customer client/ }))
    fireEvent.change(screen.getByPlaceholderText("Search clients"), { target: { value: "Missing" } })
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" })
    fireEvent.click(screen.getByRole("button", { name: "Create project" }))
    await waitFor(() => expect(requests).toHaveLength(4))
    expect(requests[3]).toEqual(requests[0])
    await screen.findByRole("alert")
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: "Changed delivery" } })
    fireEvent.click(screen.getByRole("button", { name: "Create project" }))
    await waitFor(() => expect(requests).toHaveLength(5))
    expect(requests[4].requestKey).not.toBe(requests[0].requestKey)
    expect(requests[4].name).toBe("Changed delivery")
    await screen.findByRole("alert")
    fireEvent.change(screen.getByLabelText("Description"), { target: { value: "New description" } })
    fireEvent.click(screen.getByRole("button", { name: "Create project" }))
    await waitFor(() => expect(requests).toHaveLength(6))
    expect(requests[5].requestKey).not.toBe(requests[4].requestKey)
    expect(requests[5].description).toBe("New description")
    expect(screen.queryByText(/Agreed settlement/)).not.toBeInTheDocument()
  })
  it.each(
    selectorCases,
  )("keeps exact retries after same $field and changes the key after a new selection", async ({
    label,
    current,
    next,
    field,
    value,
  }) => {
    const requests: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          requests.push(String(init.body))
          throw new TypeError("Response lost after update")
        }
        return new Response("[]")
      }),
    )
    mountExisting(existingRow())
    fireEvent.click(screen.getByRole("button", { name: "Save project" }))
    await screen.findByRole("alert")
    fireEvent.click(screen.getByRole("button", { name: label }))
    fireEvent.click(await screen.findByRole("option", { name: current }))
    fireEvent.click(screen.getByRole("button", { name: "Save project" }))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]).toBe(requests[0])
    await screen.findByRole("alert")
    fireEvent.click(screen.getByRole("button", { name: label }))
    fireEvent.click(await screen.findByRole("option", { name: next }))
    fireEvent.click(screen.getByRole("button", { name: "Save project" }))
    await waitFor(() => expect(requests).toHaveLength(3))
    expect(JSON.parse(requests[2])).toMatchObject({ [field]: value, expectedVersion: "9:source-fingerprint" })
    expect(JSON.parse(requests[2]).requestKey).not.toBe(JSON.parse(requests[0]).requestKey)
    if (value === null) {
      await screen.findByRole("alert")
      fireEvent.click(screen.getByRole("button", { name: label }))
      fireEvent.click(await screen.findByRole("option", { name: "None selected" }))
      fireEvent.click(screen.getByRole("button", { name: "Save project" }))
      await waitFor(() => expect(requests).toHaveLength(4))
      expect(requests[3]).toBe(requests[2])
    }
  })
  it("retains inactive labels and clears an optional partner with explicit null", async () => {
    const requests: Record<string, unknown>[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === "PATCH") {
          requests.push(JSON.parse(String(init.body)))
          return new Response(
            JSON.stringify({ result: existingRow().project, versionToken: "10:new", changed: true }),
          )
        }
        return new Response("[]")
      }),
    )
    mountExisting(existingRow())
    expect(screen.getByRole("button", { name: /^Partner client/ })).toHaveTextContent(
      "Historic partner (Inactive)",
    )
    fireEvent.click(screen.getByRole("button", { name: /^Partner client/ }))
    fireEvent.click(await screen.findByRole("option", { name: "None selected" }))
    fireEvent.click(screen.getByRole("button", { name: "Save project" }))
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0]).toMatchObject({ partnerClientId: null, expectedVersion: "9:source-fingerprint" })
  })
  it("uses server identityLocked for disabled controls and still permits spelling edits", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("[]")),
    )
    mountExisting(existingRow(true))
    expect(screen.getByRole("button", { name: /^Currency/ })).toBeDisabled()
    expect(screen.getByRole("button", { name: /^Collector/ })).toBeDisabled()
    expect(screen.getByRole("button", { name: /^End customer client/ })).toBeDisabled()
    expect(screen.getByRole("button", { name: /^Partner client/ })).toBeDisabled()
    expect(screen.getByLabelText(/Project name/)).not.toBeDisabled()
    expect(screen.getByLabelText(/End customer name/)).not.toBeDisabled()
  })
  it.each(selectorCases)("retains 409 when reselecting the same $field", async ({ label, current, next }) => {
    const reload = vi.fn(async () => "10:fresh")
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async (_url: string, init?: RequestInit) =>
          new Response(
            init?.method ? JSON.stringify({ code: "RECONCILIATION_CHANGED", message: "Changed" }) : "[]",
            { status: init?.method ? 409 : 200 },
          ),
      ),
    )
    mountExisting(existingRow(), reload)
    fireEvent.click(screen.getByRole("button", { name: "Save project" }))
    await screen.findByText("This project changed. Reload it before saving your changes.")
    expect(screen.getByRole("button", { name: "Save project" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: /^Currency/ }))
    fireEvent.change(screen.getByPlaceholderText("Search currencies"), { target: { value: "AUD" } })
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" })
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This project changed. Reload it before saving your changes.",
    )
    expect(screen.getByRole("button", { name: "Save project" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: label }))
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "" } })
    fireEvent.click(await screen.findByRole("option", { name: current }))
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This project changed. Reload it before saving your changes.",
    )
    expect(screen.getByRole("button", { name: "Save project" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Reload project" }))
    expect(reload).toHaveBeenCalledOnce()
    await waitFor(() => expect(screen.getByRole("button", { name: "Save project" })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: label }))
    fireEvent.click(await screen.findByRole("option", { name: next }))
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Save project" })).not.toBeDisabled()
  })
  it("searches active client candidates and saves the selected collecting partner", async () => {
    const urls: string[] = []
    const bodies: Record<string, unknown>[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        urls.push(url)
        if (init?.method === "PATCH") {
          bodies.push(JSON.parse(String(init.body)))
          return new Response(
            JSON.stringify({ result: existingRow().project, versionToken: "10:new", changed: true }),
          )
        }
        return new Response(
          JSON.stringify(
            url.includes("query=Current")
              ? [{ id: "active-client", name: "Current partner", type: "COMPANY", isActive: true }]
              : [],
          ),
        )
      }),
    )
    mountExisting(existingRow())
    fireEvent.click(screen.getByRole("button", { name: /^Collector/ }))
    fireEvent.click(await screen.findByRole("option", { name: "Partner collects" }))
    fireEvent.click(screen.getByRole("button", { name: /^Partner client/ }))
    fireEvent.change(screen.getByPlaceholderText("Search clients"), { target: { value: "Current" } })
    fireEvent.click(await screen.findByRole("option", { name: "Current partner" }))
    fireEvent.click(screen.getByRole("button", { name: "Save project" }))
    await waitFor(() => expect(bodies).toHaveLength(1))
    expect(urls.some((url) => url.endsWith("/api/clients/search?query=Current"))).toBe(true)
    expect(bodies[0]).toMatchObject({
      collectionMode: "PARTNER",
      partnerClientId: "active-client",
      endCustomerName: "Example customer",
      expectedVersion: "9:source-fingerprint",
    })
  })

  it("filters optional billing project options without changing time entries", async () => {
    const fetcher = vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify(
            url.endsWith("/api/projects")
              ? [
                  { id: "billing-one", name: "Alpha billing" },
                  { id: "billing-two", name: "Beta billing" },
                ]
              : [],
          ),
        ),
    )
    vi.stubGlobal("fetch", fetcher)
    mountExisting(existingRow())
    fireEvent.click(screen.getByRole("button", { name: /^Time-tracking project/ }))
    await screen.findByRole("option", { name: "Beta billing" })
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "Alpha" } })
    expect(screen.queryByRole("option", { name: "Beta billing" })).not.toBeInTheDocument()
    expect(screen.getByRole("option", { name: "Alpha billing" })).toBeInTheDocument()
    expect(fetcher.mock.calls.every(([url]) => !url.includes("time-entries"))).toBe(true)
  })
})

it("retains the exact request through normalized name/customer/description whitespace edits", async () => {
  const requests: Record<string, unknown>[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        requests.push(JSON.parse(String(init.body)))
        throw new TypeError("Response lost")
      }
      return new Response("[]")
    }),
  )
  const row = existingRow()
  row.project.description = "Existing notes"
  mountExisting(row)
  fireEvent.click(screen.getByRole("button", { name: "Save project" }))
  await screen.findByRole("alert")
  for (const [label, value] of [
    [/Project name/, " Delivery "],
    [/End customer name/, " Example customer "],
    ["Description", " Existing notes "],
  ] as const) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } })
    fireEvent.click(screen.getByRole("button", { name: "Save project" }))
    await waitFor(() => expect(requests.length).toBeGreaterThan(1))
    await screen.findByRole("alert")
  }
  expect(requests).toHaveLength(4)
  expect(requests.slice(1)).toEqual([requests[0], requests[0], requests[0]])
})
