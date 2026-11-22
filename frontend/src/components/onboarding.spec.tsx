import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react"
import { MemoryRouter } from "react-router"
import { afterEach, expect, it, vi } from "vitest"
import { OnboardingDialogHost, OnboardingDialogProvider, useOnboardingDialog } from "./onboarding"

function OpenOnboardingButton() {
  const { setOpen } = useOnboardingDialog()
  return (
    <button type="button" onClick={() => setOpen(true)}>
      Open company wizard
    </button>
  )
}

const clients: QueryClient[] = []
const originalScrollIntoView = Element.prototype.scrollIntoView
afterEach(() => {
  for (const client of clients.splice(0)) client.clear()
  Element.prototype.scrollIntoView = originalScrollIntoView
  vi.unstubAllGlobals()
})

it("creates an NZ company in NZD without GST registration or an NZBN", async () => {
  Element.prototype.scrollIntoView = vi.fn()
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
  const posts: Record<string, unknown>[] = []
  const company = { id: "company-1", name: "Kiwi Ltd", country: "New Zealand", countryCode: "NZ" }
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost")
    let body: unknown
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)))
      body = company
    } else if (url.pathname === "/api/documents/required-identifiers") {
      body = {
        taxKind: "GST",
        requirements: [
          { scheme: "LEGAL_ID", label: "NZBN", appliesTo: "BOTH", required: false },
          { scheme: "VAT", label: "GST number", appliesTo: "BOTH", required: false },
        ],
      }
    } else if (url.pathname.startsWith("/api/company-lookup/capabilities/")) {
      body = {
        countryCode: "NZ",
        status: "UNAVAILABLE",
        coverage: "REGISTER",
        providers: [],
        schemes: ["LEGAL_ID"],
        identifierLabel: "NZBN",
        noteKeys: [],
      }
    } else if (url.pathname.startsWith("/api/country-readiness/")) {
      body = { countryCode: "NZ", complete: true, present: [], missing: [] }
    } else if (url.pathname === "/api/company/channels") {
      body = { configured: [], suggested: [] }
    } else if (url.pathname === "/api/company/info") {
      body = company
    } else {
      throw new Error(`Unexpected request: ${url.pathname}`)
    }
    return new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  clients.push(client)
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OnboardingDialogProvider>
          <OpenOnboardingButton />
          <OnboardingDialogHost />
        </OnboardingDialogProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole("button", { name: "Open company wizard" }))
  fireEvent.click(within(screen.getByTestId("onboarding-company-country-input")).getByRole("button"))
  fireEvent.click(await screen.findByRole("option", { name: "New Zealand" }))
  fireEvent.click(screen.getByTestId("onboarding-country-next-btn"))
  fireEvent.click(await screen.findByTestId("onboarding-identifier-next-btn"))
  fireEvent.change(await screen.findByTestId("onboarding-company-name-input"), {
    target: { value: "Kiwi Ltd" },
  })
  fireEvent.click(await screen.findByTestId("onboarding-gst-unregistered-switch"))
  fireEvent.click(screen.getByTestId("onboarding-submit-btn"))
  await waitFor(() => expect(posts).toHaveLength(1))
  expect(posts[0]).toMatchObject({ countryCode: "NZ", currency: "NZD", exemptVat: true, identifiers: [] })
})
