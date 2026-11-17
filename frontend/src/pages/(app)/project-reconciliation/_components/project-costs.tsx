import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import type { HistoryPage, ProjectView } from "@/types/project-reconciliation"
import { ListSkeleton } from "../../_shared/data-list"
import { DocumentRow } from "./read-parts"
export function ProjectCosts({
  view,
  history,
  error,
  loading = false,
  retry,
  fresh,
}: {
  view: ProjectView
  history?: HistoryPage
  error: boolean
  loading?: boolean
  retry: () => void
  fresh: boolean
}) {
  const { t } = useTranslation()
  const links = [
    ...view.unallocatedDocumentLinks,
    ...view.cases.items.flatMap((x) => x.documentLinks),
  ].filter((x) => x.role === "PROJECT_COST" || x.role === "PARTNER_BILL")
  const unique = [...new Map(links.map((link) => [link.documentId, link])).values()]
  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-xl">{t("projectReconciliation.detail.costs")}</h2>
        <p className="text-sm text-muted-foreground">{t("projectReconciliation.detail.costPageBasis")}</p>
        {unique.length === 0 && <p>{t("projectReconciliation.detail.noCosts")}</p>}
        {unique.map((link) => (
          <DocumentRow key={link.id} link={link} fresh={fresh} />
        ))}
      </section>
      <section className="space-y-3">
        <h2 className="text-xl">{t("projectReconciliation.detail.history")}</h2>
        {error ? (
          <div role="alert">
            <p>{t("projectReconciliation.detail.historyError")}</p>
            <Button variant="outline" onClick={retry}>
              {t("projectReconciliation.retry")}
            </Button>
          </div>
        ) : loading ? (
          <ListSkeleton />
        ) : (
          history?.items.map((item) => (
            <article key={item.id} className="space-y-2 border-b py-3">
              <h3 className="font-semibold">
                {t(`projectReconciliation.detail.operations.${item.operation}`, {
                  defaultValue: t("projectReconciliation.detail.recordChanged"),
                })}
              </h3>
              <p className="text-sm">
                {item.actor} · {item.occurredAt} · {item.affectedRecord}
              </p>
              {item.reason && <p>{item.reason}</p>}
              <details>
                <summary className="cursor-pointer text-sm">
                  {t("projectReconciliation.detail.auditValues")}
                </summary>
                <p className="text-xs text-muted-foreground">{item.operation}</p>
                <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-all text-xs">
                  {JSON.stringify({ before: item.before, after: item.after }, null, 2)}
                </pre>
              </details>
            </article>
          ))
        )}
        {!error && history?.total === 0 && <p>{t("projectReconciliation.detail.noHistory")}</p>}
      </section>
    </div>
  )
}
