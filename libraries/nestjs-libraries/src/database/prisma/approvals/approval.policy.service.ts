import { ForbiddenException, Injectable } from '@nestjs/common';
import { ActorRole, ApprovalAction, Role, WorkflowRole } from '@prisma/client';
import { ApprovalsRepository } from '@gitroom/nestjs-libraries/database/prisma/approvals/approvals.repository';

// FORK: approvals

// the roles each workflow action accepts, in the order actorRoleFor picks them
const ACTION_ROLES: Partial<Record<ApprovalAction, WorkflowRole[]>> = {
  SUBMITTED: ['CREATOR'],
  REVIEW_APPROVED: ['REVIEWER'],
  REJECTED: ['REVIEWER', 'MONTHLY_REVIEWER'],
  FINAL_APPROVED: ['MONTHLY_REVIEWER'],
  FORCED: ['MONTHLY_REVIEWER'],
  LINKED_BRIEF: ['CREATOR', 'TECHNICAL_WRITER'],
  VERIFIED: ['TECHNICAL_WRITER'],
  VERIFICATION_PROBLEM: ['TECHNICAL_WRITER'],
};

const NOT_BY_AUTHOR: ApprovalAction[] = [
  'REVIEW_APPROVED',
  'FINAL_APPROVED',
  'FORCED',
];

@Injectable()
export class ApprovalPolicyService {
  constructor(private _approvalsRepository: ApprovalsRepository) {}

  async assertCan(
    actorUserId: string,
    orgId: string,
    action: ApprovalAction,
    approval: { id: string }
  ) {
    const allowed = ACTION_ROLES[action];
    if (!allowed) {
      throw new ForbiddenException(
        `${action} no es una acción del flujo de aprobación`
      );
    }

    const roles = await this._approvalsRepository.getRoles(orgId, actorUserId);
    if (!allowed.some((role) => roles.includes(role))) {
      throw new ForbiddenException(
        `Esta acción necesita uno de estos roles: ${allowed.join(', ')}`
      );
    }

    if (NOT_BY_AUTHOR.includes(action)) {
      const authors = await this._approvalsRepository.authorIds(
        orgId,
        approval.id
      );
      if (authors.includes(actorUserId)) {
        throw new ForbiddenException(
          'El autor de un post no puede aprobarlo ni forzarlo'
        );
      }
    }

    if (action === 'FINAL_APPROVED') {
      const review = await this._approvalsRepository.lastActorOf(
        orgId,
        approval.id,
        'REVIEW_APPROVED'
      );
      if (review?.actorUserId === actorUserId) {
        throw new ForbiddenException(
          'La aprobación final debe darla alguien distinto de quien revisó'
        );
      }
    }
  }

  async actorRoleFor(
    orgId: string,
    userId: string | undefined | null,
    action: ApprovalAction
  ): Promise<ActorRole> {
    if (!userId) {
      return 'SYSTEM';
    }

    const roles = await this._approvalsRepository.getRoles(orgId, userId);
    const candidates = ACTION_ROLES[action] || ['CREATOR'];
    return candidates.find((role) => roles.includes(role)) || 'MEMBER';
  }

  async assertIsOrgAdmin(userId: string, orgId: string) {
    const role = await this._approvalsRepository.getOrgRole(orgId, userId);
    if (role !== Role.ADMIN && role !== Role.SUPERADMIN) {
      throw new ForbiddenException(
        'Solo los administradores pueden asignar roles del flujo'
      );
    }
  }
}
