import { Currency } from '../../../../prisma/generated/prisma/client';
import { decimalsFor, toMinor } from '@/utils/financial';
import type { DocumentTotals } from './compute-totals';

export type FinancialTotals = Omit<DocumentTotals, 'netMinor' | 'vatMinor' | 'grossMinor'> & {
  netMinor: number | null;
  vatMinor: number | null;
  grossMinor: number | null;
};

const currencies = new Set<string>(Object.values(Currency));
export function isFinancialCurrency(value: unknown): value is string {
  return typeof value === 'string' && currencies.has(value);
}

/** Check a stored major-unit amount without accepting the rounding used for computed line totals. */
export function exactMinor(value: unknown, currency: string): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const minor = toMinor(value, currency);
  return Number.isSafeInteger(minor) && minor / 10 ** decimalsFor(currency) === value ? minor : null;
}

/** Supplier totals are recorded facts; informational lines must not replace them or invent tax. */
export function resolveFlatTotals(typeId: string, data: Record<string, unknown>): FinancialTotals | null {
  if (typeId !== 'expense' && typeId !== 'received-invoice') return null;
  const currency = isFinancialCurrency(data.currency) ? data.currency : null;
  const gross = typeId === 'expense' ? data.amount : data.grossAmount;
  const net = typeId === 'expense' ? undefined : data.netAmount;
  const vat = typeId === 'expense' ? undefined : data.vatAmount;
  const values = [gross, net, vat];
  const valid =
    currency !== null &&
    values.every(
      (value, index) =>
        (index > 0 && (value === undefined || value === null)) ||
        (exactMinor(value, currency) !== null && (value as number) >= 0),
    );
  return {
    currency,
    grossMinor: valid ? exactMinor(gross, currency!) : null,
    netMinor: valid && net !== undefined && net !== null ? exactMinor(net, currency!) : null,
    vatMinor: valid && vat !== undefined && vat !== null ? exactMinor(vat, currency!) : null,
    lines: [],
    vatBreakdown: [],
    warnings: [],
    showVat: false,
  };
}
