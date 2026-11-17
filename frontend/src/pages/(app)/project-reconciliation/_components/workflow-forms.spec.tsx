import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest"
import type {
  ExternalInvoiceRecord,
  ReceiptRecord,
  CaseView,
  ReconciliationException,
} from "@/types/project-reconciliation"
import { CaseUpsert } from "./case-upsert"
import { ExternalInvoiceUpsert, CreditAdjustmentDialog } from "./external-invoice-upsert"
import { ReceiptUpsert, ReceiptVoidDialog } from "./receipt-upsert"
import { DocumentLinkDialog, DocumentUnlinkDialog } from "./document-link-dialog"
import { ReviewDialog, EvidenceCoverageDialog } from "./review-dialog"

const session = vi.hoisted(() => ({ activeCompanyId: "company-a", activeRole: "OWNER" }))
vi.mock("@/hooks/queries/use-companies", () => ({ useCompanies: () => session }))
beforeEach(() => {
  session.activeCompanyId = "company-a"
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
const common = {
  companyId: "company-a",
  projectId: "project-a",
  versionToken: "1:canonical",
  open: true,
  onOpenChange: vi.fn(),
  onReload: vi.fn(async () => "1:canonical"),
}
const requests: { url: string; method: string; body: Record<string, unknown> }[] = []
function fetchRequests(status = 503) {
  requests.length = 0
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) {
        requests.push({ url, method: init.method, body: JSON.parse(String(init.body)) })
        return new Response(JSON.stringify({ code: "FINANCIAL_READ_UNAVAILABLE", message: "Unavailable" }), {
          status,
        })
      }
      return new Response(
        JSON.stringify({
          items: [
            {
              id: "doc-1",
              typeId: "invoice",
              number: 1,
              displayNumber: "INV-1",
              status: "draft",
              data: {},
              createdAt: "2026-01-01",
              updatedAt: "2026-01-01",
              companyId: "company-a",
            },
          ],
          total: 1,
          page: 1,
          pageSize: 25,
          totalPages: 1,
        }),
      )
    }),
  )
}
function mount(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>)
}
const receipt: ReceiptRecord = {
  id: "receipt-1",
  companyId: "company-a",
  projectId: "project-a",
  amountMinor: 1234,
  currency: "NZD",
  paidOn: null,
  collector: "Example partner",
  evidenceClass: "EVIDENCE_CHECKED",
  sourceReference: "Statement 1",
  evidenceReference: "Statement 1",
  evidenceUrl: null,
  reason: "Historical evidence",
  sourceSystem: null,
  sourceId: null,
  enteredBy: "user:1",
  reviewedBy: "user:1",
  reviewedAt: "2026-01-01T00:00:00Z",
  humanAttestation: "Checked",
  version: 3,
  voidedAt: null,
  voidedBy: null,
  voidReason: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}
const external: ExternalInvoiceRecord = {
  id: "invoice-1",
  companyId: "company-a",
  projectId: "project-a",
  caseId: "case-1",
  documentLinkId: null,
  external: {
    issuer: "Partner",
    recipient: "Customer",
    number: "EXT-1",
    issueDate: null,
    dueDate: null,
    currency: "NZD",
    grossMinor: 230000,
    netMinor: null,
    vatMinor: null,
    reportedStatus: "Paid",
    sourceSystem: null,
    sourceId: null,
    sourceAsOf: null,
    sourceReference: "Export 1",
  },
  originalGrossMinor: 230000,
  creditAdjustmentMinor: 100,
  adjustedGrossMinor: 229900,
  sourceSnapshot: {},
  snapshotHash: "a".repeat(64),
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}
const zero = { knownMinor: 0, missingCount: 0, completeness: "COMPLETE" as const }
function caseView(exceptions: ReconciliationException[] = [], ownMinor = 0): CaseView {
  return {
    id: "case-1",
    companyId: "company-a",
    projectId: "project-a",
    title: "Case A",
    periodStart: null,
    periodEnd: null,
    agreedGrossMinor: null,
    agreedNetMinor: null,
    agreedVatMinor: null,
    agreementReference: null,
    status: "OPEN",
    version: 2,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    coverage: { state: "MISSING", invoices: [] },
    customerInvoices: [],
    documentLinks: [],
    effectiveReviewState: "OPEN",
    exceptions,
    sourceMarkedPaid: zero,
    checkedReceipts: zero,
    reportedReceipts: zero,
    undated: {
      checkedReceipts: { ...zero, count: 0 },
      reportedReceipts: { ...zero, count: 0 },
      ownRecordedReceipts: { ...zero, count: 0 },
    },
    summary: {
      customerInvoiced: zero,
      customerCredits: zero,
      customerCollectible: zero,
      customerRemaining: zero,
      agreedSettlement: zero,
      unbilledDifference: zero,
      settlementInvoiced: zero,
      ownRecordedReceipts: zero,
      ownOutstanding: { ...zero, knownMinor: ownMinor },
      partnerBills: zero,
      partnerPaid: zero,
      partnerOutstanding: zero,
      projectCosts: zero,
    },
  }
}
const exception = (code: string): ReconciliationException => ({
  code,
  message: code,
  fingerprint: "b".repeat(64),
  caseId: "case-1",
  blocking: true,
})
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save changes" }))
describe("project record forms", () => {
  it("hides unsupported settlement controls when the loaded project has no partner", () => {
    fetchRequests()
    mount(<CaseUpsert {...common} currency="NZD" partnerClientId={null} />)
    expect(screen.queryByLabelText(/Agreed gross/)).not.toBeInTheDocument()
    expect(screen.queryByLabelText(/Agreement reference/)).not.toBeInTheDocument()
  })
  it("creates a case with unknown dates/amounts intact and explicit zero distinguished", async () => {
    fetchRequests()
    mount(<CaseUpsert {...common} currency="NZD" partnerClientId="partner-1" />)
    fireEvent.change(screen.getByLabelText(/Case title/), { target: { value: "Planning" } })
    fireEvent.change(screen.getByLabelText(/Agreed gross/), { target: { value: "0" } })
    save()
    await screen.findByRole("alert")
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: expect.stringContaining("/projects/project-a/cases"),
      body: {
        title: "Planning",
        periodStart: null,
        periodEnd: null,
        agreedGrossMinor: 0,
        agreedNetMinor: null,
        agreedVatMinor: null,
        agreementReference: null,
        expectedVersion: "1:canonical",
      },
    })
  })
  it("preserves unknown receipt date and requires fresh checked attestation for every fact edit", async () => {
    fetchRequests()
    mount(<ReceiptUpsert {...common} collectionMode="PARTNER" currency="NZD" receipt={receipt} />)
    expect(screen.getByRole("checkbox", { name: /I checked/ })).not.toBeChecked()
    fireEvent.change(screen.getByLabelText(/Receipt amount/), { target: { value: "20.00" } })
    save()
    await screen.findByText("Confirm that you checked the evidence for these receipt facts.")
    expect(requests).toHaveLength(0)
    fireEvent.click(screen.getByRole("checkbox", { name: /I checked/ }))
    save()
    await screen.findByRole("alert")
    expect(requests[0]).toMatchObject({
      method: "PATCH",
      url: expect.stringContaining("/receipts/receipt-1"),
      body: {
        amountMinor: 2000,
        paidOn: null,
        attested: true,
        evidenceReference: "Statement 1",
        reason: "Historical evidence",
        expectedVersion: "1:canonical",
      },
    })
    save()
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1].body).toEqual(requests[0].body)
  })
  it("does not turn reported Paid into receipt evidence or alter original gross after credits", async () => {
    fetchRequests()
    mount(
      <ExternalInvoiceUpsert
        {...common}
        currency="NZD"
        collectionMode="PARTNER"
        caseId="case-1"
        invoice={external}
      />,
    )
    expect(screen.getByLabelText(/Original gross/)).toBeDisabled()
    save()
    await screen.findByRole("alert")
    expect(requests[0]).toMatchObject({
      method: "PATCH",
      body: {
        grossMinor: 230000,
        reportedStatus: "Paid",
        netMinor: null,
        vatMinor: null,
        issueDate: null,
        dueDate: null,
      },
    })
    expect(requests).toHaveLength(1)
    expect(requests[0].url).toContain("/cases/case-1/customer-invoices/invoice-1")
  })
  it("submits explicit disposition evidence through the existing invoice editor", async () => {
    fetchRequests()
    mount(
      <ExternalInvoiceUpsert
        {...common}
        currency="NZD"
        collectionMode="PARTNER"
        caseId="case-1"
        invoice={external}
      />,
    )
    fireEvent.change(screen.getByRole("textbox", { name: /Credit disposition evidence reference/ }), {
      target: { value: "Refund RF-1" },
    })
    fireEvent.change(screen.getByLabelText(/How the released money was resolved/), {
      target: { value: "Customer received refund" },
    })
    save()
    await screen.findByText("Provide an evidence reference, reason and explicit human confirmation.")
    expect(requests).toHaveLength(0)
    fireEvent.click(screen.getByRole("checkbox", { name: /I checked the evidence resolving/ }))
    save()
    await screen.findByRole("alert")
    expect(requests[0].body.creditResolution).toEqual({
      evidenceReference: "Refund RF-1",
      reason: "Customer received refund",
      attested: true,
    })
  })
  it("captures matching invoice context and requires evidence after duplicate conflict reload", async () => {
    fetchRequests()
    const originalFetch = globalThis.fetch
    let failed = false
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method && !failed) {
          failed = true
          return new Response(
            JSON.stringify({
              code: "DUPLICATE_INVOICE_REVIEW_REQUIRED",
              message: "Review matching references",
              params: {
                fingerprint: "b".repeat(64),
                matches: [
                  {
                    id: "matching-id",
                    issuer: "Legal issuer",
                    invoiceNumber: "INV-77",
                    issueDate: "2026-01-01",
                    project: { name: "Earlier project" },
                  },
                ],
              },
            }),
            { status: 409 },
          )
        }
        return originalFetch(url, init)
      }),
    )
    mount(
      <ExternalInvoiceUpsert
        {...common}
        currency="NZD"
        collectionMode="PARTNER"
        caseId="case-1"
        invoice={external}
      />,
    )
    save()
    await screen.findByText(/Legal issuer · INV-77 · 2026 · Earlier project/)
    expect(screen.queryByDisplayValue("matching-id")).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Reload project" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled())
    fireEvent.change(screen.getByRole("textbox", { name: /Identity review evidence reference/ }), {
      target: { value: "Registry evidence" },
    })
    fireEvent.change(screen.getByLabelText(/Why these are distinct invoices/), {
      target: { value: "Different registered issuers" },
    })
    fireEvent.click(screen.getByRole("checkbox", { name: /I checked these references/ }))
    save()
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0].body.duplicateReview).toEqual({
      invoiceIds: ["matching-id"],
      fingerprint: "b".repeat(64),
      evidenceReference: "Registry evidence",
      reason: "Different registered issuers",
      attested: true,
    })
  })
  it.each([
    "issuer",
    "number",
    "issueDate",
  ] as const)("discards duplicate evidence when %s changes and retries the unique identity unchanged", async (field) => {
    fetchRequests()
    const originalFetch = globalThis.fetch
    let failed = false
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method && !failed) {
          failed = true
          return new Response(
            JSON.stringify({
              code: "DUPLICATE_INVOICE_REVIEW_REQUIRED",
              message: "Review matching references",
              params: {
                fingerprint: "b".repeat(64),
                matches: [
                  {
                    id: "matching-id",
                    issuer: "Legal issuer",
                    invoiceNumber: "INV-77",
                    issueDate: "2026-01-01",
                    project: { name: "Earlier project" },
                  },
                ],
              },
            }),
            { status: 409 },
          )
        }
        return originalFetch(url, init)
      }),
    )
    mount(
      <ExternalInvoiceUpsert
        {...common}
        currency="NZD"
        collectionMode="PARTNER"
        caseId="case-1"
        invoice={{ ...external, external: { ...external.external, issueDate: "2026-01-01" } }}
      />,
    )
    save()
    await screen.findByText(/Legal issuer · INV-77 · 2026 · Earlier project/)
    fireEvent.change(screen.getByRole("textbox", { name: /Identity review evidence reference/ }), {
      target: { value: "Evidence for the old identity" },
    })
    fireEvent.change(screen.getByRole("textbox", { name: /Why these are distinct invoices/ }), {
      target: { value: "Old reason" },
    })
    fireEvent.click(screen.getByRole("checkbox", { name: /I checked these references/ }))
    if (field === "issueDate") fireEvent.click(screen.getAllByRole("button", { name: "Clear date" })[0])
    else
      fireEvent.change(
        screen.getByRole("textbox", { name: field === "issuer" ? /^Issuer/ : /Invoice number/ }),
        { target: { value: "Unique corrected identity" } },
      )
    await waitFor(() =>
      expect(screen.queryByRole("checkbox", { name: /I checked these references/ })).not.toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole("button", { name: "Reload project" }))
    await waitFor(() => expect(screen.getByRole("button", { name: "Save changes" })).toBeEnabled())
    save()
    await waitFor(() => expect(requests).toHaveLength(1))
    expect(requests[0].body).not.toHaveProperty("duplicateReview")
    expect(requests[0].body[field]).toBe(field === "issueDate" ? null : "Unique corrected identity")
    await screen.findByRole("alert")
    save()
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1].body).toEqual(requests[0].body)
  })
  it("records a positive credit with source and reason on the project endpoint", async () => {
    fetchRequests()
    mount(<CreditAdjustmentDialog {...common} currency="NZD" invoiceId="invoice-1" />)
    fireEvent.change(screen.getByLabelText(/Credit amount/), { target: { value: "1.23" } })
    fireEvent.change(screen.getByLabelText(/Source reference/), { target: { value: "Credit 1" } })
    fireEvent.change(screen.getByRole("textbox", { name: /^Reason\s*\*?$/ }), {
      target: { value: "Correction" },
    })
    save()
    await screen.findByRole("alert")
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: expect.stringContaining("/customer-invoices/invoice-1/credit-adjustments"),
      body: { amountMinor: 123, sourceReference: "Credit 1", reason: "Correction" },
    })
  })
  it("voids without inheriting attestation and disables receipt editing when voided", async () => {
    fetchRequests()
    const view = mount(<ReceiptVoidDialog {...common} receiptId="receipt-1" />)
    fireEvent.change(screen.getByRole("textbox", { name: /^Reason\s*\*?$/ }), {
      target: { value: "Duplicate evidence" },
    })
    save()
    await screen.findByRole("alert")
    expect(requests[0].body).toEqual({
      reason: "Duplicate evidence",
      requestKey: expect.any(String),
      expectedVersion: "1:canonical",
    })
    view.unmount()
    mount(
      <ReceiptUpsert
        {...common}
        collectionMode="PARTNER"
        currency="NZD"
        receipt={{ ...receipt, voidedAt: "2026-01-02T00:00:00Z" }}
      />,
    )
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled()
  })
  it("links a COMPANY customer document through document-links, not external invoices", async () => {
    fetchRequests()
    mount(<DocumentLinkDialog {...common} collectionMode="COMPANY" caseId="case-1" />)
    await waitFor(() => expect(screen.getByRole("button", { name: /Existing document/ })).toBeEnabled())
    fireEvent.click(screen.getByRole("button", { name: /Existing document/ }))
    fireEvent.click(await screen.findByRole("option", { name: /INV-1/ }))
    save()
    await screen.findByRole("alert")
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: expect.stringContaining("/document-links"),
      body: { documentId: "doc-1", typeId: "invoice", caseId: "case-1", role: "CUSTOMER_INVOICE" },
    })
  })
  it("unlinks with a reason without deleting the financial document", async () => {
    fetchRequests()
    mount(<DocumentUnlinkDialog {...common} linkId="link-1" />)
    fireEvent.change(screen.getByRole("textbox", { name: /^Reason\s*\*?$/ }), {
      target: { value: "Wrong project" },
    })
    save()
    await screen.findByRole("alert")
    expect(requests[0]).toMatchObject({
      method: "POST",
      url: expect.stringContaining("/document-links/link-1/unlink"),
      body: { reason: "Wrong project" },
    })
  })
  it.each(["COMPANY"])("does not expose PARTNER-only evidence entry in %s collection", (mode) => {
    mount(<ReceiptUpsert {...common} collectionMode={mode as "COMPANY"} currency="NZD" />)
    expect(screen.queryByRole("button", { name: "Save changes" })).not.toBeInTheDocument()
  })
  it("closes and reopens with fresh receipt attestation and no previous request attempt", async () => {
    fetchRequests()
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const props = { ...common, collectionMode: "PARTNER" as const, currency: "NZD" as const, receipt }
    const view = render(
      <QueryClientProvider client={client}>
        <ReceiptUpsert {...props} />
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByRole("checkbox", { name: /I checked/ }))
    save()
    await screen.findByRole("alert")
    view.rerender(
      <QueryClientProvider client={client}>
        <ReceiptUpsert {...props} open={false} />
      </QueryClientProvider>,
    )
    view.rerender(
      <QueryClientProvider client={client}>
        <ReceiptUpsert {...props} />
      </QueryClientProvider>,
    )
    expect(screen.getByRole("checkbox", { name: /I checked/ })).not.toBeChecked()
    fireEvent.click(screen.getByRole("checkbox", { name: /I checked/ }))
    save()
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1].body.requestKey).not.toBe(requests[0].body.requestKey)
  })
})
describe("review and coverage decisions", () => {
  it("blocks either closure for known positive own balance and never offers verification for unknown evidence", () => {
    const view = mount(<ReviewDialog {...common} caseRecord={caseView([exception("OWN_OUTSTANDING")], 1)} />)
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled()
    view.unmount()
    mount(<ReviewDialog {...common} caseRecord={caseView([exception("RECEIPT_EVIDENCE_MISSING")])} />)
    fireEvent.click(screen.getByRole("button", { name: /Review action/ }))
    expect(screen.queryByRole("option", { name: "Verify" })).not.toBeInTheDocument()
    expect(screen.getByRole("option", { name: "Accept exact exceptions" })).toBeInTheDocument()
  })
  it("accepts only material allowlisted exact exception fingerprints and fresh token", async () => {
    fetchRequests()
    mount(
      <ReviewDialog
        {...common}
        caseRecord={caseView([
          exception("RECEIPT_DATE_MISSING"),
          { ...exception("SOURCE_CHANGED"), blocking: false },
        ])}
      />,
    )
    fireEvent.change(screen.getByRole("textbox", { name: /^Reason\s*\*?$/ }), {
      target: { value: "Historical review" },
    })
    fireEvent.change(screen.getByLabelText(/Reason for RECEIPT_DATE_MISSING/), {
      target: { value: "Statement lacks date" },
    })
    save()
    await screen.findByRole("alert")
    expect(requests[0].body).toMatchObject({
      mode: "ACCEPT_EXCEPTIONS",
      exceptions: [
        { code: "RECEIPT_DATE_MISSING", fingerprint: "b".repeat(64), reason: "Statement lacks date" },
      ],
      reason: "Historical review",
    })
  })
  it("does not send a review after a changed canonical reload", async () => {
    fetchRequests()
    mount(<ReviewDialog {...common} onReload={async () => "2:changed"} caseRecord={caseView()} />)
    fireEvent.change(screen.getByRole("textbox", { name: /^Reason\s*\*?$/ }), {
      target: { value: "Checked current sources" },
    })
    save()
    await screen.findByRole("alert")
    expect(requests).toHaveLength(0)
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled()
  })
  it("requires explicit selected invoice IDs, source-as-of, reference and fresh coverage attestation", async () => {
    fetchRequests()
    mount(<EvidenceCoverageDialog {...common} customerInvoices={[{ id: "invoice-1", number: "EXT-1" }]} />)
    fireEvent.click(screen.getByRole("checkbox", { name: "EXT-1" }))
    fireEvent.change(screen.getByRole("textbox", { name: /Source as of/ }), {
      target: { value: "2026-01-01T12:00:00Z" },
    })
    fireEvent.change(screen.getByLabelText(/Evidence reference/), { target: { value: "Full statement" } })
    fireEvent.click(screen.getByRole("checkbox", { name: /I confirm/ }))
    save()
    await screen.findByRole("alert")
    expect(requests[0]).toMatchObject({
      url: expect.stringContaining("/evidence-coverage"),
      body: {
        customerInvoiceIds: ["invoice-1"],
        sourceAsOf: "2026-01-01T12:00:00Z",
        evidenceReference: "Full statement",
        attested: true,
      },
    })
  })
})

describe("decision retry and attestation lifecycle", () => {
  it("clears a receipt attestation after a new persisted fact edit, while unchanged facts keep retry identity", async () => {
    fetchRequests()
    mount(<ReceiptUpsert {...common} collectionMode="PARTNER" currency="NZD" receipt={receipt} />)
    fireEvent.click(screen.getByRole("checkbox", { name: /I checked/ }))
    save()
    await screen.findByRole("alert")
    fireEvent.change(screen.getByLabelText(/Receipt amount/), { target: { value: "20.00" } })
    await waitFor(() => expect(screen.getByRole("checkbox", { name: /I checked/ })).not.toBeChecked())
    save()
    await screen.findByText("Confirm that you checked the evidence for these receipt facts.")
    expect(requests).toHaveLength(1)
  })
  it("retries a response-lost review with its original key/token without preflighting away an idempotent result", async () => {
    const reload = vi.fn().mockResolvedValueOnce("1:canonical").mockResolvedValue("2:committed")
    requests.length = 0
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, method: init!.method!, body: JSON.parse(String(init!.body)) })
        throw new TypeError("Response lost after review")
      }),
    )
    mount(<ReviewDialog {...common} onReload={reload} caseRecord={caseView()} />)
    fireEvent.change(screen.getByRole("textbox", { name: /^Reason\s*\*?$/ }), {
      target: { value: "Checked sources" },
    })
    save()
    await screen.findByRole("alert")
    save()
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1].body).toEqual(requests[0].body)
    expect(reload).toHaveBeenCalledTimes(1)
  })
  it("allows unsupported historical balance exceptions but does not offer acceptance of an unissued document", () => {
    const view = mount(<ReviewDialog {...common} caseRecord={caseView([exception("BALANCE_UNAVAILABLE")])} />)
    fireEvent.click(screen.getByRole("button", { name: /Review action/ }))
    expect(screen.getByRole("option", { name: "Accept exact exceptions" })).toBeInTheDocument()
    view.unmount()
    mount(<ReviewDialog {...common} caseRecord={caseView([exception("DOCUMENT_NOT_ISSUED")])} />)
    fireEvent.click(screen.getByRole("button", { name: /Review action/ }))
    expect(screen.queryByRole("option", { name: "Accept exact exceptions" })).not.toBeInTheDocument()
  })
  it("treats SOURCE_CHANGED alone as a stale marker, not an exception that needs acceptance", async () => {
    fetchRequests()
    mount(
      <ReviewDialog
        {...common}
        caseRecord={caseView([{ ...exception("SOURCE_CHANGED"), blocking: false }])}
      />,
    )
    fireEvent.change(screen.getByRole("textbox", { name: /^Reason\s*\*?$/ }), {
      target: { value: "Rechecked sources" },
    })
    save()
    await screen.findByRole("alert")
    expect(requests[0].body).toMatchObject({ mode: "VERIFY", exceptions: [] })
  })
  it("keeps an actual canonical read outage from sending a review", async () => {
    fetchRequests()
    mount(
      <ReviewDialog
        {...common}
        onReload={async () => {
          throw new Error("FINANCIAL_READ_UNAVAILABLE")
        }}
        caseRecord={caseView()}
      />,
    )
    fireEvent.change(screen.getByRole("textbox", { name: /^Reason\s*\*?$/ }), {
      target: { value: "Checked sources" },
    })
    save()
    await screen.findByRole("alert")
    expect(requests).toHaveLength(0)
  })
  it("drops previous target draft/attestation/attempt on target or company change", async () => {
    fetchRequests()
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
    const view = render(
      <QueryClientProvider client={client}>
        <ReceiptUpsert {...common} collectionMode="PARTNER" currency="NZD" receipt={receipt} />
      </QueryClientProvider>,
    )
    fireEvent.click(screen.getByRole("checkbox", { name: /I checked/ }))
    save()
    await screen.findByRole("alert")
    view.rerender(
      <QueryClientProvider client={client}>
        <ReceiptUpsert
          {...common}
          collectionMode="PARTNER"
          currency="NZD"
          receipt={{ ...receipt, id: "receipt-2", amountMinor: 700 }}
        />
      </QueryClientProvider>,
    )
    expect(screen.getByLabelText(/Receipt amount/)).toHaveValue("7.00")
    expect(screen.getByRole("checkbox", { name: /I checked/ })).not.toBeChecked()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    session.activeCompanyId = "company-b"
    view.rerender(
      <QueryClientProvider client={client}>
        <ReceiptUpsert
          {...common}
          companyId="company-b"
          projectId="project-b"
          collectionMode="PARTNER"
          currency="NZD"
        />
      </QueryClientProvider>,
    )
    expect(screen.getByLabelText(/Receipt amount/)).toHaveValue("")
    expect(screen.getByRole("button", { name: /Evidence class/ })).toHaveTextContent("Partner reported")
  })
})

describe("normalized receipt retry identity", () => {
  it("retains consent and exact body/key/token when 10.00 is reformatted to 10 after response loss", async () => {
    fetchRequests()
    mount(
      <ReceiptUpsert
        {...common}
        collectionMode="PARTNER"
        currency="NZD"
        receipt={{ ...receipt, amountMinor: 1000 }}
      />,
    )
    fireEvent.click(screen.getByRole("checkbox", { name: /I checked/ }))
    save()
    await screen.findByRole("alert")
    fireEvent.change(screen.getByLabelText(/Receipt amount/), { target: { value: "10" } })
    expect(screen.getByRole("checkbox", { name: /I checked/ })).toBeChecked()
    save()
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1].body).toEqual(requests[0].body)
  })
  it("does not show a prior company receipt under a new company context", () => {
    session.activeCompanyId = "company-b"
    mount(
      <ReceiptUpsert
        {...common}
        companyId="company-b"
        projectId="project-b"
        collectionMode="PARTNER"
        currency="NZD"
        receipt={receipt}
      />,
    )
    expect(screen.queryByLabelText(/Receipt amount/)).not.toBeInTheDocument()
  })
})

it("does not start a review after its dialog closes during canonical preflight", async () => {
  fetchRequests()
  let finish!: (token: string) => void
  const reload = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve
      }),
  )
  const view = mount(<ReviewDialog {...common} onReload={reload} caseRecord={caseView()} />)
  fireEvent.change(screen.getByRole("textbox", { name: /^Reason\s*\*?$/ }), {
    target: { value: "Checked sources" },
  })
  save()
  await waitFor(() => expect(reload).toHaveBeenCalledOnce())
  view.unmount()
  finish("1:canonical")
  await waitFor(() => expect(requests).toHaveLength(0))
  await new Promise((resolve) => setTimeout(resolve, 0))
  expect(requests).toHaveLength(0)
})

it("permits an explicit REOPEN with a reason when positive own balance blocks both closure choices", async () => {
  fetchRequests()
  mount(<ReviewDialog {...common} caseRecord={caseView([exception("OWN_OUTSTANDING")], 1)} />)
  expect(screen.getByRole("button", { name: /Review action/ })).toBeEnabled()
  fireEvent.click(screen.getByRole("button", { name: /Review action/ }))
  fireEvent.click(await screen.findByRole("option", { name: "Reopen" }))
  fireEvent.change(screen.getByRole("textbox", { name: /^Reason\s*\*?$/ }), {
    target: { value: "Reopen unresolved balance" },
  })
  save()
  await screen.findByRole("alert")
  expect(requests[0].body).toMatchObject({ mode: "REOPEN", exceptions: [] })
})

it("suppresses a prior verified badge after canonical review refresh fails", async () => {
  fetchRequests()
  const row = caseView()
  row.effectiveReviewState = "CLOSED_VERIFIED"
  mount(
    <ReviewDialog
      {...common}
      onReload={async () => {
        throw new Error("Canonical unavailable")
      }}
      caseRecord={row}
    />,
  )
  fireEvent.change(screen.getByRole("textbox", { name: /^Reason\s*\*?$/ }), {
    target: { value: "Recheck current sources" },
  })
  save()
  await screen.findByRole("alert")
  expect(screen.queryByText("Verified review")).not.toBeInTheDocument()
  expect(requests).toHaveLength(0)
})
