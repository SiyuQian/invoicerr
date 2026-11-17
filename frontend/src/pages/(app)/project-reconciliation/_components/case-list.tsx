import { Fragment, useState } from "react"
import { useTranslation } from "react-i18next"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatMinor } from "@/components/documents/totals-calculator"
import type { ProjectView } from "@/types/project-reconciliation"
import { DocumentRow, Measure } from "./read-parts"
export type DetailAction = {
  kind:
    | "case"
    | "invoice"
    | "credit"
    | "link"
    | "unlink"
    | "review"
    | "coverage"
    | "receipt"
    | "void"
    | "allocate"
    | "project"
    | "import"
  caseId?: string
  invoiceId?: string
  receiptId?: string
  linkId?: string
}
export function CaseList({
  view,
  canWrite,
  fresh,
  onAction,
  invoiceFiltered = false,
}: {
  view: ProjectView
  invoiceFiltered?: boolean
  canWrite: boolean
  fresh: boolean
  onAction: (action: DetailAction) => void
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<string[]>([])
  const currency = view.project.currency
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <h2 className="text-xl">{t("projectReconciliation.detail.cases")}</h2>
        {canWrite && (
          <Button onClick={() => onAction({ kind: "case" })}>
            {t("projectReconciliation.workflow.newCase")}
          </Button>
        )}
      </div>
      {view.cases.total === 0 && <p>{t("projectReconciliation.detail.noCases")}</p>}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("projectReconciliation.detail.case")}</TableHead>
            <TableHead>
              {t("projectReconciliation.customerBilled")}
              {invoiceFiltered && ` · ${t("projectReconciliation.detail.basis.invoicePeriod")}`}
            </TableHead>
            <TableHead>{t("projectReconciliation.detail.overallOutstanding")}</TableHead>
            <TableHead>{t("projectReconciliation.detail.review")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {view.cases.items.map((row) => {
            const open = expanded.includes(row.id)
            const ownLinks = new Set(
              row.customerInvoices.filter((x) => x.external === null).map((x) => x.documentLinkId),
            )
            return (
              <Fragment key={row.id}>
                <TableRow>
                  <TableCell>
                    <Button
                      variant="ghost"
                      aria-expanded={open}
                      aria-controls={`case-${row.id}`}
                      aria-label={t(
                        open
                          ? "projectReconciliation.detail.collapseCase"
                          : "projectReconciliation.detail.expandCase",
                        { name: row.title },
                      )}
                      onClick={() =>
                        setExpanded(open ? expanded.filter((id) => id !== row.id) : [...expanded, row.id])
                      }
                    >
                      {row.title}
                    </Button>
                    <p className="text-xs text-muted-foreground">
                      {row.periodStart ?? "—"} – {row.periodEnd ?? "—"}
                    </p>
                  </TableCell>
                  <TableCell>
                    <Measure value={row.summary.customerInvoiced} currency={currency} />
                  </TableCell>
                  <TableCell>
                    <Measure value={row.summary.ownOutstanding} currency={currency} />
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        fresh && row.effectiveReviewState === "CLOSED_VERIFIED" ? "success" : "warning"
                      }
                    >
                      {t(`projectReconciliation.review.${fresh ? row.effectiveReviewState : "OPEN"}`)}
                    </Badge>
                  </TableCell>
                </TableRow>
                {open && (
                  <TableRow id={`case-${row.id}`}>
                    <TableCell colSpan={4}>
                      <div className="space-y-4 py-2">
                        <div className="grid gap-2 sm:grid-cols-2">
                          <p>
                            {t("projectReconciliation.detail.overallAgreement")}:{" "}
                            <Measure value={row.summary.agreedSettlement} currency={currency} />
                          </p>
                          <p>
                            {t("projectReconciliation.detail.overallUnbilled")}:{" "}
                            <Measure value={row.summary.unbilledDifference} currency={currency} />
                          </p>
                        </div>
                        <Badge variant={fresh && row.coverage.state === "CURRENT" ? "success" : "warning"}>
                          {t(
                            `projectReconciliation.detail.coverage.${fresh || row.coverage.state !== "CURRENT" ? row.coverage.state : "STALE"}`,
                          )}
                        </Badge>
                        {row.coverage.invoices.map(
                          (item) =>
                            item.attestation && (
                              <p key={item.customerInvoiceId} className="text-sm text-muted-foreground">
                                {item.attestation.evidenceReference} · {item.attestation.sourceAsOf} ·{" "}
                                {item.attestation.attestedBy} · {item.attestation.attestedAt}
                              </p>
                            ),
                        )}
                        {row.customerInvoices.map((invoice) =>
                          invoice.external ? (
                            <article key={invoice.id} className="space-y-2 rounded-md border p-4">
                              <h3 className="font-semibold">{invoice.external.number}</h3>
                              <p>
                                {invoice.external.issuer} → {invoice.external.recipient}
                              </p>
                              <p>
                                {t("projectReconciliation.workflow.originalGross")}:{" "}
                                {formatMinor(invoice.originalGrossMinor, currency)} ·{" "}
                                {t("projectReconciliation.detail.credits")}:{" "}
                                {formatMinor(invoice.creditAdjustmentMinor, currency)} ·{" "}
                                {t("projectReconciliation.detail.collectible")}:{" "}
                                {formatMinor(invoice.adjustedGrossMinor, currency)}
                              </p>
                              <p>
                                {t("projectReconciliation.workflow.reportedStatus")}:{" "}
                                {invoice.external.reportedStatus ?? "—"} ·{" "}
                                {invoice.external.issueDate ??
                                  t("projectReconciliation.workflow.unknownDate")}
                              </p>
                              <p className="text-sm text-muted-foreground">
                                {invoice.external.sourceReference} · {invoice.external.sourceAsOf ?? "—"}
                              </p>
                              {canWrite && (
                                <div className="flex gap-2">
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() =>
                                      onAction({ kind: "invoice", caseId: row.id, invoiceId: invoice.id })
                                    }
                                  >
                                    {t("projectReconciliation.workflow.editExternalInvoice")}
                                  </Button>
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={() =>
                                      onAction({ kind: "credit", caseId: row.id, invoiceId: invoice.id })
                                    }
                                  >
                                    {t("projectReconciliation.workflow.creditTitle")}
                                  </Button>
                                </div>
                              )}
                            </article>
                          ) : (
                            <Fragment key={invoice.id}>
                              {row.documentLinks
                                .filter((link) => link.id === invoice.documentLinkId)
                                .map((link) => (
                                  <DocumentRow
                                    key={link.id}
                                    link={link}
                                    fresh={fresh}
                                    onUnlink={
                                      canWrite
                                        ? () => onAction({ kind: "unlink", linkId: link.id })
                                        : undefined
                                    }
                                  />
                                ))}
                            </Fragment>
                          ),
                        )}
                        <p className="text-sm text-muted-foreground">
                          {t("projectReconciliation.detail.caseEvidence")} ·{" "}
                          {t("projectReconciliation.detail.checkedReceipts")}:{" "}
                          <Measure value={row.checkedReceipts} currency={currency} /> ·{" "}
                          {t("projectReconciliation.detail.reportedReceipts")}:{" "}
                          <Measure value={row.reportedReceipts} currency={currency} />
                        </p>
                        {row.documentLinks
                          .filter((link) => !ownLinks.has(link.id))
                          .map((link) => (
                            <DocumentRow
                              key={link.id}
                              link={link}
                              fresh={fresh}
                              onUnlink={
                                canWrite ? () => onAction({ kind: "unlink", linkId: link.id }) : undefined
                              }
                            />
                          ))}
                        {row.exceptions.map((item) => (
                          <p key={item.fingerprint + item.code} className="text-sm text-muted-foreground">
                            {item.message}
                          </p>
                        ))}
                        {canWrite && (
                          <div className="flex flex-wrap gap-2">
                            <Button
                              variant="outline"
                              onClick={() => onAction({ kind: "case", caseId: row.id })}
                            >
                              {t("projectReconciliation.workflow.editCase")}
                            </Button>
                            {view.project.collectionMode === "PARTNER" && (
                              <>
                                <Button
                                  variant="outline"
                                  onClick={() => onAction({ kind: "invoice", caseId: row.id })}
                                >
                                  {t("projectReconciliation.workflow.newExternalInvoice")}
                                </Button>
                                <Button
                                  variant="outline"
                                  disabled={!fresh || !row.customerInvoices.some((x) => x.external !== null)}
                                  onClick={() => onAction({ kind: "coverage", caseId: row.id })}
                                >
                                  {t("projectReconciliation.workflow.coverageTitle")}
                                </Button>
                              </>
                            )}
                            <Button
                              variant="outline"
                              onClick={() => onAction({ kind: "link", caseId: row.id })}
                            >
                              {t("projectReconciliation.workflow.linkDocument")}
                            </Button>
                            <Button
                              variant="outline"
                              disabled={!fresh}
                              onClick={() => onAction({ kind: "review", caseId: row.id })}
                            >
                              {t("projectReconciliation.detail.reviewCase")}
                            </Button>
                          </div>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                )}
              </Fragment>
            )
          })}
        </TableBody>
      </Table>
      {view.unallocatedDocumentLinks.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xl">{t("projectReconciliation.detail.unallocated")}</h2>
          {view.unallocatedDocumentLinks.map((link) => (
            <DocumentRow
              key={link.id}
              link={link}
              fresh={fresh}
              onUnlink={canWrite ? () => onAction({ kind: "unlink", linkId: link.id }) : undefined}
            />
          ))}
        </section>
      )}
      {canWrite && (
        <Button variant="outline" onClick={() => onAction({ kind: "link" })}>
          {t("projectReconciliation.detail.linkConsolidated")}
        </Button>
      )}
    </div>
  )
}
