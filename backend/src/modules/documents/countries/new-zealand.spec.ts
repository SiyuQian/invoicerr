import { CountryReadinessService } from '../../country-readiness/country-readiness.service';
import { computeRetention } from '../archive/retention/compute-retention';
import { defaultRetentionCatalog } from '../archive/retention/registry';
import { missingInvoiceIdentifiers } from '../country-identifiers/printed-identifiers';
import { defaultCountryIdentifierRequirementsCatalog } from '../country-identifiers/registry';
import { applyCompanyFieldView } from '../descriptors/company-view';
import { buildInvoiceDescriptor } from '../descriptors/invoice.descriptor';
import { buildCreditNoteDescriptor } from '../descriptors/credit-note.descriptor';
import { FieldKindRegistry, registerCoreFieldKinds } from '../descriptors/field-kinds';
import { validateAgainstDescriptor } from '../descriptors/validate';
import { CountryFieldOverlayCatalog } from '../country-fields/registry';
import { resolveDomesticInvoiceCurrencyViolation } from '../country-policy/domestic-currency-issuance';
import { renderDocumentHtml } from '../rendering/render-html';
import { resolveInvoiceCrossBorderTax, ForeignVatRateError } from '../tax/resolve-invoice-tax';
import { determineLineTax } from '../tax/tax-engine';
import { defaultTaxSystemRegistry } from '../tax/tax-systems/registry';
import { TrustFlagVatValidator } from '../tax/classification';
import { computeDocumentTotals } from '../totals/compute-totals';
import { defaultVatRateCatalog, vatRateFieldOptions } from '../vat-rates/registry';

const descriptor = buildInvoiceDescriptor();
const data = (vatRate: string) => ({
  client: 'buyer',
  currency: 'NZD',
  issueDate: '2026-11-16',
  lines: [{ description: 'Consulting', quantity: 2, unitPrice: 100, discountPercent: 10, vatRate }],
});

describe('New Zealand ordinary invoicing', () => {
  it('requires NZD for domestic invoices through the shared country policy', () => {
    expect(resolveDomesticInvoiceCurrencyViolation('NZ', 'NZ', 'USD')?.requiredCurrency).toBe('NZD');
    expect(resolveDomesticInvoiceCurrencyViolation('NZ', 'NZ', 'NZD')).toBeUndefined();
  });
  it('requires the original invoice when validating an NZ correction document', () => {
    const fields = applyCompanyFieldView({
      typeId: 'credit-note',
      fields: buildCreditNoteDescriptor().fields,
      countryCode: 'NZ',
      fieldOverlayCatalog: new CountryFieldOverlayCatalog(),
      vatRateCatalog: defaultVatRateCatalog,
    });
    const registry = new FieldKindRegistry();
    registerCoreFieldKinds(registry);
    expect(validateAgainstDescriptor(fields, {}, registry).map((error) => error.key)).toContain('invoice');
    expect(
      validateAgainstDescriptor(fields, { invoice: 'original-invoice' }, registry).filter(
        (error) => error.key === 'invoice',
      ),
    ).toEqual([]);
  });

  it('clears stale EU tax metadata without changing the selected GST treatment or the input', () => {
    const original = data('nz-standard');
    const row = {
      ...original.lines[0],
      __crossBorderCategory: 'AE',
      __crossBorderExemptionReason: 'VATEX-EU-AE',
    };
    const input = {
      ...original,
      lines: [row],
      __crossBorderMentions: [{ code: 'EU', text: 'Reverse charge' }],
    };
    const result = resolveInvoiceCrossBorderTax({
      seller: { countryCode: 'NZ' },
      buyer: { countryCode: 'AU' },
      data: input,
    });
    expect(result.data.lines).toEqual(original.lines);
    expect(result.data.__crossBorderMentions).toEqual([]);
    expect(input.lines[0].__crossBorderCategory).toBe('AE');
  });

  it('the shared engine emits GST instead of EU VAT semantics for a declared overseas supply', () => {
    const result = determineLineTax(
      { legalName: 'Seller', countryCode: 'NZ', role: 'B2B', identifiers: [] },
      { legalName: 'Buyer', countryCode: 'AU', role: 'B2B', identifiers: [] },
      {
        id: '1',
        description: 'Service',
        quantity: 1,
        unitNetMinor: 10000,
        supplyType: 'SERVICES',
        taxRateHint: 15,
      },
      defaultTaxSystemRegistry.resolve('NZ')!,
      new TrustFlagVatValidator(),
    );
    expect(result.components).toEqual([
      { taxSystem: 'GST', name: 'GST', category: 'S', rate: 15, jurisdiction: 'NZ', reason: undefined },
    ]);
    expect(result.buyerSelfAssess).toBe(false);
    expect(result.mentions).toEqual([]);
  });

  it('loads all six core mechanisms and offers distinct standard, zero-rated and exempt GST choices', () => {
    expect(new CountryReadinessService().getReadiness('NZ').missing).toEqual([]);
    expect(vatRateFieldOptions(defaultVatRateCatalog, 'NZ').options.map((option) => option.value)).toEqual([
      'nz-standard',
      'nz-zero',
      'nz-exempt',
    ]);
  });

  it('requires the registered seller GST number at issuance, without requiring a buyer GST number or NZBN', () => {
    const seller = { countryCode: 'NZ', identifiers: [], vatRegime: 'STANDARD' as const };
    expect(missingInvoiceIdentifiers(seller)).toEqual([
      { party: 'SELLER', scheme: 'VAT', label: 'GST number' },
    ]);
    expect(missingInvoiceIdentifiers({ ...seller, vatRegime: 'FRANCHISE_BASE' })).toEqual([]);
    expect(
      defaultCountryIdentifierRequirementsCatalog.schemesFor('NZ').filter((scheme) => scheme.required),
    ).toEqual([]);
  });

  it.each([
    'NZ',
    'AU',
    'US',
  ])('keeps the chosen GST rate for NZ → %s and calculates discounted totals', (buyer) => {
    const result = resolveInvoiceCrossBorderTax({
      seller: { countryCode: 'NZ' },
      buyer: { countryCode: buyer },
      data: data('nz-standard'),
    });
    expect(result.warnings).toEqual([]);
    expect(computeDocumentTotals(descriptor, result.data)).toMatchObject({
      netMinor: 18000,
      vatMinor: 2700,
      grossMinor: 20700,
    });
    expect(JSON.stringify(result.data)).not.toMatch(/VATEX-EU|Directive|reverse charge/i);
  });

  it.each(['nz-zero', 'nz-exempt'])('keeps %s stable when an overseas invoice is resolved twice', (rate) => {
    const input = { seller: { countryCode: 'NZ' }, buyer: { countryCode: 'AU' }, data: data(rate) };
    const first = resolveInvoiceCrossBorderTax(input);
    const second = resolveInvoiceCrossBorderTax({ ...input, data: first.data });
    expect(second.data).toEqual(first.data);
    expect((second.data.lines as Record<string, unknown>[])[0].vatRate).toBe(rate);
    expect(computeDocumentTotals(descriptor, second.data)).toMatchObject({ vatMinor: 0, grossMinor: 18000 });
  });

  it.each(['NZ', 'AU'])('never charges GST from an unregistered seller to %s', (buyer) => {
    const result = resolveInvoiceCrossBorderTax({
      seller: { countryCode: 'NZ', taxScheme: 'FRANCHISE_BASE' },
      buyer: { countryCode: buyer },
      data: data('nz-standard'),
    });
    expect(computeDocumentTotals(descriptor, result.data).vatMinor).toBe(0);
    expect(JSON.stringify(result.data)).toContain('Not registered for GST');
    expect(JSON.stringify(result.data)).not.toMatch(/Directive|small business scheme/);
  });

  it.each(['NZ', 'AU'])('refuses a foreign rate on an NZ invoice to %s', (buyer) => {
    expect(() =>
      resolveInvoiceCrossBorderTax({
        seller: { countryCode: 'NZ' },
        buyer: { countryCode: buyer },
        data: data('20'),
      }),
    ).toThrow(ForeignVatRateError);
  });

  it('renders GST terminology and its tax amount in the invoice PDF source', () => {
    const fields = applyCompanyFieldView({
      typeId: 'invoice',
      fields: descriptor.fields,
      countryCode: 'NZ',
      fieldOverlayCatalog: new CountryFieldOverlayCatalog(),
      vatRateCatalog: defaultVatRateCatalog,
    });
    const html = renderDocumentHtml({
      descriptor: { ...descriptor, fields },
      instance: {
        id: 'invoice',
        status: 'sent',
        data: data('nz-standard'),
        createdAt: new Date('2026-11-16'),
        displayNumber: 'INV-1',
      },
      company: { name: 'Kiwi Ltd', country: 'New Zealand', countryCode: 'NZ' },
      referenceLabels: { client: 'Buyer Ltd' },
      totals: computeDocumentTotals(descriptor, data('nz-standard')),
    });
    expect(html).toContain('GST rate');
    expect(html).toContain('GST 15%');
    expect(html).toContain('27.00 NZD');
    expect(html).not.toContain('VAT rate');
  });

  it('retains records beyond the end of an unknown GST period, for seven more years', () => {
    const result = computeRetention(
      defaultRetentionCatalog.fileFor('NZ'),
      new Date('2026-11-16'),
      new Date('2026-11-16'),
    );
    expect(result.retentionUntil?.toISOString()).toBe('2034-11-16T00:00:00.000Z');
  });
});
