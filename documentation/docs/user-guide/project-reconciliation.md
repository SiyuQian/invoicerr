---
sidebar_position: 8
---

# Project reconciliation

Open **Data → Project reconciliation** to compare customer collection evidence with your company's existing invoices, payments and costs. Each project has one end customer, currency and collection direction, with an optional partner and time-tracking project.

This register updates project records. Create invoices, record payments and manage supplier bills in their document screens. Project reconciliation does not send invoices, register bank transactions, calculate a default share, convert currencies or connect to Ledgerly.

## Choose who collects

Click **New project**, enter the project and end customer names, and choose the currency and collector.

- **Partner collects**: record the partner's customer invoice as an external reference. Link your existing settlement invoice separately. Customer receipt evidence and your company's recorded payments remain separate.
- **Company collects**: link your existing customer invoice. Its canonical payments supply your recorded receipts. Link partner bills as outgoing costs; they do not reduce the customer receipt total.

Select the end customer client when linking a company-collected customer invoice. Select the collecting partner for a partner-collected project. Financial references or known agreements lock the project's currency, collector and parties. An optional time-tracking link does not change the existing time-tracking project.

Search the register by project or end customer, and filter by status, collector or **Needs attention**. Open a project to see its measures and three tabs: **Reconciliation**, **Evidence and differences**, and **Costs and history**.

## Cases and agreements

Create a case for each piece of work. Enter agreed gross, net and tax amounts only when known, with an agreement reference. A project without a partner hides the settlement agreement fields. A blank agreement stays unknown. The app does not assume a percentage, infer tax or turn an unbilled difference into an accounting receivable.

Expand a case to edit it, add a customer reference, link an existing document, review evidence coverage or make a review decision. Follow the linked document number to open its owning document screen.

A project-level settlement document is **Not allocated to cases**. Its payments count once at project level; the app does not divide them between cases. A financial document cannot belong to two reconciliation projects.

## Partner collection evidence

**Marked paid by source** reports a source label. It is not proof of a bank receipt. For example, an external customer invoice marked Paid for NZD 2,300 and your own paid settlement invoice for NZD 1,150 show two different facts. The customer's checked receipts remain unknown until evidence is recorded.

In **Evidence and differences**, choose **Add external receipt**:

1. Enter the actual amount and the receipt date, if known.
2. Choose **Partner reported** or **Evidence checked**.
3. For checked evidence, supply an evidence reference and explicitly confirm that you checked these receipt facts. The app has not accessed the partner bank.
4. Enter a reason and save. Use **Allocate receipt** to assign the amount to customer invoice references.

You can edit a reported receipt to mark that same receipt as checked. This updates its evidence class; it does not add a second receipt. Changing checked facts requires fresh confirmation. Allocations cannot exceed either the receipt or the invoice's available amount. Unallocated money is shown separately as a customer advance; when a credit released previously collected money, its disposition also remains explicitly unresolved until reviewed. Void an incorrect receipt with a reason rather than inventing an accounting reversal.

If an external reference shares an issuer, invoice number and year with another reference in this company, saving shows the matching invoice and project context. Use **Reload project**, review those references, and supply the identity evidence, reason and explicit confirmation only if this is a distinct invoice. Imports with such a collision stay blocked; correct the identity or record a legitimate distinct reference manually. Import does not attest duplicate exceptions. References with unknown dates are compared with other unknown-date references; supplying a date rechecks the year.

A credit that reduces collectible below previously allocated customer money keeps the case open with a credit disposition exception, even after fresh coverage. Edit the external reference and supply evidence explaining the refund, reassignment, agreed retention or correction, then explicitly confirm you checked it. This records your evidence assertion; it does not record company cash or establish bank truth. A further credit requires fresh disposition evidence. Credits against unpaid balances and unrelated advances do not create this exception.

Use **Attest evidence coverage** only when the selected external invoices are covered by the complete current receipt and allocation evidence. An allocation alone does not establish that the evidence set is complete.

## Dates, unknown values and reports

The summary labels each measure as **Lifetime**, **In invoice date range**, **In receipt date range**, or an overall balance/agreement. Date filters affect the labelled summary measures. Source records, allocations, available capacity and overall balances remain visible in their full context.

An undated receipt contributes to lifetime evidence. A dated cash range excludes it and discloses the omitted amount/count. A missing date stays unknown. A gross-only supplier invoice can have a known gross amount with unknown net and tax. An Expense whose payment data is unsupported shows that limitation; it is not treated as unpaid with a zero balance.

Use **Export CSV** for the current project's report and selected date filters. It includes the effective review state, latest decision and exact accepted discrepancy reasons, labelled current or stale historical. External customer amounts and checked partner receipts do not become company revenue or canonical payments.

## Review, changes and archive

**Verify** is available only when the case is complete and eligible. Known positive own receivable or payable blocks both verification and closure with exceptions.

When permitted, **Accept exact exceptions** requires a reason for each current exception and an overall reason. The case becomes **Reviewed with unresolved evidence**, remains in needs attention, and does not gain checked receipts or payment confirmation. A material source change invalidates the previous review. Refresh the project before making a new decision.

If another change conflicts with your save, use **Reload project** and review the current values. After an uncertain request failure, retrying unchanged values reuses that request. Editing the values starts a new request.

Use the register row's **Archive project** action to hide a project from the active list. Archive retains its balances, records and unresolved issues. It does not settle the project. Find it with the **Archived** or **All projects** filter and restore it when needed.

## Historical project references

**Import historical project references** accepts a selected offline Ledgerly project JSON payload, an explicit source currency and a source timestamp with timezone. **Preview import** shows proposed cases, references, historical facts and any canonical document matches. Review disagreements and unresolved matches before **Confirm import**. Changing the payload, matches or source facts requires a new preview.

Import creates project references only. It does not issue an invoice, register a payment, assume receipt dates from Paid labels or contact Ledgerly. Keep sensitive exports outside public documentation and use the correct company before importing.

Owners and administrators can make changes. Human members can read the project register and reports.
