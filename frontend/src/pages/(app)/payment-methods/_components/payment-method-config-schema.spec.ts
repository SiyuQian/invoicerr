import i18n from "i18next"
import { describe, expect, it } from "vitest"
import type { PaymentMethodConfig } from "@/types/payment-method"
import { buildPaymentMethodConfigSchema } from "./payment-method-config-schema"

const fields: PaymentMethodConfig["fields"] = [
  { key: "accountName", kind: "text", label: "Account name", required: true },
  { key: "accountNumber", kind: "text", label: "Account number", required: true },
  { key: "bankName", kind: "text", label: "Bank name" },
]
const schema = buildPaymentMethodConfigSchema({ id: "bank_transfer_nz", fields }, i18n.t)

describe("NZ bank transfer form schema", () => {
  it.each([
    "12-3456-0123456-00",
    "12-3456-0123456-000",
    "12 3456 0123456 00",
    "12 3456 0123456 000",
    " 12  3456  0123456  00 ",
    " 12-3456-0123456-000 ",
    "123456012345600",
    "1234560123456000",
  ])("preserves %j", (accountNumber) => {
    const config = { accountName: "Te Whānau & Co", accountNumber }
    expect(schema.parse(config)).toEqual(config)
  })

  it.each([
    "",
    " ",
    "12-3456-0123456-0",
    "12-3456-0123456-0000",
    "12-3456-123456-00",
    "12-3456-0123456",
    "12/3456/0123456/00",
    "12 3456-0123456-00",
    "12-3456-012345A-00",
    "１２-3456-0123456-00",
    "12\t3456\t0123456\t00",
    "12-3456-0123456-00\n",
    "1.234560123456e14",
    123456012345600,
    null,
    [],
    {},
  ])("rejects %j on the account field", (accountNumber) => {
    const result = schema.safeParse({ accountName: "Example Ltd", accountNumber })
    expect(result.success).toBe(false)
    if (!result.success)
      expect(result.error.issues.some((issue) => issue.path[0] === "accountNumber")).toBe(true)
  })

  it.each(["accountName", "bankName"])("checks single-line %s", (key) => {
    for (const value of [" ", "x".repeat(201), "name\nother", "name\rother"]) {
      const result = schema.safeParse({
        accountName: "Example Ltd",
        accountNumber: "12-3456-0123456-00",
        [key]: value,
      })
      expect(result.success).toBe(false)
      if (!result.success) expect(result.error.issues.some((issue) => issue.path[0] === key)).toBe(true)
    }
  })

  it("requires the name and accepts an optional bank name", () => {
    expect(schema.safeParse({ accountNumber: "12-3456-0123456-00" }).success).toBe(false)
    expect(
      schema.safeParse({ accountName: "Example Ltd", accountNumber: "12-3456-0123456-00", bankName: "" })
        .success,
    ).toBe(true)
    expect(
      schema.safeParse({
        accountName: "Example Ltd",
        accountNumber: "12-3456-0123456-00",
        bankName: "Example Bank",
      }).success,
    ).toBe(true)
  })

  it.each([
    "bank_transfer",
    "paypal",
    "cash",
    "cheque",
    "stripe",
    "mollie",
  ])("keeps the original schema for %s", (id) => {
    const other = buildPaymentMethodConfigSchema(
      { id, fields: [{ key: "value", kind: "text", label: "Value", required: true }] },
      i18n.t,
    )
    expect(other.parse({ value: "ordinary text" })).toEqual({ value: "ordinary text" })
    expect(other.safeParse({}).success).toBe(false)
  })
})
