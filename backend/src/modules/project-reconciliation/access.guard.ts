import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { RequestWithUser } from '@/types/request';

@Injectable()
export class ReconciliationAccessGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<RequestWithUser>();
    if (!request.user) throw new UnauthorizedException();
    const write = !['GET', 'HEAD'].includes(request.method);
    if (!request.role || !['OWNER', 'ADMIN', ...(!write ? ['MEMBER'] : [])].includes(request.role))
      throw new ForbiddenException({
        code: 'RECONCILIATION_FORBIDDEN',
        message: 'Insufficient company role.',
      });
    if (request.scopes !== null) {
      const reads = (resource: string) =>
        request.scopes!.includes(`${resource}:read`) || request.scopes!.includes(`${resource}:write`);
      if (
        !(write
          ? request.scopes.includes('project-reconciliation:write')
          : reads('project-reconciliation')) ||
        !['invoices', 'credit-notes', 'expenses', 'received-invoices'].every(reads)
      )
        throw new ForbiddenException({
          code: 'RECONCILIATION_FORBIDDEN',
          message: 'The module and all financial resource scopes are required.',
        });
    }
    return true;
  }
}
