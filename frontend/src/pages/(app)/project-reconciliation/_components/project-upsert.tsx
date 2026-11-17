import type { TFunction } from "i18next"
import { useMemo, useState } from "react"
import { useTranslation } from "react-i18next"
import { z } from "zod"
import SearchSelect from "@/components/search-input"
import { Button } from "@/components/ui/button"
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  useCreateReconciliationProject,
  useReconciliationClients,
  useReconciliationTimeProjects,
  useUpdateReconciliationProject,
} from "@/hooks/queries/use-project-reconciliation"
import { currencies } from "@/lib/constants/currencies"
import { reconciliationCurrencies, type ProjectListRow } from "@/types/project-reconciliation"
import { MutationDialog, useReconciliationForm, useReconciliationCompany } from "./mutation-form"

export const buildProjectSchema = (t: TFunction) =>
  z
    .strictObject({
      name: z.string().trim().min(1, t("projectReconciliation.required")).max(200),
      endCustomerName: z.string().trim().min(1, t("projectReconciliation.required")).max(200),
      currency: z.enum(reconciliationCurrencies, { error: t("projectReconciliation.currencyRequired") }),
      collectionMode: z.enum(["COMPANY", "PARTNER"]),
      endCustomerClientId: z.string().trim().min(1).max(200).nullable(),
      partnerClientId: z.string().trim().min(1).max(200).nullable(),
      timeProjectId: z.string().trim().min(1).max(200).nullable(),
      description: z.string().trim().min(1).max(4000).nullable(),
    })
    .superRefine((value, ctx) => {
      if (value.collectionMode === "PARTNER" && !value.partnerClientId)
        ctx.addIssue({
          code: "custom",
          path: ["partnerClientId"],
          message: t("projectReconciliation.partnerRequired"),
        })
      if (value.endCustomerClientId && value.partnerClientId === value.endCustomerClientId)
        ctx.addIssue({
          code: "custom",
          path: ["partnerClientId"],
          message: t("projectReconciliation.partiesDiffer"),
        })
    })

const currencyOptions = reconciliationCurrencies.map((code) => ({
  value: code,
  label: currencies[code] ? `${currencies[code].name} (${code})` : code,
}))
interface Props {
  companyId: string
  row?: ProjectListRow
  open: boolean
  onOpenChange: (open: boolean) => void
  onCloseAutoFocus?: (event: Event) => void
  onReload: () => Promise<string>
}
export function ProjectUpsert(props: Props) {
  const activeCompany = useReconciliationCompany(props.companyId)
  if (!activeCompany || !props.open || (props.row && props.row.project.companyId !== props.companyId))
    return null
  return <ProjectForm key={`${props.companyId}:${props.row?.project.id ?? "new"}`} {...props} />
}
function ProjectForm({ companyId, row, open, onOpenChange, onCloseAutoFocus, onReload }: Props) {
  const { t } = useTranslation()
  const project = row?.project
  const locked = !!project?.identityLocked
  const schema = useMemo(() => buildProjectSchema(t), [t])
  const [customerSearch, setCustomerSearch] = useState("")
  const [partnerSearch, setPartnerSearch] = useState("")
  const [currencySearch, setCurrencySearch] = useState("")
  const [timeProjectSearch, setTimeProjectSearch] = useState("")
  const customerClients = useReconciliationClients(customerSearch, open && !locked)
  const partnerClients = useReconciliationClients(partnerSearch, open && !locked)
  const timeProjects = useReconciliationTimeProjects(open)
  const create = useCreateReconciliationProject(companyId)
  const update = useUpdateReconciliationProject(companyId, project?.id ?? "")
  const state = useReconciliationForm(
    {
      companyId,
      projectId: project?.id ?? "new",
      versionToken: row?.versionToken ?? "new",
      open,
      onOpenChange,
      onCloseAutoFocus,
      onReload,
    },
    {
      name: project?.name ?? "",
      endCustomerName: project?.endCustomerName ?? "",
      currency: project?.currency,
      collectionMode: project?.collectionMode ?? "COMPANY",
      endCustomerClientId: project?.endCustomerClientId ?? null,
      partnerClientId: project?.partnerClientId ?? null,
      timeProjectId: project?.timeProjectId ?? null,
      description: project?.description ?? null,
    },
    schema,
    (input) => (project ? update.mutateAsync(input) : create.mutateAsync(input)),
  )
  const { form, pending, canWrite } = state
  const optionsWithCurrent = (
    options: { value: string; label: string }[],
    current: { id: string; name: string; inactive: boolean } | null | undefined,
  ) =>
    current && !options.some((option) => option.value === current.id)
      ? [
          {
            value: current.id,
            label: `${current.name}${current.inactive ? ` (${t("projectReconciliation.inactive")})` : ""}`,
          },
          ...options,
        ]
      : options
  const referenceFields = [
    {
      name: "endCustomerClientId" as const,
      label: "customerClient",
      query: customerClients,
      search: setCustomerSearch,
      current: project?.endCustomerClient,
      locked,
    },
    {
      name: "partnerClientId" as const,
      label: "partner",
      query: partnerClients,
      search: setPartnerSearch,
      current: project?.partnerClient,
      locked,
    },
    {
      name: "timeProjectId" as const,
      label: "timeProject",
      query: timeProjects,
      search: setTimeProjectSearch,
      current: project?.timeProject,
      locked: false,
    },
  ]
  return (
    <MutationDialog
      state={state}
      title={t(project ? "projectReconciliation.edit" : "projectReconciliation.new")}
      actionLabel={t(project ? "projectReconciliation.save" : "projectReconciliation.create")}
      formDataCy="reconciliation-project-form"
    >
      <div className="space-y-4">
        {(["name", "endCustomerName"] as const).map((name) => (
          <FormField
            key={name}
            name={name}
            control={form.control}
            render={({ field }) => (
              <FormItem>
                <FormLabel required>{t(`projectReconciliation.fields.${name}`)}</FormLabel>
                <FormControl>
                  <Input
                    {...field}
                    onChange={(event) => {
                      field.onChange(event)
                    }}
                    disabled={pending || !canWrite}
                    maxLength={200}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
        ))}
        <FormField
          name="currency"
          control={form.control}
          render={({ field }) => (
            <FormItem>
              <FormLabel required lockReason={locked ? t("projectReconciliation.identityLocked") : undefined}>
                {t("projectReconciliation.fields.currency")}
              </FormLabel>
              <FormControl>
                <SearchSelect
                  value={field.value}
                  options={currencyOptions.filter((option) =>
                    option.label.toLowerCase().includes(currencySearch.toLowerCase()),
                  )}
                  allOptions={currencyOptions}
                  onSearchChange={setCurrencySearch}
                  onValueChange={(value) => {
                    field.onChange(value)
                  }}
                  disabled={locked || pending || !canWrite}
                  placeholder={t("projectReconciliation.currencyPlaceholder")}
                  searchPlaceholder={t("projectReconciliation.currencySearch")}
                  noResultsText={t("projectReconciliation.noOptions")}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          name="collectionMode"
          control={form.control}
          render={({ field }) => (
            <FormItem>
              <FormLabel
                required
                description={t("projectReconciliation.collectionHelp")}
                lockReason={locked ? t("projectReconciliation.identityLocked") : undefined}
              >
                {t("projectReconciliation.fields.collectionMode")}
              </FormLabel>
              <FormControl>
                <SearchSelect
                  value={field.value}
                  options={[
                    { value: "COMPANY", label: t("projectReconciliation.companyCollected") },
                    { value: "PARTNER", label: t("projectReconciliation.partnerCollected") },
                  ]}
                  onValueChange={(value) => {
                    field.onChange(value)
                  }}
                  disabled={locked || pending || !canWrite}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        {referenceFields.map((reference) => (
          <FormField
            key={reference.name}
            name={reference.name}
            control={form.control}
            render={({ field }) => (
              <FormItem>
                <FormLabel
                  required={
                    reference.name === "partnerClientId" && form.watch("collectionMode") === "PARTNER"
                  }
                  description={t(`projectReconciliation.help.${reference.label}`)}
                  lockReason={reference.locked ? t("projectReconciliation.identityLocked") : undefined}
                >
                  {t(`projectReconciliation.fields.${reference.label}`)}
                </FormLabel>
                <FormControl>
                  <SearchSelect
                    value={field.value ?? undefined}
                    options={[
                      { value: "", label: t("projectReconciliation.optionalSelect") },
                      ...optionsWithCurrent(
                        (reference.query.data ?? [])
                          .filter(
                            (item) =>
                              reference.name !== "timeProjectId" ||
                              item.name.toLowerCase().includes(timeProjectSearch.toLowerCase()),
                          )
                          .map((item) => ({ value: item.id, label: item.name })),
                        reference.current,
                      ),
                    ]}
                    onSearchChange={reference.search}
                    onValueChange={(value) => {
                      field.onChange(value || null)
                    }}
                    disabled={reference.locked || pending || !canWrite}
                    placeholder={t("projectReconciliation.optionalSelect")}
                    searchPlaceholder={t(
                      reference.name === "timeProjectId"
                        ? "projectReconciliation.searchTimeProjects"
                        : "projectReconciliation.searchClients",
                    )}
                    noResultsText={t(
                      reference.query.isError
                        ? "projectReconciliation.referenceError"
                        : "projectReconciliation.noOptions",
                    )}
                  />
                </FormControl>
                <FormMessage />
                {reference.query.isError && (
                  <Button type="button" variant="outline" onClick={() => void reference.query.refetch()}>
                    {t("projectReconciliation.retryReferences")}
                  </Button>
                )}
              </FormItem>
            )}
          />
        ))}
        <FormField
          name="description"
          control={form.control}
          render={({ field }) => (
            <FormItem>
              <FormLabel>{t("projectReconciliation.fields.description")}</FormLabel>
              <FormControl>
                <Textarea
                  {...field}
                  value={field.value ?? ""}
                  onChange={(event) => {
                    field.onChange(event.target.value || null)
                  }}
                  disabled={pending || !canWrite}
                  maxLength={4000}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </MutationDialog>
  )
}
