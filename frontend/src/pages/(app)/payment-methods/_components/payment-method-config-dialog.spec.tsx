import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const { mutateAsync } = vi.hoisted(() => ({ mutateAsync: vi.fn() }))
vi.mock("@/hooks/queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/queries")>()),
  useUpdatePaymentMethod: () => ({ mutateAsync, isPending: false }),
}))
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import type { PaymentMethodConfig } from "@/types/payment-method"
import { PaymentMethodConfigDialog } from "./payment-method-config-dialog"

const method: PaymentMethodConfig = {
  id: "bank_transfer_nz",
  label: "Bank transfer (New Zealand)",
  enabled: false,
  configured: false,
  config: {},
  fields: [
    { key: "accountName", kind: "text", label: "Account name", required: true },
    { key: "accountNumber", kind: "text", label: "Account number", required: true },
    { key: "bankName", kind: "text", label: "Bank name" },
  ],
}

function renderDialog(activateOnSave = false) {
  const onOpenChange = vi.fn()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = (current: PaymentMethodConfig, open = true) => (
    <QueryClientProvider client={client}>
      <PaymentMethodConfigDialog
        method={current}
        open={open}
        onOpenChange={onOpenChange}
        activateOnSave={activateOnSave}
      />
    </QueryClientProvider>
  )
  const result = render(view(method))
  return {
    onOpenChange,
    reopen: (current: PaymentMethodConfig) => {
      result.rerender(view(current, false))
      result.rerender(view(current))
    },
  }
}

function fillAccount(accountNumber: string) {
  fireEvent.change(screen.getByLabelText(/Account name/), { target: { value: "Example Ltd" } })
  fireEvent.change(screen.getByLabelText(/Account number/), { target: { value: accountNumber } })
}

describe("New Zealand payment configuration dialog", () => {
  beforeEach(() => {
    mutateAsync.mockReset().mockResolvedValue(method)
  })

  it("shows an inline account error without submitting or requesting an IBAN", async () => {
    renderDialog()
    expect(screen.queryByLabelText(/IBAN|BIC/)).not.toBeInTheDocument()
    fillAccount("invalid")
    fireEvent.click(screen.getByTestId("payment-method-config-save"))
    expect(await screen.findByText(/BB-BBBB-AAAAAAA/)).toBeInTheDocument()
    expect(mutateAsync).not.toHaveBeenCalled()
  })

  it.each([
    false,
    true,
  ])("preserves a three-digit suffix and respects activateOnSave=%s", async (activate) => {
    const { onOpenChange } = renderDialog(activate)
    fillAccount("12-3456-0123456-000")
    fireEvent.click(screen.getByTestId("payment-method-config-save"))
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({
        methodId: "bank_transfer_nz",
        config: { accountName: "Example Ltd", accountNumber: "12-3456-0123456-000" },
        ...(activate ? { enabled: true } : {}),
      }),
    )
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("retains failed edits and resets to current server values when reopened", async () => {
    const { onOpenChange, reopen } = renderDialog()
    mutateAsync.mockRejectedValueOnce(new Error("Save failed"))
    fillAccount("12-3456-0123456-00")
    fireEvent.click(screen.getByTestId("payment-method-config-save"))
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1))
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(screen.getByLabelText(/Account number/)).toHaveValue("12-3456-0123456-00")
    reopen({ ...method, config: { accountName: "Current Ltd", accountNumber: "12-3456-0123456-000" } })
    expect(screen.getByLabelText(/Account name/)).toHaveValue("Current Ltd")
    expect(screen.getByLabelText(/Account number/)).toHaveValue("12-3456-0123456-000")
  })
})
