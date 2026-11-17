import { schemas, parse, encodePeriod, decodePeriod } from './validation';

const project = {
  name: 'Work',
  endCustomerName: 'Customer',
  currency: 'NZD',
  collectionMode: 'COMPANY',
  endCustomerClientId: null,
  partnerClientId: null,
  timeProjectId: null,
  description: null,
};
const agreement = {
  title: 'Stage',
  periodStart: null,
  periodEnd: null,
  agreedGrossMinor: null,
  agreedNetMinor: null,
  agreedVatMinor: null,
  agreementReference: null,
};
describe('reconciliation strict wire schemas', () => {
  it('keeps missing agreements null and never coerces amounts', () => {
    expect(parse(schemas.createCase, agreement).agreedGrossMinor).toBeNull();
    for (const value of ['100', undefined, NaN, Infinity, 1.5, -1, 2147483648, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parse(schemas.createCase, { ...agreement, agreedGrossMinor: value })).toThrow();
    }
  });
  it('rejects unknown fields, non-objects, unsupported currency, missing partner and equal parties', () => {
    for (const value of [
      null,
      [],
      'x',
      { ...project, actor: 'evil' },
      { ...project, companyId: 'evil' },
      { ...project, currency: 'ZZZ' },
      { ...project, collectionMode: 'PARTNER' },
      { ...project, endCustomerClientId: 'same', partnerClientId: 'same' },
      { ...project, name: 'x'.repeat(201) },
    ]) {
      expect(() => parse(schemas.createProject, value)).toThrow();
    }
  });
  it('checks real dates, range ordering and nullable endpoint round trips', () => {
    for (const [start, end] of [
      [null, null],
      ['2026-11-01', null],
      [null, '2026-11-30'],
      ['2024-02-29', '2026-11-30'],
    ] as const) {
      expect(decodePeriod(encodePeriod(start, end))).toEqual({ periodStart: start, periodEnd: end });
    }
    for (const dates of [
      { periodStart: '2026-02-29' },
      { periodStart: '2026-11-31' },
      { periodStart: '2026-11-30', periodEnd: '2026-11-01' },
    ]) {
      expect(() => parse(schemas.createCase, { ...agreement, ...dates })).toThrow();
    }
  });
  it('freezes bounded future evidence, allocation, invoice, review and import boundaries', () => {
    const receipt = {
      amountMinor: 100,
      currency: 'NZD',
      paidOn: null,
      evidenceClass: 'PARTNER_REPORTED',
      evidenceReference: 'report',
      evidenceUrl: null,
      reason: 'Reported',
    };
    expect(parse(schemas.receipt, receipt).paidOn).toBeNull();
    expect(
      parse(schemas.receipt, { ...receipt, evidenceUrl: 'https://evidence.example.com/reference' })
        .evidenceUrl,
    ).toBe('https://evidence.example.com/reference');
    for (const evidenceUrl of [
      'http://example.test',
      'https://user:pass@example.test',
      'javascript:alert(1)',
      'https://127.0.0.1',
      'https://device.local./proof',
      'https://intranet.localhost./proof',
      'https://example.test/ white',
      `https://example.test/${'x'.repeat(2048)}`,
    ])
      expect(() => parse(schemas.receipt, { ...receipt, evidenceUrl })).toThrow();
    expect(() => parse(schemas.receipt, { ...receipt, sourceSystem: 'ledgerly' })).toThrow();
    expect(() =>
      parse(schemas.receipt, { ...receipt, evidenceClass: 'EVIDENCE_CHECKED', evidenceReference: null }),
    ).toThrow();
    expect(() => parse(schemas.allocation, { customerInvoiceId: 'a', amountMinor: 0 })).toThrow();
    expect(() =>
      parse(schemas.externalInvoice, {
        issuer: 'i',
        recipient: 'r',
        number: 'n',
        issueDate: null,
        dueDate: null,
        currency: 'NZD',
        grossMinor: 100,
        netMinor: null,
        vatMinor: null,
        reportedStatus: null,
        sourceSystem: 'ledgerly',
        sourceId: null,
        sourceAsOf: '2026-11-01T00:00:00Z',
        sourceReference: 'report',
      }),
    ).toThrow();
    expect(() =>
      parse(schemas.reviewCase, {
        mode: 'ACCEPT_EXCEPTIONS',
        exceptions: [{ code: 'X', fingerprint: 'f', reason: '' }],
        reason: 'Review',
      }),
    ).toThrow();
    expect(() =>
      parse(schemas.evidenceCoverage, {
        customerInvoiceIds: ['a'],
        sourceAsOf: '2026-11-01T00:00:00Z',
        evidenceReference: 'report',
        attested: false,
      }),
    ).toThrow();
    expect(() =>
      parse(schemas.ledgerlyPayload, {
        sourceSystem: 'ledgerly',
        sourceAsOf: '2026-11-01T00:00:00Z',
        project: {
          id: 'a',
          name: 'a',
          customerIssuer: 'a',
          customerRecipient: 'b',
          shareIssuer: 'a',
          shareRecipient: 'b',
        },
        invoices: [],
      }),
    ).toThrow();
  });
  it('validates importer confirmation payloads and partial future updates without unknown fields', () => {
    expect(() =>
      parse(schemas.importConfirm, { previewHash: 'a'.repeat(64), payload: { unvalidated: true } }),
    ).toThrow();
    expect(() => parse(schemas.updateReceipt, { amountMinor: '100', reason: 'Change' })).toThrow();
    expect(() => parse(schemas.updateExternalInvoice, { companyId: 'foreign' })).toThrow();
  });
  it('freezes exact response schemas without accepting fabricated complete subtotals', () => {
    expect(schemas.projectView).toBeDefined();
    expect(() =>
      parse(schemas.moneyMeasure, { knownMinor: 100, missingCount: 1, completeness: 'COMPLETE' }),
    ).toThrow();
    expect(
      parse(schemas.moneyMeasure, { knownMinor: 100, missingCount: 1, completeness: 'PARTIAL' }),
    ).toEqual({ knownMinor: 100, missingCount: 1, completeness: 'PARTIAL' });
    expect(() =>
      parse(schemas.registerView, {
        project: {},
        cases: [],
        versionToken: 'v',
        asOf: '2026-11-01T00:00:00Z',
        sourceFingerprint: 'a'.repeat(64),
      }),
    ).toThrow();
  });
  it('keeps Ledgerly cents as safe source integers for later exact currency-exponent conversion', () => {
    const row = {
      id: 'row',
      number: 'INV-1',
      projectName: 'Work',
      issuer: 'Issuer',
      recipient: 'Recipient',
      kind: 'Customer invoice',
      status: 'Sent',
      issueDate: null,
      dueDate: null,
      paidDate: null,
      exGstAmountCents: 2147483700,
      gstAmountCents: 0,
      totalCents: 2147483700,
      sharePercent: null,
      sourceNumber: null,
      linkedInvoiceNumber: null,
    };
    expect(parse(schemas.ledgerlyRow, row).totalCents).toBe(2147483700);
    expect(() => parse(schemas.ledgerlyRow, { ...row, totalCents: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(
      parse(schemas.moneyMeasure, { knownMinor: -100, missingCount: 0, completeness: 'COMPLETE' }).knownMinor,
    ).toBe(-100);
    expect(() => parse(schemas.projectListQuery, { needsAttention: 'yes' })).toThrow();
  });
  it('requires explicit literal attestation for checked receipts even when reason and reference exist', () => {
    const checked = {
      amountMinor: 100,
      currency: 'NZD',
      paidOn: null,
      evidenceClass: 'EVIDENCE_CHECKED',
      evidenceReference: 'Checked bank statement',
      evidenceUrl: null,
      reason: 'Matched the statement entry',
    };
    expect(() => parse(schemas.receipt, checked)).toThrow();
    for (const attested of [undefined, false, null, 'true']) {
      expect(() => parse(schemas.receipt, { ...checked, attested })).toThrow();
    }
    expect(parse(schemas.receipt, { ...checked, attested: true }).attested).toBe(true);
    expect(() => parse(schemas.receipt, { ...checked, attested: true, evidenceReference: null })).toThrow();
    expect(
      parse(schemas.receipt, { ...checked, evidenceClass: 'PARTNER_REPORTED' }).attested,
    ).toBeUndefined();
    expect(
      parse(schemas.updateReceipt, { attested: true, reason: 'Rechecked changed amount' }).attested,
    ).toBe(true);
    expect(() => parse(schemas.updateReceipt, { attested: false, reason: 'Not attested' })).toThrow();
  });
});
