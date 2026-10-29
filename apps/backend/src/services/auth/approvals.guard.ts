import {
  CanActivate,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Request } from 'express';
import { ApprovalGateService } from '@gitroom/nestjs-libraries/database/prisma/approvals/approval.gate.service';

// FORK: approvals. The approval and brief routes only exist while
// APPROVALS_ENABLED=true.
@Injectable()
export class ApprovalsEnabledGuard implements CanActivate {
  constructor(private _approvalGate: ApprovalGateService) {}

  canActivate(): boolean {
    if (!this._approvalGate.enabled()) {
      throw new NotFoundException();
    }

    return true;
  }
}

// the same condition auth.middleware.ts uses to switch to the impersonated
// user: no workflow action can be taken in someone else's name
export const assertNotImpersonating = (req: Request) => {
  if (
    (req as any).user?.isSuperAdmin &&
    (req.cookies?.impersonate || req.headers?.impersonate)
  ) {
    throw new ForbiddenException(
      'Las acciones de aprobación no se pueden hacer suplantando a otra persona'
    );
  }
};
