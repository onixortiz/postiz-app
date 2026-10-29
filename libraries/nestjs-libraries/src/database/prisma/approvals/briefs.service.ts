import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { BriefStatus } from '@prisma/client';
import { ApprovalsRepository } from '@gitroom/nestjs-libraries/database/prisma/approvals/approvals.repository';
import { ApprovalPolicyService } from '@gitroom/nestjs-libraries/database/prisma/approvals/approval.policy.service';
import {
  CreateBriefDto,
  UpdateBriefDto,
} from '@gitroom/nestjs-libraries/dtos/approvals/brief.dto';

// FORK: approvals. The topic and base text the Technical Writer prepares
// before there is a post.

type Actor = { id: string };

@Injectable()
export class BriefsService {
  constructor(
    private _approvalsRepository: ApprovalsRepository,
    private _approvalPolicyService: ApprovalPolicyService
  ) {}

  list(orgId: string, status?: BriefStatus) {
    return this._approvalsRepository.listBriefs(orgId, status);
  }

  async get(orgId: string, id: string) {
    const brief = await this._approvalsRepository.getBrief(orgId, id);
    if (!brief) {
      throw new NotFoundException('Brief not found');
    }
    return brief;
  }

  async create(orgId: string, actor: Actor, body: CreateBriefDto) {
    await this.assertWriter(orgId, actor);
    await this.assertCreator(orgId, body.assignedCreatorId);

    return this._approvalsRepository.createBrief(orgId, actor.id, {
      topic: body.topic,
      baseCopy: body.baseCopy,
      targetDate: body.targetDate ? new Date(body.targetDate) : undefined,
      assignedCreatorId: body.assignedCreatorId,
    });
  }

  // the writer edits any brief, and whoever wrote a quick brief can edit it
  async update(orgId: string, id: string, actor: Actor, body: UpdateBriefDto) {
    const brief = await this.get(orgId, id);
    if (!(brief.quickBrief && brief.createdById === actor.id)) {
      await this.assertWriter(orgId, actor);
    }
    await this.assertCreator(orgId, body.assignedCreatorId || undefined);

    return this._approvalsRepository.updateBrief(orgId, id, {
      ...(body.topic !== undefined ? { topic: body.topic } : {}),
      ...(body.baseCopy !== undefined ? { baseCopy: body.baseCopy } : {}),
      ...(body.targetDate !== undefined
        ? { targetDate: body.targetDate ? new Date(body.targetDate) : null }
        : {}),
      ...(body.assignedCreatorId !== undefined
        ? { assignedCreatorId: body.assignedCreatorId }
        : {}),
    });
  }

  async cancel(orgId: string, id: string, actor: Actor) {
    await this.assertWriter(orgId, actor);
    const brief = await this.get(orgId, id);
    if (brief.status !== 'OPEN' && brief.status !== 'IN_PRODUCTION') {
      throw new BadRequestException('Este tema ya está cerrado');
    }

    return this._approvalsRepository.updateBrief(orgId, id, {
      status: 'CANCELLED',
    });
  }

  private async assertWriter(orgId: string, actor: Actor) {
    if (
      !(await this._approvalPolicyService.hasRole(
        orgId,
        actor.id,
        'TECHNICAL_WRITER'
      ))
    ) {
      throw new ForbiddenException(
        'Esta acción necesita el rol TECHNICAL_WRITER'
      );
    }
  }

  private async assertCreator(orgId: string, userId?: string) {
    if (userId && !(await this._approvalsRepository.isMember(orgId, userId))) {
      throw new BadRequestException('La persona asignada no es del equipo');
    }
  }
}
