---
sidebar_position: 16
---

# Project reconciliation

The module's API is `/api/project-reconciliation/projects`; its app route is `/project-reconciliation`. It uses a separate reconciliation-project identity. Existing `Project` and `/api/projects` retain their time-tracking semantics.

## Financial boundary

Reconciliation owns project/case records, external invoice references, external receipt evidence, allocations, coverage attestations and audit decisions. Financial document links read existing `DocumentInstance`, `DocumentPayment` and canonical credit/settlement data through the document financial facade. It does not issue or edit financial documents, insert payments, change numbering, send outgoing work or convert currencies.

Amounts are integer minor units in one project currency. Unknown amounts and unsupported payment data retain explicit completeness/knowledge states. Source Paid labels, checked external receipts and company recorded cash are distinct measures. Flat gross-only received invoices retain unknown net/VAT; Expense payment support is not inferred. Canonical payment conversion uses its already pinned document-currency amount, never a new reconciliation exchange rate.

Case allocations cannot exceed receipt or invoice availability. Consolidated settlement links remain project-level and are counted once without case proration. Compound tenant/project/currency/role checks and document exclusivity apply to every association.

## Authorization

Every request resolves the active company before reading nested IDs. Owners and administrators write; human members read. Belonging to two companies does not make a company B ID valid while company A is active.

API keys require a module read/write scope plus read-equivalent access to **all** of `invoices`, `credit-notes`, `expenses` and `received-invoices` for financial aggregate/detail/export routes. Each resource's write scope is read-equivalent. Module scopes alone grant no financial document access. Session authentication takes precedence over API keys, so scope tests must omit session cookies.

## Mutation and review contracts

Mutations carry `requestKey` and `expectedVersion`. Keep the exact serialized body/key after an uncertain response so an identical retry returns the existing result. A changed payload with the same key or stale expected version conflicts. A persisted-field edit starts a new intent; search text or reselecting the same field value does not.

Financial reads use transaction snapshots and source fingerprints. Review decisions refer to the exact case version and material source state. GET derives an effective open state when source facts changed without writing review/audit state. The next authorized mutation persists reopening. Positive known own outstanding blocks both closure modes. Accepted historical exceptions remain unresolved evidence, retain attention and never fabricate receipt coverage.

The API reference describes current strict DTOs and read/CSV fields. List/detail child collections use independent cursors. Civil invoice/cash ranges affect their labelled report measures; undated values remain in lifetime measures and explicit omission disclosures. Do not apply date filters to available allocation capacity or overall balances.

Manual external invoice writes take the exclusive company lock before project/document locks, as import confirm does. The shared exact issuer/number/year predicate ignores source-ID differences and excludes the edited record. Unknown dates form their own comparison group. A collision returns `DUPLICATE_INVOICE_REVIEW_REQUIRED` with matching reference context and a fingerprint. A human session may submit `duplicateReview: { invoiceIds, fingerprint, evidenceReference, reason, attested: true }`; both the exact match set and context fingerprint must still match. API keys cannot attest. The reviewed identity and context remain in the immutable audit/source snapshot. No unconditional contextual unique constraint or fuzzy matching is introduced.

External credit review reconstructs the highest simultaneously allocated invoice total from immutable `receipt.allocations`/`receipt.void` before/after sets in aggregate revision order. It does not sum per-receipt maxima, lose history on void/reassignment, or count an unrelated unallocated advance. A credit reducing collectible below that total produces the non-overridable `EXTERNAL_CREDIT_DISPOSITION_UNRESOLVED` exception. A human may PATCH the external reference with `creditResolution: { evidenceReference, reason, attested: true }`. The server stores the current credit total and collected peak alongside the evidence in `sourceSnapshot`; new credits or a different peak invalidate it. These assertions neither classify bank transactions nor implement external refund cash-flow reporting. The ordinary source fingerprint and coverage/review freshness checks still apply.

Case reads expose a bounded latest `reviewDecision` with `current` determined from the persisted case version and the same read snapshot's source fingerprint. CSV includes effective review state, current/stale decision and each exact accepted discrepancy reason, retaining formula-cell neutralization. No-partner agreements reject amount, reference or reason at the service boundary as well as at the database invariant.

## Offline import

Import preview and confirm operate on selected offline Ledgerly JSON. They do not use a live provider. Inputs require explicit source currency and source timestamp, strict known fields, bounded rows and exact selected canonical matches. The proposal exposes historical facts alongside authoritative company financial reads; historical amounts cannot overwrite canonical amounts.

Preview writes nothing. Confirm revalidates source identity, reviewed hash, expected version, candidate source facts and sorted document locks in its transaction. Exact retries return one result. Changed source facts, ambiguous matches and source revisions require review rather than silent remapping.

Only the two POST import routes accept the 2 MiB JSON transport limit; ordinary JSON remains 1 MiB. Snapshot/field and 1000-row application bounds also apply. Auth parsing and raw-body capture retain their existing factory behavior.

## Integration verification

`e2e/cypress/e2e/128-project-reconciliation.cy.ts` covers owner workflows and responsive/accessibility behavior. `129-project-reconciliation-isolation.cy.ts` covers tenant/scope boundaries and source/report/queue isolation. Both join the existing numbered Cypress suite through its current glob; no separate workflow is required. Use the existing E2E typecheck and literal-port check before running them.

The Node-only tasks in `e2e/cypress/support/reconciliation-tasks.ts` are bounded test fixtures:

- `reconciliationSourceSnapshot({companyIds, since?})` reads full source, payment, schedule, reminder and numbering rows plus complete source-attributed queue identities. Event watermarks detect already removed jobs and fail closed on trimmed/reset/incomplete history or ownership disagreement. It reads PostgreSQL and Redis separately; run a quiescent window and treat a concurrent snapshot failure as missing evidence.
- `reconciliationPrepareLegacyFixtures({companyId, fixtureNonce, invoiceIds, undatedExpenseId})` accepts only fresh exact marked API-created Invoice drafts and an optional marked Expense (`null` when absent). It sets fixed legacy issued status/display numbers or removes only the Expense date, in an all-validated transaction. This represents pre-existing historical sources outside the measured module journey. It never sends, registers payments or accepts arbitrary SQL/status patches.

Both tasks accept only explicit loopback test targets: the existing exact GitHub Cypress database/Redis service pair, or `NODE_ENV=test` with a dedicated `project_reconciliation_ui_<12 hex>` database named by `RECONCILIATION_E2E_DATABASE_NAME` and a matching nonzero Redis logical DB named by `RECONCILIATION_E2E_REDIS_DB`. Do not point the suite's destructive existing reset helper at shared or production data. Keep private environment files, credentials, source exports and screenshots outside Git.

Run the focused Node boundary checks with existing E2E dependencies:

```sh
cd e2e
node --require ts-node/register --test cypress/support/reconciliation-tasks.node.spec.ts
npm run typecheck
npm run check:ports
npx cypress run --browser firefox --spec 'cypress/e2e/128-project-reconciliation.cy.ts,cypress/e2e/129-project-reconciliation-isolation.cy.ts'
```

Supply the explicit isolated environment to both the actual app and the runner. The Node suite creates fresh marked identities through the owning APIs and removes only its exact owned records/nonce queue. Restored fixture contexts are rejected. Legacy setup and owning-module payments occur before invariance windows. Compare full source/numbering snapshots, canonical facade values, accounting/cashed exports and source-attributed queue events across project changes. Do not use global Redis heartbeat byte equality as live-app isolation proof or replace real browser screenshots with mock visuals.
