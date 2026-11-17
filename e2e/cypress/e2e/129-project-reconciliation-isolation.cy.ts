export {};

const api = Cypress.env("apiUrl");
const base = () => `${api}/api/project-reconciliation/projects`;
const nonce = crypto.randomUUID();
const foreignNonce = crypto.randomUUID();
let companyId: string,
  foreignCompanyId: string,
  customerId: string,
  partnerId: string,
  foreignClientId: string;
let settlementId: string,
  directId: string,
  unpaidId: string,
  consolidatedId: string,
  expenseId: string,
  billId: string,
  grossOnlyId: string,
  foreignDocumentId: string;
let reviewedCaseId: string, reviewedExternalId: string;
let partnerProject: string,
  directProject: string,
  unpaidProject: string,
  consolidatedProject: string,
  foreignProject: string;

type Snapshot = {
  sourceRows: Record<string, string[]>;
  queues: unknown;
  events: {
    watermarks: Record<string, { lastGeneratedId: string; entriesAdded: number }>;
    sourceEvents: unknown[];
    historyComplete: boolean;
  };
};
function switchCompany(id: string) {
  return cy.request("POST", `${api}/api/companies/switch`, { companyId: id });
}
function detail(id: string) {
  return cy.request(`${base()}/${id}`).its("body");
}
function mutate(id: string, route: string, data: Record<string, unknown>, method = "POST") {
  return detail(id)
    .then((body) =>
      cy.request({
        method,
        url: `${base()}/${id}${route}`,
        body: { ...data, expectedVersion: body.versionToken, requestKey: crypto.randomUUID() },
      }),
    )
    .its("body");
}
function project(
  name: string,
  mode: "COMPANY" | "PARTNER",
  customer: () => string,
  partner: () => string | null,
) {
  return cy
    .then(() =>
      cy.request("POST", base(), {
        name,
        endCustomerName: "Invented End Customer",
        currency: "NZD",
        collectionMode: mode,
        endCustomerClientId: customer(),
        partnerClientId: partner(),
        timeProjectId: null,
        description: null,
        expectedVersion: "new",
        requestKey: crypto.randomUUID(),
      }),
    )
    .its("body.result.id");
}
function source(type: string, action: string, data: Record<string, unknown>) {
  return cy
    .request("POST", `${api}/api/documents/types/${type}/actions/${action}`, { data })
    .its("body.document");
}
function invoice(client: string, amount: number, marker = nonce) {
  return source("invoice", "save-draft", {
    client,
    currency: "NZD",
    issueDate: "2026-08-15",
    dueDate: "2026-09-15",
    lines: [
      {
        description: `T10 fixture ${marker}: invoice`,
        quantity: 1,
        unit: "unit",
        unitPrice: amount,
        vatRate: "0",
      },
    ],
  });
}
function pay(id: string, amount: number, type = "invoice") {
  return cy.request(`${api}/api/documents/${id}?typeId=${type}`).then(({ body }) =>
    cy.request("POST", `${api}/api/documents/types/${type}/actions/record-payment`, {
      documentId: id,
      data: body.data,
      params: {
        amount,
        currency: "NZD",
        paidAt: "2026-08-20",
        note: "Invented owning-module fixture setup outside invariance window",
      },
    }),
  );
}
function caseInput(title: string, gross: number | null) {
  return {
    title,
    periodStart: null,
    periodEnd: null,
    agreedGrossMinor: gross,
    agreedNetMinor: null,
    agreedVatMinor: null,
    agreementReference: gross === null ? null : "Invented agreement",
  };
}
function external(number = "EXTERNAL-2300") {
  return {
    issuer: "Invented Partner",
    recipient: "Invented End Customer",
    number,
    issueDate: null,
    dueDate: null,
    currency: "NZD",
    grossMinor: 230000,
    netMinor: null,
    vatMinor: null,
    reportedStatus: "Paid",
    sourceSystem: null,
    sourceId: null,
    sourceAsOf: null,
    sourceReference: "Invented historical source without bank confirmation",
  };
}
function snapshot(since?: Snapshot["events"]["watermarks"]) {
  return cy.task<Snapshot>("reconciliationSourceSnapshot", {
    companyIds: [companyId, foreignCompanyId],
    ...(since ? { since } : {}),
  });
}
function reports() {
  const query = "from=2026-08-01&to=2026-12-31";
  const values: Record<string, unknown> = {};
  for (const route of [
    `/api/accounting-export?${query}`,
    `/api/revenue/cashed?granularity=monthly&${query}`,
    `/api/revenue/cashed/export?granularity=monthly&${query}`,
  ])
    cy.request(route.startsWith("http") ? route : `${api}${route}`).then((response) => {
      expect(response.status).to.equal(200);
      values[route] = response.body;
    });
  for (const [id, type] of [
    [settlementId, "invoice"],
    [directId, "invoice"],
    [unpaidId, "invoice"],
    [consolidatedId, "invoice"],
    [billId, "received-invoice"],
    [grossOnlyId, "received-invoice"],
    [expenseId, "expense"],
  ]) {
    cy.request(`${api}/api/documents/${id}?typeId=${type}`).then((response) => {
      values[`document:${id}`] = response.body;
    });
    cy.request(`${api}/api/documents/${id}/settlement?typeId=${type}`).then((response) => {
      values[`settlement:${id}`] = response.body;
    });
  }
  return cy.then(() => values);
}

describe("Project reconciliation tenant and financial isolation", () => {
  before(() => {
    cy.login();
    for (const value of [nonce, foreignNonce]) {
      cy.request("POST", `${api}/api/companies`, {
        name: `T10 Fixture Harness ${value}`,
        description: "Invented isolation acceptance fixtures",
        phone: "+6400000000",
        email: `fixture-${value}@example.com`,
        address: "1 Invented St",
        city: "Auckland",
        postalCode: "1010",
        country: "New Zealand",
        countryCode: "NZ",
        currency: "NZD",
      }).then(({ body }) => {
        if (value === nonce) companyId = body.id;
        else foreignCompanyId = body.id;
        switchCompany(body.id);
      });
      for (const name of value === nonce
        ? ["Invented End Customer", "Invented Partner"]
        : ["Invented Foreign Customer"])
        cy.request("POST", `${api}/api/clients`, {
          name,
          contactEmail: `fixture-${crypto.randomUUID()}@example.com`,
          country: "New Zealand",
          countryCode: "NZ",
          currency: "NZD",
          address: "2 Invented St",
          city: "Auckland",
          postalCode: "1010",
          isActive: true,
          type: "COMPANY",
        }).then(({ body }) => {
          if (value !== nonce) foreignClientId = body.id;
          else if (name === "Invented End Customer") customerId = body.id;
          else partnerId = body.id;
        });
    }
    cy.then(() => invoice(foreignClientId, 1150, foreignNonce)).then((doc) => {
      foreignDocumentId = doc.id;
    });
    cy.then(() =>
      project(
        "Foreign company project",
        "COMPANY",
        () => foreignClientId,
        () => null,
      ),
    ).then((id) => {
      foreignProject = id;
    });
    cy.then(() => switchCompany(companyId));
    for (const [kind, amount] of [
      ["settlement", 1150],
      ["direct", 1725],
      ["unpaid", 1150],
      ["consolidated", 1150],
    ] as const)
      cy.then(() => invoice(kind === "direct" || kind === "unpaid" ? customerId : partnerId, amount)).then(
        (doc) => {
          if (kind === "settlement") settlementId = doc.id;
          else if (kind === "direct") directId = doc.id;
          else if (kind === "unpaid") unpaidId = doc.id;
          else consolidatedId = doc.id;
        },
      );
    cy.then(() =>
      source("expense", "save-draft", {
        description: `T10 fixture ${nonce}: undated expense`,
        amount: 125.5,
        currency: "NZD",
        date: "2026-08-15",
      }),
    ).then((doc) => {
      expenseId = doc.id;
    });
    cy.then(() =>
      cy.task("reconciliationPrepareLegacyFixtures", {
        companyId,
        fixtureNonce: nonce,
        invoiceIds: [settlementId, directId, unpaidId, consolidatedId],
        undatedExpenseId: expenseId,
      }),
    );
    cy.then(() => pay(settlementId, 1150));
    cy.then(() => pay(directId, 690));
    cy.then(() => pay(directId, 1035));
    cy.then(() => pay(consolidatedId, 1150));
    for (const amount of [862.5, 869.96])
      cy.then(() =>
        source("received-invoice", "receive", {
          supplier: "Invented Partner",
          supplierClient: partnerId,
          supplierNumber: amount === 862.5 ? "INVENTED-BILL-86250" : "INVENTED-GROSS-ONLY",
          currency: "NZD",
          grossAmount: amount,
          ...(amount === 862.5 ? { issueDate: "2026-08-15" } : {}),
        }),
      ).then((doc) => {
        if (amount === 862.5) billId = doc.id;
        else grossOnlyId = doc.id;
        return cy.request("POST", `${api}/api/documents/types/received-invoice/actions/approve`, {
          documentId: doc.id,
          data: doc.data,
        });
      });
    cy.then(() => pay(billId, 862.5, "received-invoice"));
    cy.then(() =>
      project(
        "Isolation partner project",
        "PARTNER",
        () => customerId,
        () => partnerId,
      ),
    ).then((id) => {
      partnerProject = id;
    });
    cy.then(() =>
      project(
        "Isolation direct project",
        "COMPANY",
        () => customerId,
        () => partnerId,
      ),
    ).then((id) => {
      directProject = id;
    });
    cy.then(() =>
      project(
        "Isolation unpaid project",
        "COMPANY",
        () => customerId,
        () => partnerId,
      ),
    ).then((id) => {
      unpaidProject = id;
    });
    cy.then(() =>
      project(
        "Consolidated partner project",
        "PARTNER",
        () => customerId,
        () => partnerId,
      ),
    ).then((id) => {
      consolidatedProject = id;
    });
  });
  beforeEach(() => {
    cy.login();
    cy.then(() => switchCompany(companyId));
  });

  it("project changes, unlinking, exception closure, archive and exports leave all source and queue identities unchanged", () => {
    let before: Snapshot, financial: Record<string, unknown>, caseId: string;
    snapshot().then((value) => {
      before = value;
    });
    reports().then((value) => {
      financial = value;
    });
    cy.then(() => mutate(partnerProject, "/cases", caseInput("Unconfirmed historical case", 115000))).then(
      (body) => {
        caseId = body.result.id;
        reviewedCaseId = caseId;
      },
    );
    cy.then(() => mutate(partnerProject, `/cases/${caseId}/customer-invoices`, external())).then((body) => {
      reviewedExternalId = body.result.id;
    });
    cy.then(() =>
      mutate(partnerProject, "/document-links", {
        documentId: settlementId,
        typeId: "invoice",
        caseId,
        role: "SETTLEMENT_INCOME",
      }),
    ).then((body) => {
      return mutate(partnerProject, `/document-links/${body.result.id}/unlink`, {
        reason: "Invented mistaken link",
      });
    });
    cy.then(() =>
      mutate(partnerProject, "/document-links", {
        documentId: settlementId,
        typeId: "invoice",
        caseId,
        role: "SETTLEMENT_INCOME",
      }),
    );
    cy.then(() => detail(partnerProject)).then((body) => {
      const row = body.cases.items.find((item: { id: string }) => item.id === caseId);
      return mutate(partnerProject, `/cases/${caseId}/review`, {
        mode: "ACCEPT_EXCEPTIONS",
        reason: "Explicit unresolved invented history",
        exceptions: row.exceptions
          .filter((item: { code: string }) => item.code !== "SOURCE_CHANGED")
          .map((item: { code: string; fingerprint: string }) => ({
            code: item.code,
            fingerprint: item.fingerprint,
            reason: "Invented historical evidence unavailable",
          })),
      });
    });
    cy.then(() => detail(partnerProject)).then((body) => {
      expect(body.cases.items[0].effectiveReviewState).to.equal("CLOSED_WITH_EXCEPTIONS");
      expect(body.attentionCount).to.be.greaterThan(0);
      expect(body.checkedReceipts.completeness).to.equal("UNKNOWN");
    });
    cy.then(() => mutate(partnerProject, "", { status: "ARCHIVED" }, "PATCH"));
    cy.then(() => detail(partnerProject)).then((body) => {
      expect(body.project.status).to.equal("ARCHIVED");
      expect(body.summary.ownRecordedReceipts.knownMinor).to.equal(115000);
    });
    cy.then(() => mutate(partnerProject, "", { status: "ACTIVE" }, "PATCH"));
    cy.then(() => snapshot(before.events.watermarks)).then((after) => {
      expect(after.sourceRows).to.deep.equal(before.sourceRows);
      expect(after.queues).to.deep.equal(before.queues);
      expect(after.events.historyComplete).to.equal(true);
      expect(after.events.sourceEvents).to.deep.equal([]);
    });
    reports().then((after) => expect(after).to.deep.equal(financial));
    cy.visit(`/project-reconciliation/${partnerProject}`);
    cy.contains("Reviewed with unresolved evidence", { timeout: 20000 })
      .scrollIntoView()
      .should("be.visible");
    cy.screenshot("reconciliation-exceptions-retain-attention", { capture: "viewport" });
    cy.assertAccessible();
  });

  it("direct payments stay unique while a paid partner bill, gross-only invoice and unsupported Expense remain distinct", () => {
    let caseId: string;
    cy.then(() => mutate(directProject, "/cases", caseInput("Direct customer case", 172500))).then((body) => {
      caseId = body.result.id;
    });
    cy.then(() =>
      mutate(directProject, "/document-links", {
        documentId: directId,
        typeId: "invoice",
        caseId,
        role: "CUSTOMER_INVOICE",
      }),
    );
    for (const [id, type, role] of [
      [() => billId, "received-invoice", "PARTNER_BILL"],
      [() => grossOnlyId, "received-invoice", "PARTNER_BILL"],
      [() => expenseId, "expense", "PROJECT_COST"],
    ] as const)
      cy.then(() =>
        mutate(directProject, "/document-links", { documentId: id(), typeId: type, caseId, role }),
      );
    cy.then(() => detail(directProject)).then((body) => {
      expect(body.summary.ownRecordedReceipts.knownMinor).to.equal(172500);
      expect(body.summary.partnerPaid.knownMinor).to.equal(86250);
      const links = body.cases.items[0].documentLinks;
      const gross = links.find((row: { documentId: string }) => row.documentId === grossOnlyId).financial;
      expect(gross).to.include({ grossMinor: 86996, netMinor: null, vatMinor: null });
      const cost = links.find((row: { documentId: string }) => row.documentId === expenseId);
      expect(cost.issueDate).to.equal(null);
      expect(cost.financial.paymentKnowledge).to.equal("UNSUPPORTED");
      expect(cost.financial.settlement).to.equal(null);
      expect(
        links.find((row: { documentId: string }) => row.documentId === directId).financial.payments,
      ).to.have.length(2);
    });
    cy.visit(`/project-reconciliation/${directProject}`);
    cy.get('button[aria-label="Expand Direct customer case"]', { timeout: 20000 }).click();
    // Scroll all ancestors through the horizontal table to the app's vertical viewport.
    cy.contains("article", "Payment data: Not supported")
      .then(($article) => {
        $article[0].scrollIntoView({ block: "center", inline: "nearest" });
        return $article;
      })
      .should("be.visible");
    cy.contains('[role="tab"]', "Costs and history").click();
    cy.contains("869.96 NZD").scrollIntoView().should("be.visible");
    cy.assertAccessible();
  });

  it("a consolidated settlement is counted once, flagged unallocated, and cannot be claimed by another project", () => {
    for (const title of ["Consolidated case A", "Consolidated case B"])
      cy.then(() => mutate(consolidatedProject, "/cases", caseInput(title, 57500)));
    cy.then(() =>
      mutate(consolidatedProject, "/document-links", {
        documentId: consolidatedId,
        typeId: "invoice",
        caseId: null,
        role: "SETTLEMENT_INCOME",
      }),
    );
    cy.then(() => detail(consolidatedProject)).then((body) => {
      expect(body.summary.ownRecordedReceipts.knownMinor).to.equal(115000);
      expect(body.unallocatedDocumentLinks).to.have.length(1);
      expect(
        body.cases.items.every(
          (row: { summary: { ownRecordedReceipts: { knownMinor: number } } }) =>
            row.summary.ownRecordedReceipts.knownMinor === 0,
        ),
      ).to.equal(true);
    });
    cy.then(() => detail(partnerProject))
      .then((body) =>
        cy.request({
          method: "POST",
          url: `${base()}/${partnerProject}/document-links`,
          failOnStatusCode: false,
          body: {
            documentId: consolidatedId,
            typeId: "invoice",
            caseId: null,
            role: "SETTLEMENT_INCOME",
            expectedVersion: body.versionToken,
            requestKey: crypto.randomUUID(),
          },
        }),
      )
      .its("status")
      .should("equal", 409);
    cy.visit(`/project-reconciliation/${consolidatedProject}`);
    cy.contains("Not allocated to cases", { timeout: 20000 }).scrollIntoView().should("be.visible");
    cy.assertAccessible();
  });

  it("known own outstanding blocks both closure modes and stale versions cannot overwrite a case", () => {
    let caseId: string, oldToken: string;
    cy.then(() => mutate(unpaidProject, "/cases", caseInput("Known own outstanding", 115000))).then(
      (body) => {
        caseId = body.result.id;
        oldToken = body.versionToken;
      },
    );
    cy.then(() =>
      mutate(unpaidProject, "/document-links", {
        documentId: unpaidId,
        typeId: "invoice",
        caseId,
        role: "CUSTOMER_INVOICE",
      }),
    );
    for (const mode of ["VERIFY", "ACCEPT_EXCEPTIONS"])
      cy.then(() => detail(unpaidProject))
        .then((body) =>
          cy.request({
            method: "POST",
            url: `${base()}/${unpaidProject}/cases/${caseId}/review`,
            failOnStatusCode: false,
            body: {
              mode,
              reason: "Cannot waive real outstanding",
              exceptions:
                mode === "ACCEPT_EXCEPTIONS"
                  ? body.cases.items
                      .find((row: { id: string }) => row.id === caseId)
                      .exceptions.filter((item: { code: string }) => item.code !== "SOURCE_CHANGED")
                      .map((item: { code: string; fingerprint: string }) => ({
                        code: item.code,
                        fingerprint: item.fingerprint,
                        reason: "Cannot waive a known own receivable",
                      }))
                  : [],
              expectedVersion: body.versionToken,
              requestKey: crypto.randomUUID(),
            },
          }),
        )
        .its("status")
        .should("equal", 409);
    cy.then(() =>
      cy.request({
        method: "PATCH",
        url: `${base()}/${unpaidProject}/cases/${caseId}`,
        failOnStatusCode: false,
        body: { title: "Stale overwrite", expectedVersion: oldToken, requestKey: crypto.randomUUID() },
      }),
    )
      .its("status")
      .should("equal", 409);
    cy.visit(`/project-reconciliation/${unpaidProject}`);
    cy.get('button[aria-label="Expand Known own outstanding"]', { timeout: 20000 }).click();
    cy.contains("button", "Review case").click();
    cy.contains("Known positive own receivable or payable").should("be.visible");
    cy.get('[role="dialog"]').contains("button", "Save changes").should("be.disabled");
    cy.assertAccessible();
  });

  it("rejects company B project, nested case and document IDs for an owner of both companies", () => {
    let foreignCase: string;
    cy.then(() => switchCompany(foreignCompanyId));
    cy.then(() => mutate(foreignProject, "/cases", caseInput("Foreign case", null))).then((body) => {
      foreignCase = body.result.id;
    });
    cy.then(() => switchCompany(companyId));
    cy.then(() => cy.request({ url: `${base()}/${foreignProject}`, failOnStatusCode: false }))
      .its("status")
      .should("equal", 404);
    cy.then(() => detail(unpaidProject))
      .then((body) =>
        cy.request({
          method: "PATCH",
          url: `${base()}/${unpaidProject}/cases/${foreignCase}`,
          failOnStatusCode: false,
          body: {
            title: "Foreign change",
            expectedVersion: body.versionToken,
            requestKey: crypto.randomUUID(),
          },
        }),
      )
      .its("status")
      .should("equal", 404);
    cy.then(() => detail(unpaidProject))
      .then((body) =>
        cy.request({
          method: "POST",
          url: `${base()}/${unpaidProject}/document-links`,
          failOnStatusCode: false,
          body: {
            documentId: foreignDocumentId,
            typeId: "invoice",
            caseId: null,
            role: "PROJECT_COST",
            expectedVersion: body.versionToken,
            requestKey: crypto.randomUUID(),
          },
        }),
      )
      .its("status")
      .should("equal", 404);
  });

  it("a canonical source payment change invalidates review without a GET audit/version write and allocations constrain external reductions", () => {
    let historyCount: number, receiptId: string;
    let previous: { version: number; updatedAt: string };
    cy.then(() => detail(partnerProject)).then((body) => {
      const row = body.cases.items.find((item: { id: string }) => item.id === reviewedCaseId);
      previous = { version: row.version, updatedAt: row.updatedAt };
    });
    cy.request(`${base()}/${partnerProject}/history?limit=100`)
      .its("body.total")
      .then((total) => {
        historyCount = total;
      });
    // Owning-module source change is explicit setup outside the completed invariance window above.
    cy.then(() => pay(settlementId, 1));
    cy.then(() => detail(partnerProject)).then((body) => {
      const row = body.cases.items.find((item: { id: string }) => item.id === reviewedCaseId);
      expect(row.effectiveReviewState).to.equal("OPEN");
      expect(row.version).to.equal(previous.version);
      expect(row.updatedAt).to.equal(previous.updatedAt);
    });
    cy.request(`${base()}/${partnerProject}/history?limit=100`)
      .its("body.total")
      .then((total) => expect(total).to.equal(historyCount));
    cy.then(() =>
      mutate(
        partnerProject,
        `/cases/${reviewedCaseId}`,
        { title: "Source changed; review reopened" },
        "PATCH",
      ),
    );
    cy.then(() => detail(partnerProject)).then((body) => {
      const row = body.cases.items.find((item: { id: string }) => item.id === reviewedCaseId);
      expect(row.effectiveReviewState).to.equal("OPEN");
      expect(row.version).to.be.greaterThan(previous.version);
    });
    cy.request(`${base()}/${partnerProject}/history?limit=100`)
      .its("body.total")
      .then((total) => expect(total).to.be.greaterThan(historyCount));
    cy.then(() =>
      mutate(partnerProject, "/receipts", {
        amountMinor: 100000,
        currency: "NZD",
        paidOn: null,
        evidenceClass: "EVIDENCE_CHECKED",
        attested: true,
        evidenceReference: "Invented checked statement",
        evidenceUrl: null,
        reason: "Invented allocation ceiling fixture",
      }),
    ).then((body) => {
      receiptId = body.result.id;
    });
    cy.then(() =>
      mutate(
        partnerProject,
        `/receipts/${receiptId}/allocations`,
        { allocations: [{ customerInvoiceId: reviewedExternalId, amountMinor: 100000 }] },
        "PUT",
      ),
    );
    cy.then(() => detail(partnerProject))
      .then((body) =>
        cy.request({
          method: "POST",
          url: `${base()}/${partnerProject}/customer-invoices/${reviewedExternalId}/credit-adjustments`,
          failOnStatusCode: false,
          body: {
            amountMinor: 220000,
            sourceReference: "Invented excessive reduction",
            reason: "Must preserve allocated amount",
            expectedVersion: body.versionToken,
            requestKey: crypto.randomUUID(),
          },
        }),
      )
      .its("status")
      .should("equal", 409);
  });

  it("requires all financial read scopes on real cookie-free API-key aggregates and exports", () => {
    const financial = ["invoices:read", "credit-notes:read", "expenses:read", "received-invoices:read"];
    const keys: Array<{ key: string; allowed: boolean; sourceAllowed: boolean }> = [];
    for (const scopes of [
      ["project-reconciliation:read"],
      ["project-reconciliation:read", ...financial.filter((scope) => scope !== "expenses:read")],
      ["project-reconciliation:read", ...financial],
    ])
      cy.request({
        method: "POST",
        url: `${api}/api/api-keys`,
        body: { name: "Invented reconciliation scope key", scopes },
        log: false,
      }).then(({ body }) => {
        keys.push({
          key: body.key,
          allowed: scopes.length === 5,
          sourceAllowed: scopes.includes("invoices:read"),
        });
      });
    cy.clearAllCookies();
    cy.getAllCookies().should("have.length", 0);
    cy.then(() => {
      for (const key of keys)
        for (const route of [`${base()}/${directProject}`, `${base()}/${directProject}/export.csv`])
          cy.request({ url: route, headers: { "x-api-key": key.key }, failOnStatusCode: false, log: false })
            .its("status")
            .should("equal", key.allowed ? 200 : 403);
      cy.request({
        url: `${api}/api/documents/${directId}?typeId=invoice`,
        headers: { "x-api-key": keys[0].key },
        failOnStatusCode: false,
        log: false,
      })
        .its("status")
        .should("equal", 403);
    });
  });

  it("a real invited MEMBER can read but cannot mutate and sees the read-only register", () => {
    const email = `reconciliation-member-${crypto.randomUUID()}@example.com`,
      password = "Invented_Member_Password123!";
    cy.request("POST", `${api}/api/invitations`, { role: "MEMBER" })
      .its("body.code")
      .then((code) => cy.request("POST", `${api}/api/invitations/validate`, { code, email }));
    cy.clearAllCookies();
    cy.request("POST", `${api}/api/auth/sign-up/email`, {
      name: "Invented Member",
      firstname: "Invented",
      lastname: "Member",
      email,
      password,
      acceptLegal: true,
    });
    cy.request("POST", `${api}/api/auth/sign-in/email`, { email, password });
    cy.then(() => detail(directProject))
      .then((body) =>
        cy.request({
          method: "PATCH",
          url: `${base()}/${directProject}`,
          failOnStatusCode: false,
          body: {
            description: "Forbidden member change",
            expectedVersion: body.versionToken,
            requestKey: crypto.randomUUID(),
          },
        }),
      )
      .its("status")
      .should("equal", 403);
    cy.visit("/project-reconciliation");
    cy.contains("a", "Isolation direct project", { timeout: 20000 }).should("be.visible");
    cy.contains("button", "New project").should("not.exist");
    cy.get('button[aria-label^="Project actions:"]').should("not.exist");
    cy.assertAccessible();
  });
});
