import type { TFunction } from "i18next"

import { buildZodSchema } from "@/components/documents/schema"
import type { PaymentMethodConfig } from "@/types/payment-method"

// Mirror the backend's structural check; keep the submitted text unchanged.
const ACCOUNT_NUMBER =
  /^ *(?:[0-9]{15,16}|[0-9]{2}-[0-9]{4}-[0-9]{7}-[0-9]{2,3}|[0-9]{2} +[0-9]{4} +[0-9]{7} +[0-9]{2,3}) *$/

export function buildPaymentMethodConfigSchema(
  method: Pick<PaymentMethodConfig, "id" | "fields">,
  t: TFunction,
) {
  const schema = buildZodSchema(method.fields)
  if (method.id !== "bank_transfer_nz") return schema

  return schema.superRefine((config, ctx) => {
    for (const key of ["accountName", "bankName"] as const) {
      const value = config[key]
      if (
        typeof value === "string" &&
        (key === "accountName" || value !== "") &&
        (!value.trim() || value.length > 200 || /[\r\n\u2028\u2029]/.test(value))
      ) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: t(`paymentMethods.nzBankTransfer.errors.${key}`),
        })
      }
    }
    const value = config.accountNumber
    if (typeof value === "string" && (!ACCOUNT_NUMBER.test(value) || /[^0-9 -]/.test(value))) {
      ctx.addIssue({
        code: "custom",
        path: ["accountNumber"],
        message: t("paymentMethods.nzBankTransfer.errors.accountNumber"),
      })
    }
  })
}
