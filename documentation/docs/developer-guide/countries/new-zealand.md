---
title: "New Zealand invoicing"
description: "New Zealand GST invoicing over PDF and email, with separate PINT A-NZ and Peppol limitations."
sidebar_label: "New Zealand"
keywords: [New Zealand, GST, NZBN, PINT A-NZ, Peppol]
---

# New Zealand invoicing

New Zealand supports ordinary PDF and email invoices through the shared document lifecycle.
Its rules live in `backend/src/modules/documents/countries/data/nz.json` and are loaded automatically.
No additional dependency, transport or database migration is needed. Restart the backend after adding
this file so the country rules and identifier catalog are copied into the build and seeded at boot.

## Implemented

- GST rate choices: standard 15%, eligible zero-rated supplies, and exempt supplies. Zero-rated and
  exempt choices have distinct catalog ids even though both calculate 0%.
- Optional NZBN and GST number fields. NZBN is not a GST number. The existing NZBN registry provider
  remains available when `NZBN_API_KEY` is configured.
- Registered sellers must supply a GST number before issuing an invoice. This product requires it
  even on invoices at or below NZ$200, where IRD permits simpler supply information.
- Unregistered sellers select **Not registered for GST** in onboarding or company settings. This
  reuses `Company.exemptVat` and ensures invoices charge no GST. Do not use this setting for a
  GST-registered business merely because some of its supplies are zero-rated or exempt.
- GST terminology on document line fields and the PDF tax breakdown.
- NZD for domestic invoices, using the shared country currency gate. Foreign-currency GST conversion
  is outside this integration.
- Overseas sales retain the seller-selected GST treatment. A foreign customer address alone does
  not establish zero-rating eligibility. The application does not determine export eligibility,
  place of supply, or overseas registration obligations, and applies no EU VAT export/reverse-charge
  inference to these invoices.
- Linked credit notes identify the original invoice. The other correction routes remain explicitly
  unverified unless supported by the catalog's cited sources.
- Seven years' record retention after an unknown period end, conservatively calculated as the invoice
  issue date plus one year plus seven years. The app does not store the seller's GST period, so this
  can retain records longer than the statutory minimum. An IRD extension must be handled separately.

The shared issuance gate already requires each buyer's name, address and city. This exceeds the
buyer-identification minimum for GST-registered buyers above NZ$1,000; it also applies to smaller
invoices and unregistered buyers as an existing product requirement. Invoices show net, GST and
payable totals using the existing amount and rounding code.

## Separate electronic-invoicing work

NZ XML downloads are not enabled. Existing European Peppol BIS output is not a PINT A-NZ implementation.
Sending or receiving NZ Peppol invoices needs a PINT A-NZ format and validation provider plus a tested
Access Point integration. The existing Billit transport is a possible starting point; its NZ
onboarding, PINT A-NZ capability and production authorization have not been verified.

Government procurement eInvoicing obligations are not covered by ordinary email delivery. The
2027 large-supplier requirement must be evaluated against the relevant procurement and contract,
not treated as a universal mandate for all NZ businesses.

## Official references

- [IRD: charging GST](https://www.ird.govt.nz/gst/charging-gst)
- [IRD: Smart business (IR320)](https://www.ird.govt.nz/-/media/project/ir/home/documents/forms-and-guides/ir300---ir399/ir320/ir320.pdf) — New Zealand currency for invoices.
- [IRD: taxable supply information](https://www.ird.govt.nz/gst/tax-invoices-for-gst/how-tax-invoices-for-gst-work)
- [IRD: zero-rated supplies](https://www.ird.govt.nz/gst/charging-gst/zero-rated-supplies)
- [IRD: exempt supplies](https://www.ird.govt.nz/gst/charging-gst/exempt-supplies)
- [IRD: supply corrections](https://www.ird.govt.nz/gst/tax-invoices-for-gst/credit-and-debit-notes)
- [IRD: record keeping](https://www.ird.govt.nz/records) — includes approval requirements for offshore storage.
- [PINT A-NZ specification](https://docs.peppol.eu/poac/aunz/pint-aunz/)
- [MBIE: businesses trading with government](https://www.einvoicing.govt.nz/get-set-up/advice-for-government-agencies/advice-for-businesses-trading-with-government)
