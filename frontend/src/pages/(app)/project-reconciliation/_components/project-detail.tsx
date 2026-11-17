import { useRef, useState } from "react"
import { useForm } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { Link } from "react-router"
import { z } from "zod"
import { toast } from "sonner"
import { useCompanies } from "@/hooks/queries/use-companies"
import {
  useReconciliationProject,
  useReconciliationReceipts,
  useReconciliationHistory,
  useExportReconciliationCsv,
} from "@/hooks/queries/use-project-reconciliation"
import { ApiError } from "@/hooks/use-api-query"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Form } from "@/components/ui/form"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Skeleton } from "@/components/ui/skeleton"
import type {
  ExportQuery,
  ProjectSummary,
  ProjectView,
  CaseView,
  ExternalInvoiceView,
  ReceiptView,
} from "@/types/project-reconciliation"
import { CaseList, type DetailAction } from "./case-list"
import { Measure, Warnings, CursorControls } from "./read-parts"
import { CaseUpsert } from "./case-upsert"
import { ExternalInvoiceUpsert, CreditAdjustmentDialog } from "./external-invoice-upsert"
import { ReceiptUpsert, ReceiptVoidDialog } from "./receipt-upsert"
import { ReceiptAllocationDialog } from "./receipt-allocation"
import { DocumentLinkDialog, DocumentUnlinkDialog } from "./document-link-dialog"
import { ReviewDialog, EvidenceCoverageDialog } from "./review-dialog"
import { ImportDialog } from "./import-dialog"
import { ProjectUpsert } from "./project-upsert"
import { ProjectEvidence } from "./project-evidence"
import { ProjectCosts } from "./project-costs"
import { ReconciliationDateField, useReconciliationDialogFocus } from "./mutation-form"
import { downloadBlob } from "@/lib/download"

const invoiceMetrics = new Set([
  "customerInvoiced",
  "customerCredits",
  "customerCollectible",
  "settlementInvoiced",
  "partnerBills",
  "projectCosts",
  "sourceMarkedPaid",
])
const cashMetrics = new Set(["ownRecordedReceipts", "partnerPaid", "checkedReceipts", "reportedReceipts"])
function DateFilters({ onApply, value }: { onApply: (filters: ExportQuery) => void; value: ExportQuery }) {
  const { t } = useTranslation()
  const form = useForm<Record<keyof ExportQuery, string | null>>({
    defaultValues: {
      invoiceFrom: value.invoiceFrom ?? null,
      invoiceTo: value.invoiceTo ?? null,
      cashFrom: value.cashFrom ?? null,
      cashTo: value.cashTo ?? null,
    },
  })
  const schema = z
    .strictObject({
      invoiceFrom: z.iso.date().nullable(),
      invoiceTo: z.iso.date().nullable(),
      cashFrom: z.iso.date().nullable(),
      cashTo: z.iso.date().nullable(),
    })
    .refine(
      (x) =>
        (!x.invoiceFrom || !x.invoiceTo || x.invoiceFrom <= x.invoiceTo) &&
        (!x.cashFrom || !x.cashTo || x.cashFrom <= x.cashTo),
    )
  const [invalid, setInvalid] = useState(false)
  return (
    <Form {...form}>
      <form
        className="space-y-3 rounded-md border p-4"
        onSubmit={form.handleSubmit((values) => {
          const result = schema.safeParse(values)
          setInvalid(!result.success)
          if (result.success)
            onApply(
              Object.fromEntries(
                Object.entries(result.data).filter(([, value]) => value !== null),
              ) as ExportQuery,
            )
        })}
      >
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {(["invoiceFrom", "invoiceTo", "cashFrom", "cashTo"] as const).map((name) => (
            <ReconciliationDateField
              key={name}
              name={name}
              label={t(`projectReconciliation.detail.filters.${name}`)}
              placeholder={t("projectReconciliation.detail.anyDate")}
            />
          ))}
        </div>
        {invalid && <p role="alert">{t("projectReconciliation.workflow.dateOrder")}</p>}
        <div className="flex gap-2">
          <Button type="submit" variant="outline">
            {t("projectReconciliation.detail.applyFilters")}
          </Button>
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              form.reset({ invoiceFrom: null, invoiceTo: null, cashFrom: null, cashTo: null })
              setInvalid(false)
              onApply({})
            }}
          >
            {t("projectReconciliation.detail.clearFilters")}
          </Button>
        </div>
      </form>
    </Form>
  )
}
function Summary({ view, filters }: { view: ProjectView; filters: ExportQuery }) {
  const { t } = useTranslation()
  const partner = view.project.collectionMode === "PARTNER"
  const names: (keyof ProjectSummary | "sourceMarkedPaid" | "checkedReceipts" | "reportedReceipts")[] =
    partner
      ? [
          "customerInvoiced",
          "customerCredits",
          "customerCollectible",
          "sourceMarkedPaid",
          "checkedReceipts",
          "reportedReceipts",
          "customerRemaining",
          "agreedSettlement",
          "unbilledDifference",
          "settlementInvoiced",
          "ownRecordedReceipts",
          "ownOutstanding",
          "projectCosts",
        ]
      : [
          "customerInvoiced",
          "customerCredits",
          "customerCollectible",
          "ownRecordedReceipts",
          "ownOutstanding",
          "partnerBills",
          "partnerPaid",
          "partnerOutstanding",
          "agreedSettlement",
          "unbilledDifference",
          "projectCosts",
        ]
  const basis = (name: string) =>
    invoiceMetrics.has(name)
      ? filters.invoiceFrom || filters.invoiceTo
        ? "invoicePeriod"
        : "lifetime"
      : cashMetrics.has(name)
        ? filters.cashFrom || filters.cashTo
          ? "cashPeriod"
          : "lifetime"
        : "overall"
  return (
    <section
      className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
      aria-label={t("projectReconciliation.detail.summary")}
    >
      {names.map((name) => (
        <div key={name} className="space-y-1 rounded-md border bg-card p-4">
          <h2 className="text-sm font-semibold">{t(`projectReconciliation.detail.metrics.${name}`)}</h2>
          <Measure
            value={
              name in view.summary
                ? view.summary[name as keyof ProjectSummary]
                : view[name as "sourceMarkedPaid"]
            }
            currency={view.project.currency}
          />
          <p className="text-xs text-muted-foreground">
            {t(`projectReconciliation.detail.basis.${basis(name)}`)}
          </p>
          {partner &&
            name === "customerRemaining" &&
            view.summary.customerRemaining.completeness !== "COMPLETE" && (
              <p className="text-xs text-muted-foreground">
                {t("projectReconciliation.detail.coverageUnconfirmed")}
              </p>
            )}
        </div>
      ))}
      <div className="rounded-md border p-4">
        <h2 className="text-sm font-semibold">{t("projectReconciliation.detail.undated")}</h2>
        {Object.entries(view.undated).map(([name, value]) => (
          <p key={name} className="text-sm">
            {t(`projectReconciliation.detail.metrics.${name}`)}:{" "}
            <Measure value={value} currency={view.project.currency} /> · {value.count}
          </p>
        ))}
      </div>
    </section>
  )
}
const financialFailure = (view: ProjectView) =>
  view.warnings.some((x) => x.code === "FINANCIAL_READ_UNAVAILABLE") ||
  [...view.unallocatedDocumentLinks, ...view.cases.items.flatMap((x) => x.documentLinks)].some((x) =>
    x.financial.warnings.some((w) => w.code === "FINANCIAL_READ_UNAVAILABLE"),
  )
export function ProjectDetail({ companyId, projectId }: { companyId: string; projectId: string }) {
  const dialogFocus = useReconciliationDialogFocus(companyId, 'a[href="/project-reconciliation"]')
  const { t } = useTranslation()
  const { activeCompanyId, activeRole } = useCompanies()
  const canWrite = companyId === activeCompanyId && (activeRole === "OWNER" || activeRole === "ADMIN")
  const [filters, setFilters] = useState<ExportQuery>({})
  const [cases, setCases] = useState<(string | undefined)[]>([undefined])
  const [receipts, setReceipts] = useState<(string | undefined)[]>([undefined])
  const [history, setHistory] = useState<(string | undefined)[]>([undefined])
  const [action, setAction] = useState<DetailAction | null>(null)
  const actionGeneration = useRef(0)
  const [captured, setCaptured] = useState<{
    caseRecord?: CaseView
    invoice?: ExternalInvoiceView
    receipt?: ReceiptView
    versionToken?: string
  }>({})
  const [tab, setTab] = useState("reconciliation")
  const detail = useReconciliationProject(projectId, {
    ...filters,
    ...(cases.at(-1) ? { cursor: cases.at(-1) } : {}),
  })
  const receiptQuery = useReconciliationReceipts(
    projectId,
    receipts.at(-1) ? { cursor: receipts.at(-1) } : {},
  )
  const historyQuery = useReconciliationHistory(projectId, history.at(-1) ? { cursor: history.at(-1) } : {})
  const caseTarget = useReconciliationProject(action?.caseId ? projectId : "", {
    ...filters,
    ...(action?.caseId ? { caseId: action.caseId } : {}),
  })
  const receiptTarget = useReconciliationReceipts(
    action?.receiptId ? projectId : "",
    action?.receiptId ? { receiptId: action.receiptId } : {},
  )
  const csv = useExportReconciliationCsv(companyId, projectId, filters)
  const view = detail.data
  const fresh = !!view && !detail.isError && !detail.isFetching && !financialFailure(view)
  const evidenceFresh = fresh && !!receiptQuery.data && !receiptQuery.isError && !receiptQuery.isFetching
  const refresh = () => {
    void detail.refetch()
    void receiptQuery.refetch()
    void historyQuery.refetch()
  }
  const reload = async () => {
    const generation = actionGeneration.current
    const root = await detail.refetch()
    if (root.error || !root.data) throw root.error ?? new ApiError(503, "FINANCIAL_READ_UNAVAILABLE")
    if (financialFailure(root.data)) throw new ApiError(503, "FINANCIAL_READ_UNAVAILABLE")
    let selectedCase: CaseView | undefined
    let selectedReceipt: ReceiptView | undefined
    if (action?.caseId) {
      const selected = await caseTarget.refetch()
      if (selected.error || !selected.data?.cases.items.some((x) => x.id === action.caseId))
        throw selected.error ?? new ApiError(404, "RECONCILIATION_TARGET_UNAVAILABLE")
      if (financialFailure(selected.data)) throw new ApiError(503, "FINANCIAL_READ_UNAVAILABLE")
      if (selected.data.versionToken !== root.data.versionToken)
        throw new ApiError(409, "RECONCILIATION_CHANGED")
      selectedCase = selected.data.cases.items[0]
    }
    if (action?.receiptId) {
      const selected = await receiptTarget.refetch()
      if (selected.error || !selected.data?.items.some((x) => x.id === action.receiptId))
        throw selected.error ?? new ApiError(404, "RECONCILIATION_TARGET_UNAVAILABLE")
      selectedReceipt = selected.data.items[0]
    }
    const selectedInvoice = selectedCase?.customerInvoices.find(
      (x) => x.id === action?.invoiceId && x.external !== null,
    )
    if (generation !== actionGeneration.current) throw new Error("Dialog context changed")
    setCaptured((current) => ({
      ...current,
      caseRecord: selectedCase ?? current.caseRecord,
      invoice: selectedInvoice?.external ? selectedInvoice : current.invoice,
      receipt: selectedReceipt ?? current.receipt,
      versionToken: root.data.versionToken,
    }))
    return root.data.versionToken
  }
  const download = async () => {
    try {
      downloadBlob(await csv.mutateAsync(), `project-${projectId}.csv`)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("projectReconciliation.detail.exportError"))
    }
  }
  const liveCase =
    caseTarget.data?.cases.items.find((x) => x.id === action?.caseId) ??
    view?.cases.items.find((x) => x.id === action?.caseId)
  const liveInvoice = liveCase?.customerInvoices.find(
    (x) => x.id === action?.invoiceId && x.external !== null,
  )
  const liveReceipt =
    receiptTarget.data?.items.find((x) => x.id === action?.receiptId) ??
    receiptQuery.data?.items.find((x) => x.id === action?.receiptId)
  const caseRecord = captured.caseRecord ?? liveCase
  const invoice = captured.invoice ?? (liveInvoice?.external ? liveInvoice : undefined)
  const receipt = captured.receipt ?? liveReceipt
  const targetMissing = !!(
    (action?.caseId && (caseTarget.isError || !liveCase)) ||
    (action?.invoiceId && !liveInvoice) ||
    (action?.receiptId && (receiptTarget.isError || !liveReceipt)) ||
    (action?.linkId &&
      view &&
      ![...view.unallocatedDocumentLinks, ...view.cases.items.flatMap((x) => x.documentLinks)].some(
        (x) => x.id === action.linkId,
      ))
  )
  const openAction = (next: DetailAction) => {
    if (!fresh) return
    if ((next.kind === "receipt" || next.kind === "allocate" || next.kind === "void") && !evidenceFresh)
      return
    actionGeneration.current++
    const caseRow = view?.cases.items.find((x) => x.id === next.caseId)
    const invoiceRow = caseRow?.customerInvoices.find((x) => x.id === next.invoiceId && x.external !== null)
    setCaptured({
      versionToken: view?.versionToken,
      caseRecord: caseRow,
      invoice: invoiceRow?.external ? invoiceRow : undefined,
      receipt: receiptQuery.data?.items.find((x) => x.id === next.receiptId),
    })
    setAction(next)
  }
  const common = {
    companyId,
    projectId,
    versionToken: captured.versionToken ?? view?.versionToken ?? "",
    open: !!action,
    onOpenChange: (open: boolean) => {
      if (!open) {
        actionGeneration.current++
        setAction(null)
        setCaptured({})
      }
    },
    onReload: reload,
    onCloseAutoFocus: dialogFocus.restoreFocus,
    unavailable: targetMissing
      ? t("projectReconciliation.detail.targetMissing")
      : detail.isError || (view && financialFailure(view))
        ? t("projectReconciliation.detail.snapshotNotCurrent")
        : undefined,
  }
  const closureBlocked = !!view?.unallocatedDocumentLinks.some(
    (link) =>
      (link.typeId === "invoice" || link.typeId === "received-invoice") &&
      (link.financial.settlement?.outstandingMinor ?? 0) > 0,
  )
  return (
    <div
      ref={dialogFocus.scope}
      onClickCapture={dialogFocus.captureOpener}
      className="page-content space-y-6"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link className="text-sm underline" to="/project-reconciliation">
            {t("projectReconciliation.register")}
          </Link>
          <h1 className="mt-2 text-3xl">
            {view?.project.name ?? t("sidebar.navigation.projectReconciliation")}
          </h1>
          {view && (
            <p className="mt-2 text-sm text-muted-foreground">
              {view.project.endCustomerName} ·{" "}
              {t(
                view.project.collectionMode === "PARTNER"
                  ? "projectReconciliation.partnerCollected"
                  : "projectReconciliation.companyCollected",
              )}{" "}
              · {view.project.partnerClient?.name} · {view.project.currency} · {view.asOf}
              {view.project.partnerClient?.inactive && ` · ${t("projectReconciliation.inactive")}`}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={refresh} disabled={detail.isFetching}>
            {t("projectReconciliation.detail.refresh")}
          </Button>
          <Button
            variant="outline"
            onClick={() => void download()}
            disabled={!view || detail.isError || csv.isPending}
          >
            {t("projectReconciliation.detail.export")}
          </Button>
          {canWrite && view && (
            <Button variant="outline" disabled={!fresh} onClick={() => openAction({ kind: "project" })}>
              {t("projectReconciliation.edit")}
            </Button>
          )}
          {canWrite && (
            <Button variant="outline" disabled={!fresh} onClick={() => openAction({ kind: "import" })}>
              {t("projectReconciliation.import.title")}
            </Button>
          )}
        </div>
      </div>
      {detail.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : detail.isError ? (
        <div role="alert">
          <p>
            {t(
              detail.error instanceof ApiError && detail.error.status === 403
                ? "projectReconciliation.forbidden"
                : detail.error instanceof ApiError && detail.error.status === 404
                  ? "projectReconciliation.detail.notFound"
                  : view
                    ? "projectReconciliation.detail.refreshFailed"
                    : "projectReconciliation.loadError",
            )}
          </p>
          <Button variant="outline" onClick={refresh}>
            {t("projectReconciliation.retry")}
          </Button>
          {cases.length > 1 && (
            <Button variant="outline" onClick={() => setCases([undefined])}>
              {t("projectReconciliation.detail.firstCasePage")}
            </Button>
          )}
        </div>
      ) : (
        view && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <Badge
                variant={fresh && view.effectiveReviewState === "CLOSED_VERIFIED" ? "success" : "warning"}
              >
                {t(`projectReconciliation.review.${fresh ? view.effectiveReviewState : "OPEN"}`)}
              </Badge>
              {view.project.status === "ARCHIVED" && (
                <Badge variant="outline">{t("projectReconciliation.archived")}</Badge>
              )}
              <span className="text-sm">
                {t("projectReconciliation.attentionCount", { count: view.attentionCount })}
              </span>
              <span className="text-xs text-muted-foreground">
                {t("projectReconciliation.detail.freshness")}
              </span>
            </div>
            <Warnings warnings={view.warnings} currency={view.project.currency} />
            <DateFilters
              value={filters}
              onApply={(next) => {
                setFilters(next)
                setCases([undefined])
              }}
            />
            <Summary view={view} filters={filters} />
            {view.project.collectionMode === "PARTNER" && (
              <p className="text-xs text-muted-foreground">
                {t("projectReconciliation.workflow.statusHelp")}
              </p>
            )}
            <p className="text-xs text-muted-foreground">{t("projectReconciliation.detail.sourceBasis")}</p>
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList className="max-w-full overflow-x-auto">
                <TabsTrigger value="reconciliation">
                  {t("projectReconciliation.detail.tabs.reconciliation")}
                </TabsTrigger>
                <TabsTrigger value="evidence">{t("projectReconciliation.detail.tabs.evidence")}</TabsTrigger>
                <TabsTrigger value="costs">{t("projectReconciliation.detail.tabs.costs")}</TabsTrigger>
              </TabsList>
              <TabsContent value="reconciliation" className="space-y-4">
                <CaseList
                  view={view}
                  invoiceFiltered={!!filters.invoiceFrom || !!filters.invoiceTo}
                  canWrite={canWrite}
                  fresh={fresh}
                  onAction={openAction}
                />
                <CursorControls
                  kind="cases"
                  cursors={cases}
                  onChange={setCases}
                  next={view.cases.nextCursor}
                  busy={detail.isFetching}
                />
              </TabsContent>
              <TabsContent value="evidence">
                <ProjectEvidence
                  view={view}
                  receipts={receiptQuery.data}
                  fresh={evidenceFresh}
                  loading={receiptQuery.isLoading}
                  error={receiptQuery.isError}
                  retry={() => void receiptQuery.refetch()}
                  canWrite={canWrite}
                  onAction={openAction}
                />
                <CursorControls
                  kind="receipts"
                  cursors={receipts}
                  onChange={setReceipts}
                  next={receiptQuery.data?.nextCursor ?? null}
                  busy={receiptQuery.isFetching}
                />
              </TabsContent>
              <TabsContent value="costs">
                <ProjectCosts
                  view={view}
                  history={historyQuery.data}
                  loading={historyQuery.isLoading}
                  error={historyQuery.isError}
                  retry={() => void historyQuery.refetch()}
                  fresh={fresh}
                />
                <CursorControls
                  kind="cases"
                  cursors={cases}
                  onChange={setCases}
                  next={view.cases.nextCursor}
                  busy={detail.isFetching}
                />
                <CursorControls
                  kind="history"
                  cursors={history}
                  onChange={setHistory}
                  next={historyQuery.data?.nextCursor ?? null}
                  busy={historyQuery.isFetching}
                />
              </TabsContent>
            </Tabs>
          </>
        )
      )}
      {view && canWrite && action && (
        <>
          {action.kind === "import" && <ImportDialog {...common} versionToken={view.versionToken} />}
          {action.kind === "project" && <ProjectUpsert {...common} row={view} />}
          {action.kind === "case" && (!action.caseId || caseRecord) && (
            <CaseUpsert
              {...common}
              partnerClientId={view.project.partnerClientId}
              currency={view.project.currency}
              caseRecord={caseRecord}
            />
          )}
          {action.kind === "invoice" && action.caseId && (!action.invoiceId || invoice) && (
            <ExternalInvoiceUpsert
              {...common}
              collectionMode={view.project.collectionMode}
              currency={view.project.currency}
              caseId={action.caseId}
              invoice={invoice?.external ? invoice : undefined}
            />
          )}
          {action.kind === "credit" && action.invoiceId && (
            <CreditAdjustmentDialog
              {...common}
              currency={view.project.currency}
              invoiceId={action.invoiceId}
            />
          )}
          {action.kind === "link" && (
            <DocumentLinkDialog
              {...common}
              collectionMode={view.project.collectionMode}
              caseId={action.caseId ?? null}
            />
          )}
          {action.kind === "unlink" && action.linkId && (
            <DocumentUnlinkDialog {...common} linkId={action.linkId} />
          )}
          {action.kind === "review" && caseRecord && (
            <ReviewDialog {...common} caseRecord={caseRecord} closureBlocked={closureBlocked} />
          )}
          {action.kind === "coverage" && caseRecord && (
            <EvidenceCoverageDialog
              {...common}
              customerInvoices={caseRecord.customerInvoices
                .filter((x) => x.external !== null)
                .map((x) => ({ id: x.id, number: x.external!.number }))}
            />
          )}
          {action.kind === "receipt" && (!action.receiptId || receipt) && (
            <ReceiptUpsert
              {...common}
              collectionMode={view.project.collectionMode}
              currency={view.project.currency}
              receipt={receipt}
            />
          )}
          {action.kind === "void" && action.receiptId && (
            <ReceiptVoidDialog {...common} receiptId={action.receiptId} />
          )}
          {action.kind === "allocate" && receipt && <ReceiptAllocationDialog {...common} receipt={receipt} />}
        </>
      )}
    </div>
  )
}
