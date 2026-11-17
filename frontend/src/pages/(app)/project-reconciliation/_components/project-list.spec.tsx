import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { MemoryRouter } from "react-router"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { ListRowMenu } from "../../_shared/data-list"
import { ProjectList } from "./project-list"
import ProjectReconciliationPage from "../index"

const session = vi.hoisted(() => ({
  activeCompanyId: "company-a" as string | null,
  activeRole: "OWNER" as string | null,
}))
vi.mock("@/hooks/use-page-header", () => ({ usePageHeader: vi.fn() }))
vi.mock("@/hooks/queries/use-companies", () => ({ useCompanies: () => session }))
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
afterEach(() => {
  vi.unstubAllGlobals()
  session.activeRole = "OWNER"
  session.activeCompanyId = "company-a"
})
function row(id: string, currency = "NZD") {
  const measure = { knownMinor: 15000, missingCount: 0, completeness: "COMPLETE" }
  return {
    project: {
      id,
      companyId: "company-a",
      name: `Delivery ${id}`,
      endCustomerName: "Example customer",
      currency,
      collectionMode: "PARTNER",
      partnerClientId: "partner",
      endCustomerClientId: null,
      timeProjectId: null,
      description: null,
      status: "ACTIVE",
      version: 3,
      identityLocked: false,
      createdAt: "2026-11-17T00:00:00Z",
      updatedAt: "2026-11-17T00:00:00Z",
      partnerClient: { id: "partner", name: "Partner example", inactive: false },
      endCustomerClient: null,
      timeProject: null,
    },
    versionToken: "3:source-token",
    asOf: "2026-11-17T00:00:00Z",
    sourceFingerprint: "a".repeat(64),
    summary: {
      customerInvoiced: { ...measure, missingCount: 1, completeness: "PARTIAL" },
      customerCredits: measure,
      customerCollectible: measure,
      customerRemaining: measure,
      agreedSettlement: measure,
      unbilledDifference: measure,
      settlementInvoiced: measure,
      ownRecordedReceipts: measure,
      ownOutstanding: { knownMinor: 0, missingCount: 1, completeness: "UNKNOWN" },
      partnerBills: measure,
      partnerPaid: measure,
      partnerOutstanding: measure,
      projectCosts: measure,
    },
    effectiveReviewState: "CLOSED_WITH_EXCEPTIONS",
    attentionCount: 2,
  }
}
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
          <ProjectList companyId="company-a" />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
describe("project register", () => {
  it("renders partial/unknown evidence, separate currencies, server count and shared mobile row slots", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ items: [row("one"), row("two", "JPY")], nextCursor: null, total: 47 }),
          ),
      ),
    )
    mount()
    await screen.findByRole("link", { name: "Delivery one" })
    expect(screen.getByText("47 projects")).toBeInTheDocument()
    expect(screen.getByText("150.00 NZD")).toBeInTheDocument()
    expect(screen.getByText("15000 JPY")).toBeInTheDocument()
    expect(screen.getAllByText(/Known subtotal/)).toHaveLength(2)
    expect(screen.getAllByText("Unknown").length).toBeGreaterThan(0)
    expect(screen.getAllByText("Reviewed with unresolved evidence")).toHaveLength(2)
    expect(screen.queryByText(/Grand total/)).not.toBeInTheDocument()
    const node = screen.getByTestId("reconciliation-project-one")
    expect(node.querySelector(".order-3.sm\\:order-2")).toBeTruthy()
    expect(screen.getByRole("link", { name: "Delivery one" })).toHaveAttribute(
      "href",
      "/project-reconciliation/one",
    )
  })
  it("uses server search/filter/next cursors and resets pagination after a filter edit", async () => {
    const urls: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url)
        return new Response(
          JSON.stringify({
            items: [row(url.includes("cursor=") ? "two" : "one")],
            nextCursor: url.includes("cursor=") ? null : "one",
            total: 47,
          }),
        )
      }),
    )
    mount()
    await screen.findByRole("link", { name: "Delivery one" })
    fireEvent.click(screen.getByRole("link", { name: "Next projects" }))
    await screen.findByRole("link", { name: "Delivery two" })
    expect(urls.at(-1)).toContain("cursor=one")
    fireEvent.click(screen.getByRole("button", { name: "Needs attention" }))
    await waitFor(() => expect(urls.at(-1)).toContain("needsAttention=true"))
    expect(urls.at(-1)).not.toContain("cursor=")
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "No match" } })
    await waitFor(() => expect(urls.at(-1)).toContain("search=No+match"))
    expect(screen.getByText("47 projects")).toBeInTheDocument()
  })
  it.each(["MEMBER", null])("offers read-only actions for role %s", async (role) => {
    session.activeRole = role
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ items: [row("one")], nextCursor: null, total: 1 }))),
    )
    mount()
    await screen.findByRole("link", { name: "Delivery one" })
    expect(screen.queryByRole("button", { name: "New project" })).not.toBeInTheDocument()
    expect(screen.queryByRole("button", { name: /Project actions/ })).not.toBeInTheDocument()
  })
  it("archives with the aggregate token and DTO-only body", async () => {
    const fetcher = vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Response(
          JSON.stringify(
            init?.method
              ? { result: row("one").project, versionToken: "4:next", changed: true }
              : { items: [row("one")], nextCursor: null, total: 1 },
          ),
        ),
    )
    vi.stubGlobal("fetch", fetcher)
    mount()
    await screen.findByRole("link", { name: "Delivery one" })
    fireEvent.keyDown(screen.getByRole("button", { name: "Project actions: Delivery one" }), {
      key: "ArrowDown",
    })
    fireEvent.click(await screen.findByRole("menuitem", { name: "Archive project" }))
    await waitFor(() => expect(fetcher.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(true))
    const call = fetcher.mock.calls.find(([, init]) => init?.method === "PATCH")!
    expect(JSON.parse(String(call[1]?.body))).toMatchObject({
      status: "ARCHIVED",
      expectedVersion: "3:source-token",
    })
    expect(Object.keys(JSON.parse(String(call[1]?.body))).sort()).toEqual([
      "expectedVersion",
      "requestKey",
      "status",
    ])
  })
  it("shows loading, empty and forbidden states without financial rows", async () => {
    let resolve!: (value: Response) => void
    const fetcher = vi.fn(
      () =>
        new Promise<Response>((done) => {
          resolve = done
        }),
    )
    vi.stubGlobal("fetch", fetcher)
    const view = mount()
    expect(screen.getByTestId("reconciliation-loading")).toBeInTheDocument()
    resolve(new Response(JSON.stringify({ items: [], total: 0, nextCursor: null })))
    await screen.findByText("No projects yet")
    view.unmount()
    fetcher.mockImplementation(
      async () => new Response(JSON.stringify({ message: "Forbidden" }), { status: 403 }),
    )
    mount()
    await screen.findByText("Project access unavailable")
    expect(screen.queryByRole("link", { name: /Delivery/ })).not.toBeInTheDocument()
  })
  it("resets filters, cursor history and an open draft on the actual page's company switch", async () => {
    const urls: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url)
        return new Response(
          JSON.stringify(
            url.includes("project-reconciliation") ? { items: [], nextCursor: null, total: 0 } : [],
          ),
        )
      }),
    )
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const page = (
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <TooltipProvider>
            <ProjectReconciliationPage />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>
    )
    const view = render(page)
    await screen.findByText("No projects yet")
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "Only A" } })
    await waitFor(() => expect(urls.at(-1)).toContain("search=Only+A"))
    const oldOpener = screen.getByRole("button", { name: "New project" })
    oldOpener.focus()
    fireEvent.click(oldOpener)
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: "Draft A" } })
    session.activeCompanyId = "company-b"
    view.rerender(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <TooltipProvider>
            <ProjectReconciliationPage />
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await screen.findByText("No projects yet")
    expect(screen.getByRole("searchbox")).toHaveValue("")
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    expect(urls.filter((url) => url.includes("project-reconciliation")).at(-1)).not.toContain("search=")
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(oldOpener).not.toBeInTheDocument()
    expect(screen.getByRole("button", { name: "New project" })).not.toHaveFocus()
  })
})

it("preserves the actual page edit draft through failed and successful 409 reloads and requires a deliberate new save", async () => {
  const requests: Record<string, unknown>[] = []
  let detailReads = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") {
        requests.push(JSON.parse(String(init.body)))
        return new Response(JSON.stringify({ code: "RECONCILIATION_CHANGED", message: "Changed" }), {
          status: requests.length === 1 ? 409 : 503,
        })
      }
      if (url.includes("/project-reconciliation/projects/one")) {
        detailReads++
        if (detailReads === 1)
          return new Response(
            JSON.stringify({ code: "FINANCIAL_READ_UNAVAILABLE", message: "Unavailable" }),
            { status: 503 },
          )
        return new Response(
          JSON.stringify({
            project: { ...row("one").project, name: "Server project name" },
            versionToken: "4:fresh",
            asOf: "2026-11-17T01:00:00Z",
            sourceFingerprint: "b".repeat(64),
            cases: { items: [], nextCursor: null, total: 0 },
          }),
        )
      }
      return new Response(
        JSON.stringify(
          url.includes("project-reconciliation") ? { items: [row("one")], nextCursor: null, total: 1 } : [],
        ),
      )
    }),
  )
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <TooltipProvider>
          <ProjectReconciliationPage />
        </TooltipProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  await screen.findByRole("link", { name: "Delivery one" })
  fireEvent.keyDown(screen.getByRole("button", { name: "Project actions: Delivery one" }), {
    key: "ArrowDown",
  })
  fireEvent.click(await screen.findByRole("menuitem", { name: "Edit project" }))
  fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: "Keep this draft" } })
  fireEvent.click(screen.getByRole("button", { name: "Save project" }))
  await screen.findByRole("alert")
  fireEvent.click(screen.getByRole("button", { name: "Reload project" }))
  await screen.findByText("Could not refresh. Your draft is preserved; saving remains blocked.")
  expect(screen.getByRole("button", { name: "Save project" })).toBeDisabled()
  expect(screen.getByLabelText(/Project name/)).toHaveValue("Keep this draft")
  fireEvent.click(screen.getByRole("button", { name: "Reload project" }))
  await waitFor(() => expect(screen.getByRole("button", { name: "Save project" })).toBeEnabled())
  expect(requests).toHaveLength(1)
  expect(screen.getByLabelText(/Project name/)).toHaveValue("Keep this draft")
  fireEvent.click(screen.getByRole("button", { name: "Save project" }))
  await waitFor(() => expect(requests).toHaveLength(2))
  expect(requests[1]).toMatchObject({ name: "Keep this draft", expectedVersion: "4:fresh" })
  expect(requests[1].requestKey).not.toBe(requests[0].requestKey)
})

describe("project dialog focus return", () => {
  function serveFocus() {
    let saved = false
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method) {
          saved = true
          return new Response(JSON.stringify({ result: row("one").project, versionToken: "4:saved" }))
        }
        return new Response(
          JSON.stringify(
            url.includes("project-reconciliation/projects?")
              ? {
                  items: [{ ...row("one"), versionToken: saved ? "4:saved" : "3:source-token" }],
                  total: 1,
                  nextCursor: null,
                }
              : [],
          ),
        )
      }),
    )
  }
  it.each(["Escape", "Cancel"])("returns a new-project dialog to its opener after %s", async (close) => {
    serveFocus()
    mount()
    await screen.findByRole("link", { name: "Delivery one" })
    const opener = screen.getByRole("button", { name: "New project" })
    opener.focus()
    fireEvent.click(opener)
    expect(screen.getByLabelText(/Project name/)).toHaveFocus()
    if (close === "Escape") fireEvent.keyDown(document.activeElement!, { key: "Escape" })
    else fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() => expect(opener).toHaveFocus())
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
  })
  it("returns a successfully created project to its opener", async () => {
    serveFocus()
    mount()
    await screen.findByRole("link", { name: "Delivery one" })
    const opener = screen.getByRole("button", { name: "New project" })
    opener.focus()
    fireEvent.click(opener)
    fireEvent.change(screen.getByLabelText(/Project name/), { target: { value: "New delivery" } })
    fireEvent.change(screen.getByLabelText(/End customer name/), { target: { value: "Example customer" } })
    fireEvent.click(screen.getByRole("button", { name: /Currency/ }))
    fireEvent.click(await screen.findByRole("option", { name: "New Zealand Dollar (NZD)" }))
    fireEvent.click(screen.getByRole("button", { name: "Create project" }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    await waitFor(() => expect(opener).toHaveFocus())
  })
  it.each(["Cancel", "Save project"])("returns menu edits to a surviving control after %s", async (close) => {
    serveFocus()
    mount()
    await screen.findByRole("link", { name: "Delivery one" })
    const opener = screen.getByRole("button", { name: "Project actions: Delivery one" })
    opener.focus()
    fireEvent.keyDown(opener, { key: "ArrowDown" })
    const edit = await screen.findByRole("menuitem", { name: "Edit project" })
    edit.focus()
    fireEvent.click(edit)
    expect(screen.getByLabelText(/Project name/)).toHaveFocus()
    await new Promise((resolve) => setTimeout(resolve, 0))
    fireEvent.click(screen.getByRole("button", { name: close }))
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    const target = close === "Cancel" ? opener : screen.getByRole("searchbox")
    await waitFor(() => expect(target).toHaveFocus())
    if (close !== "Cancel") expect(opener).not.toBeInTheDocument()
  })
  it.each([
    ["display", "none"],
    ["visibility", "hidden"],
  ])("falls back when a connected opener refuses focus after %s: %s", async (property, value) => {
    serveFocus()
    mount()
    await screen.findByRole("link", { name: "Delivery one" })
    const opener = screen.getByRole("button", { name: "New project" })
    opener.focus()
    fireEvent.click(opener)
    Object.assign(opener.style, { [property]: value })
    // jsdom does not refuse focus for CSS hiding; model that native boundary on this button only.
    const focus = vi.spyOn(opener, "focus").mockImplementation(() => {})
    fireEvent.keyDown(document.activeElement!, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    expect(opener).toBeInTheDocument()
    expect(opener).toBeEnabled()
    await waitFor(() => expect(screen.getByRole("searchbox")).toHaveFocus())
    expect(focus).toHaveBeenCalled()
  })
  it("uses a surviving page control when the opener becomes disabled", async () => {
    serveFocus()
    mount()
    await screen.findByRole("link", { name: "Delivery one" })
    const opener = screen.getByRole("button", { name: "New project" })
    opener.focus()
    fireEvent.click(opener)
    opener.setAttribute("disabled", "")
    fireEvent.keyDown(document.activeElement!, { key: "Escape" })
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole("searchbox")).toHaveFocus())
  })
})

it("keeps focus already claimed by another control while the dialog finishes closing", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ items: [], total: 0, nextCursor: null }))),
  )
  mount()
  await screen.findByText("No projects yet")
  const opener = screen.getByRole("button", { name: "New project" })
  opener.focus()
  fireEvent.click(opener)
  fireEvent.keyDown(document.activeElement!, { key: "Escape" })
  const search = screen.getByRole("searchbox")
  search.focus()
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(search).toHaveFocus()
})

it("keeps the register accessible while its keyboard-opened row menu focuses Edit", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ items: [row("one")], total: 1, nextCursor: null }))),
  )
  mount()
  await screen.findByRole("link", { name: "Delivery one" })
  const search = screen.getByRole("searchbox")
  const opener = screen.getByRole("button", { name: "Project actions: Delivery one" })
  opener.focus()
  fireEvent.keyDown(opener, { key: "Enter" })
  const edit = await screen.findByRole("menuitem", { name: "Edit project" })
  await waitFor(() => expect(edit).toHaveFocus())
  expect(search.closest('[aria-hidden="true"]')).toBeNull()
  expect(screen.getByRole("searchbox")).toBe(search)
  fireEvent.keyDown(edit, { key: "Escape" })
  await waitFor(() => expect(opener).toHaveFocus())
})

it("preserves the shared row menu's modal default for callers that omit the option", async () => {
  render(
    <TooltipProvider>
      <button type="button">Outside action</button>
      <ListRowMenu label="Shared actions">
        <DropdownMenuItem>First action</DropdownMenuItem>
      </ListRowMenu>
    </TooltipProvider>,
  )
  const outside = screen.getByRole("button", { name: "Outside action" })
  const opener = screen.getByRole("button", { name: "Shared actions" })
  opener.focus()
  fireEvent.keyDown(opener, { key: "Enter" })
  const first = await screen.findByRole("menuitem", { name: "First action" })
  await waitFor(() => expect(first).toHaveFocus())
  expect(outside.closest('[aria-hidden="true"]')).not.toBeNull()
  fireEvent.keyDown(first, { key: "Escape" })
  await waitFor(() => expect(opener).toHaveFocus())
  expect(outside.closest('[aria-hidden="true"]')).toBeNull()
})
