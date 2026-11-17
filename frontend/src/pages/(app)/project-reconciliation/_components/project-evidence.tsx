import { useTranslation } from "react-i18next"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { formatMinor } from "@/components/documents/totals-calculator"
import type { ProjectView, ReceiptPage } from "@/types/project-reconciliation"
import { ListRow, ListSkeleton } from "../../_shared/data-list"
import type { DetailAction } from "./case-list"
export function ProjectEvidence({
  view,
  receipts,
  error,
  loading = false,
  retry,
  canWrite,
  fresh,
  onAction,
}: {
  view: ProjectView
  receipts?: ReceiptPage
  error: boolean
  loading?: boolean
  retry: () => void
  canWrite: boolean
  fresh: boolean
  onAction: (action: DetailAction) => void
}) {
  const { t } = useTranslation()
  const partner = view.project.collectionMode === "PARTNER"
  const currency = view.project.currency
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-xl">{t("projectReconciliation.detail.receiptRecords")}</h2>
        {partner && canWrite && (
          <Button disabled={!fresh} onClick={() => onAction({ kind: "receipt" })}>
            {t("projectReconciliation.workflow.newReceipt")}
          </Button>
        )}
      </div>
      <p className="text-sm text-muted-foreground">{t("projectReconciliation.detail.receiptBasis")}</p>
      {error ? (
        <div role="alert">
          <p>{t("projectReconciliation.detail.receiptError")}</p>
          <Button variant="outline" onClick={retry}>
            {t("projectReconciliation.retry")}
          </Button>
        </div>
      ) : loading ? (
        <ListSkeleton />
      ) : (
        receipts?.items.map((receipt) => (
          <article key={receipt.id} className="space-y-2 border-b py-4">
            <ListRow
              identity={
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">
                      {t(
                        receipt.voidedAt
                          ? "projectReconciliation.detail.voided"
                          : receipt.evidenceClass === "EVIDENCE_CHECKED"
                            ? "projectReconciliation.workflow.checked"
                            : "projectReconciliation.workflow.reported",
                      )}
                    </Badge>
                    <span>{receipt.paidOn ?? t("projectReconciliation.workflow.unknownDate")}</span>
                  </div>
                  <p>
                    {receipt.collector} · {receipt.evidenceReference ?? receipt.sourceReference}
                  </p>
                </div>
              }
              figures={<span className="amount">{formatMinor(receipt.amountMinor, currency)}</span>}
              primary={
                canWrite && !receipt.voidedAt ? (
                  <Button
                    variant="outline"
                    disabled={!fresh}
                    onClick={() => onAction({ kind: "receipt", receiptId: receipt.id })}
                  >
                    {t("projectReconciliation.workflow.editReceipt")}
                  </Button>
                ) : undefined
              }
            />
            {receipt.evidenceReference && receipt.sourceReference !== receipt.evidenceReference && (
              <p>{receipt.sourceReference}</p>
            )}
            {receipt.reason && <p className="text-sm">{receipt.reason}</p>}
            {receipt.evidenceUrl && /^https:\/\//i.test(receipt.evidenceUrl) && (
              <a className="underline" href={receipt.evidenceUrl} target="_blank" rel="noopener noreferrer">
                {t("projectReconciliation.workflow.evidenceUrl")}
              </a>
            )}
            <p className="text-sm">
              {t("projectReconciliation.detail.allocated")}: {formatMinor(receipt.allocatedMinor, currency)} ·{" "}
              {t("projectReconciliation.detail.advance")}: {formatMinor(receipt.unallocatedMinor, currency)}
            </p>
            {receipt.allocations.map((item) => (
              <p key={item.id} className="text-sm">
                {item.customerInvoice.number} · {item.customerInvoice.caseTitle} ·{" "}
                {formatMinor(item.amountMinor, currency)}
              </p>
            ))}
            <p className="text-xs text-muted-foreground">
              {receipt.sourceSystem && `${receipt.sourceSystem} · ${receipt.sourceId} · `}
              {receipt.reviewedBy} {receipt.reviewedAt} {receipt.humanAttestation}
            </p>
            {receipt.voidedAt && (
              <p>
                {receipt.voidedAt} · {receipt.voidedBy} · {receipt.voidReason}
              </p>
            )}
            {canWrite && !receipt.voidedAt && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={!fresh}
                  onClick={() => onAction({ kind: "allocate", receiptId: receipt.id })}
                >
                  {t("projectReconciliation.detail.allocate")}
                </Button>
                <Button
                  variant="outline"
                  disabled={!fresh}
                  onClick={() => onAction({ kind: "void", receiptId: receipt.id })}
                >
                  {t("projectReconciliation.workflow.voidReceipt")}
                </Button>
              </div>
            )}
          </article>
        ))
      )}
      {!error && receipts?.total === 0 && <p>{t("projectReconciliation.detail.noReceipts")}</p>}
      <section className="space-y-2">
        <h2 className="text-xl">{t("projectReconciliation.detail.differences")}</h2>
        {view.exceptions.map((item) => (
          <p key={`${item.caseId}:${item.code}:${item.fingerprint}`} className="text-sm">
            {item.message}
          </p>
        ))}
      </section>
    </div>
  )
}
