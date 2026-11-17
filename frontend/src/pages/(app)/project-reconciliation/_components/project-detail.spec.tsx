import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within, act } from "@testing-library/react"
import { MemoryRouter, Routes, Route } from "react-router"
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest"
import type { ProjectView, ReceiptPage, HistoryPage } from "@/types/project-reconciliation"
import fixture from "./reconciliation-fixtures.json"
import DetailPage from "../[id]"
import { Warnings } from "./read-parts"
const session = vi.hoisted(() => ({
  activeCompanyId: "invented-company" as string | null,
  activeRole: "OWNER" as string | null,
}))
vi.mock("@/hooks/queries/use-companies", () => ({ useCompanies: () => session }))
vi.mock("@/hooks/use-page-header", () => ({ usePageHeader: vi.fn() }))
beforeEach(() => {
  session.activeCompanyId = "invented-company"
  session.activeRole = "OWNER"
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
function data() {
  return structuredClone(fixture) as unknown as {
    detail: ProjectView
    receipts: ReceiptPage
    customerInvoices: typeof fixture.customerInvoices
    history: HistoryPage
  }
}
function serve(state = data(), failDetail = false) {
  const calls: { url: string; init?: RequestInit }[] = []
  const exactCase = structuredClone(state.detail.cases.items[0])
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      if (init?.method)
        return new Response(
          JSON.stringify({ code: "ALLOCATION_EXCEEDS_AVAILABLE", message: "Allocation changed" }),
          { status: 409 },
        )
      if (url.includes("caseId="))
        return new Response(
          JSON.stringify({
            ...state.detail,
            cases: {
              items: [state.detail.cases.items.find((x) => x.id === exactCase.id) ?? exactCase],
              total: 1,
              nextCursor: null,
            },
          }),
        )
      if (url.includes("/receipts?")) return new Response(JSON.stringify(state.receipts))
      if (url.includes("/customer-invoices?")) return new Response(JSON.stringify(state.customerInvoices))
      if (url.includes("/history?")) return new Response(JSON.stringify(state.history))
      if (failDetail) return new Response(JSON.stringify({ message: "Unavailable" }), { status: 503 })
      return new Response(JSON.stringify(state.detail))
    }),
  )
  return calls
}
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/project-reconciliation/invented-project"]}>
        <Routes>
          <Route path="/project-reconciliation/:id" element={<DetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
const tab = async (name: string) => {
  fireEvent.mouseDown(await screen.findByRole("tab", { name }), { button: 0, ctrlKey: false })
  await waitFor(() => expect(screen.getByRole("tab", { name })).toHaveAttribute("data-state", "active"))
}
it("keeps financial uncertainty and omitted facts visible while disclosing the server explanation", async () => {
  const message = "A document with unknown date was omitted from period amounts."
  render(
    <Warnings
      currency="NZD"
      warnings={[
        { code: "INVOICE_DATE_UNKNOWN", message, params: { omittedKnownMinor: 12345, count: 2 } },
        { code: "FINANCIAL_READ_UNAVAILABLE", message: "Financial sources could not be read." },
      ]}
    />,
  )
  expect(screen.getByText(/^Invoice date unknown/)).toBeVisible()
  expect(screen.getByText(/Omitted amount:.*123\.45/)).toBeVisible()
  expect(screen.getByText(/Records: 2/)).toBeVisible()
  expect(screen.getByText("Financial data unavailable")).toBeVisible()
  expect(screen.getByText(message)).not.toBeVisible()
  fireEvent.click(screen.getByRole("button", { name: /Invoice date unknown/ }))
  await waitFor(() =>
    expect(
      screen.getAllByText(message).some((node) => !node.hidden && node.closest("[hidden]") === null),
    ).toBe(true),
  )
})
describe("canonical project detail", () => {
  it("uses three house tabs and separates source Paid, unknown evidence, canonical payments and current server coverage", async () => {
    const state = data()
    state.detail.cases.items[0].coverage.state = "STALE"
    state.detail.cases.items[0].coverage.invoices[0].current = false
    serve(state)
    mount()
    await screen.findByRole("heading", { name: "Invented project" })
    expect(screen.getAllByRole("tab")).toHaveLength(3)
    expect(screen.getByRole("button", { name: /Invoice date from/ })).toHaveTextContent("Any date")
    expect(screen.getByRole("button", { name: /Receipt date from/ })).toHaveTextContent("Any date")
    expect(screen.getByText("Marked paid by source")).toBeInTheDocument()
    expect(screen.getByText("Partner reported receipts")).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Expand Invented milestone" }))
    expect(screen.getByText("Coverage stale")).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "OWN-EXAMPLE-1" })).toHaveAttribute(
      "href",
      "/documents/invoice/invented-document",
    )
    expect(screen.getByText(/^Recorded payment ·/)).toBeInTheDocument()
    expect(screen.getByText("Payment data: Available")).toBeInTheDocument()
    await tab("Evidence and differences")
    const evidence = screen.getByText(/Invented proof/).closest("article")!
    expect(within(evidence).getByText("Unknown date")).toBeInTheDocument()
    await tab("Costs and history")
    expect(screen.getByRole("heading", { name: "Receipt recorded" })).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Change history" })).toBeInTheDocument()
    expect(screen.getByText(/^user:invented-reviewer ·/)).toBeInTheDocument()
  })
  it("represents a COMPANY own customer invoice once and keeps cancelled canonical cash/balance visible", async () => {
    const state = data()
    const link = state.detail.cases.items[0].documentLinks[0]
    link.role = "CUSTOMER_INVOICE"
    link.financial.status = "cancelled"
    link.financial.settlement!.outstandingMinor = 250
    state.detail.project.collectionMode = "COMPANY"
    state.detail.cases.items[0].customerInvoices = [
      { id: "own-ref", caseId: "invented-case", documentLinkId: link.id, external: null },
    ]
    state.detail.cases.items[0].coverage = { state: "NOT_APPLICABLE", invoices: [] }
    serve(state)
    mount()
    await screen.findByRole("heading", { name: "Invented project" })
    fireEvent.click(screen.getByRole("button", { name: "Expand Invented milestone" }))
    expect(screen.getAllByRole("link", { name: "OWN-EXAMPLE-1" })).toHaveLength(1)
    expect(screen.getByText("cancelled")).toBeInTheDocument()
    expect(screen.getAllByText(/2\.50 NZD/).length).toBeGreaterThan(0)
    expect(screen.queryByText("Marked paid by source")).not.toBeInTheDocument()
    expect(screen.getByText(/^Recorded payment ·/)).toBeInTheDocument()
  })
  it("shows a consolidated document once at project level and never inside a case chain", async () => {
    const state = data()
    const link = state.detail.cases.items[0].documentLinks.pop()!
    link.caseId = null
    state.detail.unallocatedDocumentLinks = [link]
    serve(state)
    mount()
    await screen.findByRole("heading", { name: "Invented project" })
    fireEvent.click(screen.getByRole("button", { name: "Expand Invented milestone" }))
    expect(screen.getByText("Not allocated to cases")).toBeInTheDocument()
    expect(screen.getAllByRole("link", { name: "OWN-EXAMPLE-1" })).toHaveLength(1)
  })
  it("uses independent case/receipt/history cursors and sends civil date filters only to report/export", async () => {
    const state = data()
    state.detail.cases.nextCursor = "case-25"
    state.receipts.nextCursor = "receipt-25"
    state.history.nextCursor = "audit-25"
    const calls = serve(state)
    mount()
    await screen.findByRole("heading", { name: "Invented project" })
    fireEvent.click(screen.getByRole("button", { name: "Next cases" }))
    await waitFor(() => expect(calls.some((x) => x.url.includes("cursor=case-25"))).toBe(true))
    await tab("Evidence and differences")
    fireEvent.click(screen.getByRole("button", { name: "Next receipts" }))
    await waitFor(() => expect(calls.some((x) => x.url.includes("/receipts?cursor=receipt-25"))).toBe(true))
    await tab("Costs and history")
    fireEvent.click(screen.getByRole("button", { name: "Next history" }))
    await waitFor(() => expect(calls.some((x) => x.url.includes("/history?cursor=audit-25"))).toBe(true))
    expect(
      calls
        .filter((x) => x.url.includes("/history?"))
        .every((x) => !x.url.includes("case-25") && !x.url.includes("receipt-25")),
    ).toBe(true)
  })
  it("suppresses cached success views after a failed refresh and offers retry", async () => {
    const state = data()
    state.detail.effectiveReviewState = "CLOSED_VERIFIED"
    serve(state)
    mount()
    await screen.findByRole("heading", { name: "Invented project" })
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "Unavailable" }), { status: 503 })),
    )
    fireEvent.click(screen.getByRole("button", { name: "Refresh project" }))
    await screen.findByText("Could not refresh this project. The previous financial snapshot is not current.")
    expect(screen.queryByText("Verified review")).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
  })
  it("shows typed unsupported balances as unknown, while an actual canonical outage disables new review", async () => {
    const state = data()
    state.detail.warnings = [{ code: "FINANCIAL_READ_UNAVAILABLE", message: "Canonical unavailable" }]
    state.detail.cases.items[0].documentLinks[0].financial.paymentKnowledge = "UNKNOWN"
    state.detail.cases.items[0].documentLinks[0].financial.settlement = null
    state.detail.cases.items[0].exceptions = [
      {
        code: "BALANCE_UNAVAILABLE",
        message: "Unsupported",
        fingerprint: "c".repeat(64),
        caseId: "invented-case",
        blocking: false,
      },
    ]
    serve(state)
    mount()
    await screen.findByRole("heading", { name: "Invented project" })
    fireEvent.click(screen.getByRole("button", { name: "Expand Invented milestone" }))
    expect(screen.getByRole("button", { name: "Review case" })).toBeDisabled()
    expect(screen.getByText("Canonical unavailable")).toBeInTheDocument()
    expect(screen.getByText("Payment data: Unknown")).toBeInTheDocument()
  })
})

it("applies picked civil dates with explicit period labels while retaining overall balances and exports the exact same filters", async () => {
  const state = data()
  const calls = serve(state)
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:invented")
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {})
  mount()
  await screen.findByRole("heading", { name: "Invented project" })
  const choose = (label: RegExp, year: string, month: string, day: RegExp) => {
    fireEvent.click(screen.getByRole("button", { name: label }))
    fireEvent.change(screen.getByRole("combobox", { name: "Choose the Year" }), { target: { value: year } })
    fireEvent.change(screen.getByRole("combobox", { name: "Choose the Month" }), { target: { value: month } })
    fireEvent.click(screen.getByRole("button", { name: day }))
  }
  choose(/Invoice date from/, "2026", "0", /January 1st, 2026/)
  choose(/Receipt date from/, "2026", "2", /March 1st, 2026/)
  fireEvent.click(screen.getByRole("button", { name: "Apply date filters" }))
  await waitFor(() =>
    expect(
      calls.some((x) => x.url.includes("invoiceFrom=2026-01-01") && x.url.includes("cashFrom=2026-03-01")),
    ).toBe(true),
  )
  await screen.findByRole("tab", { name: "Reconciliation" })
  expect(screen.getByRole("button", { name: /Invoice date from/ })).toHaveTextContent("January 1st, 2026")
  expect(screen.getByRole("button", { name: /Receipt date from/ })).toHaveTextContent("March 1st, 2026")
  expect(screen.getAllByText("In invoice date range").length).toBeGreaterThan(0)
  expect(screen.getAllByText("In receipt date range").length).toBeGreaterThan(0)
  expect(
    screen.getAllByText("Overall balance or agreement; unaffected by date filters").length,
  ).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole("button", { name: "Export CSV" }))
  await waitFor(() => expect(click).toHaveBeenCalledOnce())
  const url = calls.find((x) => x.url.includes("/export.csv"))!.url
  expect(url).toContain("invoiceFrom=2026-01-01&cashFrom=2026-03-01")
  expect(url).not.toContain("cursor=")
  expect(url).not.toContain("limit=")
  click.mockRestore()
  vi.restoreAllMocks()
})

it("recovers an off-page edit target with a separate exact read while preserving the draft and main page counts", async () => {
  const state = data()
  const calls = serve(state)
  mount()
  await screen.findByRole("heading", { name: "Invented project" })
  fireEvent.click(screen.getByRole("button", { name: "Expand Invented milestone" }))
  fireEvent.click(screen.getByRole("button", { name: "Edit case" }))
  fireEvent.change(screen.getByLabelText(/Case title/), { target: { value: "Recover this case draft" } })
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
  await screen.findByText("Allocation changed")
  state.detail.cases.items = []
  state.detail.cases.total = 25
  state.detail.cases.nextCursor = "later-case"
  fireEvent.click(screen.getByRole("button", { name: "Reload project" }))
  await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled())
  expect(screen.getByLabelText(/Case title/)).toHaveValue("Recover this case draft")
  expect(calls.some((x) => x.url.includes("caseId=invented-case"))).toBe(true)
  expect(calls.filter((x) => x.init?.method)).toHaveLength(1)
})

it("blocks either closure for a relevant unallocated project payable while preserving typed unsupported cost knowledge", async () => {
  const state = data()
  const link = structuredClone(state.detail.cases.items[0].documentLinks[0])
  link.id = "consolidated-bill"
  link.documentId = "bill-1"
  link.typeId = "received-invoice"
  link.caseId = null
  link.role = "PARTNER_BILL"
  link.financial.typeId = "received-invoice"
  link.financial.documentId = "bill-1"
  link.financial.settlement!.outstandingMinor = 1
  link.financial.displayNumber = "BILL-1"
  state.detail.unallocatedDocumentLinks = [link]
  const expense = structuredClone(link)
  expense.id = "cost"
  expense.documentId = "expense-1"
  expense.typeId = "expense"
  expense.caseId = "invented-case"
  expense.role = "PROJECT_COST"
  expense.financial.typeId = "expense"
  expense.financial.documentId = "expense-1"
  expense.financial.displayNumber = "COST-1"
  expense.financial.status = "draft"
  expense.financial.paymentKnowledge = "UNSUPPORTED"
  expense.financial.settlement = null
  expense.financial.payments = []
  state.detail.cases.items[0].documentLinks.push(expense)
  serve(state)
  mount()
  await screen.findByRole("heading", { name: "Invented project" })
  fireEvent.click(screen.getByRole("button", { name: "Expand Invented milestone" }))
  fireEvent.click(screen.getByRole("button", { name: "Review case" }))
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  await tab("Costs and history")
  expect(screen.getByText("Payment data: Not supported")).toBeInTheDocument()
  expect(screen.getByText("Balance unavailable; payment data is unknown.")).toBeInTheDocument()
  expect(screen.queryByText("Unpaid")).not.toBeInTheDocument()
})

it("rebases untouched agreement facts after conflict reload while retaining the user dirty title", async () => {
  const state = data()
  const calls = serve(state)
  mount()
  await screen.findByRole("heading", { name: "Invented project" })
  fireEvent.click(screen.getByRole("button", { name: "Expand Invented milestone" }))
  fireEvent.click(screen.getByRole("button", { name: "Edit case" }))
  fireEvent.change(screen.getByLabelText(/Case title/), { target: { value: "My changed title" } })
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
  await screen.findByText("Allocation changed")
  state.detail.versionToken = "4:new-agreement"
  state.detail.cases.items[0].agreedGrossMinor = 777
  state.detail.summary.agreedSettlement.knownMinor = 777
  state.detail.cases.items[0].summary.agreedSettlement.knownMinor = 777
  fireEvent.click(screen.getByRole("button", { name: "Reload project" }))
  await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled())
  expect(screen.getByLabelText(/Case title/)).toHaveValue("My changed title")
  expect(screen.getByLabelText(/Agreed gross/)).toHaveValue("7.77")
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
  await waitFor(() => expect(calls.filter((x) => x.init?.method)).toHaveLength(2))
  expect(JSON.parse(String(calls.filter((x) => x.init?.method)[1].init?.body))).toMatchObject({
    title: "My changed title",
    agreedGrossMinor: 777,
    expectedVersion: "4:new-agreement",
  })
})

it("ignores a late exact reload from a closed dialog after another case is opened", async () => {
  const state = data()
  const b = structuredClone(state.detail.cases.items[0])
  b.id = "case-b"
  b.title = "Case B"
  state.detail.cases.items.push(b)
  state.detail.cases.total = 2
  let caseReads = 0
  let finish!: (response: Response) => void
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method)
        return new Response(JSON.stringify({ code: "RECONCILIATION_CHANGED", message: "Case changed" }), {
          status: 409,
        })
      if (url.includes("caseId=invented-case")) {
        if (++caseReads === 2)
          return new Promise<Response>((resolve) => {
            finish = resolve
          })
        return new Response(
          JSON.stringify({
            ...state.detail,
            cases: { items: [state.detail.cases.items[0]], total: 1, nextCursor: null },
          }),
        )
      }
      if (url.includes("caseId=case-b"))
        return new Response(
          JSON.stringify({ ...state.detail, cases: { items: [b], total: 1, nextCursor: null } }),
        )
      if (url.includes("/receipts?")) return new Response(JSON.stringify(state.receipts))
      if (url.includes("/history?")) return new Response(JSON.stringify(state.history))
      return new Response(JSON.stringify(state.detail))
    }),
  )
  mount()
  await screen.findByRole("heading", { name: "Invented project" })
  fireEvent.click(screen.getByRole("button", { name: "Expand Invented milestone" }))
  fireEvent.click(screen.getByRole("button", { name: "Edit case" }))
  await waitFor(() => expect(caseReads).toBe(1))
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
  await screen.findByText("Case changed")
  fireEvent.click(screen.getByRole("button", { name: "Reload project" }))
  await waitFor(() => expect(caseReads).toBe(2))
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  fireEvent.click(screen.getByRole("button", { name: "Expand Case B" }))
  fireEvent.click(screen.getAllByRole("button", { name: "Edit case" }).at(-1)!)
  await waitFor(() => expect(screen.getByLabelText(/Case title/)).toHaveValue("Case B"))
  fireEvent.change(screen.getByLabelText(/Case title/), { target: { value: "Keep B draft" } })
  finish(
    new Response(
      JSON.stringify({
        ...state.detail,
        cases: { items: [state.detail.cases.items[0]], total: 1, nextCursor: null },
      }),
    ),
  )
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(screen.getByLabelText(/Case title/)).toHaveValue("Keep B draft")
})

it("does not let a prior dialog reload remove a new credit lock when the same invoice is reopened", async () => {
  const state = data()
  const old = structuredClone(state.detail)
  let exactReads = 0
  let finish!: (response: Response) => void
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method)
        return new Response(JSON.stringify({ code: "RECONCILIATION_CHANGED", message: "Invoice changed" }), {
          status: 409,
        })
      if (url.includes("caseId=")) {
        if (++exactReads === 2)
          return new Promise<Response>((resolve) => {
            finish = resolve
          })
        return new Response(
          JSON.stringify({
            ...state.detail,
            cases: { items: [state.detail.cases.items[0]], total: 1, nextCursor: null },
          }),
        )
      }
      if (url.includes("/receipts?")) return new Response(JSON.stringify(state.receipts))
      if (url.includes("/history?")) return new Response(JSON.stringify(state.history))
      return new Response(JSON.stringify(state.detail))
    }),
  )
  mount()
  await screen.findByRole("heading", { name: "Invented project" })
  fireEvent.click(screen.getByRole("button", { name: "Expand Invented milestone" }))
  fireEvent.click(screen.getByRole("button", { name: "Edit external customer reference" }))
  await waitFor(() => expect(exactReads).toBe(1))
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
  await screen.findByText("Invoice changed")
  fireEvent.click(screen.getByRole("button", { name: "Reload project" }))
  await waitFor(() => expect(exactReads).toBe(2))
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
  state.detail.versionToken = "4:changed"
  state.detail.summary.customerCredits.knownMinor = 100
  const current = state.detail.cases.items[0].customerInvoices[0]
  if (current.external) {
    current.creditAdjustmentMinor = 100
    current.adjustedGrossMinor = 229900
    current.allocatedMinor = 229900
  }
  fireEvent.click(screen.getByRole("button", { name: "Refresh project" }))
  await screen.findByText("1.00 NZD")
  fireEvent.click(screen.getByRole("button", { name: "Edit external customer reference" }))
  expect(screen.getByLabelText(/Original gross/)).toBeDisabled()
  await act(async () => {
    finish(
      new Response(
        JSON.stringify({ ...old, cases: { items: [old.cases.items[0]], total: 1, nextCursor: null } }),
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  expect(screen.getByLabelText(/Original gross/)).toBeDisabled()
})

it("refreshes the aggregate detail before the exact receipt and retains the paged receipt read separately", async () => {
  const state = data()
  const calls = serve(state)
  mount()
  await screen.findByRole("heading", { name: "Invented project" })
  await tab("Evidence and differences")
  fireEvent.click(screen.getByRole("button", { name: "Edit external receipt" }))
  await waitFor(() => expect(calls.some((x) => x.url.includes("receiptId=invented-receipt"))).toBe(true))
  fireEvent.change(screen.getByRole("textbox", { name: /^Reason\s*\*?$/ }), {
    target: { value: "My reviewed evidence" },
  })
  fireEvent.click(screen.getByRole("checkbox", { name: /I checked/ }))
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
  await screen.findByText("Allocation changed")
  const start = calls.length
  fireEvent.click(screen.getByRole("button", { name: "Reload project" }))
  await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled())
  const refreshed = calls
    .slice(start)
    .filter((x) => !x.init?.method)
    .map((x) => x.url)
  expect(refreshed).toEqual([
    expect.stringMatching(/\/projects\/invented-project\?limit=25$/),
    expect.stringContaining("/receipts?receiptId=invented-receipt&limit=25"),
  ])
  expect(calls.some((x) => x.url.endsWith("/receipts?limit=25"))).toBe(true)
  expect(screen.getByRole("textbox", { name: /^Reason\s*\*?$/ })).toHaveValue("My reviewed evidence")
})
it("keeps an existing receipt target unavailable after exact404 instead of creating a new receipt, with explicit reload available", async () => {
  const state = data()
  const calls = serve(state)
  const original = globalThis.fetch
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) =>
      url.includes("receiptId=")
        ? new Response(JSON.stringify({ message: "Receipt unavailable" }), { status: 404 })
        : original(url, init),
    ),
  )
  mount()
  await screen.findByRole("heading", { name: "Invented project" })
  await tab("Evidence and differences")
  fireEvent.click(screen.getByRole("button", { name: "Edit external receipt" }))
  await screen.findByText("The edited record is unavailable. Your draft is preserved; reload before saving.")
  expect(screen.getByRole("heading", { name: "Edit external receipt" })).toBeInTheDocument()
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled()
  expect(screen.getByRole("button", { name: "Reload project" })).toBeEnabled()
  expect(calls.filter((x) => x.init?.method)).toHaveLength(0)
})

it("labels a PARTNER remaining subtotal as recorded balance with unconfirmed collection coverage", async () => {
  const state = data()
  state.detail.summary.customerRemaining = { knownMinor: 130000, missingCount: 1, completeness: "PARTIAL" }
  serve(state)
  mount()
  await screen.findByRole("heading", { name: "Invented project" })
  expect(screen.getByText("Recorded customer balance")).toBeInTheDocument()
  expect(
    screen.getByText("Recorded allocations only; collection coverage is unconfirmed."),
  ).toBeInTheDocument()
})

it.each(["Escape", "Cancel"])("returns the detail case dialog to its opener after %s", async (close) => {
  serve()
  mount()
  await screen.findByRole("heading", { name: "Invented project" })
  const opener = screen.getByRole("button", { name: "New case" })
  opener.focus()
  fireEvent.click(opener)
  const dialog = screen.getByRole("dialog")
  expect(dialog.contains(document.activeElement)).toBe(true)
  if (close === "Escape") fireEvent.keyDown(document.activeElement!, { key: "Escape" })
  else fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
  await waitFor(() => expect(opener).toHaveFocus())
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
})

it("returns a successful case edit to the register link when refreshed data removes its opener", async () => {
  const state = data()
  serve(state)
  const reads = globalThis.fetch
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) {
        state.detail.cases.items = []
        return new Response(JSON.stringify({ result: {}, versionToken: "2:saved" }))
      }
      return reads(url, init)
    }),
  )
  mount()
  await screen.findByRole("heading", { name: "Invented project" })
  fireEvent.click(screen.getByRole("button", { name: "Expand Invented milestone" }))
  const opener = screen.getByRole("button", { name: "Edit case" })
  opener.focus()
  fireEvent.click(opener)
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  await waitFor(() => expect(screen.getByRole("link", { name: "Project register" })).toHaveFocus())
  expect(opener).not.toBeInTheDocument()
})

it("waits for both snapshots after its own receipt promotion before opening the next allocation", async () => {
  const state = data()
  const receipt = state.receipts.items[0]
  receipt.evidenceClass = "PARTNER_REPORTED"
  receipt.allocations = []
  receipt.allocatedMinor = 0
  receipt.unallocatedMinor = 230000
  state.customerInvoices.items[0].allocatedMinor = 0
  state.customerInvoices.items[0].availableMinor = 230000
  const promotedVersion = `4:${"b".repeat(64)}`
  const writes: { method: string; body: Record<string, unknown> }[] = []
  let promoted = false
  let rootWaiting = false
  let receiptsWaiting = false
  let releaseRoot!: () => void
  let releaseReceipts!: () => void
  const rootGate = new Promise<void>((resolve) => {
    releaseRoot = resolve
  })
  const receiptGate = new Promise<void>((resolve) => {
    releaseReceipts = resolve
  })
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>
        writes.push({ method: init.method, body })
        if (init.method === "PATCH") {
          promoted = true
          receipt.evidenceClass = "EVIDENCE_CHECKED"
          state.detail.versionToken = promotedVersion
          return new Response(
            JSON.stringify({ result: receipt, versionToken: promotedVersion, changed: true }),
          )
        }
        return new Response(
          JSON.stringify({ result: {}, versionToken: `5:${"c".repeat(64)}`, changed: true }),
        )
      }
      if (url.includes("/receipts?")) {
        if (promoted && !url.includes("receiptId=")) {
          receiptsWaiting = true
          await receiptGate
        }
        return new Response(JSON.stringify(state.receipts))
      }
      if (url.includes("/customer-invoices?")) return new Response(JSON.stringify(state.customerInvoices))
      if (url.includes("/history?")) return new Response(JSON.stringify(state.history))
      if (promoted) {
        rootWaiting = true
        await rootGate
      }
      return new Response(JSON.stringify(state.detail))
    }),
  )
  mount()
  await screen.findByRole("heading", { name: "Invented project" })
  await tab("Evidence and differences")
  fireEvent.click(screen.getByRole("button", { name: "Edit external receipt" }))
  fireEvent.click(screen.getByRole("button", { name: "Evidence class" }))
  fireEvent.click(await screen.findByRole("option", { name: "Evidence checked" }))
  fireEvent.change(screen.getByRole("textbox", { name: /^Reason\s*\*?$/ }), {
    target: { value: "Checked the invented statement" },
  })
  fireEvent.click(screen.getByRole("checkbox", { name: /I checked/ }))
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
  await waitFor(() => expect(rootWaiting && receiptsWaiting).toBe(true))
  expect(writes[0]).toMatchObject({
    method: "PATCH",
    body: { evidenceClass: "EVIDENCE_CHECKED", attested: true },
  })
  for (const name of [
    "Add external receipt",
    "Edit external receipt",
    "Allocate receipt",
    "Void external receipt",
    "Edit project",
  ])
    expect(screen.getByRole("button", { name })).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Allocate receipt" }))
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  await act(async () => releaseRoot())
  await waitFor(() => expect(screen.getByRole("button", { name: "Refresh project" })).toBeEnabled())
  expect(screen.getByRole("button", { name: "Allocate receipt" })).toBeDisabled()
  await act(async () => releaseReceipts())
  await waitFor(() => expect(screen.getByRole("button", { name: "Allocate receipt" })).toBeEnabled())
  fireEvent.click(screen.getByRole("button", { name: "Allocate receipt" }))
  fireEvent.click(await screen.findByRole("button", { name: "Add allocation" }))
  fireEvent.change(screen.getByLabelText(/Allocation for EXAMPLE-1/), { target: { value: "2000" } })
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
  await waitFor(() => expect(writes).toHaveLength(2))
  expect(writes[1]).toMatchObject({
    method: "PUT",
    body: {
      expectedVersion: promotedVersion,
      allocations: [{ customerInvoiceId: "invented-reference", amountMinor: 200000 }],
    },
  })
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
})
