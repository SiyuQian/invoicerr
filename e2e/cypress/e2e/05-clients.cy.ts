export {}; // makes this spec a module, not a global script -- see tsconfig.json

beforeEach(() => {
	cy.login();
});

function searchClients(term: string): void {
	cy.visit("/clients");
	cy.get('[data-cy="clients-search"]', { timeout: 10000 }).type(term);
}

describe("Clients E2E", () => {
	describe("Create Clients", () => {
		it("creates a company client", () => {
			cy.visit("/clients");
			cy.get('[data-cy="client-add-button"]', { timeout: 10000 }).should("be.visible");
			cy.assertAccessible();
			cy.viewport(390, 844);
			cy.assertAccessible();
			cy.viewport(1000, 660);
			cy.contains("button", /add|new|créer|ajouter/i, {
				timeout: 10000,
			}).click();

			cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should(
				"be.visible",
			);
			cy.assertAccessible();

			cy.get('[name="name"]').clear().type("ACME Corporation");
			cy.get('[name="description"]')
				.clear()
				.type("A leading technology company");

			cy.selectCountry("client-country-select", "France");
			cy.get('[name="address"]').clear().type("123 Tech Boulevard");
			cy.get('[name="postalCode"]').clear().type("12345");
			cy.get('[name="city"]').clear().type("San Francisco");

			cy.get('[data-cy="client-identifier-LEGAL_ID"]', { timeout: 10000 })
				.clear()
				.type("123456789");
			cy.assertAccessible();
			// The country-specific identifiers section (EIN, above) pushes this
			// select further down the scrollable dialog — scroll it into view first
			// or the opened options panel renders clipped by the dialog's overflow.
			cy.get('[data-cy="client-currency-select"] button')
				.scrollIntoView()
				.click();
			cy.get('[data-cy="client-currency-select-options"]').should("be.visible");
			cy.get('[data-cy="client-currency-select"] input').type("Euro");
			cy.get('[data-cy="client-currency-select-option-euro-(€)"]').click();

			cy.get('[name="contacts.0.email"]').clear().type("contact@acme.org");
			cy.get('[name="contacts.0.phone"]').clear().type("+1 23 456 7890");
			cy.assertAccessible();

			cy.get('[data-cy="client-submit"]').click();

			cy.get('[data-cy="client-dialog"]').should("not.exist");
			cy.contains("ACME Corporation", { timeout: 10000 });
		});

		it("creates an individual client", () => {
			cy.visit("/clients");
			cy.contains("button", /add|new|créer|ajouter/i, {
				timeout: 10000,
			}).click();

			cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should(
				"be.visible",
			);

			cy.get('[data-cy="client-type-select"]').click();
			cy.get('[data-cy="client-type-individual"]').click();
			cy.get('[name="contactFirstname"]').clear().type("Jane");
			cy.get('[name="contactLastname"]').clear().type("Doe");
			cy.get('[name="description"]').clear().type("Freelance developer");

			cy.selectCountry("client-country-select", "United States");
			cy.get('[name="address"]').clear().type("456 Developer Lane");
			cy.get('[name="postalCode"]').clear().type("67890");
			cy.get('[name="city"]').clear().type("Los Angeles");

			// The United States has no per-country identifiers catalog of its own (only the five
			// in-scope countries — FR/DE/IT/PL/PT — have one) — the Tax & identifiers step must show
			// the honest "unknown country" placeholder rather than silently rendering nothing. This is
			// the ONLY place in the suite that proves the placeholder's
			// POSITIVE existence: `35-cross-border-tax.cy.ts` only ever asserts its ABSENCE (for a
			// country that DOES have a file), and `scenarios/full-lifecycle.cy.ts`'s own equivalent
			// branch is unreachable — every one of its six legs pairs two of the five in-scope
			// countries, all five of which ship a catalog.
			cy.get('[data-cy="client-identifiers-unknown-country"]', { timeout: 10000 }).should("exist");

			// The "Supplier" switch and currency select share the Identity/Tax steps with everything
			// else now — no more scrolling past unrelated fields to reach the currency select.
			cy.get('[data-cy="client-currency-select"] button')
				.scrollIntoView()
				.click();
			cy.get('[data-cy="client-currency-select-options"]').should("be.visible");
			cy.get('[data-cy="client-currency-select"] input').type("Dollar");
			cy.get(
				'[data-cy="client-currency-select-option-united-states-dollar-($)"]',
			).click();

			cy.get('[name="contacts.0.email"]').clear().type("jane.doe@freelance.org");
			cy.get('[name="contacts.0.phone"]').clear().type("+1 98 765 4321");

			cy.get('[data-cy="client-submit"]').click();

			cy.get('[data-cy="client-dialog"]').should("not.exist");
			cy.contains("Jane", { timeout: 10000 });
			cy.contains("Doe");
		});
	});

	describe("Validation Errors - Company", () => {
		it("shows error for empty company name", () => {
			cy.visit("/clients");
			cy.contains("button", /add|new|créer|ajouter/i, {
				timeout: 10000,
			}).click();

			cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should(
				"be.visible",
			);

			// "name" is validated on the Identity step's own "Continue" — no need to reach any later
			// step at all.
			cy.get('[name="name"]').clear();
			cy.get('[data-cy="client-submit"]').click();
			cy.get('[data-cy="client-dialog"]').should("be.visible");
			cy.contains(/required|requis|nom/i);
		});

		it("shows error for empty legalId (company)", () => {
			cy.visit("/clients");
			cy.contains("button", /add|new|créer|ajouter/i, {
				timeout: 10000,
			}).click();

			cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should(
				"be.visible",
			);

			cy.get('[name="name"]').clear().type("Test Company");

			cy.selectCountry("client-country-select", "France");
			cy.get('[name="address"]').clear().type("123 Test St");
			cy.get('[name="postalCode"]').clear().type("12345");
			cy.get('[name="city"]').clear().type("Test City");

			cy.get('[data-cy="client-identifier-LEGAL_ID"]', { timeout: 10000 }).clear();
			cy.get('[data-cy="client-submit"]').click();
			cy.get('[data-cy="client-dialog"]').should("be.visible");
			cy.contains(/required|requis|siret|legal/i);
		});
	});

	describe("Validation Errors - Individual", () => {
		it("shows error for empty firstname (individual)", () => {
			cy.visit("/clients");
			cy.contains("button", /add|new|créer|ajouter/i, {
				timeout: 10000,
			}).click();

			cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should(
				"be.visible",
			);

			cy.get('[data-cy="client-type-select"]').click();
			cy.get('[data-cy="client-type-individual"]').click();
			cy.get('[name="contactFirstname"]').clear();
			cy.get('[name="contactLastname"]').clear().type("Smith");

			cy.get('[data-cy="client-submit"]').click();
			cy.get('[data-cy="client-dialog"]').should("be.visible");
			cy.contains(/required|requis|firstname|prénom/i);
		});

		it("shows error for empty lastname (individual)", () => {
			cy.visit("/clients");
			cy.contains("button", /add|new|créer|ajouter/i, {
				timeout: 10000,
			}).click();

			cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should(
				"be.visible",
			);

			cy.get('[data-cy="client-type-select"]').click();
			cy.get('[data-cy="client-type-individual"]').click();
			cy.get('[name="contactFirstname"]').clear().type("John");
			cy.get('[name="contactLastname"]').clear();

			cy.get('[data-cy="client-submit"]').click();
			cy.get('[data-cy="client-dialog"]').should("be.visible");
			cy.contains(/required|requis|lastname|nom/i);
		});
	});

	describe("Common Validation Errors", () => {
		// The email is only required where it is actually USED (sending a document,
		// the portal invite, dunning reminders) — each of those refuses/skips cleanly on its own
		// (see 28-document-async-send.cy.ts's "send_failed ... no contact email on file" coverage).
		// The client RECORD itself must save with no email at all — a real screen submission, the
		// network response asserted directly (201), never inferred from the dialog merely closing.
		it("creates a client with NO email at all — the field is optional, saved as a 201", () => {
			cy.intercept("POST", `${Cypress.env("apiUrl")}/api/clients`).as(
				"createClientNoEmail",
			);

			cy.visit("/clients");
			cy.contains("button", /add|new|créer|ajouter/i, {
				timeout: 10000,
			}).click();

			cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should(
				"be.visible",
			);

			cy.get('[name="name"]').clear().type("No Email At All SARL");

			cy.selectCountry("client-country-select", "France");
			cy.get('[name="address"]').clear().type("123 Test St");
			cy.get('[name="postalCode"]').clear().type("12345");
			cy.get('[name="city"]').clear().type("Test City");

			cy.get('[data-cy="client-identifier-LEGAL_ID"]', { timeout: 10000 })
				.clear()
				.type("123456789");

			// The email field, left BLANK — no error, no block, the Contact step's own "Continue"
			// accepts it exactly like a filled one.
			cy.get('[name="contacts.0.email"]').clear();
			cy.get('[name="contacts.0.phone"]').clear().type("+1 23 456 7890");

			cy.get('[data-cy="client-submit"]').click();

			cy.wait("@createClientNoEmail").its("response.statusCode").should("eq", 201);
			cy.get('[data-cy="client-dialog"]').should("not.exist");
			cy.contains("No Email At All SARL", { timeout: 10000 });
		});

		it("shows error for invalid email format", () => {
			cy.visit("/clients");
			cy.contains("button", /add|new|créer|ajouter/i, {
				timeout: 10000,
			}).click();

			cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should(
				"be.visible",
			);

			cy.get('[name="name"]').clear().type("Test Company");

			cy.selectCountry("client-country-select", "France");
			cy.get('[name="address"]').clear().type("123 Test St");
			cy.get('[name="postalCode"]').clear().type("12345");
			cy.get('[name="city"]').clear().type("Test City");

			// A VALID SIREN — see the previous test's identical comment.
			cy.get('[data-cy="client-identifier-LEGAL_ID"]', { timeout: 10000 })
				.clear()
				.type("123456789");

			cy.get('[name="contacts.0.email"]').clear().type("not-an-email");
			cy.get('[data-cy="client-submit"]').click();
			cy.get('[data-cy="client-dialog"]').should("be.visible");
			cy.contains(/format|invalid|invalide|email/i);
		});

		it("shows error for invalid postal code format", () => {
			cy.visit("/clients");
			cy.contains("button", /add|new|créer|ajouter/i, {
				timeout: 10000,
			}).click();

			cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should(
				"be.visible",
			);

			cy.get('[name="name"]').clear().type("Test Company");

			// "postalCode" is validated on the Address step's own "Continue" — no need to reach Tax &
			// identifiers or Contact at all.
			cy.selectCountry("client-country-select", "France");
			cy.get('[name="address"]').clear().type("123 Test St");
			cy.get('[name="postalCode"]').clear().type("AB");
			cy.get('[name="city"]').clear().type("Test City");
			cy.get('[data-cy="client-submit"]').click();
			cy.get('[data-cy="client-dialog"]').should("be.visible");
			cy.contains(/format|invalid|invalide|postal|code/i);
		});

		// Re-scoped by the wizard split: VAT is deliberately EXEMPT from this screen's own pattern gate
		// (client-upsert.tsx's own schema comment — `tax/vat-syntax.ts` owns VAT syntax exclusively),
		// unlike LEGAL_ID just above. The single-page form's OLD version of this test asserted the
		// SAME `/format|invalid|invalide|vat|tva/i` regex right after clicking "save" while still on
		// one page carrying the static "VAT Number" field label — a label match, not a real check: the
		// backend's own `clients.service.ts#syncPartyIdentifiers` ACCEPTS a syntactically bad VAT (201,
		// `clients.vat-validation.spec.ts`'s own "never even asked of VIES" case) and persists it with
		// `validationStatus: 'INVALID'` rather than rejecting the request — there is no user-facing
		// error to find on ANY step. This asserts the real, documented behavior instead: the client
		// saves through the screen, and the persisted verdict is read back via the API.
		it("accepts an invalid VAT format at save time, but persists it as an unverified/invalid syntax verdict", () => {
			cy.visit("/clients");
			cy.contains("button", /add|new|créer|ajouter/i, {
				timeout: 10000,
			}).click();

			cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should(
				"be.visible",
			);

			cy.get('[name="name"]').clear().type("Bad VAT Syntax SARL");

			cy.selectCountry("client-country-select", "France");
			cy.get('[name="address"]').clear().type("123 Test St");
			cy.get('[name="postalCode"]').clear().type("12345");
			cy.get('[name="city"]').clear().type("Test City");

			cy.get('[data-cy="client-identifier-LEGAL_ID"]', { timeout: 10000 })
				.clear()
				.type("123456789");
			cy.get('[data-cy="client-identifier-VAT"]').clear().type("123456");

			cy.get('[name="contacts.0.email"]').clear().type("bad-vat-syntax@example.com");

			cy.get('[data-cy="client-submit"]').click();
			cy.get('[data-cy="client-dialog"]').should("not.exist");
			cy.contains("Bad VAT Syntax SARL", { timeout: 10000 });

			cy.request<{ partyIdentifiers: { scheme: string; validationStatus: string | null }[] }[]>({
				url: `${Cypress.env("apiUrl")}/api/clients/search?query=${encodeURIComponent("Bad VAT Syntax SARL")}`,
			})
				.its("body")
				.then((clients) => {
					const vat = clients[0].partyIdentifiers.find((i) => i.scheme === "VAT");
					expect(vat, "the VAT identifier was saved").to.exist;
					expect(
						vat?.validationStatus,
						"a syntactically-bad VAT is persisted INVALID, never silently accepted as valid",
					).to.eq("INVALID");
				});
		});
	});

	// The wizard warns — but never blocks — when the email being typed already belongs
	// to another client of this company. `clients.duplicates.spec.ts` (jest) proves the backend
	// matching rule directly; this proves the SCREEN actually calls it and still lets the create
	// through.
	describe("Duplicate detection (non-blocking)", () => {
		const originalName = "Duplicate Check Original SARL";
		const duplicateEmail = "duplicate-check-t194@example.com";

		it("creates the original client that the next test will collide with", () => {
			cy.intercept("POST", `${Cypress.env("apiUrl")}/api/clients`).as(
				"createOriginal",
			);

			cy.visit("/clients");
			cy.contains("button", /add|new|créer|ajouter/i, {
				timeout: 10000,
			}).click();

			cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should(
				"be.visible",
			);

			cy.get('[name="name"]').clear().type(originalName);

			cy.selectCountry("client-country-select", "France");
			cy.get('[name="address"]').clear().type("1 Original Street");
			cy.get('[name="postalCode"]').clear().type("12345");
			cy.get('[name="city"]').clear().type("Test City");

			cy.get('[data-cy="client-identifier-LEGAL_ID"]', { timeout: 10000 })
				.clear()
				.type("123456789");

			cy.get('[name="contacts.0.email"]').clear().type(duplicateEmail);

			cy.get('[data-cy="client-submit"]').click();
			cy.wait("@createOriginal").its("response.statusCode").should("eq", 201);
			cy.get('[data-cy="client-dialog"]').should("not.exist");
			cy.contains(originalName, { timeout: 10000 });
		});

		it("shows a non-blocking warning for the same email, naming the existing client, and still creates it", () => {
			cy.intercept("POST", `${Cypress.env("apiUrl")}/api/clients`).as(
				"createDuplicate",
			);
			cy.intercept("GET", `${Cypress.env("apiUrl")}/api/clients/duplicates*`).as(
				"checkDuplicates",
			);

			cy.visit("/clients");
			cy.contains("button", /add|new|créer|ajouter/i, {
				timeout: 10000,
			}).click();

			cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should(
				"be.visible",
			);

			// A DIFFERENT name and address — the collision under test is the EMAIL alone.
			cy.get('[name="name"]').clear().type("Duplicate Check Second SARL");

			cy.selectCountry("client-country-select", "France");
			cy.get('[name="address"]').clear().type("2 Second Street");
			cy.get('[name="postalCode"]').clear().type("54321");
			cy.get('[name="city"]').clear().type("Other City");

			cy.get('[data-cy="client-identifier-LEGAL_ID"]', { timeout: 10000 })
				.clear()
				.type("987654321");

			// The SAME email as the previous test's client — the debounced check fires once typing
			// settles.
			cy.get('[name="contacts.0.email"]').clear().type(duplicateEmail);
			cy.wait("@checkDuplicates", { timeout: 10000 });

			cy.get('[data-cy="client-duplicate-warning"]', { timeout: 10000 })
				.should("be.visible")
				.and("contain.text", originalName);

			// Non-blocking: "Continue" and "Create" both still work with the warning on screen.
			cy.get('[data-cy="client-submit"]').click();

			cy.wait("@createDuplicate").its("response.statusCode").should("eq", 201);
			cy.get('[data-cy="client-dialog"]').should("not.exist");
			cy.contains("Duplicate Check Second SARL", { timeout: 10000 });
		});
	});

	describe("Search Clients", () => {
		it("searches for a client by name", () => {
			searchClients("ACME");
			cy.get('[data-cy="client-row-contact@acme.org"]').should("be.visible");
			cy.get('[data-cy="client-row-jane.doe@freelance.org"]').should("not.exist");
		});

		it("searches for a client by email", () => {
			searchClients("jane.doe");
			cy.get('[data-cy="client-row-jane.doe@freelance.org"]').should("be.visible");
			cy.get('[data-cy="client-row-contact@acme.org"]').should("not.exist");
		});
	});

	describe("View Client Details", () => {
		it("views a client details", () => {
			cy.visit("/clients");
			cy.get('[data-cy="view-client-button-jane.doe@freelance.org"]', { timeout: 15000 }).click();
			cy.get('[data-cy="client-view-name"]').should("have.text", "Jane Doe");
			cy.get('[data-cy="client-view-contact-0"]').should("contain.text", "jane.doe@freelance.org");
		});
	});

	describe("Edit Clients", () => {
		it("edits an existing client", () => {
			cy.visit("/clients");

			cy.get('[data-cy="edit-client-button-jane.doe@freelance.org"]', { timeout: 15000 }).click();

			cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should(
				"be.visible",
			);
			// "description" lives on the Identity step, the wizard's own default landing step — no
			// navigation needed to reach it, even in edit mode.
			cy.get('[name="description"]').clear().type("A global technology leader");
			cy.get('[data-cy="client-submit"]').click();

			cy.get('[data-cy="client-dialog"]').should("not.exist");
			cy.wait(2000);

			cy.get('[data-cy="edit-client-button-jane.doe@freelance.org"]').click();
			cy.wait(2000);
			cy.get('[data-cy="client-dialog"]', { timeout: 5000 }).should(
				"be.visible",
			);
			cy.get('[name="description"]').should(
				"have.value",
				"A global technology leader",
			);

			// No dedicated "Cancel" button any more (SteppedDialog's own fixed footer is Back/Continue
			// only) — closing goes through the dialog's own header close button, same as every other
			// stepped-dialog.tsx wizard.
			cy.get('[data-cy="client-dialog"] [data-slot="dialog-close"]').click();
		});
	});
});
