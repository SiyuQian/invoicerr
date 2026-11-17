import { sourceAmountMinor } from './import';
import { assertImportSize, parse, schemas } from './validation';

const row = {
  id: 'invented-customer',
  projectId: 'invented-source-project',
  number: 'EX-CUSTOMER',
  projectName: 'Invented project',
  issuer: 'Invented partner',
  recipient: 'Invented customer',
  kind: 'Customer invoice',
  status: 'Paid',
  issueDate: null,
  dueDate: null,
  paidDate: null,
  exGstAmountCents: 10000,
  gstAmountCents: 1500,
  totalCents: 11500,
  sharePercent: null,
  sourceNumber: 'EX-CUSTOMER',
  linkedInvoiceNumber: null,
};
const payload = {
  sourceSystem: 'ledgerly',
  sourceAsOf: '2026-11-01T00:00:00Z',
  currency: 'NZD',
  project: {
    id: 'invented-source-project',
    name: 'Invented project',
    customerIssuer: 'Invented partner',
    customerRecipient: 'Invented customer',
    shareIssuer: 'Invented company',
    shareRecipient: 'Invented partner',
  },
  invoices: [row],
};
describe('import strict boundaries and exact source cents', () => {
  it('converts safe source cents to exact currency minors without rounding or FX', () => {
    expect(sourceAmountMinor(12300, 'JPY')).toBe(123);
    expect(sourceAmountMinor(12345, 'NZD')).toBe(12345);
    expect(sourceAmountMinor(12345, 'KWD')).toBe(123450);
    expect(sourceAmountMinor(214748364700, 'JPY')).toBe(2147483647);
    for (const [amount, currency] of [
      [12301, 'JPY'],
      [2147483648, 'NZD'],
      [214748365, 'KWD'],
      [-1, 'NZD'],
      [1.5, 'NZD'],
      [Number.MAX_SAFE_INTEGER + 1, 'JPY'],
    ] as const)
      expect(() => sourceAmountMinor(amount, currency)).toThrow();
  });
  it('requires selectedMatches, rejects unknown fields, and bounds both source kinds and choices', () => {
    expect(parse(schemas.importPreviewInput, { payload, selectedMatches: [] }).payload.invoices).toHaveLength(
      1,
    );
    for (const input of [
      { payload },
      { payload, selectedMatches: [], actor: 'spoof' },
      { payload: { ...payload, invoices: Array.from({ length: 1001 }, () => row) }, selectedMatches: [] },
      {
        payload,
        selectedMatches: Array.from({ length: 1001 }, () => ({
          sourceId: row.id,
          caseSourceId: row.id,
          documentId: 'invented-doc',
          typeId: 'invoice',
        })),
      },
      { payload: { ...payload, sourceUrl: 'https://source.example.test' }, selectedMatches: [] },
    ])
      expect(() => parse(schemas.importPreviewInput, input)).toThrow();
  });
  it('accepts only the observed inert snapshot structure, including signed historical cents', () => {
    const snapshot = {
      lineItems: [
        {
          category: 'Service',
          description: 'Invented discount',
          amountCents: -100,
          earnsReferralFee: false,
          revenueType: 'Service',
          treatment: 'Recorded',
        },
      ],
    };
    expect(parse(schemas.ledgerlyRow, { ...row, sourceSnapshot: snapshot }).sourceSnapshot).toEqual(snapshot);
    for (const sourceSnapshot of [
      { url: 'https://source.example.test' },
      { customerCard: { token: 'secret' } },
      { lineItems: [{ ...snapshot.lineItems[0], attachment: 'data:ignored' }] },
      { lineItems: Array.from({ length: 1001 }, () => snapshot.lineItems[0]) },
    ])
      expect(() => parse(schemas.ledgerlyRow, { ...row, sourceSnapshot })).toThrow();
  });
  it('rejects an oversized original snapshot before inert text trims can hide its size', () => {
    const original = {
      payload: {
        ...payload,
        invoices: [
          {
            ...row,
            sourceSnapshot: {
              lineItems: [
                {
                  category: 'Service',
                  description: ' '.repeat(65536),
                  amountCents: 0,
                  earnsReferralFee: false,
                  revenueType: 'Service',
                  treatment: 'Recorded',
                },
              ],
            },
          },
        ],
      },
      selectedMatches: [],
    };
    expect(() => assertImportSize(original)).toThrow();
  });
  it('accepts inert empty source placeholders without filling primary parties or project membership', () => {
    const placeholder = {
      ...row,
      projectId: null,
      projectName: '',
      sourceSnapshot: {
        customerCard: {
          label: '',
          issuer: '',
          recipient: '',
          number: null,
          pending: true,
          amountCents: 0,
          totalCents: 0,
        },
      },
    };
    const parsed = parse(schemas.ledgerlyRow, placeholder);
    expect(parsed.projectName).toBe('');
    expect(parsed.projectId).toBeNull();
    expect(parsed.sourceSnapshot?.customerCard?.issuer).toBe('');
    expect(() => parse(schemas.ledgerlyRow, { ...placeholder, issuer: '' })).toThrow();
    expect(() => parse(schemas.ledgerlyRow, { ...placeholder, recipient: '' })).toThrow();
    expect(() => parse(schemas.ledgerlyRow, { ...placeholder, number: '' })).toThrow();
    expect(() =>
      parse(schemas.ledgerlyPayload, { ...payload, project: { ...payload.project, name: '' } }),
    ).toThrow();
  });
  it('checks UTF-8 bytes on original untrimmed body rather than normalized characters', () => {
    expect(() => assertImportSize({ description: 'x'.repeat(2 * 1024 * 1024 - 18) })).not.toThrow();
    expect(() => assertImportSize({ description: '界'.repeat(750000) })).toThrow();
    expect(() => assertImportSize({ description: ' '.repeat(2 * 1024 * 1024) })).toThrow();
  });
  it('keeps exact edit-target read selectors separate from cursor pagination', () => {
    expect(parse(schemas.reportQuery, { caseId: 'invented-case', cashFrom: '2026-11-01' }).caseId).toBe(
      'invented-case',
    );
    expect(parse(schemas.receiptQuery, { receiptId: 'invented-receipt' }).receiptId).toBe('invented-receipt');
    expect(() =>
      parse(schemas.reportQuery, { caseId: 'invented-case', cursor: 'invented-cursor' }),
    ).toThrow();
    expect(() =>
      parse(schemas.receiptQuery, { receiptId: 'invented-receipt', cursor: 'invented-cursor' }),
    ).toThrow();
    expect(() => parse(schemas.reportQuery, { receiptId: 'invented-receipt' })).toThrow();
  });
  it('requires mapped historical invoice facts on every own-link proposal', () => {
    const link = {
      sourceId: 'invented-row',
      caseSourceId: 'invented-customer',
      role: 'CUSTOMER_INVOICE',
      candidates: [],
      selectedMatch: null,
      existingLinkId: null,
      action: 'UNRESOLVED',
    };
    expect(() => parse(schemas.importLinkProposal, link)).toThrow();
    const historical = {
      issuer: 'Invented company',
      recipient: 'Invented customer',
      number: 'EX-HISTORY',
      issueDate: null,
      dueDate: null,
      currency: 'NZD',
      grossMinor: 987654,
      netMinor: 900000,
      vatMinor: 87654,
      reportedStatus: 'Needs review',
      sourceSystem: 'ledgerly',
      sourceId: 'invented-row',
      sourceAsOf: payload.sourceAsOf,
      sourceReference: 'Invented immutable source',
    };
    expect(parse(schemas.importLinkProposal, { ...link, historical }).historical.grossMinor).toBe(987654);
    expect(() =>
      parse(schemas.importLinkProposal, {
        ...link,
        historical: { ...historical, documentId: 'invented-live-id' },
      }),
    ).toThrow();
  });
});
