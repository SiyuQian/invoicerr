export {};

const api = Cypress.env("apiUrl");
const nonce = crypto.randomUUID();
let companyId: string;
let customerId: string;
let partnerId: string;
let inactivePartnerId: string;
let inactiveProjectId: string;
let settlementId: string;
let directInvoiceId: string;
let partnerProjectId: string;
let directProjectId: string;
let caseId: string;
let externalId: string;
let retryProjectId: string;
type Snapshot = {
  sourceRows: Record<string, string[]>;
  queues: unknown;
  events: {
    watermarks: Record<string, { lastGeneratedId: string; entriesAdded: number }>;
    sourceEvents: unknown[];
  };
};
let sourceBefore: Snapshot;
const base = () => `${api}/api/project-reconciliation/projects`;

function field(label: string, value: string) {
  cy.contains('[role="dialog"] label', label)
    .invoke("attr", "for")
    .then((id) => {
      expect(id, `label ${label} has a control`).to.be.a("string");
      cy.get(`[id="${id}"]`).clear().type(value, { parseSpecialCharSequences: false });
    });
}
function choose(label: string, option: string) {
  cy.contains('[role="dialog"] label', label)
    .invoke("attr", "for")
    .then((id) => cy.get(`[id="${id}"]`).click());
  cy.contains('[role="option"]', option).scrollIntoView().click();
  cy.get('[role="listbox"]').should("not.exist");
}
function save() {
  cy.get('[role="dialog"]').contains("button", "Save changes").scrollIntoView().click();
  cy.get('[role="dialog"]').should("not.exist");
}
function measure(label: string, value: string) {
  cy.get('[aria-label="Project measures"]', { timeout: 20000 }).contains("h2", label).parent().should("contain.text", value);
}
function createProject(name: string, mode: "PARTNER" | "COMPANY") {
  cy.contains("button", "New project").click();
  field("Project name", name);
  field("End customer name", "Invented End Customer");
  choose("Currency", "New Zealand Dollar (NZD)");
  choose("Collector", mode === "PARTNER" ? "Partner collects" : "Company collects");
  choose("End customer client", "Invented End Customer");
  choose("Partner client", "Invented Partner");
  cy.intercept("POST", "**/api/project-reconciliation/projects").as("createProject");
  cy.contains("button", "Create project").click();
  return cy.wait("@createProject").then(({ response }) => {
    expect(response?.statusCode).to.equal(201);
    return cy
      .get('[role="dialog"]')
      .should("not.exist")
      .then(() => response!.body.result.id as string);
  });
}
function view(id: string) {
  return cy.request(`${base()}/${id}`).its("body");
}
function mutate(id: string, path: string, data: Record<string, unknown>, method = "POST") {
  return view(id)
    .then((body) =>
      cy.request({
        method,
        url: `${base()}/${id}${path}`,
        body: { ...data, expectedVersion: body.versionToken, requestKey: crypto.randomUUID() },
      }),
    )
    .its("body");
}
function projectDetailReady() {
  cy.contains("button", "Refresh project", { timeout: 20000 }).should("be.visible");
  cy.get('[aria-label="Project measures"]', { timeout: 20000 }).should("exist");
}
function open(id: string) {
  cy.visit(`/project-reconciliation/${id}`);
  projectDetailReady();
}
function newCase(title: string, agreed?: string) {
  cy.contains("button", "New case").click();
  field("Case title", title);
  if (agreed) {
    field("Agreed gross", agreed);
    field("Agreement reference", "Invented written agreement");
  }
  save();
  cy.get(`button[aria-label="Expand ${title}"]`).click();
}
function tabTo(label: string, remaining = 60, group?: string): void {
  cy.document().then((doc) => {
    const active = doc.activeElement as HTMLElement | null;
    const name = active?.getAttribute("aria-label") ?? active?.textContent?.trim();
    if (name === label || (group && active?.closest(group))) {
      cy.task("logStep", `Native Tab reached ${label} after ${60 - remaining} presses (${name})`);
      cy.wrap(active).should("be.visible");
      return;
    }
    expect(remaining, `native Tab can reach ${label}`).to.be.greaterThan(0);
    cy.press(Cypress.Keyboard.Keys.TAB).then(() => tabTo(label, remaining - 1, group));
  });
}
function invoice(client: () => string, amount: number) {
  return cy
    .then(() =>
      cy.request("POST", `${api}/api/documents/types/invoice/actions/save-draft`, {
        data: {
          client: client(),
          currency: "NZD",
          issueDate: "2026-08-15",
          dueDate: "2026-09-15",
          lines: [
            {
              description: `T10 fixture ${nonce}: invoice`,
              quantity: 1,
              unit: "unit",
              unitPrice: amount,
              vatRate: "0",
            },
          ],
        },
      }),
    )
    .its("body.document.id");
}
function payment(id: string, amount: number) {
  return cy.request(`${api}/api/documents/${id}?typeId=invoice`).then(({ body }) =>
    cy.request("POST", `${api}/api/documents/types/invoice/actions/record-payment`, {
      documentId: id,
      data: body.data,
      params: {
        amount,
        currency: "NZD",
        paidAt: "2026-08-20",
        note: "Invented fixture payment outside reconciliation measurement",
      },
    }),
  );
}

describe("Project reconciliation owner workflows", () => {
  before(() => {
    cy.login();
    cy.request("POST", `${api}/api/companies`, {
      name: `T10 Fixture Harness ${nonce}`,
      description: "Invented reconciliation acceptance fixtures",
      phone: "+6400000000",
      email: "reconciliation@example.com",
      address: "1 Invented St",
      city: "Auckland",
      postalCode: "1010",
      country: "New Zealand",
      countryCode: "NZ",
      currency: "NZD",
    }).then(({ body }) => {
      companyId = body.id;
      cy.request("POST", `${api}/api/companies/switch`, { companyId });
    });
    for (const name of ["Invented End Customer", "Invented Partner", "Invented Former Partner"]) {
      cy.request("POST", `${api}/api/clients`, {
        name,
        contactEmail:
          name === "Invented Former Partner"
            ? "former-partner@example.com"
            : name.startsWith("Invented End")
              ? "customer@example.com"
              : "partner@example.com",
        country: "New Zealand",
        countryCode: "NZ",
        currency: "NZD",
        address: "2 Invented St",
        city: "Auckland",
        postalCode: "1010",
        isActive: true,
        type: "COMPANY",
      }).then(({ body }) => {
        if (name.startsWith("Invented End")) customerId = body.id;
        else if (name === "Invented Partner") partnerId = body.id;
        else inactivePartnerId = body.id;
      });
    }
    // Establish the historical association before deactivating its party through the owning API.
    // All fixture setup precedes the measured source/queue window.
    cy.then(() =>
      cy.request("POST", base(), {
        name: "Inactive historical association",
        endCustomerName: "Invented End Customer",
        currency: "NZD",
        collectionMode: "COMPANY",
        endCustomerClientId: customerId,
        partnerClientId: inactivePartnerId,
        timeProjectId: null,
        description: null,
        expectedVersion: "new",
        requestKey: crypto.randomUUID(),
      }),
    ).then(({ body }) => {
      inactiveProjectId = body.result.id;
      cy.request("DELETE", `${api}/api/clients/${inactivePartnerId}`)
        .its("body.isActive")
        .should("equal", false);
    });
    // Canonical historical setup only: draft API, bounded fixed legacy recipe, owning payment API.
    invoice(() => partnerId, 1150).then((id) => {
      settlementId = id;
    });
    invoice(() => customerId, 1725).then((id) => {
      directInvoiceId = id;
    });
    cy.then(() =>
      cy.task("reconciliationPrepareLegacyFixtures", {
        companyId,
        fixtureNonce: nonce,
        invoiceIds: [settlementId, directInvoiceId],
        undatedExpenseId: null,
      }),
    );
    cy.then(() => payment(settlementId, 1150));
    cy.then(() => payment(directInvoiceId, 690));
    cy.then(() => payment(directInvoiceId, 1035));
    cy.then(() => cy.task<Snapshot>("reconciliationSourceSnapshot", { companyIds: [companyId] })).then(
      (value) => {
        sourceBefore = value;
      },
    );
  });

  beforeEach(() => {
    cy.login();
    cy.request("POST", `${api}/api/companies/switch`, { companyId });
    cy.intercept("**/*ledgerly*", () => {
      throw new Error("Ordinary project use must not contact Ledgerly");
    });
    cy.intercept("POST", /\/api\/documents\/types\/[^/]+\/actions\/(send|record-payment)(?:\?|$)/, () => {
      throw new Error("Reconciliation must not send or register a canonical payment");
    });
    cy.visit("/project-reconciliation");
    // API switching invalidates the session; wait for the UI's actual company before opening a draft.
    cy.contains("button", `T10 Fixture Harness ${nonce}`, { timeout: 15000 }).should("be.visible");
  });

  it("retains an inactive historical party through a real unrelated edit and reload", () => {
    open(inactiveProjectId);
    view(inactiveProjectId).then(({ project }) => {
      expect(project.partnerClientId).to.equal(inactivePartnerId);
      expect(project.partnerClient).to.include({
        id: inactivePartnerId,
        name: "Invented Former Partner",
        inactive: true,
      });
    });
    cy.contains("button", "Edit project").click();
    cy.contains('[role="dialog"] button', "Invented Former Partner (Inactive)")
      .scrollIntoView()
      .should("be.visible");
    choose("Partner client", "Invented Former Partner (Inactive)");
    field("Description", "Unrelated historical project note");
    cy.contains("button", "Save project").click();
    cy.get('[role="dialog"]').should("not.exist");
    cy.reload();
    projectDetailReady();
    view(inactiveProjectId).then(({ project }) => {
      expect(project.partnerClientId).to.equal(inactivePartnerId);
      expect(project.partnerClient).to.include({ id: inactivePartnerId, inactive: true });
      expect(project.description).to.equal("Unrelated historical project note");
    });
    cy.contains("button", "Edit project").click();
    cy.contains('[role="dialog"] button', "Invented Former Partner (Inactive)")
      .scrollIntoView()
      .should("be.visible");
    cy.contains('[role="dialog"] button', "Cancel").click();
  });

  it("keeps a source Paid label separate from checked cash and our own paid settlement invoice", () => {
    createProject("Partner historical collection", "PARTNER").then((id) => {
      partnerProjectId = id;
      open(id);
    });
    newCase("Paid source without receipt proof", "1150");
    cy.contains("button", "Add external customer reference").click();
    field("Issuer", "Invented Partner");
    field("Recipient", "Invented End Customer");
    field("Invoice number", "EXTERNAL-2300");
    field("Original gross", "2300");
    field("Reported source status", "Paid");
    field("Source reference", "Invented historical export; no bank proof");
    save();
    cy.then(() => view(partnerProjectId)).then((body) => {
      caseId = body.cases.items[0].id;
      externalId = body.cases.items[0].customerInvoices[0].id;
      expect(body.sourceMarkedPaid.knownMinor).to.equal(230000);
      expect(body.checkedReceipts.completeness).to.equal("UNKNOWN");
      return mutate(partnerProjectId, "/document-links", {
        documentId: settlementId,
        typeId: "invoice",
        caseId,
        role: "SETTLEMENT_INCOME",
      });
    });
    cy.then(() => open(partnerProjectId));
    measure("Marked paid by source", "2300.00 NZD");
    measure("Customer receipts checked", "Unknown");
    measure("Our recorded receipts", "1150.00 NZD");
    measure("Overall own invoice outstanding", "0.00 NZD");
    cy.contains("A Paid source status is not receipt evidence").scrollIntoView().should("be.visible");
    cy.assertAccessible();
  });

  it("promotes one reported receipt without duplication and allocates two checked undated receipts", () => {
    open(partnerProjectId);
    cy.contains('[role="tab"]', "Evidence and differences").click();
    cy.contains("button", "Add external receipt").click();
    field("Receipt amount", "1000");
    field("Evidence reference", "Invented bank statement A");
    field("Reason", "Invented partner report");
    save();
    cy.contains("article", "Invented bank statement A").within(() =>
      cy.contains("button", "Edit external receipt").click(),
    );
    choose("Evidence class", "Evidence checked");
    field("Reason", "Checked invented statement, no bank connection");
    cy.get('[role="dialog"] [role="checkbox"]').click();
    save();
    cy.contains("article", "Invented bank statement A").within(() =>
      cy.contains("button", "Allocate receipt").click(),
    );
    cy.get('[role="dialog"]').contains("button", "Add allocation").click();
    field("Allocation for EXTERNAL-2300", "1000");
    save();
    cy.contains("button", "Add external receipt").click();
    field("Receipt amount", "1300");
    choose("Evidence class", "Evidence checked");
    field("Evidence reference", "Invented bank statement B");
    field("Reason", "Checked invented second statement");
    cy.get('[role="dialog"] [role="checkbox"]').click();
    save();
    cy.contains("article", "Invented bank statement B").within(() =>
      cy.contains("button", "Allocate receipt").click(),
    );
    cy.get('[role="dialog"]').contains("button", "Add allocation").click();
    field("Allocation for EXTERNAL-2300", "1300");
    save();
    measure("Customer receipts checked", "2300.00 NZD");
    measure("Our recorded receipts", "1150.00 NZD");
    cy.then(() => view(partnerProjectId)).then((body) => {
      expect(body.checkedReceipts.knownMinor).to.equal(230000);
      expect(body.undated.checkedReceipts).to.include({ knownMinor: 230000, count: 2 });
    });
    cy.then(() => cy.request(`${base()}/${partnerProjectId}/receipts`))
      .then(({ body }) => {
        expect(body.items).to.have.length(2);
        expect(
          body.items.every((row: { evidenceClass: string }) => row.evidenceClass === "EVIDENCE_CHECKED"),
        ).to.equal(true);
        const receipt = body.items[1];
        return view(partnerProjectId).then((current) =>
          cy.request({
            method: "PUT",
            url: `${base()}/${partnerProjectId}/receipts/${receipt.id}/allocations`,
            failOnStatusCode: false,
            body: {
              allocations: [{ customerInvoiceId: externalId, amountMinor: receipt.amountMinor + 1 }],
              expectedVersion: current.versionToken,
              requestKey: crypto.randomUUID(),
            },
          }),
        );
      })
      .its("status")
      .should("equal", 409);
    cy.request(`${base()}/${partnerProjectId}?cashFrom=2026-08-01&cashTo=2026-12-31`)
      .its("body")
      .then((body) => {
        expect(body.checkedReceipts.knownMinor).to.equal(0);
        expect(body.undated.checkedReceipts).to.include({ knownMinor: 230000, count: 2 });
      });
    cy.assertAccessible();
  });

  it("excludes undated checked receipts from an actual picked cash-date range and matching CSV", () => {
    open(partnerProjectId);
    cy.contains("label", "Receipt date from")
      .invoke("attr", "for")
      .then((id) => cy.get(`[id="${id}"]`).click());
    let pickedDate: string;
    cy.window().then((win) => {
      const today = new win.Date();
      pickedDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    });
    cy.contains("button", "Today").scrollIntoView().click();
    cy.intercept("GET", `**/api/project-reconciliation/projects/${partnerProjectId}?*`).as("datedView");
    cy.contains("button", "Apply date filters").click();
    cy.wait("@datedView").then(({ request, response }) => {
      expect(new URL(request.url).searchParams.get("cashFrom")).to.equal(pickedDate);
      expect(response?.body.checkedReceipts.knownMinor).to.equal(0);
      expect(response?.body.undated.checkedReceipts).to.include({ knownMinor: 230000, count: 2 });
    });
    measure("Customer receipts checked", "0.00 NZD");
    cy.contains("h2", "Undated lifetime amounts and counts").parent().should("contain.text", "2300.00 NZD");
    cy.intercept("GET", "**/export.csv?*").as("datedCsv");
    cy.contains("button", "Export CSV").click();
    cy.wait("@datedCsv").then(({ request, response }) => {
      expect(new URL(request.url).searchParams.get("cashFrom")).to.equal(pickedDate);
      expect(response?.statusCode).to.equal(200);
      const rows = String(response?.body).split(/\r?\n/);
      // These two comma-free, controlled aggregate rows avoid parsing quoted source-detail cells.
      const prefix = `${partnerProjectId},Partner historical collection,NZD,,,`;
      const dated = rows.find((row) => row.startsWith(`${prefix}measure,,checkedReceipts,`));
      const undated = rows.find((row) => row.startsWith(`${prefix}undated,,checkedReceipts,`));
      expect(dated, "dated checked-cash CSV aggregate").to.be.a("string");
      expect(undated, "undated checked-cash CSV disclosure").to.be.a("string");
      expect(dated!.split(",")[8]).to.equal("0");
      expect(dated!.split(",")[11]).to.equal("in period: cash date");
      expect(undated!.split(",")[8]).to.equal("230000");
      expect(undated!.split(",")[11]).to.equal("overall; excluded from dated cash");
      expect(undated!.split(",")[12]).to.equal("2");
    });
  });

  it("imports an invented customer reference through preview and confirm without inventing an agreement", () => {
    open(partnerProjectId);
    cy.contains("button", "Import historical project references").click();
    const payload = {
      sourceSystem: "ledgerly",
      sourceAsOf: "2026-11-01T00:00:00Z",
      currency: "NZD",
      project: {
        id: "invented-import-project",
        name: "Partner historical collection",
        customerIssuer: "Invented Partner",
        customerRecipient: "Invented End Customer",
        shareIssuer: "Invented Company",
        shareRecipient: "Invented Partner",
      },
      invoices: [
        {
          id: "invented-import-customer",
          projectId: "invented-import-project",
          number: "IMPORTED-NO-AGREEMENT",
          projectName: "Partner historical collection",
          issuer: "Invented Partner",
          recipient: "Invented End Customer",
          kind: "Customer invoice",
          status: "Paid",
          issueDate: null,
          dueDate: null,
          paidDate: null,
          exGstAmountCents: 10000,
          gstAmountCents: 1500,
          totalCents: 11500,
          sharePercent: null,
          sourceNumber: null,
          linkedInvoiceNumber: null,
        },
      ],
    };
    field("Ledgerly project payload JSON", JSON.stringify(payload));
    choose("Source currency", "NZD");
    field("Source as of", "2026-11-01T00:00:00Z");
    cy.intercept("POST", "**/import/preview").as("preview");
    cy.contains("button", "Preview import").click();
    cy.wait("@preview").its("response.statusCode").should("equal", 200);
    cy.contains("Import proposals").scrollIntoView().should("be.visible");
    cy.contains('[role="dialog"]', "Overall agreed settlement: Unknown").should("exist");
    cy.assertAccessible();
    cy.intercept("POST", "**/import/confirm").as("confirm");
    cy.contains("button", "Confirm import").scrollIntoView().click();
    cy.wait("@confirm").then(({ request, response }) => {
      expect(response?.statusCode).to.equal(201);
      cy.request("POST", request.url, request.body).its("status").should("equal", 200);
      cy.request({
        method: "POST",
        url: request.url,
        failOnStatusCode: false,
        body: {
          ...request.body,
          payload: {
            ...request.body.payload,
            project: { ...request.body.payload.project, name: "Changed payload with same key" },
          },
        },
      })
        .its("status")
        .should("equal", 409);
    });
    cy.get('[role="dialog"]').should("not.exist");
    cy.then(() => view(partnerProjectId)).then((body) => {
      const imported = body.cases.items.find(
        (row: { title: string }) => row.title === "IMPORTED-NO-AGREEMENT",
      );
      expect(imported.agreedGrossMinor).to.equal(null);
      expect(body.unknownAgreementCount).to.equal(1);
      expect(body.summary.ownRecordedReceipts.knownMinor).to.equal(115000);
    });
    cy.contains("button", "IMPORTED-NO-AGREEMENT").scrollIntoView().should("be.visible");
    cy.request(`${base()}/${partnerProjectId}/history?limit=100`)
      .its("body.items")
      .then((items) =>
        expect(
          items.filter((row: { operation: string }) => row.operation === "import.confirm"),
        ).to.have.length(1),
      );
  });

  it("creates a direct collection project and counts its two canonical payments exactly once", () => {
    createProject("Company direct collection", "COMPANY").then((id) => {
      directProjectId = id;
      open(id);
    });
    newCase("Direct customer work", "1725");
    cy.then(() => view(directProjectId)).then((body) =>
      mutate(directProjectId, "/document-links", {
        documentId: directInvoiceId,
        typeId: "invoice",
        caseId: body.cases.items[0].id,
        role: "CUSTOMER_INVOICE",
      }),
    );
    cy.then(() => open(directProjectId));
    measure("Our recorded receipts", "1725.00 NZD");
    measure("Overall own invoice outstanding", "0.00 NZD");
    cy.get('button[aria-label="Expand Direct customer work"]').click();
    cy.get(`a[href="/documents/invoice/${directInvoiceId}"]`).scrollIntoView().click();
    cy.location("pathname", { timeout: 15000 }).should("equal", `/documents/invoice/${directInvoiceId}`);
    cy.get('[data-cy="document-detail-page"]', { timeout: 15000 }).should("be.visible");
    cy.get('[data-cy="document-form-number"]')
      .should("have.text", `T10-LEGACY-${nonce}-${directInvoiceId}`);
    cy.go("back");
    cy.then(() =>
      cy.location("pathname", { timeout: 15000 }).should("equal", `/project-reconciliation/${directProjectId}`),
    );
    measure("Our recorded receipts", "1725.00 NZD");
    cy.contains('[role="tab"]', "Evidence and differences").click();
    cy.contains("button", "Add receipt evidence").should("not.exist");
    cy.contains('[role="tab"]', "Costs and history").click();
    cy.assertAccessible();
  });

  it("retries a committed create with the same body and key after a lost successful response", () => {
    let committed: Record<string, unknown>;
    let createdId: string;
    cy.intercept({ method: "POST", url: "**/api/project-reconciliation/projects", times: 1 }, (request) => {
      committed = request.body;
      request.continue((response) => {
        expect(response.statusCode).to.equal(201);
        createdId = response.body.result.id;
        // The real server committed. Replace only its delivery to exercise uncertain transport recovery.
        response.send({
          statusCode: 503,
          body: { message: "Synthetic successful response lost after commit" },
        });
      });
    }).as("lostCreate");
    cy.contains("button", "New project").click();
    field("Project name", "Uncertain create retry");
    field("End customer name", "Invented End Customer");
    choose("Currency", "New Zealand Dollar (NZD)");
    choose("End customer client", "Invented End Customer");
    cy.contains("button", "Create project").click();
    cy.wait("@lostCreate");
    cy.contains("Could not save the project").scrollIntoView().should("be.visible");
    choose("Currency", "New Zealand Dollar (NZD)");
    choose("Collector", "Company collects");
    choose("End customer client", "Invented End Customer");
    cy.intercept("POST", "**/api/project-reconciliation/projects").as("retryCreate");
    cy.contains("button", "Create project").click();
    cy.wait("@retryCreate").then(({ request, response }) => {
      expect(request.body).to.deep.equal(committed);
      expect(response?.statusCode).to.equal(200);
      expect(response?.body.result.id).to.equal(createdId);
      retryProjectId = createdId;
    });
    cy.get('[role="dialog"]').should("not.exist");
    cy.request(`${base()}?search=Uncertain%20create%20retry`).its("body.total").should("equal", 1);
  });

  it("keeps a real stale-edit conflict through same-value selectors and reloads explicitly", () => {
    open(retryProjectId);
    cy.contains("button", "Edit project").click();
    cy.then(() => mutate(retryProjectId, "", { description: "Concurrent invented owner edit" }, "PATCH"));
    field("Description", "My preserved draft");
    cy.intercept("PATCH", `**/api/project-reconciliation/projects/${retryProjectId}`).as("staleSave");
    cy.contains("button", "Save project").click();
    cy.wait("@staleSave").its("response.statusCode").should("equal", 409);
    cy.contains("This project changed. Reload it before saving your changes.")
      .scrollIntoView()
      .should("be.visible");
    choose("Currency", "New Zealand Dollar (NZD)");
    choose("Collector", "Company collects");
    choose("End customer client", "Invented End Customer");
    choose("Time-tracking project", "None selected");
    cy.contains("button", "Save project").should("be.disabled");
    cy.get('[role="dialog"] [role="alert"]').should("contain.text", "This project changed");
    cy.contains("button", "Reload project").scrollIntoView().click();
    cy.contains("button", "Save project").should("not.be.disabled");
    field("Description", "New reviewed draft");
    cy.contains("button", "Save project").click();
    cy.get('[role="dialog"]').should("not.exist");
    cy.then(() => view(retryProjectId))
      .its("project.description")
      .should("equal", "New reviewed draft");
  });

  it("uses native keyboard navigation through a dialog, selector, tabs and project row menu", () => {
    cy.contains("button", "New project").should("be.visible");
    tabTo("New project");
    cy.press(Cypress.Keyboard.Keys.SPACE);
    cy.focused().should("have.attr", "name", "name").type("Keyboard draft");
    cy.press(Cypress.Keyboard.Keys.TAB);
    cy.focused().should("have.attr", "name", "endCustomerName").type("Invented Keyboard Customer");
    cy.press(Cypress.Keyboard.Keys.TAB);
    cy.focused().should("contain.text", "Choose a currency");
    // Independent real-browser Enter also opens this and the core Quote selector. Cypress's
    // native Enter did not activate this button in this environment; native Space is a valid button key.
    cy.press(Cypress.Keyboard.Keys.SPACE);
    cy.get('[role="combobox"]').should("be.focused").type("NZD");
    cy.press(Cypress.Keyboard.Keys.DOWN);
    cy.press(Cypress.Keyboard.Keys.ENTER);
    cy.contains('[role="dialog"] button', "New Zealand Dollar (NZD)").should("be.focused");
    cy.press(Cypress.Keyboard.Keys.ESC);
    cy.get('[role="dialog"]').should("not.exist");
    cy.contains("button", "New project").should("be.focused");
    tabTo("Project actions: Partner historical collection");
    cy.focused().type("{enter}");
    cy.get('[role="menu"]').should("be.visible");
    cy.focused().should("have.attr", "role", "menuitem");
    cy.assertAccessible();
    cy.focused().type("e{enter}");
    cy.get('[role="dialog"]').should("be.visible");
    const opener = 'button[aria-label="Project actions: Partner historical collection"]';
    cy.get(opener).then(($button) => $button.css("display", "none"));
    cy.press(Cypress.Keyboard.Keys.ESC);
    cy.get('[role="dialog"]').should("not.exist");
    cy.get('input[placeholder="Search project or end customer"]').should("be.focused");
    cy.get(opener).then(($button) => $button.css("display", ""));
    cy.get('[role="menu"]').should("not.exist");
    open(partnerProjectId);
    cy.contains('[role="tab"]', "Reconciliation")
      .should("have.attr", "aria-selected", "true");
    // Before entry Radix makes the group the tab stop; the selected trigger becomes the stop on entry.
    cy.get('[role="tablist"]').should("have.attr", "tabindex", "0");
    cy.document().then((doc) =>
      cy.task("logStep", `Loaded selected tab; traversal starts at ${doc.activeElement?.tagName}`),
    );
    tabTo("Reconciliation", 60, '[role="tablist"]');
    cy.contains('[role="tab"]', "Reconciliation").should("be.focused");
    cy.press(Cypress.Keyboard.Keys.RIGHT);
    cy.contains('[role="tab"]', "Evidence and differences")
      .should("have.attr", "aria-selected", "true")
      .and("be.focused");
    cy.press(Cypress.Keyboard.Keys.RIGHT);
    cy.contains('[role="tab"]', "Costs and history").should("have.attr", "aria-selected", "true");
    cy.assertAccessible();
  });

  for (const width of [390, 768, 1440])
    for (const theme of ["light", "dark"]) {
      it(`renders real list, detail tabs and dialogs at ${width}px in ${theme} theme`, () => {
        cy.viewport(width, width === 390 ? 844 : 1000);
        cy.window().its("innerWidth").should("equal", width);
        cy.window().then((win) => win.localStorage.setItem("vite-ui-theme", theme));
        cy.reload();
        cy.get("html").should("have.class", theme);
        cy.get('input[placeholder="Search project or end customer"]', { timeout: 15000 }).type("Partner");
        cy.contains("a", "Partner historical collection", { timeout: 15000 }).should("be.visible");
        cy.contains("button", "Partner collects").click();
        cy.contains("button", "Needs attention").click();
        cy.assertAccessible();
        cy.screenshot(`reconciliation-list-${width}-${theme}`, { capture: "fullPage" });
        cy.contains("a", "Partner historical collection", { timeout: 15000 }).click();
        projectDetailReady();
        cy.contains("h1", "Partner historical collection").scrollIntoView();
        cy.screenshot(`reconciliation-summary-${width}-${theme}`, { capture: "viewport" });
        cy.task("logStep", `viewport/theme ${width}/${theme}: list, summary, three tabs and receipt dialog`);
        for (const tab of ["Reconciliation", "Evidence and differences", "Costs and history"]) {
          cy.contains('[role="tab"]', tab).scrollIntoView().click();
          cy.assertAccessible();
          cy.screenshot(`reconciliation-${tab}-${width}-${theme}`, { capture: "fullPage" });
        }
        cy.contains('[role="tab"]', "Evidence and differences").click();
        cy.contains("button", "Add external receipt").click();
        cy.assertAccessible();
        cy.screenshot(`reconciliation-receipt-dialog-${width}-${theme}`, { capture: "viewport" });
        cy.get('[role="dialog"]').contains("button", "Cancel").click();
        cy.get('[role="dialog"]').should("not.exist");
        open(directProjectId);
        measure("Our recorded receipts", "1725.00 NZD");
        cy.assertAccessible();
        cy.screenshot(`reconciliation-company-summary-${width}-${theme}`, { capture: "viewport" });
        cy.contains('[role="tab"]', "Evidence and differences").scrollIntoView().click();
        cy.contains("button", "Add external receipt").should("not.exist");
        cy.assertAccessible();
        cy.document().then((doc) =>
          expect(doc.documentElement.scrollWidth, "page has no horizontal overflow").to.be.at.most(width),
        );
      });
    }

  it("exports the actual project CSV and archives/restores it through the register", () => {
    open(partnerProjectId);
    cy.intercept("GET", "**/export.csv*").as("csv");
    cy.contains("button", "Export CSV").click();
    cy.wait("@csv").then(({ response }) => {
      expect(response?.statusCode).to.equal(200);
      expect(String(response?.body)).to.include("EXTERNAL-2300");
    });
    cy.visit("/project-reconciliation");
    cy.get('button[aria-label="Project actions: Partner historical collection"]', { timeout: 15000 }).click();
    cy.contains('[role="menuitem"]', "Archive project").click();
    // A loading register must not satisfy the archived-row absence check.
    cy.get("body", { timeout: 15000 }).should(($body) => {
      expect($body.find('[data-cy="reconciliation-loading"]')).to.have.length(0);
      expect($body.find('button[aria-label="Project actions: Partner historical collection"]')).to.have.length(0);
      expect($body.find("a").filter((_, link) => link.textContent === "Inactive historical association")).to.have.length(1);
    });
    cy.contains("a", "Partner historical collection").should("not.exist");
    cy.contains("button", "Archived").click();
    cy.contains("a", "Partner historical collection", { timeout: 15000 }).should("be.visible");
    cy.get('button[aria-label="Project actions: Partner historical collection"]', { timeout: 15000 }).click();
    cy.contains('[role="menuitem"]', "Restore project").click();
    cy.contains("button", "Active").click();
    cy.contains("a", "Partner historical collection", { timeout: 15000 }).should("be.visible");
  });

  it("leaves canonical sources, numbering and outgoing source work unchanged through every UI workflow", () => {
    cy.then(() =>
      cy.task<Snapshot>("reconciliationSourceSnapshot", {
        companyIds: [companyId],
        since: sourceBefore.events.watermarks,
      }),
    ).then((after) => {
      expect(after.sourceRows).to.deep.equal(sourceBefore.sourceRows);
      expect(after.queues).to.deep.equal(sourceBefore.queues);
      expect(after.events.sourceEvents).to.deep.equal([]);
    });
  });
});
