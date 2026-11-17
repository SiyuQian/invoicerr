import { FolderKanban, Pencil, Plus, Archive, ArchiveRestore, TriangleAlert } from "lucide-react"
import { type ReactNode, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { Link, useNavigate } from "react-router"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenuItem } from "@/components/ui/dropdown-menu"
import { EmptyState } from "@/components/ui/empty-state"
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination"
import { formatMinor } from "@/components/documents/totals-calculator"
import { ApiError, apiFetch } from "@/hooks/use-api-query"
import { useCompanies } from "@/hooks/queries/use-companies"
import {
  useReconciliationProjects,
  useUpdateReconciliationProject,
} from "@/hooks/queries/use-project-reconciliation"
import type {
  MoneyMeasure,
  MutationBody,
  ProjectListQuery,
  ProjectListRow,
  UpdateProjectInput,
  RegisterView,
} from "@/types/project-reconciliation"
import {
  FilterChip,
  FilterChipGroup,
  ListRow,
  ListRowMenu,
  ListSearch,
  ListSkeleton,
  PanelSection,
} from "../../_shared/data-list"
import { ProjectUpsert } from "./project-upsert"
import { useReconciliationDialogFocus } from "./mutation-form"

function Measure({ measure, currency }: { measure: MoneyMeasure; currency: string }) {
  const { t } = useTranslation()
  if (measure.completeness === "UNKNOWN") return <span>{t("projectReconciliation.unknown")}</span>
  return (
    <>
      <span className="amount">{formatMinor(measure.knownMinor, currency)}</span>
      {measure.completeness === "PARTIAL" && (
        <span className="block text-xs text-muted-foreground">
          {t("projectReconciliation.subtotal", { count: measure.missingCount })}
        </span>
      )}
    </>
  )
}
function ProjectRow({
  row,
  companyId,
  canWrite,
  onEdit,
  onReload,
}: {
  row: ProjectListRow
  companyId: string
  canWrite: boolean
  onEdit: () => void
  onReload: () => void
}) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const update = useUpdateReconciliationProject(companyId, row.project.id)
  const [failure, setFailure] = useState<unknown>(null)
  const request = useRef<MutationBody<UpdateProjectInput> | null>(null)
  const { project } = row
  const archive = async () => {
    request.current ??= {
      status: project.status === "ACTIVE" ? "ARCHIVED" : "ACTIVE",
      expectedVersion: row.versionToken,
      requestKey: crypto.randomUUID(),
    }
    setFailure(null)
    try {
      await update.mutateAsync(request.current)
      request.current = null
    } catch (error) {
      setFailure(error)
    }
  }
  const conflict = failure instanceof ApiError && failure.status === 409
  const href = `/project-reconciliation/${encodeURIComponent(project.id)}`
  return (
    <div>
      <ListRow
        dataCy={`reconciliation-project-${project.id}`}
        onOpen={() => void navigate(href)}
        identity={
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <Link to={href} className="font-semibold focus-ring">
                {project.name}
              </Link>
              <Badge variant={row.effectiveReviewState === "CLOSED_VERIFIED" ? "success" : "warning"}>
                {t(`projectReconciliation.review.${row.effectiveReviewState}`)}
              </Badge>
              {project.status === "ARCHIVED" && (
                <Badge variant="outline">{t("projectReconciliation.archived")}</Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {project.endCustomerName} ·{" "}
              {t(
                project.collectionMode === "COMPANY"
                  ? "projectReconciliation.companyCollected"
                  : "projectReconciliation.partnerCollected",
              )}
              {project.partnerClient && ` · ${project.partnerClient.name}`}
            </p>
            {row.attentionCount > 0 && (
              <p className="text-xs text-muted-foreground">
                {t("projectReconciliation.attentionCount", { count: row.attentionCount })}
              </p>
            )}
          </div>
        }
        figures={
          <div className="space-y-2">
            <div>
              <span className="block text-xs text-muted-foreground">
                {t("projectReconciliation.customerBilled")}
              </span>
              <Measure measure={row.summary.customerInvoiced} currency={project.currency} />
            </div>
            <div>
              <span className="block text-xs text-muted-foreground">
                {t("projectReconciliation.ourOutstanding")}
              </span>
              <Measure measure={row.summary.ownOutstanding} currency={project.currency} />
            </div>
          </div>
        }
        primary={
          <Button asChild variant="outline">
            <Link to={href}>{t("projectReconciliation.open")}</Link>
          </Button>
        }
        menu={
          canWrite && (
            // Issue #715: match document row menus so the focusable sidebar is not aria-hidden.
            <ListRowMenu modal={false} label={t("projectReconciliation.actionsFor", { name: project.name })}>
              <DropdownMenuItem onSelect={onEdit}>
                <Pencil />
                {t("projectReconciliation.edit")}
              </DropdownMenuItem>
              <DropdownMenuItem disabled={update.isPending} onSelect={() => void archive()}>
                {project.status === "ACTIVE" ? <Archive /> : <ArchiveRestore />}
                {t(
                  project.status === "ACTIVE"
                    ? "projectReconciliation.archive"
                    : "projectReconciliation.restore",
                )}
              </DropdownMenuItem>
            </ListRowMenu>
          )
        }
      />
      {!!failure && (
        <div role="alert" className="px-5 pb-4 text-sm text-destructive">
          <p>{t(conflict ? "projectReconciliation.conflict" : "projectReconciliation.saveError")}</p>
          <Button variant="outline" onClick={conflict ? onReload : () => void archive()}>
            {t(conflict ? "projectReconciliation.reload" : "projectReconciliation.retry")}
          </Button>
        </div>
      )}
    </div>
  )
}
export function ProjectList({ companyId }: { companyId: string }) {
  const dialogFocus = useReconciliationDialogFocus(companyId, 'input[type="search"]')
  const { t } = useTranslation()
  const { activeCompanyId, activeRole } = useCompanies()
  const canWrite = activeCompanyId === companyId && (activeRole === "OWNER" || activeRole === "ADMIN")
  const [search, setSearch] = useState("")
  const [status, setStatus] = useState<NonNullable<ProjectListQuery["status"]>>("ACTIVE")
  const [collectionMode, setCollectionMode] = useState<ProjectListQuery["collectionMode"]>()
  const [attention, setAttention] = useState(false)
  const [cursors, setCursors] = useState<Array<string | undefined>>([undefined])
  const [editing, setEditing] = useState<ProjectListRow | "new" | null>(null)
  const filters: ProjectListQuery = {
    ...(search ? { search } : {}),
    status,
    ...(collectionMode ? { collectionMode } : {}),
    ...(attention ? { needsAttention: "true" } : {}),
    ...(cursors.at(-1) ? { cursor: cursors.at(-1) } : {}),
  }
  const query = useReconciliationProjects(filters)
  const change = (apply: () => void) => {
    apply()
    setCursors([undefined])
  }
  const reload = () => {
    setEditing(null)
    setCursors([undefined])
    void query.refetch()
  }
  const reloadEditing = async () => {
    if (!editing || editing === "new" || activeCompanyId !== companyId)
      throw new Error("No active project edit")
    const id = editing.project.id
    const fresh = await apiFetch<RegisterView>(
      `/api/project-reconciliation/projects/${encodeURIComponent(id)}`,
    )
    if (fresh.project.companyId !== companyId || fresh.project.id !== id || !fresh.versionToken)
      throw new Error("Project refresh unavailable")
    setEditing((current) =>
      current && current !== "new" && current.project.id === id
        ? {
            ...current,
            project: fresh.project,
            versionToken: fresh.versionToken,
            asOf: fresh.asOf,
            sourceFingerprint: fresh.sourceFingerprint,
          }
        : current,
    )
    return fresh.versionToken
  }
  const filtered = !!search || status !== "ACTIVE" || !!collectionMode || attention
  let body: ReactNode
  if (query.isError)
    body = (
      <EmptyState
        icon={TriangleAlert}
        tone="destructive"
        title={t(
          query.error instanceof ApiError && query.error.status === 403
            ? "projectReconciliation.forbidden"
            : "projectReconciliation.loadError",
        )}
        action={
          <Button variant="outline" onClick={() => void query.refetch()}>
            {t("projectReconciliation.retry")}
          </Button>
        }
      />
    )
  else if (query.isPending) body = <ListSkeleton dataCy="reconciliation-loading" />
  else if (!query.data?.items.length)
    body = (
      <EmptyState
        icon={FolderKanban}
        title={t(filtered ? "projectReconciliation.noMatches" : "projectReconciliation.empty")}
        description={t("projectReconciliation.emptyDescription")}
      />
    )
  else
    body = (
      <div className="divide-y">
        {query.data.items.map((row) => (
          <ProjectRow
            key={`${row.project.id}:${row.versionToken}`}
            row={row}
            companyId={companyId}
            canWrite={canWrite}
            onEdit={() => setEditing(row)}
            onReload={reload}
          />
        ))}
      </div>
    )
  return (
    <div
      ref={dialogFocus.scope}
      onClickCapture={dialogFocus.captureOpener}
      className="page-content space-y-5"
    >
      <div className="flex items-center gap-2">
        <ListSearch
          value={search}
          onChange={(value) => change(() => setSearch(value))}
          placeholder={t("projectReconciliation.search")}
          className="flex-1 sm:max-w-sm"
        />
        {canWrite && (
          <Button className="ms-auto" onClick={() => setEditing("new")}>
            <Plus aria-hidden="true" />
            {t("projectReconciliation.new")}
          </Button>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <FilterChipGroup label={t("projectReconciliation.statusFilter")}>
          {(["ACTIVE", "ARCHIVED", "ALL"] as const).map((value) => (
            <FilterChip
              key={value}
              label={t(`projectReconciliation.status.${value}`)}
              active={status === value}
              onClick={() => change(() => setStatus(value))}
            />
          ))}
        </FilterChipGroup>
        <FilterChipGroup label={t("projectReconciliation.collectionFilter")}>
          <FilterChip
            label={t("projectReconciliation.allCollectors")}
            active={!collectionMode}
            onClick={() => change(() => setCollectionMode(undefined))}
          />
          {(["COMPANY", "PARTNER"] as const).map((value) => (
            <FilterChip
              key={value}
              label={t(
                value === "COMPANY"
                  ? "projectReconciliation.companyCollected"
                  : "projectReconciliation.partnerCollected",
              )}
              active={collectionMode === value}
              onClick={() => change(() => setCollectionMode(value))}
            />
          ))}
        </FilterChipGroup>
        <FilterChipGroup label={t("projectReconciliation.attentionFilter")}>
          <FilterChip
            label={t("projectReconciliation.needsAttention")}
            active={attention}
            tone="warning"
            onClick={() => change(() => setAttention(!attention))}
          />
        </FilterChipGroup>
      </div>
      <PanelSection
        title={t("projectReconciliation.register")}
        description={
          query.data && !query.isError
            ? t("projectReconciliation.resultCount", { count: query.data.total })
            : undefined
        }
      >
        {body}
      </PanelSection>
      {query.data && !query.isError && (
        <Pagination aria-label={t("projectReconciliation.pagination")}>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                href="#"
                aria-label={t("projectReconciliation.previous")}
                aria-disabled={cursors.length === 1 || query.isFetching}
                disabled={cursors.length === 1 || query.isFetching}
                onClick={(event) => {
                  event.preventDefault()
                  if (cursors.length > 1 && !query.isFetching) setCursors(cursors.slice(0, -1))
                }}
              />
            </PaginationItem>
            <PaginationItem>
              <PaginationNext
                href="#"
                aria-label={t("projectReconciliation.next")}
                aria-disabled={!query.data.nextCursor || query.isFetching}
                disabled={!query.data.nextCursor || query.isFetching}
                onClick={(event) => {
                  event.preventDefault()
                  if (query.data?.nextCursor && !query.isFetching)
                    setCursors([...cursors, query.data.nextCursor])
                }}
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      )}
      {editing && canWrite && (
        <ProjectUpsert
          key={editing === "new" ? "new" : editing.project.id}
          companyId={companyId}
          row={editing === "new" ? undefined : editing}
          open
          onOpenChange={(open) => {
            if (!open) setEditing(null)
          }}
          onReload={reloadEditing}
          onCloseAutoFocus={dialogFocus.restoreFocus}
        />
      )}
    </div>
  )
}
