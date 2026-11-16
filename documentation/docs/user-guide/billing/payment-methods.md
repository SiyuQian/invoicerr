---
sidebar_position: 1
---

# Payment Methods

The **Payment Methods** page is where you turn on the ways clients can pay you. Every enabled
method prints on your invoices automatically — there is nothing to attach per document.

## How it works

Unlike Clients or Articles, this isn't a list you add entries to. Invoicerr ships a fixed set of
payment methods, each shown as one row of a single list:

- **Bank transfer** — IBAN (required) and BIC (optional)
- **Bank transfer (New Zealand)** — account name and local account number (required), bank name (optional)
- **PayPal** — the receiving account's e-mail
- **Cash** — nothing to configure; the label alone is enough
- **Cheque** — the payee name a cheque should be made out to
- **Stripe** — turns on card payments through your connected Stripe account (Settings → Payments)
- **Mollie** — turns on payments through your connected Mollie account (Settings → Payments)

## Turning a method on

Flip the switch at the end of a row. If the method needs information it doesn't have yet (an IBAN, a PayPal
e-mail…), the switch opens the configuration dialog instead of failing silently — fill it in and
save, and the method is enabled in the same step. A method already configured just toggles straight
on or off.

## Configuring a method

Click **Configure** on any row to open or change its details, whether it's currently on or off. A
method with nothing to configure (Cash, Stripe, Mollie) shows no fields at all — there's simply
nothing to fill in.

## What shows on a document

Every method's preview, the same "field: value" lines your invoices print, appears under its
name, so what you see here is exactly what a client sees. **Cash**, **Stripe**, and **Mollie**
show nothing beyond their own label; **Bank transfer** shows the IBAN/BIC you set; **PayPal** shows
the account e-mail. **Bank transfer (New Zealand)** shows the account name, local account number,
and bank name if supplied. These details are also included in invoice emails.

## New Zealand bank transfers

Use **Bank transfer (New Zealand)** for a standard New Zealand domestic bank account. No IBAN is
needed. Enter the account name as it appears on your bank account and the full account number:

- Bank: 2 digits
- Branch: 4 digits
- Account: 7 digits
- Suffix: 2 or 3 digits

For example, `12-3456-0123456-00` or `12-3456-0123456-000`. These are format examples, not payment
destinations. Four groups separated by spaces, or 15/16 digits without separators, are also
accepted. Leading zeros and the suffix length are preserved exactly as entered.

The app checks the format; it does not verify that the account exists or belongs to the named
recipient. Check your details before enabling this method. This supplies payment instructions:
clients make the transfer through their bank, and you record the payment after confirming receipt.
It does not connect to a bank or automatically mark an invoice paid. International wire instructions
and special foreign-currency account formats are outside this method's scope.

The two bank-transfer methods are separate. A client restricted to **Bank transfer** will not see
the New Zealand method until you explicitly allow it in that client's payment-method settings.
You can enable either or both; clients allowed both see both sets of details. If you previously
entered a New Zealand account into the IBAN field, verify and configure it under the New Zealand
method. Then manually clear that incorrect IBAN in the company settings: disabling the old method
alone leaves the IBAN available to electronic-invoice exports. Keep any legitimate IBAN if you
use both account types. Disable the old method if unused and review client restrictions. Existing
details are never converted or erased automatically.

## What this page doesn't do

- **No adding or removing methods.** The set of seven is fixed; a method you don't use simply stays off.
- **No per-document choice.** A quote or invoice doesn't ask "which payment method" — every method
  you've turned on appears on every document that shows payment methods (invoices). You can still
 narrow this per **client** - see [Restricting payment methods for a client](../clients.md#restricting-payment-methods-for-a-client).
- **No search or filter.** There are only seven rows.

## First use

Every method starts off. Turn on at least one — Bank transfer or PayPal need no external account,
just a field or two — before sending your first invoice.
