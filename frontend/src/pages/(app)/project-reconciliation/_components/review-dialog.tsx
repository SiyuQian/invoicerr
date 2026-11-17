import { useTranslation } from "react-i18next"
import { z } from "zod"
import { Badge } from "@/components/ui/badge"
import { ApiError } from "@/hooks/use-api-query"
import {
  useAttestReconciliationCoverage,
  useReviewReconciliationCase,
} from "@/hooks/queries/use-project-reconciliation"
import type { CaseView, ReviewCaseInput } from "@/types/project-reconciliation"
import {
  requiredText,
  MutationDialog,
  ReconciliationTextField,
  ReconciliationChoiceField,
  ReconciliationCheckField,
  useReconciliationForm,
  useReconciliationCompany,
  type ReconciliationFormProps,
} from "./mutation-form"

const overridable = new Set([
  "AGREEMENT_MISSING",
  "AGREEMENT_REFERENCE_MISSING",
  "EVIDENCE_COVERAGE_MISSING",
  "RECEIPT_EVIDENCE_MISSING",
  "RECEIPT_DATE_MISSING",
  "INVOICE_DATE_MISSING",
  "CUSTOMER_COLLECTION_UNCONFIRMED",
  "UNALLOCATED_DOCUMENT",
  "BALANCE_UNAVAILABLE",
])
// The page callback must throw on an actual financial read failure; typed unsupported balances may be excepted.
async function prepareReview(props: ReconciliationFormProps, token: string) {
  if ((await props.onReload()) !== token) throw new ApiError(409, "RECONCILIATION_CHANGED")
}
export function ReviewDialog(
  props: ReconciliationFormProps & { caseRecord: CaseView; closureBlocked?: boolean },
) {
  const activeCompany = useReconciliationCompany(props.companyId)
  if (
    !activeCompany ||
    !props.open ||
    props.caseRecord.companyId !== props.companyId ||
    props.caseRecord.projectId !== props.projectId
  )
    return null
  return <ReviewForm key={`${props.companyId}:${props.projectId}:${props.caseRecord.id}`} {...props} />
}
function ReviewForm(props: ReconciliationFormProps & { caseRecord: CaseView; closureBlocked?: boolean }) {
  const { t } = useTranslation()
  const row = props.caseRecord
  const mutation = useReviewReconciliationCase(props.companyId, props.projectId, row.id)
  const material = row.exceptions.filter((x) => x.code !== "SOURCE_CHANGED")
  const positive =
    !!props.closureBlocked ||
    row.summary.ownOutstanding.knownMinor > 0 ||
    row.summary.partnerOutstanding.knownMinor > 0
  const allowed: ReviewCaseInput["mode"][] = [
    ...(!positive && material.length === 0 ? ["VERIFY" as const] : []),
    ...(!positive && material.length > 0 && material.every((x) => overridable.has(x.code))
      ? ["ACCEPT_EXCEPTIONS" as const]
      : []),
    "REOPEN",
  ]
  const keyOf = (x: (typeof material)[number]) => `${x.code}:${x.fingerprint}`
  const schema = z
    .strictObject({
      mode: z.enum(["VERIFY", "ACCEPT_EXCEPTIONS", "REOPEN"]),
      reason: requiredText(),
      reasons: z.record(z.string(), z.string()),
    })
    .superRefine((x, ctx) => {
      if (!allowed.includes(x.mode))
        ctx.addIssue({
          code: "custom",
          path: ["mode"],
          message: t("projectReconciliation.workflow.reviewBlocked"),
        })
      if (x.mode === "ACCEPT_EXCEPTIONS")
        for (const item of material)
          if (!x.reasons[keyOf(item)]?.trim())
            ctx.addIssue({
              code: "custom",
              path: ["reasons", keyOf(item)],
              message: t("projectReconciliation.required"),
            })
    })
    .transform((x) => ({
      mode: x.mode,
      reason: x.reason,
      exceptions:
        x.mode === "ACCEPT_EXCEPTIONS"
          ? material.map((item) => ({
              code: item.code,
              fingerprint: item.fingerprint,
              reason: x.reasons[keyOf(item)].trim(),
            }))
          : [],
    }))
  const state = useReconciliationForm(
    props,
    {
      mode: allowed[0] === "REOPEN" ? null : allowed[0],
      reason: "",
      reasons: Object.fromEntries(material.map((x) => [keyOf(x), ""])),
    },
    schema,
    (input) => mutation.mutateAsync(input),
    (token) => prepareReview(props, token),
  )
  const mode = state.form.watch("mode")
  const currentReview = !state.unavailable && !state.error && !state.pending && !state.reloading
  return (
    <MutationDialog
      state={state}
      title={t("projectReconciliation.workflow.reviewTitle")}
      disabled={mode === null || !allowed.includes(mode)}
    >
      <Badge
        variant={currentReview && row.effectiveReviewState === "CLOSED_VERIFIED" ? "success" : "warning"}
      >
        {t(`projectReconciliation.review.${currentReview ? row.effectiveReviewState : "OPEN"}`)}
      </Badge>
      {positive && <p>{t("projectReconciliation.workflow.reviewBlocked")}</p>}
      <ReconciliationChoiceField
        name="mode"
        label={t("projectReconciliation.workflow.reviewAction")}
        options={allowed.map((value) => ({
          value,
          label: t(`projectReconciliation.workflow.reviewModes.${value}`),
        }))}
      />
      {row.exceptions.map((item) => (
        <div key={keyOf(item)} className="space-y-2">
          <p className="text-sm">{item.message}</p>
          {mode === "ACCEPT_EXCEPTIONS" && item.code !== "SOURCE_CHANGED" && (
            <ReconciliationTextField
              name={`reasons.${keyOf(item)}`}
              label={t("projectReconciliation.workflow.exceptionReason", { code: item.code })}
              required
            />
          )}
        </div>
      ))}
      {mode === "ACCEPT_EXCEPTIONS" && (
        <p className="text-sm text-muted-foreground">{t("projectReconciliation.workflow.exceptionsAmber")}</p>
      )}
      <ReconciliationTextField name="reason" label={t("projectReconciliation.workflow.reason")} required />
    </MutationDialog>
  )
}
export function EvidenceCoverageDialog(
  props: ReconciliationFormProps & { customerInvoices: { id: string; number: string }[] },
) {
  const activeCompany = useReconciliationCompany(props.companyId)
  if (!activeCompany || !props.open) return null
  return <CoverageForm key={`${props.companyId}:${props.projectId}`} {...props} />
}
function CoverageForm(
  props: ReconciliationFormProps & { customerInvoices: { id: string; number: string }[] },
) {
  const { t } = useTranslation()
  const mutation = useAttestReconciliationCoverage(props.companyId, props.projectId)
  const schema = z
    .strictObject({
      selected: z.record(z.string(), z.boolean()),
      sourceAsOf: z.iso.datetime({ offset: true }),
      evidenceReference: requiredText(),
      attested: z.literal(true, { error: t("projectReconciliation.workflow.coverageAttestationRequired") }),
    })
    .transform((x) => ({
      customerInvoiceIds: props.customerInvoices.filter((row) => x.selected[row.id]).map((row) => row.id),
      sourceAsOf: x.sourceAsOf,
      evidenceReference: x.evidenceReference,
      attested: x.attested,
    }))
    .refine((x) => x.customerInvoiceIds.length > 0 && x.customerInvoiceIds.length <= 1000, {
      path: ["selected"],
      message: t("projectReconciliation.workflow.selectInvoices"),
    })
  const state = useReconciliationForm(
    props,
    {
      selected: Object.fromEntries(props.customerInvoices.map((x) => [x.id, false])),
      sourceAsOf: "",
      evidenceReference: "",
      attested: false,
    },
    schema,
    (input) => mutation.mutateAsync(input),
    (token) => prepareReview(props, token),
  )
  return (
    <MutationDialog state={state} title={t("projectReconciliation.workflow.coverageTitle")}>
      <p className="text-sm text-muted-foreground">{t("projectReconciliation.workflow.coverageHelp")}</p>
      {props.customerInvoices.map((row) => (
        <ReconciliationCheckField key={row.id} name={`selected.${row.id}`} label={row.number} />
      ))}
      {state.form.formState.errors.selected && (
        <p role="alert">{t("projectReconciliation.workflow.selectInvoices")}</p>
      )}
      <ReconciliationTextField
        name="sourceAsOf"
        label={t("projectReconciliation.workflow.sourceAsOf")}
        description={t("projectReconciliation.workflow.asOfHelp")}
        required
      />
      <ReconciliationTextField
        name="evidenceReference"
        label={t("projectReconciliation.workflow.evidenceReference")}
        required
      />
      <ReconciliationCheckField
        name="attested"
        label={t("projectReconciliation.workflow.coverageAttestation")}
      />
    </MutationDialog>
  )
}
