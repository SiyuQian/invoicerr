import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import { ApiError } from "@/hooks/use-api-query"
import { useCreateReconciliationCase } from "@/hooks/queries/use-project-reconciliation"
import {
  MutationDialog,
  ReconciliationTextField,
  ReconciliationChoiceField,
  minorAmountSchema,
  useReconciliationForm,
} from "./mutation-form"

vi.mock("@/hooks/queries/use-companies", () => ({
  useCompanies: () => ({ activeCompanyId: "company-a", activeRole: "OWNER" }),
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
const schema = z.strictObject({ title: z.string().trim().min(1), mode: z.string().nullable() })
function Harness({
  versionToken = "1:source",
  sourceLabel = "old",
  onReload = async () => "2:fresh",
}: {
  versionToken?: string
  sourceLabel?: string
  onReload?: () => Promise<string>
}) {
  const mutation = useCreateReconciliationCase("company-a", "project-a")
  const state = useReconciliationForm(
    {
      companyId: "company-a",
      projectId: "project-a",
      versionToken,
      open: true,
      onOpenChange: vi.fn(),
      onReload,
    },
    { title: "Case", mode: null },
    schema.transform((value) => ({ ...value, sourceLabel })),
    async (input) => mutation.mutateAsync(input as never),
  )
  return (
    <MutationDialog state={state} title="Edit case">
      <ReconciliationTextField name="title" label="Title" />
      <ReconciliationChoiceField
        name="mode"
        label="Mode"
        options={[
          { value: "", label: "None" },
          { value: "A", label: "A" },
        ]}
      />
    </MutationDialog>
  )
}
function mount(props: Parameters<typeof Harness>[0] = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(<Harness {...props} />, {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  })
}
describe("exact mutation attempt lifecycle", () => {
  it("keeps the attempted payload/key/token through response loss, newer props, search and same nullable selection", async () => {
    const requests: Record<string, unknown>[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        requests.push(JSON.parse(init.body))
        throw new TypeError("Response lost")
      }),
    )
    const view = mount()
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await screen.findByRole("alert")
    view.rerender(<Harness versionToken="9:background" sourceLabel="background" />)
    fireEvent.click(screen.getByRole("button", { name: /Mode/ }))
    fireEvent.change(screen.getByPlaceholderText("Search options"), { target: { value: "None" } })
    fireEvent.click(await screen.findByRole("option", { name: "None" }))
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]).toEqual(requests[0])
    expect(requests[0]).toMatchObject({ mode: null, expectedVersion: "1:source" })
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Changed" } })
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(requests).toHaveLength(3))
    expect(requests[2].requestKey).not.toBe(requests[0].requestKey)
    expect(requests[2].title).toBe("Changed")
    view.unmount()
  })
  it("keeps 409 blocked through persisted edits and failed reload, preserves draft and permits only deliberate save after fresh reload", async () => {
    const requests: Record<string, unknown>[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        requests.push(JSON.parse(init.body))
        return new Response(JSON.stringify({ code: "RECONCILIATION_CHANGED", message: "Changed" }), {
          status: 409,
        })
      }),
    )
    const reload = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, "Unavailable"))
      .mockResolvedValueOnce("2:fresh")
    const view = mount({ onReload: reload })
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await screen.findByRole("alert")
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Keep this draft" } })
    view.rerender(<Harness onReload={reload} versionToken="99:background" />)
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Reload project" }))
    await screen.findByText("Could not refresh. Your draft is preserved; saving remains blocked.")
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled()
    fireEvent.click(screen.getByRole("button", { name: "Reload project" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled())
    expect(requests).toHaveLength(1)
    expect(screen.getByLabelText("Title")).toHaveValue("Keep this draft")
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]).toMatchObject({ title: "Keep this draft", expectedVersion: "2:fresh" })
    expect(requests[1].requestKey).not.toBe(requests[0].requestKey)
  })
})
describe("project currency amounts", () => {
  it("keeps unknown distinct from zero and rejects precision loss, exponent syntax, overflow and negative amounts", () => {
    expect(minorAmountSchema("NZD", true).parse("")).toBeNull()
    expect(minorAmountSchema("NZD", true).parse("0")).toBe(0)
    expect(minorAmountSchema("NZD", false).parse("12.34")).toBe(1234)
    expect(minorAmountSchema("JPY", false).parse("12")).toBe(12)
    expect(minorAmountSchema("KWD", false).parse("12.345")).toBe(12345)
    for (const value of ["1.001", "1e2", "21474836.48", "-1", "Infinity", "0x10"])
      expect(minorAmountSchema("NZD", false).safeParse(value).success).toBe(false)
    expect(minorAmountSchema("JPY", false).safeParse("1.1").success).toBe(false)
    expect(minorAmountSchema("NZD", false, true).safeParse("0").success).toBe(false)
  })
})

it("uses the opening version before first save even when background props advance", async () => {
  const requests: Record<string, unknown>[] = []
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body))
      throw new TypeError("Response lost")
    }),
  )
  const view = mount()
  fireEvent.change(screen.getByLabelText("Title"), { target: { value: "My draft" } })
  view.rerender(<Harness versionToken="9:unseen-change" />)
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
  await screen.findByRole("alert")
  expect(requests[0]).toMatchObject({ title: "My draft", expectedVersion: "1:source" })
})
