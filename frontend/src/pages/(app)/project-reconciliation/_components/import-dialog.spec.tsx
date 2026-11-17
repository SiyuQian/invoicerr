import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter } from "react-router"
import { beforeEach, afterEach, it, expect, vi } from "vitest"
import type { ImportPreview } from "@/types/project-reconciliation"
import source from "./import-fixtures.json"
import { ImportDialog } from "./import-dialog"
vi.mock("@/hooks/queries/use-companies", () => ({
  useCompanies: () => ({ activeCompanyId: "invented-company", activeRole: "OWNER" }),
}))
beforeEach(() =>
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  ),
)
afterEach(() => vi.unstubAllGlobals())
const props = {
  companyId: "invented-company",
  projectId: "invented-project",
  versionToken: source.preview.projectVersion,
  open: true,
  onOpenChange: vi.fn(),
  onReload: vi.fn(async () => source.preview.projectVersion),
}
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return {
    client,
    ...render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <ImportDialog {...props} />
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  }
}
async function input(payload = source.previewInput.payload) {
  fireEvent.change(screen.getByRole("textbox", { name: /Ledgerly project payload JSON/ }), {
    target: { value: JSON.stringify(payload) },
  })
  fireEvent.click(screen.getByRole("button", { name: /Source currency/ }))
  fireEvent.change(screen.getByPlaceholderText("Search options"), { target: { value: "NZD" } })
  fireEvent.click(await screen.findByRole("option", { name: "NZD" }))
  fireEvent.change(screen.getByRole("textbox", { name: /Source as of/ }), {
    target: { value: source.previewInput.payload.sourceAsOf },
  })
}
it("keeps the import instructions behind the payload field help", () => {
  mount()
  const instructions = /Paste a selected project payload/
  expect(screen.getByText(instructions)).not.toBeVisible()
  fireEvent.click(
    screen.getByRole("button", {
      name: /Ledgerly project payload JSON.*help|Help.*Ledgerly project payload JSON/i,
    }),
  )
  expect(screen.getAllByText(instructions).some((node) => node.closest("[hidden]") === null)).toBe(true)
})
it("re-previews an edited selected match and confirms only exact project input, retaining response-loss retries", async () => {
  const requests: { url: string; body: Record<string, unknown> }[] = []
  let previews = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body))
      requests.push({ url, body })
      if (url.endsWith("/preview")) {
        const preview = structuredClone(source.preview) as ImportPreview
        if (previews++ === 0) {
          preview.previewHash = "a".repeat(64)
          preview.proposedLinks[0].selectedMatch = null
          preview.proposedLinks[0].action = "UNRESOLVED"
          preview.unresolved = [
            {
              code: "MATCH_REQUIRED",
              message: "Choose an existing own invoice.",
              sourceIds: ["invented-share-row"],
              caseSourceId: "invented-customer-row",
              blocking: true,
            },
          ]
        }
        return new Response(JSON.stringify(preview))
      }
      throw new TypeError("Response lost after confirm")
    }),
  )
  const view = mount()
  await input()
  fireEvent.click(screen.getByRole("button", { name: "Preview import" }))
  await screen.findByText(/Choose an existing own invoice/)
  expect(screen.getByRole("button", { name: "Confirm import" })).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: /Match for invented-share-row/ }))
  fireEvent.click(await screen.findByRole("option", { name: /EX-SHARE/ }))
  expect(screen.getByRole("button", { name: "Confirm import" })).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Preview import" }))
  await waitFor(() => expect(screen.getByRole("button", { name: "Confirm import" })).toBeEnabled())
  fireEvent.click(screen.getByRole("button", { name: "Confirm import" }))
  await screen.findByRole("alert")
  view.rerender(
    <QueryClientProvider client={view.client}>
      <MemoryRouter>
        <ImportDialog {...props} versionToken="9:background" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole("button", { name: "Confirm import" }))
  await waitFor(() => expect(requests.filter((x) => x.url.endsWith("/confirm"))).toHaveLength(2))
  const confirms = requests.filter((x) => x.url.endsWith("/confirm"))
  expect(confirms[0].body).toEqual({ ...source.confirmBody, requestKey: expect.any(String) })
  expect(confirms[1].body).toEqual(confirms[0].body)
  expect(
    requests.every((x) => x.url.includes("/project-reconciliation/projects/invented-project/import/")),
  ).toBe(true)
})
it("allows nonblocking canonical amount warnings but invalidates preview after payload changes", async () => {
  const preview = structuredClone(source.preview) as ImportPreview
  preview.unresolved = [
    {
      code: "CANONICAL_SOURCE_DIFFERENCE",
      message: "Canonical amount remains authoritative.",
      sourceIds: ["invented-share-row"],
      caseSourceId: "invented-customer-row",
      blocking: false,
    },
  ]
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(preview))),
  )
  mount()
  await input()
  fireEvent.click(screen.getByRole("button", { name: "Preview import" }))
  await screen.findByText(/Canonical amount remains authoritative/)
  expect(screen.getByRole("button", { name: "Confirm import" })).toBeEnabled()
  const changed = structuredClone(source.previewInput.payload)
  changed.invoices[0].number = "CHANGED"
  fireEvent.change(screen.getByRole("textbox", { name: /Ledgerly project payload JSON/ }), {
    target: { value: JSON.stringify(changed) },
  })
  expect(screen.getByRole("button", { name: "Confirm import" })).toBeDisabled()
})
it("requires a new preview after 409 reload even if the project token is unchanged", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) =>
      url.endsWith("/preview")
        ? new Response(JSON.stringify(source.preview))
        : new Response(JSON.stringify({ code: "IMPORT_PREVIEW_STALE", message: "Preview stale" }), {
            status: 409,
          }),
    ),
  )
  mount()
  await input()
  fireEvent.click(screen.getByRole("button", { name: "Preview import" }))
  await waitFor(() => expect(screen.getByRole("button", { name: "Confirm import" })).toBeEnabled())
  fireEvent.click(screen.getByRole("button", { name: "Confirm import" }))
  await screen.findByText("Preview stale")
  fireEvent.click(screen.getByRole("button", { name: "Reload project" }))
  await waitFor(() => expect(screen.queryByText("Preview stale")).not.toBeInTheDocument())
  expect(screen.getByRole("button", { name: "Confirm import" })).toBeDisabled()
  expect(screen.getByRole("textbox", { name: /Ledgerly project payload JSON/ })).toHaveValue(
    JSON.stringify(source.previewInput.payload),
  )
})

it("disables an older valid preview after a fresh preview fails", async () => {
  let calls = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      ++calls === 1
        ? new Response(JSON.stringify(source.preview))
        : new Response(
            JSON.stringify({ code: "FINANCIAL_READ_UNAVAILABLE", message: "Current source unavailable" }),
            { status: 503 },
          ),
    ),
  )
  mount()
  await input()
  fireEvent.click(screen.getByRole("button", { name: "Preview import" }))
  await waitFor(() => expect(screen.getByRole("button", { name: "Confirm import" })).toBeEnabled())
  fireEvent.click(screen.getByRole("button", { name: "Preview import" }))
  await screen.findByText("Current source unavailable")
  expect(screen.getByRole("button", { name: "Confirm import" })).toBeDisabled()
})
it("rejects unknown payload fields before sending source data", async () => {
  const fetcher = vi.fn()
  vi.stubGlobal("fetch", fetcher)
  mount()
  await input()
  fireEvent.change(screen.getByRole("textbox", { name: /Ledgerly project payload JSON/ }), {
    target: { value: JSON.stringify({ ...source.previewInput.payload, credentials: "invented-never-send" }) },
  })
  fireEvent.click(screen.getByRole("button", { name: "Preview import" }))
  await screen.findByText(
    "The payload has invalid or unknown fields, dates, amounts or more than 1000 source rows.",
  )
  expect(fetcher).not.toHaveBeenCalled()
})

it("sends bounded empty historical placeholders to semantic preview and blocks its fatal membership issue", async () => {
  const requests: Record<string, unknown>[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)))
      const preview = structuredClone(source.preview) as ImportPreview
      preview.errors = [
        {
          code: "IMPORT_PROJECT_MEMBERSHIP",
          message: "Source project membership needs review.",
          sourceIds: ["invented-customer-row"],
          caseSourceId: null,
          blocking: true,
        },
      ]
      return new Response(JSON.stringify(preview))
    }),
  )
  mount()
  await input()
  const payload = structuredClone(source.previewInput.payload) as typeof source.previewInput.payload & {
    invoices: Array<(typeof source.previewInput.payload.invoices)[number] & { sourceSnapshot?: unknown }>
  }
  payload.invoices[0].projectName = ""
  payload.invoices[0].sourceSnapshot = {
    customerCard: {
      label: "",
      issuer: "",
      recipient: "",
      number: "",
      pending: true,
      amountCents: 0,
      totalCents: 0,
    },
    shareCard: {
      label: "",
      issuer: "",
      recipient: "",
      number: null,
      pending: true,
      amountCents: 0,
      totalCents: 0,
    },
  }
  fireEvent.change(screen.getByRole("textbox", { name: /Ledgerly project payload JSON/ }), {
    target: { value: JSON.stringify(payload) },
  })
  fireEvent.click(screen.getByRole("button", { name: "Preview import" }))
  await screen.findByText(/Source project membership needs review/)
  expect(requests[0]).toMatchObject({
    payload: {
      invoices: [
        expect.objectContaining({ projectName: "", sourceSnapshot: payload.invoices[0].sourceSnapshot }),
        expect.anything(),
      ],
    },
  })
  expect(screen.getByRole("button", { name: "Confirm import" })).toBeDisabled()
})

it("shows COMPANY mapped historical facts beside canonical authority without proposing external COMPANY references", async () => {
  const preview = structuredClone(source.preview) as ImportPreview
  preview.proposedReferences = []
  preview.counts.referencesToCreate = 0
  preview.proposedLinks = [
    structuredClone(source.companyHistoricalLink) as ImportPreview["proposedLinks"][number],
  ]
  const requests: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      requests.push(url)
      return new Response(JSON.stringify(preview))
    }),
  )
  const companyPayload = structuredClone(source.previewInput.payload)
  Object.assign(companyPayload.project, {
    customerIssuer: "Invented company",
    customerRecipient: "Invented customer",
    shareIssuer: "Invented partner",
    shareRecipient: "Invented company",
  })
  Object.assign(companyPayload.invoices[0], {
    issuer: "Invented company",
    recipient: "Invented customer",
    totalCents: 987654,
    exGstAmountCents: 900000,
    gstAmountCents: 87654,
    status: "Needs review",
  })
  Object.assign(companyPayload.invoices[1], { issuer: "Invented partner", recipient: "Invented company" })
  mount()
  await input(companyPayload)
  fireEvent.click(screen.getByRole("button", { name: "Preview import" }))
  const historical = await screen.findByRole("region", { name: "Historical source facts" })
  expect(within(historical).getByText(/9876\.54 NZD/)).toBeInTheDocument()
  expect(within(historical).getByText(/Needs review/)).toBeInTheDocument()
  expect(within(historical).getByText(/2026-10-01/)).toBeInTheDocument()
  expect(within(historical).getByText(/2026-10-31/)).toBeInTheDocument()
  const canonical = screen.getByRole("region", { name: "Authoritative company document" })
  expect(within(canonical).getByText(/87\.00 NZD/)).toBeInTheDocument()
  expect(within(canonical).getByText(/^sent/)).toBeInTheDocument()
  expect(within(canonical).getByRole("link", { name: "EX-CUSTOMER" })).toHaveAttribute(
    "href",
    "/documents/invoice/invented-own-invoice",
  )
  expect(preview.proposedReferences).toEqual([])
  expect(requests.every((url) => url.endsWith("/import/preview"))).toBe(true)
})
