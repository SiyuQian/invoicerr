import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { useWatch } from "react-hook-form"
import { Link } from "react-router"
import { z } from "zod"
import SearchSelect from "@/components/search-input"
import { formatMinor } from "@/components/documents/totals-calculator"
import { Button } from "@/components/ui/button"
import { FieldLabel } from "@/components/ui/field-help"
import { FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form"
import { Textarea } from "@/components/ui/textarea"
import { ApiError } from "@/hooks/use-api-query"
import {
  usePreviewReconciliationImport,
  useConfirmReconciliationImport,
} from "@/hooks/queries/use-project-reconciliation"
import {
  reconciliationCurrencies,
  type ImportPreview,
  type ImportPreviewInput,
} from "@/types/project-reconciliation"
import {
  MutationDialog,
  ReconciliationTextField,
  ReconciliationChoiceField,
  useReconciliationCompany,
  useReconciliationForm,
  type ReconciliationFormProps,
} from "./mutation-form"

const text = (max: number) => z.string().trim().min(1).max(max)
const integer = z.number().int().safe()
const percent = z.number().min(0).max(100)
const date = z.iso.date().nullable()
const card = z.strictObject({
  label: z.string().max(200),
  issuer: z.string().max(200),
  recipient: z.string().max(200),
  number: z.string().max(100).nullable(),
  pending: z.boolean(),
  amountCents: integer,
  totalCents: integer,
})
const sourceSnapshot = z.strictObject({
  customerCard: card.optional(),
  shareCard: card.optional(),
  lineItems: z
    .array(
      z.strictObject({
        category: text(200),
        description: text(4000),
        amountCents: integer,
        earnsReferralFee: z.boolean(),
        revenueType: text(200),
        treatment: text(200),
      }),
    )
    .max(1000)
    .optional(),
  calculation: z
    .strictObject({
      sourceSubtotalCents: integer,
      eligibleSubtotalCents: integer,
      internalSubtotalCents: integer,
      thirdPartyCostsCents: integer,
      passThroughExpensesCents: integer,
      sharePercent: percent,
      gstAmountCents: integer,
      totalCents: integer,
    })
    .optional(),
})
const payloadSchema = z.strictObject({
  sourceSystem: z.literal("ledgerly"),
  sourceAsOf: z.iso.datetime({ offset: true }),
  currency: z.enum(reconciliationCurrencies),
  project: z.strictObject({
    id: text(200),
    name: text(200),
    customerIssuer: text(200),
    customerRecipient: text(200),
    shareIssuer: text(200),
    shareRecipient: text(200),
  }),
  invoices: z
    .array(
      z.strictObject({
        id: text(200),
        projectId: z.string().max(200).nullable().optional(),
        number: text(100),
        projectName: z.string().max(200),
        issuer: text(200),
        recipient: text(200),
        kind: z.enum(["Customer invoice", "Internal share"]),
        status: z.enum(["Needs review", "Paid", "Sent"]),
        issueDate: date,
        dueDate: date,
        paidDate: date,
        exGstAmountCents: integer.nonnegative(),
        gstAmountCents: integer.nonnegative(),
        totalCents: integer.nonnegative(),
        sharePercent: percent.nullable(),
        sourceNumber: text(100).nullable(),
        linkedInvoiceNumber: text(100).nullable(),
        sourceSnapshot: sourceSnapshot.optional(),
      }),
    )
    .max(1000),
})
const matchSchema = z.strictObject({
  sourceId: text(200),
  documentId: text(200),
  typeId: z.enum(["invoice", "expense", "received-invoice"]),
  caseSourceId: text(200),
})
export function ImportDialog(props: ReconciliationFormProps) {
  const active = useReconciliationCompany(props.companyId)
  if (!active || !props.open) return null
  return <ImportForm key={`${props.companyId}:${props.projectId}`} {...props} />
}
function ImportForm(props: ReconciliationFormProps) {
  const { t } = useTranslation()
  const previewMutation = usePreviewReconciliationImport(props.companyId, props.projectId)
  const confirm = useConfirmReconciliationImport(props.companyId, props.projectId)
  const [snapshot, setSnapshot] = useState<{
    input: ImportPreviewInput
    signature: string
    preview: ImportPreview
  } | null>(null)
  const [invalidated, setInvalidated] = useState(false)
  const [previewError, setPreviewError] = useState<unknown>(null)
  const previewRef = useRef<ImportPreview | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])
  const base = z
    .strictObject({
      payloadText: z.string().min(1),
      currency: z.enum(reconciliationCurrencies),
      sourceAsOf: z.iso.datetime({ offset: true }),
      selectedMatches: z.array(matchSchema).max(1000),
    })
    .transform((fields, ctx) => {
      let parsed: unknown
      try {
        if (new TextEncoder().encode(fields.payloadText).byteLength > 2 * 1024 * 1024) throw new Error("size")
        parsed = JSON.parse(fields.payloadText)
      } catch {
        ctx.addIssue({
          code: "custom",
          path: ["payloadText"],
          message: t("projectReconciliation.import.invalidJson"),
        })
        return z.NEVER
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        ctx.addIssue({
          code: "custom",
          path: ["payloadText"],
          message: t("projectReconciliation.import.invalidJson"),
        })
        return z.NEVER
      }
      const payload = payloadSchema.safeParse({
        ...parsed,
        currency: fields.currency,
        sourceAsOf: fields.sourceAsOf,
      })
      if (!payload.success) {
        ctx.addIssue({
          code: "custom",
          path: ["payloadText"],
          message: t("projectReconciliation.import.invalidPayload"),
        })
        return z.NEVER
      }
      return { payload: payload.data, selectedMatches: fields.selectedMatches }
    })
  const schema = base.transform((input) => ({ ...input, previewHash: previewRef.current?.previewHash ?? "" }))
  const onReload = async () => {
    const version = await props.onReload()
    if (alive.current) setInvalidated(true)
    return version
  }
  const state = useReconciliationForm(
    { ...props, onReload },
    {
      payloadText: "",
      currency: null,
      sourceAsOf: "",
      selectedMatches: [] as ImportPreviewInput["selectedMatches"],
    },
    schema,
    (input) => confirm.mutateAsync(input),
    async (token) => {
      if ((await props.onReload()) !== token) throw new ApiError(409, "IMPORT_PREVIEW_STALE")
    },
  )
  const values = useWatch({ control: state.form.control })
  const parsed = base.safeParse(values)
  const signature = parsed.success ? JSON.stringify(parsed.data) : null
  const valid =
    !!snapshot &&
    signature === snapshot.signature &&
    props.versionToken === snapshot.preview.projectVersion &&
    !invalidated
  const blocked =
    !!snapshot &&
    (snapshot.preview.errors.length > 0 || snapshot.preview.unresolved.some((issue) => issue.blocking))
  const preview = async () => {
    const result = base.safeParse(state.form.getValues())
    state.form.clearErrors()
    setPreviewError(null)
    if (!result.success) {
      for (const issue of result.error.issues)
        state.form.setError(issue.path.join(".") as "payloadText", { message: issue.message })
      return
    }
    const requested = JSON.stringify(result.data)
    try {
      const response = await previewMutation.mutateAsync(result.data)
      if (!alive.current) return
      const latest = base.safeParse(state.form.getValues())
      if (!latest.success || JSON.stringify(latest.data) !== requested) return
      previewRef.current = response
      setSnapshot({ input: result.data, signature: requested, preview: response })
      setInvalidated(false)
    } catch (error) {
      if (alive.current) {
        setPreviewError(error)
        setInvalidated(true)
      }
    }
  }
  return (
    <MutationDialog
      state={state}
      title={t("projectReconciliation.import.title")}
      actionLabel={t("projectReconciliation.import.confirm")}
      disabled={previewMutation.isPending || blocked || (!valid && !state.retrying)}
    >
      <FormField
        control={state.form.control}
        name="payloadText"
        render={({ field }) => (
          <FormItem>
            <FormLabel required description={t("projectReconciliation.import.help")}>
              {t("projectReconciliation.import.payload")}
            </FormLabel>
            <FormControl>
              <Textarea {...field} rows={8} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
      <ReconciliationChoiceField
        name="currency"
        label={t("projectReconciliation.import.currency")}
        options={reconciliationCurrencies.map((value) => ({ value, label: value }))}
      />
      <ReconciliationTextField
        name="sourceAsOf"
        label={t("projectReconciliation.workflow.sourceAsOf")}
        description={t("projectReconciliation.workflow.asOfHelp")}
        required
      />
      <Button
        type="button"
        variant="outline"
        onClick={() => void preview()}
        disabled={previewMutation.isPending || state.pending || !state.canWrite}
      >
        {t("projectReconciliation.import.preview")}
      </Button>
      {!!previewError && (
        <p role="alert">
          {previewError instanceof Error
            ? previewError.message
            : t("projectReconciliation.import.previewError")}
        </p>
      )}
      {snapshot && (
        <section className="space-y-4">
          <h2 className="text-xl">{t("projectReconciliation.import.proposals")}</h2>
          {!valid && (
            <p className="text-sm text-muted-foreground">
              {t("projectReconciliation.import.previewRequired")}
            </p>
          )}
          <p className="text-sm">
            {snapshot.preview.sourceAsOf} · {t("projectReconciliation.import.sourcePaidHelp")}
          </p>
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            {Object.entries(snapshot.preview.counts).map(([key, value]) => (
              <p key={key}>
                {t(`projectReconciliation.import.counts.${key}`)}: {value}
              </p>
            ))}
          </div>
          {[...snapshot.preview.errors, ...snapshot.preview.unresolved].map((issue) => (
            <p
              key={JSON.stringify(issue)}
              className={issue.blocking ? "text-sm text-destructive" : "text-sm text-muted-foreground"}
            >
              {issue.message} · {issue.sourceIds.join(", ")}
            </p>
          ))}
          {snapshot.preview.proposedCases.map((item) => (
            <article key={item.caseSourceId} className="space-y-2 rounded-md border p-3">
              <h3 className="font-semibold">
                {item.proposed.title} · {item.action}
              </h3>
              <p>
                {t("projectReconciliation.detail.overallAgreement")}:{" "}
                {item.proposed.agreedGrossMinor === null
                  ? t("projectReconciliation.unknown")
                  : formatMinor(item.proposed.agreedGrossMinor, snapshot.input.payload.currency)}
              </p>
              <details>
                <summary>{t("projectReconciliation.import.changedValues")}</summary>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
                  {JSON.stringify({ existing: item.existing, proposed: item.proposed }, null, 2)}
                </pre>
              </details>
            </article>
          ))}
          {snapshot.preview.proposedReferences.map((item) => (
            <article key={item.sourceId} className="space-y-2 rounded-md border p-3">
              <h3 className="font-semibold">
                {item.proposed.number} · {item.action}
              </h3>
              <p>
                {formatMinor(item.proposed.grossMinor, item.proposed.currency)} ·{" "}
                {item.proposed.reportedStatus} ·{" "}
                {item.proposed.issueDate ?? t("projectReconciliation.workflow.unknownDate")}
              </p>
              <details>
                <summary>{t("projectReconciliation.import.changedValues")}</summary>
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">
                  {JSON.stringify({ existing: item.existing, proposed: item.proposed }, null, 2)}
                </pre>
              </details>
            </article>
          ))}
          {snapshot.preview.proposedLinks.map((link) => {
            const selected = state.form.watch("selectedMatches").find((x) => x.sourceId === link.sourceId)
            const selectedId = selected?.documentId ?? link.selectedMatch?.documentId ?? ""
            return (
              <article key={link.sourceId} className="space-y-3 rounded-md border p-3">
                <h3 className="font-semibold">
                  {t(`projectReconciliation.workflow.roles.${link.role}`)} · {link.action}
                </h3>
                <section
                  aria-label={t("projectReconciliation.import.historical")}
                  className="space-y-2 rounded-md border p-3 text-sm"
                >
                  <h4 className="font-semibold">{t("projectReconciliation.import.historical")}</h4>
                  <p>
                    {link.historical.number} · {link.historical.issuer} → {link.historical.recipient}
                  </p>
                  <p>
                    {t("projectReconciliation.workflow.originalGross")}:{" "}
                    {formatMinor(link.historical.grossMinor, link.historical.currency)} ·{" "}
                    {t("projectReconciliation.workflow.net")}:{" "}
                    {link.historical.netMinor === null
                      ? t("projectReconciliation.unknown")
                      : formatMinor(link.historical.netMinor, link.historical.currency)}{" "}
                    · {t("projectReconciliation.workflow.vat")}:{" "}
                    {link.historical.vatMinor === null
                      ? t("projectReconciliation.unknown")
                      : formatMinor(link.historical.vatMinor, link.historical.currency)}
                  </p>
                  <p>
                    {t("projectReconciliation.workflow.reportedStatus")}:{" "}
                    {link.historical.reportedStatus ?? t("projectReconciliation.unknown")}
                  </p>
                  <p>
                    {t("projectReconciliation.workflow.issueDate")}:{" "}
                    {link.historical.issueDate ?? t("projectReconciliation.workflow.unknownDate")} ·{" "}
                    {t("projectReconciliation.workflow.dueDate")}:{" "}
                    {link.historical.dueDate ?? t("projectReconciliation.workflow.unknownDate")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {link.historical.sourceReference} · {link.historical.sourceSystem} ·{" "}
                    {link.historical.sourceId} · {link.historical.sourceAsOf}
                  </p>
                </section>
                <FieldLabel htmlFor={`match-${link.sourceId}`}>
                  {t("projectReconciliation.import.matchFor", { source: link.sourceId })}
                </FieldLabel>
                <SearchSelect
                  id={`match-${link.sourceId}`}
                  value={selectedId}
                  options={[
                    { value: "", label: t("projectReconciliation.optionalSelect") },
                    ...link.candidates.map((candidate) => ({
                      value: candidate.documentId,
                      label: candidate.financial.displayNumber ?? candidate.documentId,
                    })),
                  ]}
                  onValueChange={(value) => {
                    if (String(value) === selectedId) return
                    const candidate = link.candidates.find((x) => x.documentId === String(value))
                    const matches = state.form
                      .getValues("selectedMatches")
                      .filter((x) => x.sourceId !== link.sourceId)
                    state.form.setValue(
                      "selectedMatches",
                      candidate
                        ? [
                            ...matches,
                            {
                              sourceId: link.sourceId,
                              caseSourceId: link.caseSourceId,
                              documentId: candidate.documentId,
                              typeId: candidate.typeId,
                            },
                          ]
                        : matches,
                      { shouldDirty: true },
                    )
                    setInvalidated(true)
                  }}
                />
                {link.candidates.map((candidate) => (
                  <section
                    key={candidate.documentId}
                    aria-label={t("projectReconciliation.import.canonical")}
                    className="space-y-1 rounded-md border p-3 text-sm"
                  >
                    <h4 className="font-semibold">{t("projectReconciliation.import.canonical")}</h4>
                    <Link
                      className="underline"
                      to={`/documents/${encodeURIComponent(candidate.typeId)}/${encodeURIComponent(candidate.documentId)}`}
                    >
                      {candidate.financial.displayNumber ?? candidate.documentId}
                    </Link>
                    <p>
                      {candidate.financial.status} · {t("projectReconciliation.detail.canonicalGross")}:{" "}
                      {candidate.financial.grossMinor === null || !candidate.financial.currency
                        ? t("projectReconciliation.unknown")
                        : formatMinor(candidate.financial.grossMinor, candidate.financial.currency)}
                    </p>
                    {candidate.financial.settlement && candidate.financial.currency && (
                      <p>
                        {t("projectReconciliation.detail.canonicalPaid")}:{" "}
                        {formatMinor(candidate.financial.settlement.paidMinor, candidate.financial.currency)}{" "}
                        · {t("projectReconciliation.detail.credits")}:{" "}
                        {formatMinor(
                          candidate.financial.settlement.creditedMinor,
                          candidate.financial.currency,
                        )}{" "}
                        · {t("projectReconciliation.detail.overallOutstanding")}:{" "}
                        {formatMinor(
                          candidate.financial.settlement.outstandingMinor,
                          candidate.financial.currency,
                        )}
                      </p>
                    )}
                  </section>
                ))}
              </article>
            )
          })}
        </section>
      )}
    </MutationDialog>
  )
}
