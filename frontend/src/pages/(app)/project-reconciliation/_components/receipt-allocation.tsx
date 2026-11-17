import { useState } from "react"
import { useFieldArray } from "react-hook-form"
import { useTranslation } from "react-i18next"
import { z } from "zod"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { FieldLabel } from "@/components/ui/field-help"
import { formatMinor } from "@/components/documents/totals-calculator"
import {
  useReconciliationInvoiceChoices,
  useReplaceReceiptAllocations,
} from "@/hooks/queries/use-project-reconciliation"
import type { AllocationView, ReceiptView } from "@/types/project-reconciliation"
import { CursorControls } from "./read-parts"
import {
  MutationDialog,
  ReconciliationTextField,
  amountInput,
  minorAmountSchema,
  useReconciliationCompany,
  useReconciliationForm,
  type ReconciliationFormProps,
} from "./mutation-form"
export function ReceiptAllocationDialog(props: ReconciliationFormProps & { receipt: ReceiptView }) {
  const active = useReconciliationCompany(props.companyId)
  if (
    !active ||
    !props.open ||
    props.receipt.companyId !== props.companyId ||
    props.receipt.projectId !== props.projectId
  )
    return null
  return <AllocationForm key={`${props.companyId}:${props.projectId}:${props.receipt.id}`} {...props} />
}
function AllocationForm(props: ReconciliationFormProps & { receipt: ReceiptView }) {
  const { t } = useTranslation()
  const receipt = props.receipt
  const currency = receipt.currency
  const [search, setSearch] = useState("")
  const [cursors, setCursors] = useState<(string | undefined)[]>([undefined])
  const choices = useReconciliationInvoiceChoices(props.projectId, {
    ...(search ? { search } : {}),
    ...(cursors.at(-1) ? { cursor: cursors.at(-1) } : {}),
  })
  const [selected, setSelected] = useState<Record<string, AllocationView["customerInvoice"]>>({})
  const contexts = new Map<string, AllocationView["customerInvoice"]>([
    ...Object.entries(selected),
    ...receipt.allocations.map((x) => [x.customerInvoiceId, x.customerInvoice] as const),
    ...(choices.data?.items ?? []).map(
      (x) => [x.id, { ...x, number: x.external.number, currency: x.external.currency }] as const,
    ),
  ])
  const mutation = useReplaceReceiptAllocations(props.companyId, props.projectId, receipt.id)
  const schema = z
    .strictObject({
      allocations: z
        .array(
          z.strictObject({
            customerInvoiceId: z.string().min(1),
            amountMinor: minorAmountSchema(currency, false, true).pipe(z.number()),
          }),
        )
        .max(1000),
    })
    .superRefine((x, ctx) => {
      if (
        new Set(x.allocations.map((a) => a.customerInvoiceId)).size !== x.allocations.length ||
        x.allocations.reduce((sum, a) => sum + a.amountMinor, 0) > receipt.amountMinor
      )
        ctx.addIssue({
          code: "custom",
          path: ["allocations"],
          message: t("projectReconciliation.detail.allocationExceeds"),
        })
      for (const [index, item] of x.allocations.entries()) {
        const invoice = contexts.get(item.customerInvoiceId)
        const old =
          receipt.allocations.find((a) => a.customerInvoiceId === item.customerInvoiceId)?.amountMinor ?? 0
        if (!invoice || item.amountMinor > invoice.availableMinor + old)
          ctx.addIssue({
            code: "custom",
            path: ["allocations", index, "amountMinor"],
            message: t("projectReconciliation.detail.allocationExceeds"),
          })
      }
    })
  const state = useReconciliationForm(
    props,
    {
      allocations: receipt.allocations.map((x) => ({
        customerInvoiceId: x.customerInvoiceId,
        amountMinor: amountInput(x.amountMinor, currency),
      })),
    },
    schema,
    (input) => mutation.mutateAsync(input),
  )
  const lines = useFieldArray({ control: state.form.control, name: "allocations" })
  const amounts = state.form.watch("allocations")
  const parsed = schema.safeParse({ allocations: amounts })
  const proposed = parsed.success ? parsed.data.allocations.reduce((sum, a) => sum + a.amountMinor, 0) : null
  return (
    <MutationDialog
      state={state}
      title={t("projectReconciliation.detail.allocate")}
      readOnly={!!receipt.voidedAt}
    >
      <p>
        {t("projectReconciliation.detail.receiptAvailable")}: {formatMinor(receipt.amountMinor, currency)}
      </p>
      <div className="space-y-1 text-sm text-muted-foreground">
        <p>{t("projectReconciliation.detail.currentAllocationSet")}</p>
        {receipt.allocations.map((item) => (
          <p key={item.id}>
            {item.customerInvoice.number} · {formatMinor(item.amountMinor, currency)}
          </p>
        ))}
      </div>
      <p>
        {t("projectReconciliation.detail.advance")}:{" "}
        {proposed === null ? "—" : formatMinor(receipt.amountMinor - proposed, currency)}
      </p>
      {lines.fields.map((line, index) => {
        const invoice = contexts.get(line.customerInvoiceId)
        const old =
          receipt.allocations.find((x) => x.customerInvoiceId === line.customerInvoiceId)?.amountMinor ?? 0
        return (
          <div key={line.id} className="space-y-2 border-b pb-3">
            <ReconciliationTextField
              name={`allocations.${index}.amountMinor`}
              label={t("projectReconciliation.detail.allocationFor", {
                number: invoice?.number ?? line.customerInvoiceId,
              })}
              required
            />
            <p className="text-sm text-muted-foreground">
              {invoice?.caseTitle} · {t("projectReconciliation.detail.replacementCapacity")}:{" "}
              {invoice
                ? formatMinor(invoice.availableMinor + old, currency)
                : t("projectReconciliation.unknown")}
            </p>
            <Button type="button" variant="outline" onClick={() => lines.remove(index)}>
              {t("projectReconciliation.detail.removeAllocation")}
            </Button>
          </div>
        )
      })}
      {state.form.formState.errors.allocations?.root?.message && (
        <p role="alert">{state.form.formState.errors.allocations.root.message}</p>
      )}
      <Button type="button" variant="outline" onClick={() => lines.replace([])}>
        {t("projectReconciliation.detail.clearAllocations")}
      </Button>
      <FieldLabel htmlFor="allocation-search">{t("projectReconciliation.detail.invoiceChoices")}</FieldLabel>
      <Input
        id="allocation-search"
        value={search}
        onChange={(event) => {
          setSearch(event.target.value)
          setCursors([undefined])
        }}
      />
      {choices.isError ? (
        <div role="alert">
          <p>{t("projectReconciliation.referenceError")}</p>
          <Button type="button" variant="outline" onClick={() => void choices.refetch()}>
            {t("projectReconciliation.retryReferences")}
          </Button>
        </div>
      ) : (
        choices.data?.items.map((invoice) => (
          <div
            key={invoice.id}
            className="flex min-w-0 flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between"
          >
            <span className="min-w-0 max-w-full break-words">
              {invoice.external.number} · {invoice.caseTitle} ·{" "}
              {formatMinor(invoice.availableMinor, currency)}
            </span>
            <Button
              type="button"
              variant="outline"
              disabled={
                amounts.some((x) => x.customerInvoiceId === invoice.id) || lines.fields.length >= 1000
              }
              onClick={() => {
                setSelected((current) => ({
                  ...current,
                  [invoice.id]: {
                    ...invoice,
                    number: invoice.external.number,
                    currency: invoice.external.currency,
                  },
                }))
                lines.append({ customerInvoiceId: invoice.id, amountMinor: "" })
              }}
            >
              {t("projectReconciliation.detail.addAllocation")}
            </Button>
          </div>
        ))
      )}
      <CursorControls
        kind="choices"
        cursors={cursors}
        onChange={setCursors}
        next={choices.data?.nextCursor ?? null}
        busy={choices.isFetching}
      />
    </MutationDialog>
  )
}
