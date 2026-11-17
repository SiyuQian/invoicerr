import { useEffect, useRef } from "react"
import { useTranslation } from "react-i18next"
import { z } from "zod"
import {
  useCreateExternalReceipt,
  useUpdateExternalReceipt,
  useVoidExternalReceipt,
} from "@/hooks/queries/use-project-reconciliation"
import type { CollectionMode, ReceiptRecord, ReconciliationCurrency } from "@/types/project-reconciliation"
import {
  amountInput,
  minorAmountSchema,
  nullableDate,
  nullableText,
  requiredText,
  MutationDialog,
  ReconciliationTextField,
  ReconciliationDateField,
  ReconciliationChoiceField,
  ReconciliationCheckField,
  useReconciliationForm,
  useReconciliationCompany,
  type ReconciliationFormProps,
} from "./mutation-form"

type ReceiptProps = ReconciliationFormProps & {
  currency: ReconciliationCurrency
  collectionMode: CollectionMode
  receipt?: ReceiptRecord
}
export function ReceiptUpsert(props: ReceiptProps) {
  const activeCompany = useReconciliationCompany(props.companyId)
  if (
    !activeCompany ||
    !props.open ||
    props.collectionMode !== "PARTNER" ||
    (props.receipt &&
      (props.receipt.companyId !== props.companyId || props.receipt.projectId !== props.projectId))
  )
    return null
  return (
    <ReceiptForm key={`${props.companyId}:${props.projectId}:${props.receipt?.id ?? "new"}`} {...props} />
  )
}
function ReceiptForm(props: ReceiptProps) {
  const { t } = useTranslation()
  const receipt = props.receipt
  const create = useCreateExternalReceipt(props.companyId, props.projectId)
  const update = useUpdateExternalReceipt(props.companyId, props.projectId, receipt?.id ?? "")
  const schema = z
    .strictObject({
      amountMinor: minorAmountSchema(props.currency, false, true),
      paidOn: nullableDate,
      evidenceClass: z.enum(["PARTNER_REPORTED", "EVIDENCE_CHECKED"]),
      evidenceReference: nullableText(),
      evidenceUrl: nullableText(2048).refine(
        (value) => value === null || (/^https:\/\//i.test(value) && URL.canParse(value)),
        t("projectReconciliation.workflow.httpsOnly"),
      ),
      reason: requiredText(),
      attested: z.boolean(),
    })
    .superRefine((x, ctx) => {
      if (x.evidenceClass === "EVIDENCE_CHECKED") {
        if (!x.attested)
          ctx.addIssue({
            code: "custom",
            path: ["attested"],
            message: t("projectReconciliation.workflow.attestationRequired"),
          })
        if (!x.evidenceReference)
          ctx.addIssue({
            code: "custom",
            path: ["evidenceReference"],
            message: t("projectReconciliation.required"),
          })
      }
    })
    .transform(({ attested, ...input }) => ({
      ...input,
      amountMinor: input.amountMinor!,
      currency: props.currency,
      ...(input.evidenceClass === "EVIDENCE_CHECKED" && attested ? { attested: true as const } : {}),
    }))
  const state = useReconciliationForm(
    props,
    {
      amountMinor: amountInput(receipt?.amountMinor, props.currency),
      paidOn: receipt?.paidOn ?? null,
      evidenceClass: receipt?.evidenceClass ?? "PARTNER_REPORTED",
      evidenceReference: receipt?.evidenceReference ?? null,
      evidenceUrl: receipt?.evidenceUrl ?? null,
      reason: receipt?.reason ?? "",
      attested: false,
    },
    schema,
    (input) => (receipt ? update.mutateAsync(input) : create.mutateAsync(input)),
  )
  const { attested: _attested, ...facts } = state.form.watch()
  const checkedFacts = schema.safeParse({ ...facts, attested: true })
  const factSignature = JSON.stringify(checkedFacts.success ? checkedFacts.data : facts)
  const previousFacts = useRef(factSignature)
  useEffect(() => {
    if (previousFacts.current !== factSignature) {
      previousFacts.current = factSignature
      state.form.setValue("attested", false)
    }
  }, [factSignature, state.form])
  const checked = state.form.watch("evidenceClass") === "EVIDENCE_CHECKED"
  return (
    <MutationDialog
      state={state}
      title={t(
        receipt ? "projectReconciliation.workflow.editReceipt" : "projectReconciliation.workflow.newReceipt",
      )}
      readOnly={!!receipt?.voidedAt}
    >
      {receipt?.voidedAt && <p>{t("projectReconciliation.workflow.voidedReceipt")}</p>}
      <ReconciliationTextField
        name="amountMinor"
        label={`${t("projectReconciliation.workflow.receiptAmount")} (${props.currency})`}
        required
      />
      <ReconciliationDateField name="paidOn" label={t("projectReconciliation.workflow.paidOn")} />
      <ReconciliationChoiceField
        name="evidenceClass"
        label={t("projectReconciliation.workflow.evidenceClass")}
        options={[
          { value: "PARTNER_REPORTED", label: t("projectReconciliation.workflow.reported") },
          { value: "EVIDENCE_CHECKED", label: t("projectReconciliation.workflow.checked") },
        ]}
      />
      <ReconciliationTextField
        name="evidenceReference"
        label={t("projectReconciliation.workflow.evidenceReference")}
        required={checked}
      />
      <ReconciliationTextField
        name="evidenceUrl"
        label={t("projectReconciliation.workflow.evidenceUrl")}
        maxLength={2048}
      />
      <ReconciliationTextField name="reason" label={t("projectReconciliation.workflow.reason")} required />
      {checked && (
        <ReconciliationCheckField
          name="attested"
          label={t("projectReconciliation.workflow.receiptAttestation")}
        />
      )}
    </MutationDialog>
  )
}
export function ReceiptVoidDialog(props: ReconciliationFormProps & { receiptId: string }) {
  const activeCompany = useReconciliationCompany(props.companyId)
  if (!activeCompany || !props.open) return null
  return <VoidForm key={`${props.companyId}:${props.projectId}:${props.receiptId}`} {...props} />
}
function VoidForm(props: ReconciliationFormProps & { receiptId: string }) {
  const { t } = useTranslation()
  const mutation = useVoidExternalReceipt(props.companyId, props.projectId, props.receiptId)
  const state = useReconciliationForm(
    props,
    { reason: "" },
    z.strictObject({ reason: requiredText() }),
    (input) => mutation.mutateAsync(input),
  )
  return (
    <MutationDialog state={state} title={t("projectReconciliation.workflow.voidReceipt")}>
      <ReconciliationTextField name="reason" label={t("projectReconciliation.workflow.reason")} required />
    </MutationDialog>
  )
}
