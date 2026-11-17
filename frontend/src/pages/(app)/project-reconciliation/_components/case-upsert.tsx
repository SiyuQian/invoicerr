import { useTranslation } from "react-i18next"
import { z } from "zod"
import {
  useCreateReconciliationCase,
  useUpdateReconciliationCase,
} from "@/hooks/queries/use-project-reconciliation"
import type { CaseRecord } from "@/types/project-reconciliation"
import {
  amountInput,
  minorAmountSchema,
  nullableDate,
  nullableText,
  requiredText,
  MutationDialog,
  ReconciliationTextField,
  ReconciliationDateField,
  useReconciliationForm,
  useReconciliationCompany,
  type ReconciliationFormProps,
} from "./mutation-form"

export function CaseUpsert(
  props: ReconciliationFormProps & {
    currency: string
    partnerClientId: string | null
    caseRecord?: CaseRecord
  },
) {
  const activeCompany = useReconciliationCompany(props.companyId)
  if (
    !activeCompany ||
    !props.open ||
    (props.caseRecord &&
      (props.caseRecord.companyId !== props.companyId || props.caseRecord.projectId !== props.projectId))
  )
    return null
  return (
    <CaseForm key={`${props.companyId}:${props.projectId}:${props.caseRecord?.id ?? "new"}`} {...props} />
  )
}
function CaseForm(
  props: ReconciliationFormProps & {
    currency: string
    partnerClientId: string | null
    caseRecord?: CaseRecord
  },
) {
  const { t } = useTranslation()
  const row = props.caseRecord
  const create = useCreateReconciliationCase(props.companyId, props.projectId)
  const update = useUpdateReconciliationCase(props.companyId, props.projectId, row?.id ?? "")
  const schema = z
    .strictObject({
      title: requiredText(200),
      periodStart: nullableDate,
      periodEnd: nullableDate,
      agreedGrossMinor: minorAmountSchema(props.currency, true),
      agreedNetMinor: minorAmountSchema(props.currency, true),
      agreedVatMinor: minorAmountSchema(props.currency, true),
      agreementReference: nullableText(),
    })
    .refine((x) => !x.periodStart || !x.periodEnd || x.periodStart <= x.periodEnd, {
      path: ["periodEnd"],
      message: t("projectReconciliation.workflow.dateOrder"),
    })
  const state = useReconciliationForm(
    props,
    {
      title: row?.title ?? "",
      periodStart: row?.periodStart ?? null,
      periodEnd: row?.periodEnd ?? null,
      agreedGrossMinor: amountInput(row?.agreedGrossMinor, props.currency),
      agreedNetMinor: amountInput(row?.agreedNetMinor, props.currency),
      agreedVatMinor: amountInput(row?.agreedVatMinor, props.currency),
      agreementReference: row?.agreementReference ?? null,
    },
    schema,
    (input) => (row ? update.mutateAsync(input) : create.mutateAsync(input)),
  )
  return (
    <MutationDialog
      state={state}
      title={t(row ? "projectReconciliation.workflow.editCase" : "projectReconciliation.workflow.newCase")}
    >
      <ReconciliationTextField
        name="title"
        label={t("projectReconciliation.workflow.caseTitle")}
        required
        maxLength={200}
      />
      <ReconciliationDateField name="periodStart" label={t("projectReconciliation.workflow.periodStart")} />
      <ReconciliationDateField name="periodEnd" label={t("projectReconciliation.workflow.periodEnd")} />
      {props.partnerClientId && (
        <>
          {(
            [
              ["agreedGrossMinor", t("projectReconciliation.workflow.agreedGrossMinor")],
              ["agreedNetMinor", t("projectReconciliation.workflow.agreedNetMinor")],
              ["agreedVatMinor", t("projectReconciliation.workflow.agreedVatMinor")],
            ] as const
          ).map(([name, label]) => (
            <ReconciliationTextField key={name} name={name} label={`${label} (${props.currency})`} />
          ))}
          <ReconciliationTextField
            name="agreementReference"
            label={t("projectReconciliation.workflow.agreementReference")}
          />
        </>
      )}
    </MutationDialog>
  )
}
