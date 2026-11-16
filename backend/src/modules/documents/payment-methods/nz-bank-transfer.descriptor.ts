import { ValidationError } from '../descriptors/validate';
import { PaymentMethodDescriptor, presentFromFields } from './types';

// Keep suffix width and leading zeros; never repair arbitrary input by stripping non-digits.
const ACCOUNT_NUMBER =
  /^ *(?:[0-9]{15,16}|[0-9]{2}-[0-9]{4}-[0-9]{7}-[0-9]{2,3}|[0-9]{2} +[0-9]{4} +[0-9]{7} +[0-9]{2,3}) *$/;

export function validateNzBankTransferConfig(config: Record<string, unknown>): ValidationError[] {
  const errors: ValidationError[] = [];
  for (const key of ['accountName', 'bankName']) {
    const value = config[key];
    if (
      typeof value === 'string' &&
      value !== '' &&
      (!value.trim() || value.length > 200 || /[\r\n\u2028\u2029]/.test(value))
    ) {
      errors.push({ key, message: 'must be a non-blank single line of at most 200 characters.' });
    }
  }
  const value = config.accountNumber;
  if (typeof value === 'string' && value !== '' && (!ACCOUNT_NUMBER.test(value) || /[^0-9 -]/.test(value))) {
    errors.push({
      key: 'accountNumber',
      message: 'must be a New Zealand account in BB-BBBB-AAAAAAA-SS or BB-BBBB-AAAAAAA-SSS format.',
    });
  }
  return errors;
}

export const nzBankTransferPaymentMethod: PaymentMethodDescriptor = {
  id: 'bank_transfer_nz',
  label: 'Bank transfer (New Zealand)',
  fields: [
    { key: 'accountName', kind: 'text', label: 'Account name', required: true },
    {
      key: 'accountNumber',
      kind: 'text',
      label: 'Account number',
      required: true,
      helpText:
        'BB-BBBB-AAAAAAA-SS or BB-BBBB-AAAAAAA-SSS. Spaces or digits only are also accepted. Format validation does not verify the account.',
    },
    { key: 'bankName', kind: 'text', label: 'Bank name', required: false },
  ],
  validateConfig: validateNzBankTransferConfig,
  present(ctx) {
    return presentFromFields(nzBankTransferPaymentMethod, ctx.config);
  },
};
