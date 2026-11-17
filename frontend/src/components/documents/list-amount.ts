import {
  acceptedOptionTotals,
  computeDocumentOptionTotals,
  computeDocumentTotals,
} from "@/components/documents/document-totals"
import { fromMinor, toMinor } from "@/components/documents/totals-calculator"
import { extractCurrency } from "@/components/documents/totals-shape"
import type { DerivedDocumentTotals, DocumentTypeDescriptor } from "@/components/documents/types"

export interface RowAmount {
  minor: number
  currency: string
  /** The top-level field the figure was read from, when it was one — so the list's secondary line
   *  can skip repeating it. Undefined when the figure was summed from line rows. */
  fieldKey?: string
}

/**
 * The one figure a list row shows for a saved record — "what is this worth", right-aligned in the
 * mono face. Received invoices and expenses use their recorded flat gross/amount first; supplier
 * lines are informational and cannot override that recorded amount. Other types use two sources:
 *  1. a type with line rows (invoice, quote, credit note, purchase order…) gets the gross total of
 *     those lines, through the exact same arithmetic the detail page's totals card uses;
 *  2. otherwise the first top-level `money` field that carries a value, in its declared currency.
 * Null when neither applies - the row simply shows no amount, it never invents one. Also null -  * issue #373 ("quotes with options") - for a quote offering 2+ options: summing every option's
 * lines together would be exactly the meaningless total this issue exists to stop printing, so the
 * row shows no amount at all rather than a wrong one (the same "never invents one" contract this
 * function already holds for every other gap). Issue #479: once an option is accepted
 * (`acceptedOption`, by signature or manual acceptance), the row shows THAT option's own total again.
 * Issue #507: `derivedTotals` (a LINKED credit note's, computed by the backend from the invoice it
 * corrects - see `DocumentInstance.derivedTotals`) wins over both sources above, since the row's own
 * `lines` are empty by construction and would read 0.00.
 */
export function resolveRowAmount(
  descriptor: DocumentTypeDescriptor,
  data: Record<string, unknown>,
  acceptedOption?: string | null,
  derivedTotals?: DerivedDocumentTotals | null,
): RowAmount | null {
  if (derivedTotals?.currency) return { minor: derivedTotals.grossMinor, currency: derivedTotals.currency }

  if (descriptor.id === "received-invoice" || descriptor.id === "expense") {
    const fieldKey = descriptor.id === "received-invoice" ? "grossAmount" : "amount"
    const amount = data[fieldKey]
    const currency = data.currency
    if (
      typeof currency !== "string" ||
      !descriptor.fields
        .find((field) => field.key === "currency")
        ?.options?.some((option) => option.value === currency) ||
      typeof amount !== "number" ||
      amount < 0 ||
      !Number.isFinite(amount)
    )
      return null
    const minor = toMinor(amount, currency)
    return Number.isSafeInteger(minor) && fromMinor(minor, currency) === amount
      ? { minor, currency, fieldKey }
      : null
  }

  const optionTotals = computeDocumentOptionTotals(descriptor, data)
  if (optionTotals) {
    const accepted = acceptedOptionTotals(optionTotals, acceptedOption)
    return accepted?.currency ? { minor: accepted.grossMinor, currency: accepted.currency } : null
  }

  const totals = computeDocumentTotals(descriptor, data)
  if (totals?.currency) {
    return { minor: totals.grossMinor, currency: totals.currency }
  }

  for (const field of descriptor.fields) {
    if (field.kind !== "money") continue
    const raw = data[field.key]
    const amount = typeof raw === "number" ? raw : Number(raw)
    if (raw === undefined || raw === null || raw === "" || Number.isNaN(amount)) continue
    const currency =
      (field.currencyField ? (data[field.currencyField] as string | undefined) : field.currency) ??
      extractCurrency(descriptor, data)
    if (!currency) continue
    return { minor: toMinor(amount, currency), currency, fieldKey: field.key }
  }

  return null
}
