import React from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, afterEach, it, expect, vi } from "vitest"
import type { ReceiptView } from "@/types/project-reconciliation"
import fixture from "./reconciliation-fixtures.json"
import { ReceiptAllocationDialog } from "./receipt-allocation"
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
function mountAllocation(receipt: ReceiptView) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={client}>
      <ReceiptAllocationDialog
        companyId="invented-company"
        projectId="invented-project"
        versionToken="3:canonical"
        open
        onOpenChange={vi.fn()}
        onReload={async () => "4:fresh"}
        receipt={receipt}
      />
    </QueryClientProvider>,
  )
}
it.each([
  "replacement",
  "reversal",
] as const)("browses both invoice-choice pages without saving a valid unsaved %s", async (draft) => {
  const requests: string[] = []
  const reads: string[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) {
        requests.push(String(init.body))
        throw new TypeError("Response lost")
      }
      reads.push(url)
      return new Response(
        JSON.stringify({
          items: [],
          nextCursor: url.includes("cursor=") ? null : "next-page",
          total: 26,
        }),
      )
    }),
  )
  mountAllocation(structuredClone(fixture.receipts.items[0]) as ReceiptView)
  if (draft === "replacement")
    fireEvent.change(screen.getByLabelText(/Allocation for EXAMPLE-1/), {
      target: { value: "1000.00" },
    })
  else fireEvent.click(screen.getByRole("button", { name: "Clear allocations" }))
  await waitFor(() => expect(screen.getByRole("button", { name: "Next invoice choices" })).toBeEnabled())
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Next invoice choices" })))
  await waitFor(() => expect(screen.getByRole("button", { name: "Next invoice choices" })).toBeDisabled())
  expect(reads.some((url) => url.includes("cursor=next-page"))).toBe(true)
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Previous invoice choices" })))
  await waitFor(() => expect(screen.getByRole("button", { name: "Previous invoice choices" })).toBeDisabled())
  expect(requests).toEqual([])
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
  await screen.findByRole("alert")
  expect(requests).toHaveLength(1)
  expect(JSON.parse(requests[0]).allocations).toEqual(
    draft === "replacement" ? [{ customerInvoiceId: "invented-reference", amountMinor: 100000 }] : [],
  )
})
it("replays the exact lost allocation after choice capacity changes, but validates a new edited intent", async () => {
  const requests: string[] = []
  let available = 1000
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method) {
        requests.push(String(init.body))
        available = 0
        throw new TypeError("Response lost after commit")
      }
      const invoice = structuredClone(fixture.customerInvoices.items[0])
      invoice.availableMinor = available
      return new Response(JSON.stringify({ items: [invoice], nextCursor: null, total: 1 }))
    }),
  )
  const receipt = structuredClone(fixture.receipts.items[0]) as ReceiptView
  receipt.allocations = []
  receipt.amountMinor = 1000
  receipt.allocatedMinor = 0
  receipt.unallocatedMinor = 1000
  mountAllocation(receipt)
  fireEvent.click(await screen.findByRole("button", { name: "Add allocation" }))
  fireEvent.change(screen.getByLabelText(/Allocation for EXAMPLE-1/), { target: { value: "10.00" } })
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
  await screen.findByRole("alert")
  expect(requests).toHaveLength(1)
  expect(JSON.parse(requests[0])).toEqual({
    allocations: [{ customerInvoiceId: "invented-reference", amountMinor: 1000 }],
    expectedVersion: "3:canonical",
    requestKey: expect.any(String),
  })
  fireEvent.change(screen.getByLabelText("Search invoice number or case title"), {
    target: { value: "EX" },
  })
  await waitFor(() =>
    expect(screen.getByText(/Maximum for this replacement:/)).toHaveTextContent(
      /Maximum for this replacement: 0\.00 NZD$/,
    ),
  )
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
  await waitFor(() => expect(requests).toHaveLength(2))
  expect(requests[1]).toBe(requests[0])
  fireEvent.change(screen.getByLabelText(/Allocation for EXAMPLE-1/), { target: { value: "10" } })
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
  await waitFor(() => expect(requests).toHaveLength(3))
  expect(requests[2]).toBe(requests[0])
  fireEvent.change(screen.getByLabelText(/Allocation for EXAMPLE-1/), { target: { value: "9" } })
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
  await screen.findByText("Allocations exceed the receipt or an invoice available amount.")
  expect(requests).toHaveLength(3)
})
it("keeps off-page allocation context and replaces the complete set, including empty reversal and server conflict", async () => {
  const requests: Record<string, unknown>[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method) {
        requests.push(JSON.parse(String(init.body)))
        return new Response(
          JSON.stringify({ code: "ALLOCATION_EXCEEDS_AVAILABLE", message: "Available amount changed" }),
          { status: 409 },
        )
      }
      return new Response(JSON.stringify({ items: [], nextCursor: null, total: 0 }))
    }),
  )
  const receipt = structuredClone(fixture.receipts.items[0]) as ReceiptView
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <ReceiptAllocationDialog
        companyId="invented-company"
        projectId="invented-project"
        versionToken="3:canonical"
        open
        onOpenChange={vi.fn()}
        onReload={async () => "4:fresh"}
        receipt={receipt}
      />
    </QueryClientProvider>,
  )
  expect(screen.getByLabelText(/Allocation for EXAMPLE-1/)).toHaveValue("2300.00")
  expect(screen.getByText(/Maximum for this replacement: 2300.00 NZD/)).toBeInTheDocument()
  fireEvent.change(screen.getByLabelText(/Allocation for EXAMPLE-1/), { target: { value: "2300.01" } })
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
  await screen.findByText("Allocations exceed the receipt or an invoice available amount.")
  expect(requests).toHaveLength(0)
  fireEvent.click(screen.getByRole("button", { name: "Clear allocations" }))
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
  await screen.findByText("Available amount changed")
  expect(requests[0]).toEqual({
    allocations: [],
    requestKey: expect.any(String),
    expectedVersion: "3:canonical",
  })
  expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled()
  fireEvent.click(screen.getByRole("button", { name: "Reload project" }))
  await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled())
  expect(requests).toHaveLength(1)
})

it("preserves the complete dirty allocation set by invoice identity after refreshed server rows reorder", async () => {
  const requests: Record<string, unknown>[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method) {
        requests.push(JSON.parse(String(init.body)))
        return new Response(
          JSON.stringify({ code: "ALLOCATION_EXCEEDS_AVAILABLE", message: "Changed allocation set" }),
          { status: 409 },
        )
      }
      return new Response(JSON.stringify({ items: [], nextCursor: null, total: 0 }))
    }),
  )
  const base = structuredClone(fixture.receipts.items[0]) as ReceiptView
  const b = structuredClone(base.allocations[0])
  b.id = "allocation-b"
  b.customerInvoiceId = "invoice-b"
  b.amountMinor = 100000
  b.customerInvoice = {
    ...b.customerInvoice,
    id: "invoice-b",
    number: "EXAMPLE-B",
    originalGrossMinor: 100000,
    adjustedGrossMinor: 100000,
    allocatedMinor: 100000,
  }
  base.amountMinor = 330000
  base.allocatedMinor = 330000
  base.allocations.push(b)
  function Harness() {
    const [receipt, setReceipt] = React.useState(base)
    const [version, setVersion] = React.useState("3:before")
    return (
      <ReceiptAllocationDialog
        companyId="invented-company"
        projectId="invented-project"
        versionToken={version}
        open
        onOpenChange={vi.fn()}
        onReload={async () => {
          const a = structuredClone(base.allocations[0])
          a.amountMinor = 200000
          a.customerInvoice.allocatedMinor = 200000
          a.customerInvoice.availableMinor = 30000
          const nextB = structuredClone(b)
          nextB.amountMinor = 50000
          nextB.customerInvoice.allocatedMinor = 50000
          nextB.customerInvoice.availableMinor = 50000
          setReceipt({ ...base, allocations: [nextB, a], allocatedMinor: 250000, unallocatedMinor: 80000 })
          setVersion("4:after")
          return "4:after"
        }}
        receipt={receipt}
      />
    )
  }
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  )
  fireEvent.change(screen.getByLabelText(/Allocation for EXAMPLE-1/), { target: { value: "1000.00" } })
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
  await screen.findByText("Changed allocation set")
  fireEvent.click(screen.getByRole("button", { name: "Reload project" }))
  await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled())
  expect(screen.getByLabelText(/Allocation for EXAMPLE-1/)).toHaveValue("1000.00")
  expect(screen.getByLabelText(/Allocation for EXAMPLE-B/)).toHaveValue("1000.00")
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
  await waitFor(() => expect(requests).toHaveLength(2))
  expect(requests[1]).toMatchObject({
    allocations: [
      { customerInvoiceId: "invented-reference", amountMinor: 100000 },
      { customerInvoiceId: "invoice-b", amountMinor: 100000 },
    ],
    expectedVersion: "4:after",
  })
})
