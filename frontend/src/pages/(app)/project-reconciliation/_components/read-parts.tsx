import { useTranslation } from "react-i18next"
import { Link } from "react-router"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ProseHelp } from "@/components/ui/prose-help"
import { formatMinor } from "@/components/documents/totals-calculator"
import type { DocumentLinkView, MoneyMeasure, Problem } from "@/types/project-reconciliation"
export function Measure({ value, currency }: { value: MoneyMeasure; currency: string }) {
  const { t } = useTranslation()
  return (
    <span>
      {value.completeness === "UNKNOWN" ? (
        <span>{t("projectReconciliation.unknown")}</span>
      ) : (
        <>
          <span className="amount">{formatMinor(value.knownMinor, currency)}</span>
          {value.completeness === "PARTIAL" && (
            <span className="block text-xs text-muted-foreground">
              {t("projectReconciliation.subtotal", { count: value.missingCount })}
            </span>
          )}
        </>
      )}
    </span>
  )
}
export function CursorControls({
  cursors,
  onChange,
  next,
  busy,
  kind,
}: {
  cursors: (string | undefined)[]
  onChange: (cursors: (string | undefined)[]) => void
  next: string | null
  busy: boolean
  kind: "cases" | "receipts" | "history" | "choices"
}) {
  const { t } = useTranslation()
  return (
    <div className="flex min-w-0 flex-col gap-2 py-3 sm:flex-row sm:flex-wrap">
      <Button
        type="button"
        variant="outline"
        disabled={cursors.length === 1 || busy}
        onClick={() => onChange(cursors.slice(0, -1))}
      >
        {t(`projectReconciliation.detail.previous.${kind}`)}
      </Button>
      <Button
        type="button"
        variant="outline"
        disabled={!next || busy}
        onClick={() => onChange([...cursors, next!])}
      >
        {t(`projectReconciliation.detail.next.${kind}`)}
      </Button>
    </div>
  )
}
export function Warnings({ warnings, currency }: { warnings: Problem[]; currency: string }) {
  const { t } = useTranslation()
  const statusKeys: Record<string, string> = {
    INVOICE_DATE_UNKNOWN: "invoiceDateUnknown",
    CASH_DATE_UNKNOWN: "cashDateUnknown",
    FINANCIAL_READ_UNAVAILABLE: "readUnavailable",
    SOURCE_UNAVAILABLE: "sourceUnavailable",
    TOTALS_UNAVAILABLE: "totalsUnavailable",
    PAYMENTS_UNSUPPORTED: "paymentsUnsupported",
    SETTLEMENT_UNAVAILABLE: "settlementUnavailable",
  }
  return (
    <>
      {warnings.map((warning) => (
        <ProseHelp
          key={JSON.stringify(warning)}
          tone="warning"
          title={[
            t(`projectReconciliation.detail.warningStatus.${statusKeys[warning.code] ?? "needsReview"}`),
            ...(typeof warning.params?.omittedKnownMinor === "number"
              ? [
                  t("projectReconciliation.detail.omittedAmount", {
                    amount: currency
                      ? formatMinor(warning.params.omittedKnownMinor, currency)
                      : t("projectReconciliation.unknown"),
                  }),
                ]
              : []),
            ...(typeof warning.params?.count === "number"
              ? [t("projectReconciliation.detail.warningRecords", { count: warning.params.count })]
              : []),
          ].join(" · ")}
        >
          {warning.message}
        </ProseHelp>
      ))}
    </>
  )
}
export function DocumentRow({
  link,
  fresh = true,
  onUnlink,
}: {
  link: DocumentLinkView
  fresh?: boolean
  onUnlink?: () => void
}) {
  const { t } = useTranslation()
  const read = link.financial
  const currency = read.currency
  const money = (minor: number | null) =>
    minor === null || !currency ? t("projectReconciliation.unknown") : formatMinor(minor, currency)
  return (
    <article
      className="space-y-2 rounded-md border p-4"
      aria-label={`${t(`projectReconciliation.workflow.roles.${link.role}`)} ${read.displayNumber ?? link.documentId}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Link
          className="font-semibold underline focus-ring"
          to={`/documents/${encodeURIComponent(link.typeId)}/${encodeURIComponent(link.documentId)}`}
        >
          {read.displayNumber ?? link.documentId}
        </Link>
        <Badge variant="outline">{read.status}</Badge>
        <span className="text-sm text-muted-foreground">
          {t(`projectReconciliation.workflow.roles.${link.role}`)} ·{" "}
          {link.issueDate ?? t("projectReconciliation.workflow.unknownDate")}
        </span>
        {onUnlink && (
          <Button size="sm" variant="outline" onClick={onUnlink}>
            {t("projectReconciliation.workflow.unlinkDocument")}
          </Button>
        )}
      </div>
      <div className="grid gap-2 text-sm sm:grid-cols-2">
        <p>
          {t("projectReconciliation.detail.canonicalGross")}:{" "}
          <span className="amount">{money(read.grossMinor)}</span>
        </p>
        <p>
          {t("projectReconciliation.detail.paymentKnowledge")}:{" "}
          {t(`projectReconciliation.detail.paymentAvailability.${read.paymentKnowledge}`)}
        </p>
        {read.settlement ? (
          <>
            <p>
              {t("projectReconciliation.detail.credits")}: {money(read.settlement.creditedMinor)}
            </p>
            <p>
              {t("projectReconciliation.detail.canonicalPaid")}: {money(read.settlement.paidMinor)}
            </p>
            <p>
              {t("projectReconciliation.detail.overallOutstanding")}:{" "}
              {money(read.settlement.outstandingMinor)}
            </p>
            <p>
              {t("projectReconciliation.detail.excess")}: {money(read.settlement.excessMinor)}
            </p>
          </>
        ) : (
          <p>{t("projectReconciliation.detail.balanceUnavailable")}</p>
        )}
      </div>
      {!fresh && (
        <p className="text-sm text-muted-foreground">
          {t("projectReconciliation.detail.snapshotNotCurrent")}
        </p>
      )}
      {read.payments.map((payment) => (
        <p key={`${payment.source}:${payment.id}`} className="text-sm">
          {t(
            payment.source === "document-payment"
              ? "projectReconciliation.detail.documentPayment"
              : "projectReconciliation.detail.disbursement",
          )}{" "}
          · {money(payment.documentAmountMinor)} ·{" "}
          {payment.paidOn
            ? new Date(payment.paidOn).toISOString().slice(0, 10)
            : t("projectReconciliation.workflow.unknownDate")}
          {currency !== payment.originalCurrency && (
            <> · {formatMinor(payment.originalAmountMinor, payment.originalCurrency)}</>
          )}
        </p>
      ))}
      <Warnings warnings={read.warnings} currency={currency ?? ""} />
    </article>
  )
}
