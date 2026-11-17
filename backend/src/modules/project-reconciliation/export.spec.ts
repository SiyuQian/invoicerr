import { csvCell, buildReconciliationCsv } from './export';
describe('reconciliation CSV trust boundary', () => {
  it.each(['=1+1', '+1', '-1', '@SUM(A1)', '\tcommand', '\rcommand', '  =1', '\n\t@cmd'])(
    'neutralises formula prefix %j',
    (value) => {
      expect(csvCell(value).replace(/^"/, '').startsWith("'")).toBe(true);
    },
  );
  it('preserves generated signed numeric amounts', () => {
    expect(csvCell(-115000)).toBe('-115000');
  });
  it('quotes commas, embedded quotes and newlines', () => {
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
  });
  it('refuses a partial view rather than silently exporting the first page', () => {
    expect(() =>
      buildReconciliationCsv({ cases: { items: [], nextCursor: 'next', total: 50 } } as never),
    ).toThrow('complete');
  });
});
