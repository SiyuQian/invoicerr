export {}; // makes this spec a module, not a global script -- see tsconfig.json

beforeEach(() => {
	cy.login();
});

/**
 * The client dialog (client-upsert.tsx) shows every section on one page (form-page-dialog.tsx):
 * Identity, Address, Tax & identifiers, Contact & portal, Summary. Saving validates the whole form
 * first, so a validation test fills what it needs and clicks save.
 */
function expectClientDetail(label: string, value: string): void {
	cy.get('[data-cy="client-view-dialog"]')
		.contains("dt", label)
		.next("dd")
		.should("have.text", value);
}

describe("Clients E2E", () => {

	describe("Extended Address Fields", () => {
		it("creates a client with addressLine2 and state (US address)", () => {
			cy.visit("/clients");
			cy.contains("button", /add|new|créer|ajouter/i, {
				timeout: 10000,
			}).click();

			cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should(
				"be.visible",
			);

			cy.get('[name="name"]').clear().type("Tech Innovations LLC");

			cy.selectCountry("client-country-select", "France");
			cy.get('[name="address"]').clear().type("456 Innovation Drive");
			cy.get('[name="addressLine2"]').clear().type("Suite 200");
			cy.get('[name="postalCode"]').clear().type("94105");
			cy.get('[name="city"]').clear().type("San Francisco");
			cy.get('[name="state"]').clear().type("CA");

			cy.get('[data-cy="client-identifier-LEGAL_ID"]', { timeout: 10000 })
				.clear()
				.type("112233445");

			cy.get('[name="contacts.0.email"]').clear().type("info@techinnovations.com");

			cy.get('[data-cy="client-submit"]').click();

			cy.get('[data-cy="client-dialog"]').should("not.exist");
			cy.contains("Tech Innovations", { timeout: 10000 });
		});

		it("verifies addressLine2 and state are displayed in client view", () => {
			cy.visit("/clients");
			cy.get('[data-cy="view-client-button-info@techinnovations.com"]', { timeout: 15000 }).click();
			expectClientDetail("Address", "456 Innovation Drive");
			expectClientDetail("Address Line 2", "Suite 200");
			expectClientDetail("State/Province", "CA");
		});

		it("creates a client with addressLine2 only (European address)", () => {
			cy.visit("/clients");
			cy.contains("button", /add|new|créer|ajouter/i, {
				timeout: 10000,
			}).click();

			cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should(
				"be.visible",
			);

			cy.get('[name="name"]').clear().type("European Solutions GmbH");

			cy.selectCountry("client-country-select", "Germany");
			cy.get('[name="address"]').clear().type("Hauptstrasse 42");
			cy.get('[name="addressLine2"]').clear().type("3. Etage");
			cy.get('[name="postalCode"]').clear().type("10115");
			cy.get('[name="city"]').clear().type("Berlin");

			cy.get('[data-cy="client-identifier-LEGAL_ID"]', { timeout: 10000 })
				.clear()
				.type("DE987654321");

			cy.get('[name="contacts.0.email"]').clear().type("contact@eusolutions.de");

			cy.get('[data-cy="client-submit"]').click();

			cy.get('[data-cy="client-dialog"]').should("not.exist");
			cy.contains("European Solutions", { timeout: 10000 });
		});

		it("creates a client without addressLine2 and state (backward compatibility)", () => {
			cy.visit("/clients");
			cy.contains("button", /add|new|créer|ajouter/i, {
				timeout: 10000,
			}).click();

			cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should(
				"be.visible",
			);

			cy.get('[name="name"]').clear().type("Simple Company Ltd");

			cy.selectCountry("client-country-select", "France");
			cy.get('[name="address"]').clear().type("10 Downing Street");
			cy.get('[name="postalCode"]').clear().type("SW1A 2AA");
			cy.get('[name="city"]').clear().type("London");

			cy.get('[data-cy="client-identifier-LEGAL_ID"]', { timeout: 10000 })
				.clear()
				.type("123456789");

			cy.get('[name="contacts.0.email"]').clear().type("info@simple.co.uk");

			cy.get('[data-cy="client-submit"]').click();

			cy.get('[data-cy="client-dialog"]').should("not.exist");
			cy.contains("Simple Company", { timeout: 10000 });
		});

		it("edits a client and adds addressLine2 and state", () => {
			cy.visit("/clients");
			cy.wait(2000);

			cy.get('[data-cy="edit-client-button-info@simple.co.uk"]').click();

			cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should(
				"be.visible",
			);
			cy.get('[name="addressLine2"]').clear().type("Building B");
			cy.get('[data-cy="client-submit"]').click();

			cy.get('[data-cy="client-dialog"]').should("not.exist");
			cy.wait(2000);

			cy.get('[data-cy="view-client-button-info@simple.co.uk"]').click();
			expectClientDetail("Address Line 2", "Building B");
		});
	});

	describe("Edge Cases", () => {
		it("handles special characters in name", () => {
			cy.visit("/clients");
			cy.contains("button", /add|new|créer|ajouter/i, {
				timeout: 10000,
			}).click();

			cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should(
				"be.visible",
			);

			cy.get('[name="name"]').clear().type("O'Reilly & Associates, Inc.");

			cy.selectCountry("client-country-select", "France");
			cy.get('[name="address"]').clear().type("789 Publishing Way");
			cy.get('[name="postalCode"]').clear().type("11111");
			cy.get('[name="city"]').clear().type("New York");

			cy.get('[data-cy="client-identifier-LEGAL_ID"]', { timeout: 10000 })
				.clear()
				.type("987654321");

			cy.get('[name="contacts.0.email"]').clear().type("info@oreilly.com");

			cy.get('[data-cy="client-submit"]').click();

			cy.get('[data-cy="client-dialog"]').should("not.exist");
			cy.contains("O'Reilly", { timeout: 10000 });
		});

		it("handles unicode characters", () => {
			cy.visit("/clients");
			cy.contains("button", /add|new|créer|ajouter/i, {
				timeout: 10000,
			}).click();

			cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should(
				"be.visible",
			);

			cy.get('[name="name"]').clear().type("Société Française SAS");

			cy.selectCountry("client-country-select", "France");
			cy.get('[name="address"]').clear().type("1 Rue de la Paix");
			cy.get('[name="postalCode"]').clear().type("75001");
			cy.get('[name="city"]').clear().type("Paris");

			// SIREN is nine digits and nothing else (countries/data/fr.json (section "identifiers"), sourced to INSEE),
			// and that shape is now enforced on save. The VAT field keeps its FR-prefixed value: VAT is
			// deliberately exempt from the generic pattern check and validated by tax/vat-syntax.ts.
			cy.get('[data-cy="client-identifier-LEGAL_ID"]', { timeout: 10000 })
				.clear()
				.type("123456789");
			cy.get('[data-cy="client-identifier-VAT"]').clear().type("FR12345678901");

			cy.get('[name="contacts.0.email"]').clear().type("contact@societe.fr");

			cy.get('[data-cy="client-submit"]').click();

			cy.get('[data-cy="client-dialog"]').should("not.exist");
			cy.contains("Société Française", { timeout: 10000 });
		});

		// USER DECISION (2026-09-01, "SIRET vs SIREN sur la facture", now RESOLVED) —
		// `countries/data/fr.json (section "identifiers")`'s LEGAL_ID field accepts EITHER a 9-digit SIREN or a
		// 14-digit SIRET (see that file's own `notes`). Every OTHER FR fixture in this spec types a
		// 14-digit-shaped value (unaffected by the decision — both lengths pass); this is the one
		// that proves the 9-digit SIREN saves too, at the screen.
		it("accepts a bare 9-digit SIREN for a French company client (SIREN or SIRET, decision 2026-09-01)", () => {
			cy.visit("/clients");
			cy.contains("button", /add|new|créer|ajouter/i, {
				timeout: 10000,
			}).click();

			cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should(
				"be.visible",
			);

			cy.get('[name="name"]').clear().type("SIREN Seul SARL");

			cy.selectCountry("client-country-select", "France");
			cy.get('[name="address"]').clear().type("2 Rue de la Paix");
			cy.get('[name="postalCode"]').clear().type("75001");
			cy.get('[name="city"]').clear().type("Paris");

			cy.get('[data-cy="client-identifier-LEGAL_ID"]', { timeout: 10000 })
				.clear()
				.type("123456789");

			cy.get('[name="contacts.0.email"]').clear().type("contact@siren-seul.fr");

			cy.get('[data-cy="client-submit"]').click();

			cy.get('[data-cy="client-dialog"]').should("not.exist");
			cy.contains("SIREN Seul", { timeout: 10000 });
		});

		it("accepts valid EU VAT format", () => {
			cy.visit("/clients");
			cy.contains("button", /add|new|créer|ajouter/i, {
				timeout: 10000,
			}).click();

			cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should(
				"be.visible",
			);

			cy.get('[name="name"]').clear().type("German Company GmbH");

			cy.selectCountry("client-country-select", "Germany");
			cy.get('[name="address"]').clear().type("Hauptstrasse 1");
			cy.get('[name="postalCode"]').clear().type("10115");
			cy.get('[name="city"]').clear().type("Berlin");

			cy.get('[data-cy="client-identifier-LEGAL_ID"]', { timeout: 10000 })
				.clear()
				.type("DE123456789");
			cy.get('[data-cy="client-identifier-VAT"]').clear().type("DE123456789");

			cy.get('[name="contacts.0.email"]').clear().type("contact@german.de");

			cy.get('[data-cy="client-submit"]').click();

			cy.get('[data-cy="client-dialog"]').should("not.exist");
			cy.contains("German Company", { timeout: 10000 });
		});
	});

	// The Peppol scheme selector (`peppolSchemeId`, client-upsert.tsx, now on the Tax & identifiers
	// step). Every label asserted below is quoted VERBATIM from the Peppol v9.7 Participant Identifier
	// Schemes codelist (docs.peppol.eu/edelivery/codelists/) — see that component's own inline comments
	// for the exact source citation on each entry.
	describe("Peppol scheme selector", () => {
		it("offers the 7 EAS the 2026-09-02 B2G audit added routing rules for, but this selector never offered", () => {
			cy.visit("/clients");
			cy.contains("button", /add|new|créer|ajouter/i, {
				timeout: 10000,
			}).click();
			cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should(
				"be.visible",
			);

			cy.get('[name="name"]').clear().type("Peppol Scheme Test SARL");
			cy.selectCountry("client-country-select", "France");
			cy.get('[name="address"]').clear().type("1 Rue Test");
			cy.get('[name="postalCode"]').clear().type("75001");
			cy.get('[name="city"]').clear().type("Paris");

			cy.get('[data-cy="client-peppol-scheme-select"]')
				.scrollIntoView()
				.click();

			// b2g-routing/data/{ee,lt,lv,lu,cy,gr,mt}.json each cite the exact same string.
			cy.get('[data-cy="client-peppol-scheme-option-0191"]').should(
				"contain.text",
				"0191 — EE Company code",
			);
			cy.get('[data-cy="client-peppol-scheme-option-0200"]').should(
				"contain.text",
				"0200 — LT Legal entity code",
			);
			cy.get('[data-cy="client-peppol-scheme-option-0218"]').should(
				"contain.text",
				"0218 — LV Unified registration number",
			);
			cy.get('[data-cy="client-peppol-scheme-option-0240"]').should(
				"contain.text",
				"0240 — LU Register of legal persons",
			);
			// Cyprus/Greece/Malta have no dedicated business-register scheme in the codelist — only
			// their VAT scheme exists (each file's own notes).
			cy.get('[data-cy="client-peppol-scheme-option-9928"]').should(
				"contain.text",
				"9928 — CY VAT number",
			);
			cy.get('[data-cy="client-peppol-scheme-option-9933"]').should(
				"contain.text",
				"9933 — GR VAT number",
			);
			cy.get('[data-cy="client-peppol-scheme-option-9943"]').should(
				"contain.text",
				"9943 — MT VAT number",
			);
		});

		it('0106 is labelled NL KVK (was wrongly "DK CVR"), and the real Danish CVR, 0184, is now offered', () => {
			cy.visit("/clients");
			cy.contains("button", /add|new|créer|ajouter/i, {
				timeout: 10000,
			}).click();
			cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should(
				"be.visible",
			);

			cy.get('[name="name"]').clear().type("Peppol Scheme Test 2 SARL");
			cy.selectCountry("client-country-select", "France");
			cy.get('[name="address"]').clear().type("1 Rue Test");
			cy.get('[name="postalCode"]').clear().type("75001");
			cy.get('[name="city"]').clear().type("Paris");

			cy.get('[data-cy="client-peppol-scheme-select"]')
				.scrollIntoView()
				.click();

			// 0106 = "Vereniging van Kamers van Koophandel en Fabrieken in Nederland" (NL, the KVK)
			// in the codelist — never Danish. Re-verified live against the v9.7 codelist on
			// 2026-09-03 (see client-upsert.tsx's own comment for the full citation).
			cy.get('[data-cy="client-peppol-scheme-option-0106"]')
				.should("contain.text", "0106 — NL KVK")
				.and("not.contain.text", "DK");
			// 0184 = "The Danish Business Authority - CVR-number (DK:CVR)" — the REAL Danish CVR.
			cy.get('[data-cy="client-peppol-scheme-option-0184"]').should(
				"contain.text",
				"0184 — DK CVR",
			);
		});
	});

	describe("Delete Clients", () => {
		// This describe used to target "contact@german.de", a client created by an EARLIER test in
		// this same file's "Create Clients" describe (~15 client-creating tests run before this one,
		// none of them resetting) — and `clients/index.tsx`'s own list is PAGE-SCOPED client-side
		// filtering (10 clients per page, `useClients(page)`'s own page, never a server-wide search —
		// see the "Supplier role" describe's own header below for the same, already-documented product
		// limit). Whether "contact@german.de" still landed on page 1 by the time this test ran
		// depended on exactly how many clients every earlier test in the file happened to create — an
		// ordering accident, not something this test controls. Resetting first, then creating the
		// client THIS TEST deletes, removes that dependency entirely: at most two clients exist
		// (the baseline "Test Client" `resetAndSeed` creates, plus this one), both on page 1, whatever
		// order Cypress ends up running specs in.
		before(() => {
			cy.resetAndSeed();
		});

		it("deletes a client", () => {
			cy.visit("/clients");
			cy.contains("button", /add|new|créer|ajouter/i, { timeout: 10000 }).click();
			cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should("be.visible");

			cy.get('[name="name"]').clear().type("Client À Supprimer SARL");

			cy.selectCountry("client-country-select", "France");
			cy.get('[name="address"]').clear().type("1 Rue Delete");
			cy.get('[name="postalCode"]').clear().type("75000");
			cy.get('[name="city"]').clear().type("Paris");

			cy.get('[data-cy="client-identifier-LEGAL_ID"]', { timeout: 10000 })
				.clear()
				.type("999888777");

			cy.get('[name="contacts.0.email"]').clear().type("delete-me@example.com");

			cy.get('[data-cy="client-submit"]').click();
			cy.get('[data-cy="client-dialog"]').should("not.exist");
			cy.contains("Client À Supprimer SARL", { timeout: 10000 });

			cy.get('[data-cy="client-row-menu-delete-me@example.com"]').click();
			cy.get('[data-cy="delete-client-button-delete-me@example.com"]').click();

			cy.get('[data-cy="confirm-delete-client-button"]', {
				timeout: 5000,
			}).should("be.visible");

			// Below 640 px the footer stacks its buttons full width, the action above cancel.
			cy.viewport(390, 844);
			cy.get('[data-slot="dialog-footer"]').then(($footer) => {
				const footer = $footer[0].getBoundingClientRect();
				const [cancel, confirm] = Array.from($footer[0].querySelectorAll("button"), (button) =>
					button.getBoundingClientRect(),
				);
				expect(confirm.bottom, "action above cancel").to.be.at.most(cancel.top);
				expect(Math.abs(cancel.width - footer.width), "cancel full width").to.be.lessThan(2);
				expect(Math.abs(confirm.width - footer.width), "action full width").to.be.lessThan(2);
			});

			// From 640 px up they sit on one row, cancel first, neither stretched.
			cy.viewport(1000, 660);
			cy.get('[data-slot="dialog-footer"]').then(($footer) => {
				const footer = $footer[0].getBoundingClientRect();
				const [cancel, confirm] = Array.from($footer[0].querySelectorAll("button"), (button) =>
					button.getBoundingClientRect(),
				);
				expect(Math.abs(cancel.top - confirm.top), "same row").to.be.lessThan(2);
				expect(cancel.right, "cancel before the action").to.be.at.most(confirm.left);
				expect(confirm.width, "action not stretched").to.be.lessThan(footer.width / 2);
			});

			cy.get('[data-cy="confirm-delete-client-button"]').click();

			cy.wait(2000);
			cy.get('[data-cy="client-status-inactive-delete-me@example.com"]').should(
				"exist",
			);
		});
	});
});


/**
 * The "Supplier" role, manual toggle on THIS screen (auto-set-at-link is
 * covered end-to-end, by the screen, in 36-received-invoices.cy.ts). A SEPARATE top-level `describe`,
 * deliberately placed LAST in this file and starting with its own `cy.resetAndSeed()`: the client
 * list/filter (`clients/index.tsx`) is PAGE-SCOPED client-side filtering (10 clients
 * per page, filtered from whatever page is currently loaded — a pre-existing product limit, out of
 * scope here to fix) — every OTHER describe above this one has, between them, created
 * enough clients that which page holds any one of them is not something this spec should have to
 * predict. Resetting first (safe here ONLY because nothing else in this file runs afterwards) makes
 * "at most two clients exist, both on page 1" simply true instead of assumed.
 */
describe("Supplier role", () => {
	const api = Cypress.env("apiUrl");

	before(() => {
		cy.resetAndSeed();
	});

	beforeEach(() => {
		cy.login();
	});

	it('toggling "Supplier" on at creation persists the role — visible on the list row without opening it', () => {
		cy.visit("/clients");
		cy.contains("button", /add|new|créer|ajouter/i, { timeout: 10000 }).click();
		cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should("be.visible");

		cy.get('[name="name"]').clear().type("Fournisseur T5b SARL");
		cy.get('[data-cy="client-is-supplier-switch"]').scrollIntoView().click();

		cy.selectCountry("client-country-select", "France");
		cy.get('[name="address"]').clear().type("1 Rue Fournisseur");
		cy.get('[name="postalCode"]').clear().type("75000");
		cy.get('[name="city"]').clear().type("Paris");

		cy.get('[data-cy="client-identifier-LEGAL_ID"]', { timeout: 10000 })
			.clear()
			.type("555666777");

		cy.get('[name="contacts.0.email"]').clear().type("fournisseur-t5b@example.com");

		cy.get('[data-cy="client-submit"]').click();
		cy.get('[data-cy="client-dialog"]').should("not.exist");

		cy.get('[data-cy="client-role-supplier-fournisseur-t5b@example.com"]', {
			timeout: 10000,
		}).should("contain.text", "Supplier");

		cy.request<{ isSupplier?: boolean }[]>({
			url: `${api}/api/clients/search?query=${encodeURIComponent("Fournisseur T5b SARL")}`,
		})
			.its("body")
			.then((clients) => {
				expect(
					clients[0].isSupplier,
					"the role is really persisted, not just rendered",
				).to.eq(true);
			});
	});

	it("unchecked by default: a client created without touching the switch is NOT a supplier", () => {
		cy.visit("/clients");
		cy.contains("button", /add|new|créer|ajouter/i, { timeout: 10000 }).click();
		cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should("be.visible");

		cy.get('[name="name"]').clear().type("Client Ordinaire T5b SARL");

		cy.selectCountry("client-country-select", "France");
		cy.get('[name="address"]').clear().type("2 Rue Ordinaire");
		cy.get('[name="postalCode"]').clear().type("75000");
		cy.get('[name="city"]').clear().type("Paris");

		cy.get('[data-cy="client-identifier-LEGAL_ID"]', { timeout: 10000 })
			.clear()
			.type("112233446");

		cy.get('[name="contacts.0.email"]')
			.clear()
			.type("client-ordinaire-t5b@example.com");

		cy.get('[data-cy="client-submit"]').click();
		cy.get('[data-cy="client-dialog"]').should("not.exist");

		cy.get(
			'[data-cy="client-role-supplier-client-ordinaire-t5b@example.com"]',
		).should("not.exist");

		cy.request<{ isSupplier?: boolean }[]>({
			url: `${api}/api/clients/search?query=${encodeURIComponent("Client Ordinaire T5b SARL")}`,
		})
			.its("body")
			.then((clients) => {
				expect(
					clients[0].isSupplier,
					"the backfill decision: never a supplier unless set",
				).to.be.oneOf([false, undefined]);
			});
	});

	it('the "Suppliers" filter on the list shows only clients flagged as suppliers', () => {
		cy.visit("/clients");
		cy.get('[data-cy="clients-filter-supplier"]').click();

		cy.contains("Fournisseur T5b SARL", { timeout: 10000 });
		cy.contains("Client Ordinaire T5b SARL").should("not.exist");
	});

	// `SteppedDialog` hands its last step's "Continue" click `form.getValues()` directly, never through
	// `form.handleSubmit` (which normally runs the zodResolver and hands back SCHEMA-COERCED values) —
	// a real defect found on a SIBLING screen built the same way (numbers reached the API as strings).
	// This form has no coercing field (no `z.coerce`, no numeric input), so client-upsert.tsx's own
	// `clientSchema.safeParse(values)` at the submit boundary is a no-op here in practice — this test
	// is the regression guard for that: every genuinely TYPED field (a country string, the GOVERNMENT
	// enum, a real boolean switch) must reach the API as its own type, through BOTH create and an edit
	// round-trip, not just render correctly on screen. Placed LAST in this describe (reusing its own
	// `resetAndSeed()`, never a fresh one of its own) so the list stays at 3 clients total — the same
	// page-scoped-list reasoning this describe's own header already gives for why it resets at all.
	it("country, GOVERNMENT kind and the isSupplier boolean survive create AND an edit round-trip with their real types", () => {
		cy.visit("/clients");
		cy.contains("button", /add|new|créer|ajouter/i, { timeout: 10000 }).click();
		cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should("be.visible");

		cy.get('[name="name"]').clear().type("Typed Fields Co");
		cy.get('[data-cy="client-is-supplier-switch"]').click();

		cy.selectCountry("client-country-select", "Germany");
		cy.get('[name="address"]').clear().type("Hauptstrasse 9");
		cy.get('[name="postalCode"]').clear().type("10115");
		cy.get('[name="city"]').clear().type("Berlin");

		cy.get('[data-cy="client-kind-select"]').click();
		cy.get('[data-cy="client-kind-government"]').click();

		cy.get('[name="contacts.0.email"]').clear().type("typed-fields@example.com");

		cy.get('[data-cy="client-submit"]').click();
		cy.get('[data-cy="client-dialog"]').should("not.exist");
		cy.contains("Typed Fields Co", { timeout: 10000 });

		cy.request<{ country: string; kind: string; isSupplier: boolean }[]>({
			url: `${api}/api/clients/search?query=${encodeURIComponent("Typed Fields Co")}`,
		})
			.its("body")
			.then((clients) => {
				const c = clients[0];
				expect(c.country, "country persisted as the real string").to.eq("Germany");
				expect(c.kind, "GOVERNMENT persisted as its own enum string").to.eq("GOVERNMENT");
				expect(c.isSupplier, "isSupplier is a real boolean, never the STRING \"true\"").to.eq(true);
				expect(typeof c.isSupplier).to.eq("boolean");
			});

		// Edit round-trip: flip the switch back off — every step is already "done" in edit mode
		// (`initialMaxReached`), so jump straight to Summary instead of walking every step again.
		// The row this clicks exists only once `GET /api/clients` has answered, and the row is
		// re-rendered when it does. Clicking as soon as `cy.get` first sees it opens a Radix layer on
		// a node the page has not finished settling — the family of races
		// support/commands.ts#waitForLayerTeardown documents. Waited on, not hoped for.
		cy.intercept({ method: "GET", pathname: "/api/clients" }).as("clientsList");
		cy.visit("/clients");
		cy.wait("@clientsList", { timeout: 20000 });
		cy.get('[data-cy="edit-client-button-typed-fields@example.com"]', { timeout: 10000 }).click();
		cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should("be.visible");
		cy.get('[data-cy="client-is-supplier-switch"]').click();
		cy.get('[data-cy="client-submit"]').click();
		cy.get('[data-cy="client-dialog"]').should("not.exist");

		cy.request<{ isSupplier: boolean; kind: string }[]>({
			url: `${api}/api/clients/search?query=${encodeURIComponent("Typed Fields Co")}`,
		})
			.its("body")
			.then((clients) => {
				expect(
					clients[0].isSupplier,
					"the edit round-trip keeps isSupplier a real boolean, now false",
				).to.eq(false);
				expect(clients[0].kind, "kind untouched by the edit still reads GOVERNMENT").to.eq(
					"GOVERNMENT",
				);
			});
	});
});

/**
 * Italian recipient identifiers (IT_SDI / PEC) — countries/data/it.json (section "identifiers") declared only
 * VAT/LEGAL_ID until 2026-09-13 (afc986f9): `fatturapa-provider.ts` already read `IT_SDI`/`PEC` off
 * the client to route CodiceDestinatario/FormatoTrasmissione, but this data-driven form (one
 * `<Input>` per catalog scheme, `client-identifier-${req.scheme}`) had no scheme to render, so a
 * genuinely domestic Italian B2B invoice fell through every branch to `XXXXXXX` — the placeholder
 * this same specification reserves for a recipient not resident/established/identified in Italy.
 * Proven here through the SCREEN for the collection half (the Cypress spec `fatturapa-provider.spec.ts`
 * itself cannot reach) and through a real downloaded artifact for the routing half — never the screen
 * alone as proof of what was actually served, same discipline as 30-document-xml-format.cy.ts.
 */
describe("Italian recipient identifiers (IT_SDI) — FatturaPA routing", () => {
	const api = Cypress.env("apiUrl");

	before(() => {
		cy.resetAndSeed();
		cy.login();
		// resetAndSeed's baseline company sets no transport — "send" refuses at its own preflight
		// otherwise (invoice-actions.ts's `resolveInvoiceTransport`), and the invoice would never get
		// its number (BT-1) at all. Same setup as 30-document-xml-format.cy.ts's own `before()`.
		cy.request({
			method: "POST",
			url: `${api}/api/company/info`,
			body: { invoiceTransportId: "email" },
		}).then((res) => {
			expect(res.status, "transport configured").to.be.oneOf([200, 201]);
		});
	});

	beforeEach(() => {
		cy.login();
	});

	it("entering a Codice Destinatario on an Italian B2B client's screen persists it and routes a real domestic invoice's downloaded FatturaPA XML off it — never the foreign-recipient XXXXXXX placeholder", () => {
		cy.visit("/clients");
		cy.contains("button", /add|new|créer|ajouter/i, { timeout: 10000 }).click();
		cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should("be.visible");

		cy.get('[name="name"]').clear().type("Ditta Italiana SdI Srl");

		cy.selectCountry("client-country-select", "Italy");
		cy.get('[name="address"]').clear().type("Via Roma 10");
		cy.get('[name="postalCode"]').clear().type("00100");
		cy.get('[name="city"]').clear().type("Roma");

		// The field only exists on screen because countries/data/it.json (section "identifiers") declares IT_SDI —
		// this is the exact screen that catalog change unlocks (see it.json's own top-level notes).
		// PEC (the other fallback the same specification allows) is asserted present too, for free,
		// off the same generic mechanism — no extra field-specific code anywhere in client-upsert.tsx.
		cy.get('[data-cy="client-identifier-IT_SDI"]', { timeout: 10000 })
			.should("exist")
			.clear()
			.type("ABC123X");
		cy.get('[data-cy="client-identifier-PEC"]', { timeout: 10000 }).should("exist");
		// A French invoice to a business in another member state names its VAT number.
		cy.get('[data-cy="client-identifier-VAT"]').clear().type("IT01057861005");
		cy.openSearchSelect("client-currency-select");
		cy.get('[data-cy="client-currency-select"] input').type("Euro");
		cy.get('[data-cy="client-currency-select-option-euro-(€)"]').click();

		cy.get('[name="contacts.0.email"]').clear().type("fatturazione@ditta-sdi.example");

		cy.get('[data-cy="client-submit"]').click();
		cy.get('[data-cy="client-dialog"]').should("not.exist");
		cy.contains("Ditta Italiana SdI Srl", { timeout: 10000 });

		cy.request<{ id: string; partyIdentifiers: { scheme: string; value: string }[] }[]>({
			url: `${api}/api/clients/search?query=${encodeURIComponent("Ditta Italiana SdI Srl")}`,
		})
			.its("body")
			.then((clients) => {
				const client = clients[0];
				const sdi = client.partyIdentifiers.find((pi) => pi.scheme === "IT_SDI");
				expect(sdi, "IT_SDI really persisted, not just rendered").to.exist;
				expect(sdi!.value).to.eq("ABC123X");

				const invoiceData = {
					client: client.id,
					// BEFORE the FR PDP channel-mandate date (2026-09-01, transports/channel-policy) —
					// same fixture date as 30-document-xml-format.cy.ts's own `createAndSendInvoice` —
					// or "send" 501s on the seller's own French seat (the seeded baseline company),
					// which has nothing to do with the ITALIAN recipient this test actually exercises.
					issueDate: "2026-08-30",
					dueDate: "2026-09-30",
					currency: "EUR",
					lines: [
						{
							description: "Consulenza",
							quantity: 1,
							unit: "day",
							unitPrice: 500,
							// A valid vatRate CHOICE is resolved from the SELLER's own vat-rates catalog
							// (resetAndSeed's baseline company is French) — never the client's country, and
							// never a free-form value (invoice.descriptor.ts's own header). "20" is the same
							// FR rate every other spec in this suite already uses.
							vatRate: "20",
						},
					],
				};
				cy.request({
					method: "POST",
					url: `${api}/api/documents/types/invoice/actions/save-draft`,
					body: { data: invoiceData },
				}).then((saved) => {
					expect(saved.status).to.be.oneOf([200, 201]);
					const invoiceId = saved.body?.document?.id as string;
					// "send" — the number (BT-1) only needs to be ASSIGNED, never the async email worker
					// to finish — the download-xml action never waits on it (same reasoning
					// 30-document-xml-format.cy.ts's own `createAndSendInvoice` documents). The action
					// re-validates the FULL document data, same shape as save-draft — never just `{client}`.
					cy.request({
						method: "POST",
						url: `${api}/api/documents/types/invoice/actions/send`,
						body: { documentId: invoiceId, data: invoiceData },
					}).then((sent) => {
						expect(sent.status).to.be.oneOf([200, 201]);

						cy.request({
							url: `${api}/api/documents/${invoiceId}/formats/fatturapa?typeId=invoice`,
							encoding: "binary",
						}).then((res) => {
							expect(res.status, "a real, validated FatturaPA export").to.eq(200);
							expect(res.body).to.contain(
								"<FormatoTrasmissione>FPR12</FormatoTrasmissione>",
							);
							expect(res.body).to.contain("<CodiceDestinatario>ABC123X</CodiceDestinatario>");
							expect(
								res.body,
								"a domestic recipient must never be announced to SdI as a foreign one",
							).to.not.contain("XXXXXXX");
						});
					});
				});
			});
	});
});

// Last on purpose: earlier tests expect the client they create on the list's first page.
describe("A French private client", () => {
	it("creates a French individual client without a SIREN, which stays optional", () => {
		cy.intercept("POST", `${Cypress.env("apiUrl")}/api/clients`).as("createPrivateClient");
		cy.visit("/clients");
		cy.contains("button", /add|new|créer|ajouter/i, { timeout: 10000 }).click();
		cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should("be.visible");

		cy.get('[data-cy="client-type-select"]').click();
		cy.get('[data-cy="client-type-individual"]').click();
		cy.get('[name="contactFirstname"]').clear().type("Jeanne");
		cy.get('[name="contactLastname"]').clear().type("Martin");

		cy.selectCountry("client-country-select", "France");
		cy.get('[name="address"]').clear().type("8 Rue des Tilleuls");
		cy.get('[name="postalCode"]').clear().type("69003");
		cy.get('[name="city"]').clear().type("Lyon");

		cy.get('[data-cy="client-identifier-LEGAL_ID"]', { timeout: 10000 }).should("have.value", "");
		cy.get('[data-cy="client-submit"]').click();

		cy.wait("@createPrivateClient").its("response.statusCode").should("eq", 201);
		cy.get('[data-cy="client-dialog"]').should("not.exist");
	});
});