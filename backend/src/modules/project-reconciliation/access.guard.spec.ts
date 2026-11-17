import { ReconciliationAccessGuard } from './access.guard';
import { ExecutionContext } from '@nestjs/common';
const resources = ['invoices', 'credit-notes', 'expenses', 'received-invoices'];
function context(scopes: string[] | null, method = 'GET', role = 'MEMBER') {
  return {
    switchToHttp: () => ({ getRequest: () => ({ scopes, method, role, user: { id: 'u' }, companyId: 'c' }) }),
  } as ExecutionContext;
}
describe('ReconciliationAccessGuard all-of resource scopes', () => {
  const guard = new ReconciliationAccessGuard();
  it('allows MEMBER reads but only OWNER/ADMIN writes', () => {
    expect(guard.canActivate(context(null))).toBe(true);
    expect(() => guard.canActivate(context(null, 'POST'))).toThrow();
    for (const role of ['OWNER', 'ADMIN']) expect(guard.canActivate(context(null, 'POST', role))).toBe(true);
  });
  it('requires the module scope and read-equivalent access to every financial resource', () => {
    const scopes = ['project-reconciliation:read', ...resources.map((r) => `${r}:read`)];
    expect(guard.canActivate(context(scopes))).toBe(true);
    for (let i = 0; i < scopes.length; i++)
      expect(() => guard.canActivate(context(scopes.filter((_, j) => i !== j)))).toThrow();
    expect(() => guard.canActivate(context(['project-reconciliation:read']))).toThrow();
    expect(
      guard.canActivate(
        context(['project-reconciliation:write', ...resources.map((r) => `${r}:write`)], 'POST', 'ADMIN'),
      ),
    ).toBe(true);
    expect(() => guard.canActivate(context(scopes, 'POST', 'ADMIN'))).toThrow();
    for (let i = 0; i < resources.length; i++)
      expect(
        guard.canActivate(
          context(scopes.map((s) => (s === `${resources[i]}:read` ? `${resources[i]}:write` : s))),
        ),
      ).toBe(true);
  });
});
