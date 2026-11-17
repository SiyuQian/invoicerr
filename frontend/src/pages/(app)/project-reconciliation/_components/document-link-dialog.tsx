import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { z } from "zod"
import SearchSelect from "@/components/search-input"
import { Button } from "@/components/ui/button"
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import {
  useLinkReconciliationDocument,
  useUnlinkReconciliationDocument,
  useReconciliationDocumentCandidates,
} from "@/hooks/queries/use-project-reconciliation"
import type { CollectionMode, LinkDocumentInput } from "@/types/project-reconciliation"
import {
  requiredText,
  MutationDialog,
  ReconciliationTextField,
  ReconciliationChoiceField,
  useReconciliationForm,
  useReconciliationCompany,
  type ReconciliationFormProps,
} from "./mutation-form"

type LinkProps = ReconciliationFormProps & {
  collectionMode: CollectionMode
  caseId: string | null
  role?: LinkDocumentInput["role"]
}
export function DocumentLinkDialog(props: LinkProps) {
  const activeCompany = useReconciliationCompany(props.companyId)
  if (!activeCompany || !props.open) return null
  return (
    <LinkForm
      key={`${props.companyId}:${props.projectId}:${props.caseId ?? "project"}:${props.role ?? "default"}`}
      {...props}
    />
  )
}
const documentType = (role: LinkDocumentInput["role"]) =>
  role === "PROJECT_COST" ? "expense" : role === "PARTNER_BILL" ? "received-invoice" : "invoice"
function LinkForm(props: LinkProps) {
  const { t } = useTranslation()
  const role =
    props.role ??
    (props.collectionMode === "PARTNER"
      ? "SETTLEMENT_INCOME"
      : props.caseId
        ? "CUSTOMER_INVOICE"
        : "PROJECT_COST")
  const mutation = useLinkReconciliationDocument(props.companyId, props.projectId)
  const allowed: LinkDocumentInput["role"][] =
    props.collectionMode === "PARTNER"
      ? ["SETTLEMENT_INCOME", "PROJECT_COST"]
      : [...(props.caseId ? ["CUSTOMER_INVOICE" as const] : []), "PARTNER_BILL", "PROJECT_COST"]
  const schema = z
    .strictObject({
      documentId: requiredText(200),
      role: z.enum(["CUSTOMER_INVOICE", "SETTLEMENT_INCOME", "PARTNER_BILL", "PROJECT_COST"]),
      typeId: z.enum(["invoice", "expense", "received-invoice"]),
    })
    .refine((x) => allowed.includes(x.role), {
      path: ["role"],
      message: t("projectReconciliation.workflow.invalidRole"),
    })
    .transform((x) => ({ ...x, caseId: props.caseId }))
  const state = useReconciliationForm(
    props,
    { documentId: "", role, typeId: documentType(role) },
    schema,
    (input) => mutation.mutateAsync(input),
  )
  const currentRole = state.form.watch("role")
  const currentType = state.form.watch("typeId")
  const oldRole = useRef(currentRole)
  const oldType = useRef(currentType)
  const [search, setSearch] = useState("")
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<{ value: string; label: string } | null>(null)
  useEffect(() => {
    if (oldRole.current !== currentRole) {
      oldRole.current = currentRole
      state.form.setValue("typeId", documentType(currentRole))
      state.form.setValue("documentId", "")
      setSelected(null)
      setSearch("")
      setPage(1)
    }
  }, [currentRole, state.form])
  useEffect(() => {
    if (oldType.current !== currentType) {
      oldType.current = currentType
      state.form.setValue("documentId", "")
      setSelected(null)
      setSearch("")
      setPage(1)
    }
  }, [currentType, state.form])
  const query = useReconciliationDocumentCandidates(currentType, search, page, true)
  const options =
    query.data?.items.map((row) => ({
      value: row.id,
      label: `${row.displayNumber ?? row.id} · ${row.status}`,
    })) ?? []
  return (
    <MutationDialog state={state} title={t("projectReconciliation.workflow.linkDocument")}>
      <ReconciliationChoiceField
        name="role"
        label={t("projectReconciliation.workflow.documentRole")}
        options={allowed.map((value) => ({
          value,
          label: t(`projectReconciliation.workflow.roles.${value}`),
        }))}
      />
      {currentRole === "PROJECT_COST" && (
        <ReconciliationChoiceField
          name="typeId"
          label={t("projectReconciliation.workflow.documentType")}
          options={[
            { value: "expense", label: t("projectReconciliation.workflow.expense") },
            { value: "received-invoice", label: t("projectReconciliation.workflow.receivedInvoice") },
          ]}
        />
      )}
      <FormField
        control={state.form.control}
        name="documentId"
        render={({ field }) => (
          <FormItem>
            <FormLabel required>{t("projectReconciliation.workflow.existingDocument")}</FormLabel>
            <FormControl>
              <SearchSelect
                options={options}
                allOptions={
                  selected ? [...options.filter((x) => x.value !== selected.value), selected] : options
                }
                value={field.value}
                onSearchChange={(value) => {
                  setSearch(value)
                  setPage(1)
                }}
                onValueChange={(value) => {
                  const id = String(value)
                  field.onChange(id)
                  setSelected(options.find((x) => x.value === id) ?? selected)
                }}
                searchPlaceholder={t("projectReconciliation.workflow.searchDocuments")}
                disabled={query.isLoading}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      {query.isError && (
        <div role="alert">
          <p>{t("projectReconciliation.referenceError")}</p>
          <Button type="button" variant="outline" onClick={() => void query.refetch()}>
            {t("projectReconciliation.retryReferences")}
          </Button>
        </div>
      )}
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={page === 1 || query.isFetching}
          onClick={() => setPage((x) => x - 1)}
        >
          {t("projectReconciliation.workflow.previousOptions")}
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={!query.data || page * query.data.pageSize >= query.data.total || query.isFetching}
          onClick={() => setPage((x) => x + 1)}
        >
          {t("projectReconciliation.workflow.nextOptions")}
        </Button>
      </div>
      {props.caseId === null && (
        <p className="text-sm text-muted-foreground">
          {t("projectReconciliation.workflow.projectLevelLink")}
        </p>
      )}
    </MutationDialog>
  )
}
export function DocumentUnlinkDialog(props: ReconciliationFormProps & { linkId: string }) {
  const activeCompany = useReconciliationCompany(props.companyId)
  if (!activeCompany || !props.open) return null
  return <UnlinkForm key={`${props.companyId}:${props.projectId}:${props.linkId}`} {...props} />
}
function UnlinkForm(props: ReconciliationFormProps & { linkId: string }) {
  const { t } = useTranslation()
  const mutation = useUnlinkReconciliationDocument(props.companyId, props.projectId, props.linkId)
  const state = useReconciliationForm(
    props,
    { reason: "" },
    z.strictObject({ reason: requiredText() }),
    (input) => mutation.mutateAsync(input),
  )
  return (
    <MutationDialog state={state} title={t("projectReconciliation.workflow.unlinkDocument")}>
      <ReconciliationTextField name="reason" label={t("projectReconciliation.workflow.reason")} required />
    </MutationDialog>
  )
}
