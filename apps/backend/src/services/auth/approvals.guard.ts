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

// With DISABLE_REGISTRATION (invite-only install) only an admin of the
// organization invites or removes members. Without Stripe the policies guard
// allows every section, so any member could otherwise do it.
export const assertOrgAdminWhenInviteOnly = (org: {
  users?: { role: string }[];
}) => {
  if (
    process.env.DISABLE_REGISTRATION === 'true' &&
    !['ADMIN', 'SUPERADMIN'].includes(org?.users?.[0]?.role || '')
  ) {
    throw new ForbiddenException(
      'Solo un administrador puede invitar o quitar miembros'
    );
  }
};

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
