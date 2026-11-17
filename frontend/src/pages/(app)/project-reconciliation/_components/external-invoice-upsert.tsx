import { useEffect, useState } from "react"
import { useWatch } from "react-hook-form"
import { ApiError } from "@/hooks/use-api-query"
import { useTranslation } from "react-i18next"
import { z } from "zod"
import {
  useCreateExternalInvoice,
  useUpdateExternalInvoice,
  useExternalCreditAdjustment,
} from "@/hooks/queries/use-project-reconciliation"
import type {
  CollectionMode,
  ExternalInvoiceRecord,
  ReconciliationCurrency,
} from "@/types/project-reconciliation"
import {
  amountInput,
  minorAmountSchema,
  nullableDate,
  nullableText,
  requiredText,
  MutationDialog,
  ReconciliationTextField,
  ReconciliationDateField,
  ReconciliationCheckField,
  useReconciliationForm,
  useReconciliationCompany,
  type ReconciliationFormProps,
} from "./mutation-form"

type InvoiceProps = ReconciliationFormProps & {
  currency: ReconciliationCurrency
  collectionMode: CollectionMode
  caseId: string
  invoice?: ExternalInvoiceRecord
}
export function ExternalInvoiceUpsert(props: InvoiceProps) {
  const activeCompany = useReconciliationCompany(props.companyId)
  if (
    !activeCompany ||
    !props.open ||
    props.collectionMode !== "PARTNER" ||
    (props.invoice &&
      (props.invoice.companyId !== props.companyId ||
        props.invoice.projectId !== props.projectId ||
        props.invoice.caseId !== props.caseId))
  )
    return null
  return (
    <InvoiceForm
      key={`${props.companyId}:${props.projectId}:${props.caseId}:${props.invoice?.id ?? "new"}`}
      {...props}
    />
  )
}
function InvoiceForm(props: InvoiceProps) {
  const { t } = useTranslation()
  const [duplicates, setDuplicates] = useState<
    Array<{
      id: string
      issuer: string
      invoiceNumber: string
      issueDate: string | null
      project: { name: string }
    }>
  >([])
  const [duplicateFingerprint, setDuplicateFingerprint] = useState("")
  const [duplicateIdentity, setDuplicateIdentity] = useState<string | null>(null)
  const creditDisposition = { help: t("projectReconciliation.workflow.creditDispositionHelp") }
  const invoice = props.invoice
  const row = invoice?.external
  const create = useCreateExternalInvoice(props.companyId, props.projectId, props.caseId)
  const update = useUpdateExternalInvoice(props.companyId, props.projectId, props.caseId, invoice?.id ?? "")
  const schema = z
    .strictObject({
      duplicateReason: nullableText(),
      duplicateReference: nullableText(),
      duplicateAttested: z.boolean(),
      creditReason: nullableText(),
      creditReference: nullableText(),
      creditAttested: z.boolean(),
      issuer: requiredText(200),
      recipient: requiredText(200),
      number: requiredText(100),
      issueDate: nullableDate,
      dueDate: nullableDate,
      grossMinor: minorAmountSchema(props.currency, false).pipe(z.number()),
      netMinor: minorAmountSchema(props.currency, true),
      vatMinor: minorAmountSchema(props.currency, true),
      reportedStatus: nullableText(200),
      sourceSystem: nullableText(200),
      sourceId: nullableText(200),
      sourceAsOf: nullableText().pipe(z.iso.datetime({ offset: true }).nullable()),
      sourceReference: requiredText(),
    })
    .refine((x) => !!x.sourceSystem === !!x.sourceId, {
      path: ["sourceId"],
      message: t("projectReconciliation.workflow.sourcePair"),
    })
    .refine((x) => !x.issueDate || !x.dueDate || x.issueDate <= x.dueDate, {
      path: ["dueDate"],
      message: t("projectReconciliation.workflow.dateOrder"),
    })
    .superRefine((input, ctx) => {
      if (
        duplicates.length &&
        (!input.duplicateReason || !input.duplicateReference || !input.duplicateAttested)
      )
        ctx.addIssue({
          code: "custom",
          path: ["duplicateReason"],
          message: t("projectReconciliation.workflow.reviewEvidenceRequired"),
        })
      if (
        (input.creditReason || input.creditReference || input.creditAttested) &&
        (!input.creditReason || !input.creditReference || !input.creditAttested)
      )
        ctx.addIssue({
          code: "custom",
          path: ["creditReason"],
          message: t("projectReconciliation.workflow.reviewEvidenceRequired"),
        })
    })
    .transform(
      ({
        duplicateReason,
        duplicateReference,
        duplicateAttested,
        creditReason,
        creditReference,
        creditAttested,
        ...input
      }) => ({
        ...input,
        currency: props.currency,
        ...(duplicates.length && duplicateAttested
          ? {
              duplicateReview: {
                invoiceIds: duplicates.map((d) => d.id),
                fingerprint: duplicateFingerprint,
                reason: duplicateReason!,
                evidenceReference: duplicateReference!,
                attested: true as const,
              },
            }
          : {}),
        ...(creditAttested
          ? {
              creditResolution: {
                reason: creditReason!,
                evidenceReference: creditReference!,
                attested: true as const,
              },
            }
          : {}),
      }),
    )
  const state = useReconciliationForm(
    props,
    {
      duplicateReason: null,
      duplicateReference: null,
      duplicateAttested: false,
      creditReason: null,
      creditReference: null,
      creditAttested: false,
      issuer: row?.issuer ?? "",
      recipient: row?.recipient ?? "",
      number: row?.number ?? "",
      issueDate: row?.issueDate ?? null,
      dueDate: row?.dueDate ?? null,
      grossMinor: amountInput(row?.grossMinor, props.currency),
      netMinor: amountInput(row?.netMinor, props.currency),
      vatMinor: amountInput(row?.vatMinor, props.currency),
      reportedStatus: row?.reportedStatus ?? null,
      sourceSystem: row?.sourceSystem ?? null,
      sourceId: row?.sourceId ?? null,
      sourceAsOf: row?.sourceAsOf ?? null,
      sourceReference: row?.sourceReference ?? "",
    },
    schema,
    async (input) => {
      try {
        return await (invoice ? update.mutateAsync(input) : create.mutateAsync(input))
      } catch (error) {
        if (error instanceof ApiError) {
          const body = error.body as {
            code?: string
            params?: { matches?: typeof duplicates; fingerprint?: string }
          }
          if (
            body?.code === "DUPLICATE_INVOICE_REVIEW_REQUIRED" &&
            body.params?.matches &&
            body.params.fingerprint
          ) {
            setDuplicates(body.params.matches)
            setDuplicateFingerprint(body.params.fingerprint)
            setDuplicateIdentity(
              JSON.stringify([input.issuer, input.number, input.issueDate?.slice(0, 4) ?? null]),
            )
          }
        }
        throw error
      }
    },
  )
  const [issuer, number, issueDate] = useWatch({
    control: state.form.control,
    name: ["issuer", "number", "issueDate"],
  })
  const identity = JSON.stringify([
    issuer?.trim() ?? "",
    number?.trim() ?? "",
    issueDate?.slice(0, 4) ?? null,
  ])
  useEffect(() => {
    if (duplicateIdentity === null || duplicateIdentity === identity) return
    setDuplicates([])
    setDuplicateFingerprint("")
    setDuplicateIdentity(null)
    state.form.setValue("duplicateReason", null)
    state.form.setValue("duplicateReference", null)
    state.form.setValue("duplicateAttested", false)
  }, [duplicateIdentity, identity, state.form])
  return (
    <MutationDialog
      state={state}
      title={t(
        invoice
          ? "projectReconciliation.workflow.editExternalInvoice"
          : "projectReconciliation.workflow.newExternalInvoice",
      )}
    >
      {duplicates.length > 0 && (
        <section className="space-y-4">
          <ul>
            {duplicates.map((d) => (
              <li key={d.id}>
                {d.issuer} · {d.invoiceNumber} ·{" "}
                {d.issueDate?.slice(0, 4) ?? t("projectReconciliation.workflow.unknownDate")} ·{" "}
                {d.project.name}
              </li>
            ))}
          </ul>
          <ReconciliationTextField
            name="duplicateReference"
            label={t("projectReconciliation.workflow.duplicateReference")}
            description={t("projectReconciliation.workflow.duplicateHelp")}
            required
          />
          <ReconciliationTextField
            name="duplicateReason"
            label={t("projectReconciliation.workflow.duplicateReason")}
            required
          />
          <ReconciliationCheckField
            name="duplicateAttested"
            label={t("projectReconciliation.workflow.duplicateAttested")}
          />
        </section>
      )}
      {!!invoice?.creditAdjustmentMinor && (
        <section className="space-y-4">
          <ReconciliationTextField
            name="creditReference"
            label={t("projectReconciliation.workflow.creditReference")}
            description={creditDisposition.help}
          />
          <ReconciliationTextField
            name="creditReason"
            label={t("projectReconciliation.workflow.creditReason")}
          />
          <ReconciliationCheckField
            name="creditAttested"
            label={t("projectReconciliation.workflow.creditAttested")}
          />
        </section>
      )}
      {(
        [
          ["issuer", t("projectReconciliation.workflow.issuer")],
          ["recipient", t("projectReconciliation.workflow.recipient")],
          ["number", t("projectReconciliation.workflow.number")],
        ] as const
      ).map(([name, label]) => (
        <ReconciliationTextField
          key={name}
          name={name}
          label={label}
          required
          maxLength={name === "number" ? 100 : 200}
        />
      ))}
      <ReconciliationDateField name="issueDate" label={t("projectReconciliation.workflow.issueDate")} />
      <ReconciliationDateField name="dueDate" label={t("projectReconciliation.workflow.dueDate")} />
      <ReconciliationTextField
        name="grossMinor"
        label={`${t("projectReconciliation.workflow.originalGross")} (${props.currency})`}
        required
        disabled={!!invoice?.creditAdjustmentMinor}
      />
      <ReconciliationTextField
        name="netMinor"
        label={`${t("projectReconciliation.workflow.net")} (${props.currency})`}
      />
      <ReconciliationTextField
        name="vatMinor"
        label={`${t("projectReconciliation.workflow.vat")} (${props.currency})`}
      />
      <ReconciliationTextField
        name="reportedStatus"
        label={t("projectReconciliation.workflow.reportedStatus")}
        description={t("projectReconciliation.workflow.statusHelp")}
        maxLength={200}
      />
      {(
        [
          ["sourceReference", t("projectReconciliation.workflow.sourceReference")],
          ["sourceSystem", t("projectReconciliation.workflow.sourceSystem")],
          ["sourceId", t("projectReconciliation.workflow.sourceId")],
          ["sourceAsOf", t("projectReconciliation.workflow.sourceAsOf")],
        ] as const
      ).map(([name, label]) => (
        <ReconciliationTextField
          key={name}
          name={name}
          label={label}
          required={name === "sourceReference"}
          maxLength={name === "sourceSystem" || name === "sourceId" ? 200 : 4000}
        />
      ))}
    </MutationDialog>
  )
}
export function CreditAdjustmentDialog(
  props: ReconciliationFormProps & { currency: ReconciliationCurrency; invoiceId: string },
) {
  const activeCompany = useReconciliationCompany(props.companyId)
  if (!activeCompany || !props.open) return null
  return <CreditForm key={`${props.companyId}:${props.projectId}:${props.invoiceId}`} {...props} />
}
function CreditForm(
  props: ReconciliationFormProps & { currency: ReconciliationCurrency; invoiceId: string },
) {
  const { t } = useTranslation()
  const mutation = useExternalCreditAdjustment(props.companyId, props.projectId, props.invoiceId)
  const schema = z.strictObject({
    amountMinor: minorAmountSchema(props.currency, false, true).pipe(z.number()),
    sourceReference: requiredText(),
    reason: requiredText(),
  })
  const state = useReconciliationForm(
    props,
    { amountMinor: "", sourceReference: "", reason: "" },
    schema,
    (input) => mutation.mutateAsync(input),
  )
  return (
    <MutationDialog state={state} title={t("projectReconciliation.workflow.creditTitle")}>
      <ReconciliationTextField
        name="amountMinor"
        label={`${t("projectReconciliation.workflow.creditAmount")} (${props.currency})`}
        required
      />
      <ReconciliationTextField
        name="sourceReference"
        label={t("projectReconciliation.workflow.sourceReference")}
        required
      />
      <ReconciliationTextField name="reason" label={t("projectReconciliation.workflow.reason")} required />
    </MutationDialog>
  )
}
