// Mirrors the accepted project-reconciliation wire schemas; no backend runtime imports.

export const reconciliationCurrencies = [
  "AED",
  "AFN",
  "ALL",
  "AMD",
  "ANG",
  "AOA",
  "ARS",
  "AUD",
  "AWG",
  "AZN",
  "BAM",
  "BBD",
  "BDT",
  "BGN",
  "BHD",
  "BIF",
  "BMD",
  "BND",
  "BOB",
  "BRL",
  "BSD",
  "BTC",
  "BTN",
  "BWP",
  "BYR",
  "BZD",
  "CAD",
  "CDF",
  "CHF",
  "CLF",
  "CLP",
  "CNY",
  "COP",
  "CRC",
  "CUC",
  "CUP",
  "CVE",
  "CZK",
  "DJF",
  "DKK",
  "DOP",
  "DZD",
  "EEK",
  "EGP",
  "ERN",
  "ETB",
  "EUR",
  "FJD",
  "FKP",
  "GBP",
  "GEL",
  "GGP",
  "GHS",
  "GIP",
  "GMD",
  "GNF",
  "GTQ",
  "GYD",
  "HKD",
  "HNL",
  "HRK",
  "HTG",
  "HUF",
  "IDR",
  "ILS",
  "IMP",
  "INR",
  "IQD",
  "IRR",
  "ISK",
  "JEP",
  "JMD",
  "JOD",
  "JPY",
  "KES",
  "KGS",
  "KHR",
  "KMF",
  "KPW",
  "KRW",
  "KWD",
  "KYD",
  "KZT",
  "LAK",
  "LBP",
  "LKR",
  "LRD",
  "LSL",
  "LTL",
  "LVL",
  "LYD",
  "MAD",
  "MDL",
  "MGA",
  "MKD",
  "MMK",
  "MNT",
  "MOP",
  "MRO",
  "MTL",
  "MUR",
  "MVR",
  "MWK",
  "MXN",
  "MYR",
  "MZN",
  "NAD",
  "NGN",
  "NIO",
  "NOK",
  "NPR",
  "NZD",
  "OMR",
  "PAB",
  "PEN",
  "PGK",
  "PHP",
  "PKR",
  "PLN",
  "PYG",
  "QAR",
  "RON",
  "RSD",
  "RUB",
  "RWF",
  "SAR",
  "SBD",
  "SCR",
  "SDG",
  "SEK",
  "SGD",
  "SHP",
  "SLL",
  "SOS",
  "SRD",
  "STD",
  "SVC",
  "SYP",
  "SZL",
  "THB",
  "TJS",
  "TMT",
  "TND",
  "TOP",
  "TRY",
  "TTD",
  "TWD",
  "TZS",
  "UAH",
  "UGX",
  "USD",
  "UYU",
  "UZS",
  "VEF",
  "VND",
  "VUV",
  "WST",
  "XAF",
  "XAG",
  "XAU",
  "XCD",
  "XDR",
  "XOF",
  "XPD",
  "XPF",
  "XPT",
  "YER",
  "ZAR",
  "ZMK",
  "ZMW",
  "ZWL",
] as const

export type ReconciliationCurrency = (typeof reconciliationCurrencies)[number]

export type CollectionMode = "COMPANY" | "PARTNER"

export type ReviewState = "OPEN" | "CLOSED_VERIFIED" | "CLOSED_WITH_EXCEPTIONS"

export type Page<T> = { items: T[]; nextCursor: string | null; total: number }

export type MutationBody<T> = T & MutationEnvelope

export type MutationResult<T> = { result: T; versionToken: string; changed: boolean }

export type CreateProjectInput = {
  name: string
  endCustomerName: string
  currency: ReconciliationCurrency
  collectionMode: "COMPANY" | "PARTNER"
  endCustomerClientId: string | null
  partnerClientId: string | null
  timeProjectId: string | null
  description: string | null
}

export type UpdateProjectInput = {
  name?: string
  endCustomerName?: string
  currency?: ReconciliationCurrency
  collectionMode?: "COMPANY" | "PARTNER"
  endCustomerClientId?: string | null
  partnerClientId?: string | null
  timeProjectId?: string | null
  description?: string | null
  status?: "ACTIVE" | "ARCHIVED"
}

export type CreateCaseInput = {
  title: string
  periodStart: string | null
  periodEnd: string | null
  agreedGrossMinor: number | null
  agreedNetMinor: number | null
  agreedVatMinor: number | null
  agreementReference: string | null
}

export type UpdateCaseInput = {
  title?: string
  periodStart?: string | null
  periodEnd?: string | null
  agreedGrossMinor?: number | null
  agreedNetMinor?: number | null
  agreedVatMinor?: number | null
  agreementReference?: string | null
}

export type ProjectRecord = {
  name: string
  endCustomerName: string
  currency: ReconciliationCurrency
  collectionMode: "COMPANY" | "PARTNER"
  endCustomerClientId: string | null
  partnerClientId: string | null
  timeProjectId: string | null
  description: string | null
  id: string
  companyId: string
  status: "ACTIVE" | "ARCHIVED"
  version: number
  identityLocked: boolean
  createdAt: string
  updatedAt: string
  endCustomerClient: {
    id: string
    name: string
    inactive: boolean
  } | null
  partnerClient: {
    id: string
    name: string
    inactive: boolean
  } | null
  timeProject: {
    id: string
    name: string
    inactive: boolean
  } | null
}

export type CaseRecord = {
  title: string
  periodStart: string | null
  periodEnd: string | null
  agreedGrossMinor: number | null
  agreedNetMinor: number | null
  agreedVatMinor: number | null
  agreementReference: string | null
  id: string
  companyId: string
  projectId: string
  status: "OPEN" | "CLOSED_VERIFIED" | "CLOSED_WITH_EXCEPTIONS"
  version: number
  createdAt: string
  updatedAt: string
}

export type RegisterView = {
  project: ProjectRecord
  cases: {
    items: Array<CaseRecord>
    nextCursor: string | null
    total: number
  }
  versionToken: string
  asOf: string
  sourceFingerprint: string
}

export type ProjectView = {
  project: ProjectRecord
  cases: {
    items: Array<CaseView>
    nextCursor: string | null
    total: number
  }
  versionToken: string
  asOf: string
  sourceFingerprint: string
  summary: ProjectSummary
  sourceMarkedPaid: MoneyMeasure
  checkedReceipts: MoneyMeasure
  reportedReceipts: MoneyMeasure
  undated: {
    checkedReceipts: {
      knownMinor: number
      missingCount: number
      completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN"
      count: number
    }
    reportedReceipts: {
      knownMinor: number
      missingCount: number
      completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN"
      count: number
    }
    ownRecordedReceipts: {
      knownMinor: number
      missingCount: number
      completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN"
      count: number
    }
  }
  attentionCount: number
  unknownAgreementCount: number
  effectiveReviewState: "OPEN" | "CLOSED_VERIFIED" | "CLOSED_WITH_EXCEPTIONS"
  exceptions: Array<ReconciliationException>
  warnings: Array<{
    code: string
    message: string
    params?: Record<string, string | number>
  }>
  unallocatedDocumentLinks: DocumentLinkView[]
}

export type ProjectListRow = {
  project: ProjectRecord
  versionToken: string
  asOf: string
  sourceFingerprint: string
  summary: ProjectSummary
  effectiveReviewState: "OPEN" | "CLOSED_VERIFIED" | "CLOSED_WITH_EXCEPTIONS"
  attentionCount: number
}

export type ProjectListPage = {
  items: Array<ProjectListRow>
  nextCursor: string | null
  total: number
}

export type ProjectListQuery = {
  cursor?: string
  limit?: string
  search?: string
  status?: "ACTIVE" | "ARCHIVED" | "ALL"
  collectionMode?: "COMPANY" | "PARTNER"
  needsAttention?: "true" | "false"
}

export type CaseView = {
  reviewDecision?: (ReviewResult & { current: boolean }) | null
  title: string
  periodStart: string | null
  periodEnd: string | null
  agreedGrossMinor: number | null
  agreedNetMinor: number | null
  agreedVatMinor: number | null
  agreementReference: string | null
  id: string
  companyId: string
  projectId: string
  status: "OPEN" | "CLOSED_VERIFIED" | "CLOSED_WITH_EXCEPTIONS"
  version: number
  createdAt: string
  updatedAt: string
  summary: ProjectSummary
  sourceMarkedPaid: MoneyMeasure
  checkedReceipts: MoneyMeasure
  reportedReceipts: MoneyMeasure
  undated: {
    checkedReceipts: {
      knownMinor: number
      missingCount: number
      completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN"
      count: number
    }
    reportedReceipts: {
      knownMinor: number
      missingCount: number
      completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN"
      count: number
    }
    ownRecordedReceipts: {
      knownMinor: number
      missingCount: number
      completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN"
      count: number
    }
  }
  coverage: CaseCoverageView
  customerInvoices: CustomerInvoiceView[]
  documentLinks: DocumentLinkView[]
  effectiveReviewState: "OPEN" | "CLOSED_VERIFIED" | "CLOSED_WITH_EXCEPTIONS"
  exceptions: Array<ReconciliationException>
}

export type MoneyMeasure = {
  knownMinor: number
  missingCount: number
  completeness: "COMPLETE" | "PARTIAL" | "UNKNOWN"
}

export type InvoiceReviewEvidence = { evidenceReference: string; reason: string; attested: true }
export type ExternalInvoiceInput = {
  duplicateReview?: InvoiceReviewEvidence & { invoiceIds: string[]; fingerprint: string }
  creditResolution?: InvoiceReviewEvidence
  issuer: string
  recipient: string
  number: string
  issueDate: string | null
  dueDate: string | null
  currency: ReconciliationCurrency
  grossMinor: number
  netMinor: number | null
  vatMinor: number | null
  reportedStatus: string | null
  sourceSystem: string | null
  sourceId: string | null
  sourceAsOf: string | null
  sourceReference: string
}

export type UpdateExternalInvoiceInput = {
  duplicateReview?: InvoiceReviewEvidence & { invoiceIds: string[]; fingerprint: string }
  creditResolution?: InvoiceReviewEvidence
  issuer?: string
  recipient?: string
  number?: string
  issueDate?: string | null
  dueDate?: string | null
  currency?: ReconciliationCurrency
  grossMinor?: number
  netMinor?: number | null
  vatMinor?: number | null
  reportedStatus?: string | null
  sourceSystem?: string | null
  sourceId?: string | null
  sourceAsOf?: string | null
  sourceReference?: string
}

export type ReceiptInput = {
  amountMinor: number
  currency: ReconciliationCurrency
  paidOn: string | null
  evidenceClass: "PARTNER_REPORTED" | "EVIDENCE_CHECKED"
  attested?: true
  evidenceReference: string | null
  evidenceUrl: string | null
  reason: string
  sourceSystem?: string | null
  sourceId?: string | null
}

export type UpdateReceiptInput = {
  amountMinor?: number
  currency?: ReconciliationCurrency
  paidOn?: string | null
  evidenceClass?: "PARTNER_REPORTED" | "EVIDENCE_CHECKED"
  attested?: true
  evidenceReference?: string | null
  evidenceUrl?: string | null
  reason: string
  sourceSystem?: string | null
  sourceId?: string | null
}

export type AllocationInput = {
  customerInvoiceId: string
  amountMinor: number
}

export type AllocationsInput = {
  allocations: Array<AllocationInput>
}

export type LinkDocumentInput = {
  documentId: string
  typeId: "invoice" | "expense" | "received-invoice"
  caseId: string | null
  role: "CUSTOMER_INVOICE" | "SETTLEMENT_INCOME" | "PARTNER_BILL" | "PROJECT_COST"
}

export type ReviewCaseInput = {
  mode: "VERIFY" | "ACCEPT_EXCEPTIONS" | "REOPEN"
  exceptions: Array<{
    code: string
    fingerprint: string
    reason: string
  }>
  reason: string
}

export type EvidenceCoverageInput = {
  customerInvoiceIds: Array<string>
  sourceAsOf: string
  evidenceReference: string
  attested: true
}

export type CreditAdjustmentInput = {
  amountMinor: number
  sourceReference: string
  reason: string
  sourceSystem?: string | null
  sourceId?: string | null
}

export type ReasonInput = {
  reason: string
}

export type LedgerlyInvoiceRow = {
  id: string
  projectId?: string | null
  number: string
  projectName: string
  issuer: string
  recipient: string
  kind: "Customer invoice" | "Internal share"
  status: "Needs review" | "Paid" | "Sent"
  issueDate: string | null
  dueDate: string | null
  paidDate: string | null
  exGstAmountCents: number
  gstAmountCents: number
  totalCents: number
  sharePercent: number | null
  sourceNumber: string | null
  linkedInvoiceNumber: string | null
  sourceSnapshot?: {
    customerCard?: {
      label: string
      issuer: string
      recipient: string
      number: string | null
      pending: boolean
      amountCents: number
      totalCents: number
    }
    shareCard?: {
      label: string
      issuer: string
      recipient: string
      number: string | null
      pending: boolean
      amountCents: number
      totalCents: number
    }
    lineItems?: Array<{
      category: string
      description: string
      amountCents: number
      earnsReferralFee: boolean
      revenueType: string
      treatment: string
    }>
    calculation?: {
      sourceSubtotalCents: number
      eligibleSubtotalCents: number
      internalSubtotalCents: number
      thirdPartyCostsCents: number
      passThroughExpensesCents: number
      sharePercent: number
      gstAmountCents: number
      totalCents: number
    }
  }
}

export type LedgerlyProjectPayload = {
  sourceSystem: "ledgerly"
  sourceAsOf: string
  currency: ReconciliationCurrency
  project: {
    id: string
    name: string
    customerIssuer: string
    customerRecipient: string
    shareIssuer: string
    shareRecipient: string
  }
  invoices: Array<LedgerlyInvoiceRow>
}

export type ImportConfirmInput = ImportPreviewInput & { previewHash: string }

export type MutationEnvelope = {
  requestKey: string
  expectedVersion: string
}

export type ProjectSummary = {
  customerInvoiced: MoneyMeasure
  customerCredits: MoneyMeasure
  customerCollectible: MoneyMeasure
  customerRemaining: MoneyMeasure
  agreedSettlement: MoneyMeasure
  unbilledDifference: MoneyMeasure
  settlementInvoiced: MoneyMeasure
  ownRecordedReceipts: MoneyMeasure
  ownOutstanding: MoneyMeasure
  partnerBills: MoneyMeasure
  partnerPaid: MoneyMeasure
  partnerOutstanding: MoneyMeasure
  projectCosts: MoneyMeasure
}

export type AssociationLabel = {
  id: string
  name: string
  inactive: boolean
}

export type ReconciliationException = {
  code: string
  message: string
  params?: Record<string, string | number>
  fingerprint: string
  caseId: string | null
  blocking: boolean
}

export type ProjectId = string
export type Problem = ProjectView["warnings"][number]
export type DocumentLinkRecord = {
  id: string
  documentId: string
  typeId: "invoice" | "expense" | "received-invoice"
  caseId: string | null
  role: LinkDocumentInput["role"]
}
export type CustomerInvoiceRecord = {
  id: string
  caseId: string
  documentLinkId: string | null
  external: ExternalInvoiceInput | null
}

// Accepted T4 mutation records; read views are added only after T6 publishes them.
export type ExternalInvoiceRecord = {
  id: string
  companyId: string
  projectId: string
  caseId: string
  documentLinkId: null
  external: ExternalInvoiceInput
  originalGrossMinor: number
  creditAdjustmentMinor: number
  adjustedGrossMinor: number
  sourceSnapshot: Record<string, unknown>
  snapshotHash: string
  createdAt: string
  updatedAt: string
}
export type ReceiptRecord = {
  id: string
  companyId: string
  projectId: string
  amountMinor: number
  currency: ReconciliationCurrency
  paidOn: string | null
  collector: string
  evidenceClass: "PARTNER_REPORTED" | "EVIDENCE_CHECKED"
  sourceReference: string
  evidenceReference: string | null
  evidenceUrl: string | null
  reason: string | null
  sourceSystem: string | null
  sourceId: string | null
  enteredBy: string
  reviewedBy: string | null
  reviewedAt: string | null
  humanAttestation: string | null
  version: number
  voidedAt: string | null
  voidedBy: string | null
  voidReason: string | null
  createdAt: string
  updatedAt: string
}
export type AllocationRecord = {
  id: string
  customerInvoiceId: string
  amountMinor: number
  createdAt: string
}
export type ReceiptAllocationsRecord = {
  receiptId: string
  allocations: AllocationRecord[]
  allocatedMinor: number
  unallocatedMinor: number
}
export type CoverageResult = {
  customerInvoiceIds: string[]
  receiptIds: string[]
  allocationIds: string[]
  sourceAsOf: string
  evidenceReference: string
  attested: true
  sourceFingerprint: string
  attestedBy: string
  attestedAt: string
}
export type ReviewResult = {
  case: CaseRecord
  mode: ReviewCaseInput["mode"]
  sourceFingerprint: string
  exceptions: ReviewCaseInput["exceptions"]
  reason: string
  reviewedBy: string
  reviewedAt: string
}

// Accepted T6 nested reads. Mutation records above intentionally remain separate.
export type DocumentFinancialRead = {
  documentId: string
  typeId: DocumentLinkRecord["typeId"]
  status: string
  displayNumber: string | null
  currency: string | null
  grossMinor: number | null
  netMinor: number | null
  vatMinor: number | null
  paymentKnowledge: "KNOWN" | "UNKNOWN" | "UNSUPPORTED"
  settlement: {
    paidMinor: number
    creditedMinor: number
    outstandingMinor: number
    excessMinor: number
    settled: boolean
  } | null
  payments: Array<{
    source: "document-payment" | "disbursement-event"
    id: string
    documentAmountMinor: number
    originalAmountMinor: number
    originalCurrency: string
    paidOn: string | null
  }>
  sourceVersion: string
  warnings: Problem[]
}
export type DocumentLinkView = DocumentLinkRecord & {
  issueDate: string | null
  financial: DocumentFinancialRead
}
export type ExternalInvoiceView = ExternalInvoiceRecord & {
  caseTitle: string
  allocatedMinor: number
  availableMinor: number
}
export type CustomerInvoiceView =
  | { id: string; caseId: string; documentLinkId: string; external: null }
  | ExternalInvoiceView
export type CoverageView = Pick<
  CoverageResult,
  "sourceAsOf" | "evidenceReference" | "sourceFingerprint" | "attestedBy" | "attestedAt"
>
export type CaseCoverageView = {
  state: "NOT_APPLICABLE" | "MISSING" | "CURRENT" | "STALE"
  invoices: Array<{ customerInvoiceId: string; current: boolean; attestation: CoverageView | null }>
}
export type AllocationView = AllocationRecord & {
  customerInvoice: Pick<
    ExternalInvoiceView,
    | "id"
    | "caseId"
    | "caseTitle"
    | "originalGrossMinor"
    | "creditAdjustmentMinor"
    | "adjustedGrossMinor"
    | "allocatedMinor"
    | "availableMinor"
  > & { number: string; currency: ReconciliationCurrency }
}
export type ReceiptView = ReceiptRecord & {
  allocations: AllocationView[]
  allocatedMinor: number
  unallocatedMinor: number
}
export type ReceiptPage = Page<ReceiptView>
export type ExternalInvoicePage = Page<ExternalInvoiceView>
export type HistoryRecord = {
  id: string
  actor: string
  occurredAt: string
  operation: string
  affectedRecord: string
  before: unknown
  after: unknown
  reason: string | null
}
export type HistoryPage = Page<HistoryRecord>
export type PageQuery = { cursor?: string; limit?: string }
export type ExportQuery = { invoiceFrom?: string; invoiceTo?: string; cashFrom?: string; cashTo?: string }
export type ReportQuery = PageQuery & ExportQuery & { caseId?: string }
export type InvoiceChoiceQuery = PageQuery & { search?: string }

export type SelectedImportMatch = {
  sourceId: string
  documentId: string
  typeId: "invoice" | "expense" | "received-invoice"
  caseSourceId: string
}

export type ImportPreviewInput = {
  payload: LedgerlyProjectPayload
  selectedMatches: Array<SelectedImportMatch>
}

export type ImportIssue = {
  code: string
  message: string
  params?: Record<string, string | number>
  sourceIds: Array<string>
  caseSourceId: string | null
  blocking: boolean
}

export type ImportCounts = {
  sourceRows: number
  casesToCreate: number
  referencesToCreate: number
  linksToCreate: number
  reused: number
  revisions: number
  unresolved: number
  errors: number
}

export type ImportCaseProposal = {
  caseSourceId: string
  sourceIds: Array<string>
  caseId: string | null
  action: "CREATE" | "REUSE" | "REVISION"
  existing: CaseRecord | null
  proposed: CreateCaseInput
  existingSnapshotHash: string | null
  proposedSnapshotHash: string
}

export type ImportReferenceProposal = {
  sourceId: string
  caseSourceId: string
  referenceId: string | null
  action: "CREATE" | "REUSE" | "REVISION"
  existing: ExternalInvoiceRecord | null
  proposed: ExternalInvoiceInput
  proposedSnapshotHash: string
}

export type ImportCandidate = {
  documentId: string
  typeId: "invoice" | "expense" | "received-invoice"
  basis: "CONTEXTUAL_REFERENCE" | "EXPLICIT_SELECTION"
  financial: DocumentFinancialRead
}

export type ImportLinkProposal = {
  sourceId: string
  caseSourceId: string
  role: "CUSTOMER_INVOICE" | "SETTLEMENT_INCOME" | "PARTNER_BILL" | "PROJECT_COST"
  historical: ExternalInvoiceInput
  candidates: Array<ImportCandidate>
  selectedMatch: SelectedImportMatch | null
  existingLinkId: string | null
  action: "CREATE" | "REUSE" | "UNRESOLVED"
}

export type ImportPreview = {
  previewHash: string
  sourceHash: string
  projectVersion: string
  sourceAsOf: string
  proposedCases: Array<ImportCaseProposal>
  proposedReferences: Array<ImportReferenceProposal>
  proposedLinks: Array<ImportLinkProposal>
  unresolved: Array<ImportIssue>
  errors: Array<ImportIssue>
  counts: ImportCounts
}

export type ImportApplied = {
  previewHash: string
  sourceHash: string
  sourceAsOf: string
  cases: Array<{
    caseSourceId: string
    caseId: string
    created: boolean
  }>
  references: Array<{
    sourceId: string
    referenceId: string
    created: boolean
  }>
  links: Array<{
    sourceId: string
    linkId: string
    created: boolean
  }>
  unresolved: Array<ImportIssue>
  counts: ImportCounts
}

export type ImportResult = MutationResult<ImportApplied>
export type ImportConfirmBody = MutationBody<ImportConfirmInput>

export type ReceiptQuery = PageQuery & { receiptId?: string }
