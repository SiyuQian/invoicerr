import { FieldKindRegistry, registerCoreFieldKinds } from '../descriptors/field-kinds';
import { validateAgainstDescriptor } from '../descriptors/validate';
import { BUILT_IN_PAYMENT_METHODS } from './built-in';

const registry = new FieldKindRegistry();
registerCoreFieldKinds(registry);

function nzMethod() {
  const method = BUILT_IN_PAYMENT_METHODS.find((entry) => entry.id === 'bank_transfer_nz');
  expect(method).toBeDefined();
  return method!;
}

function errors(config: Record<string, unknown>) {
  const method = nzMethod();
  return [
    ...validateAgainstDescriptor(method.fields, config, registry),
    ...(method.validateConfig?.(config) ?? []),
  ];
}

describe('New Zealand bank transfer', () => {
  const validNumbers = [
    '12-3456-0123456-00',
    '12-3456-0123456-000',
    '12 3456 0123456 00',
    '12 3456 0123456 000',
    ' 12  3456  0123456  00 ',
    ' 12-3456-0123456-000 ',
    '123456012345600',
    '1234560123456000',
  ];
  it.each(validNumbers)('preserves the valid account %j', (accountNumber) => {
    const config = { accountName: 'Te Whānau & Co', accountNumber };
    expect(errors(config)).toEqual([]);
    expect(nzMethod().present({ config, currency: 'NZD', amountMinor: 10000 })).toEqual({
      id: 'bank_transfer_nz',
      label: 'Bank transfer (New Zealand)',
      lines: ['Account name: Te Whānau & Co', `Account number: ${accountNumber}`],
    });
  });

  it.each([
    '',
    ' ',
    '12-3456-0123456-0',
    '12-3456-0123456-0000',
    '12-3456-123456-00',
    '12-3456-0123456',
    '12/3456/0123456/00',
    '12 3456-0123456-00',
    '12-3456-012345A-00',
    '１２-3456-0123456-00',
    '12\t3456\t0123456\t00',
    '12-3456-0123456-00\n',
    '1.234560123456e14',
    123456012345600,
    null,
    [],
    {},
  ])('rejects account %j without echoing it', (accountNumber) => {
    const result = errors({ accountName: 'Example Ltd', accountNumber });
    expect(result.some((error) => error.key === 'accountNumber')).toBe(true);
    if (typeof accountNumber === 'string' && accountNumber.length > 5) {
      expect(JSON.stringify(result)).not.toContain(accountNumber);
    }
  });

  it.each(['accountName', 'bankName'])('checks non-empty single-line %s', (key) => {
    for (const value of [' ', 'x'.repeat(201), 'name\nother', 'name\rother']) {
      expect(errors({ accountName: 'Example Ltd', accountNumber: validNumbers[0], [key]: value })).toEqual(
        expect.arrayContaining([expect.objectContaining({ key })]),
      );
    }
  });

  it('requires an account name and accepts an optional bank name', () => {
    expect(errors({ accountNumber: validNumbers[0] })).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'accountName' })]),
    );
    const config = { accountName: 'Example Ltd', accountNumber: validNumbers[0], bankName: 'Example Bank' };
    expect(errors(config)).toEqual([]);
    expect(nzMethod().present({ config }).lines.at(-1)).toBe('Bank name: Example Bank');
    expect(errors({ ...config, bankName: '' })).toEqual([]);
  });
});
