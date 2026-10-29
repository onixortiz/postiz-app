import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ApprovalStage,
  PostApproval,
  Prisma,
  WorkflowRole,
} from '@prisma/client';
import dayjs from 'dayjs';
import * as Sentry from '@sentry/nestjs';
import {
  ApprovalEventInput,
  ApprovalsRepository,
} from '@gitroom/nestjs-libraries/database/prisma/approvals/approvals.repository';
import { ApprovalPolicyService } from '@gitroom/nestjs-libraries/database/prisma/approvals/approval.policy.service';
import { ApprovalGateService } from '@gitroom/nestjs-libraries/database/prisma/approvals/approval.gate.service';
import { ApprovalNotifyService } from '@gitroom/nestjs-libraries/database/prisma/approvals/approval.notify.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { CreatePublicCommentDto } from '@gitroom/nestjs-libraries/dtos/comments/add.comment.dto';
import {
  BatchDetail,
  InboxItem,
  RoleRow,
  StagesMap,
} from '@gitroom/nestjs-libraries/dtos/approvals/approval.actions.dto';

// FORK: approvals. Every step of the flow: load, check the actor, check the
// stage, move it with the optimistic lock, then send the notices.

type Actor = { id: string };

const PRE_APPROVAL: ApprovalStage[] = [
  'IN_PRODUCTION',
  'CHANGES_REQUESTED',
  'IN_REVIEW',
  'AWAITING_FINAL',
];

// the stages each role works on, for the inbox
const INBOX_STAGES: Record<WorkflowRole, ApprovalStage[]> = {
  CREATOR: ['IN_PRODUCTION', 'CHANGES_REQUESTED'],
  REVIEWER: ['IN_REVIEW'],
  MONTHLY_REVIEWER: ['AWAITING_FINAL'],
  TECHNICAL_WRITER: ['PUBLISHED'],
};

@Injectable()
export class ApprovalService {
  private readonly _logger = new Logger(ApprovalService.name);

  constructor(
    private _approvalsRepository: ApprovalsRepository,
    private _approvalPolicyService: ApprovalPolicyService,
    private _approvalGateService: ApprovalGateService,
    private _approvalNotifyService: ApprovalNotifyService,
    private _postsService: PostsService
  ) {}

  // ---- workflow actions ----

  async submit(
    orgId: string,
    batchId: string,
    version: number,
    actor: Actor,
    quickTopic?: string
  ) {
    const approval = await this.load(orgId, batchId);
    await this._approvalPolicyService.assertCan(
      actor.id,
      orgId,
      'SUBMITTED',
      approval
    );
    this.assertStage(approval, ['IN_PRODUCTION', 'CHANGES_REQUESTED']);

    const topic = quickTopic?.trim();
    if (!approval.briefId && !topic) {
      throw new BadRequestException('Falta el tema');
    }

    const roots = await this.validateBatch(orgId, batchId);
    const actorRole = await this._approvalPolicyService.actorRoleFor(
      orgId,
      actor.id,
      'SUBMITTED'
    );

    // a batch without brief gets a one line brief from the creator
    const brief = approval.briefId
      ? null
      : await this._approvalsRepository.createBrief(orgId, actor.id, {
          topic: topic!,
          quickBrief: true,
          status: 'IN_PRODUCTION',
        });

    const fingerprints = await this._approvalGateService.fingerprintsFromDb(
      orgId,
      batchId
    );
    const events: ApprovalEventInput[] = [
      ...(brief
        ? [
            {
              actorUserId: actor.id,
              actorRole,
              action: 'LINKED_BRIEF' as const,
              surface: 'WEB' as const,
            },
          ]
        : []),
      {
        actorUserId: actor.id,
        actorRole,
        action: 'SUBMITTED',
        surface: 'WEB',
        fingerprints,
        snapshot: this.snapshot(roots),
      },
    ];

    try {
      await this.move(
        orgId,
        approval,
        version,
        { stage: 'IN_REVIEW', ...(brief ? { briefId: brief.id } : {}) },
        events
      );
    } catch (err) {
      if (brief) {
        await this._approvalsRepository.updateBrief(orgId, brief.id, {
          status: 'CANCELLED',
          deletedAt: new Date(),
        });
      }
      throw err;
    }

    await this._approvalNotifyService.notifyRole(
      orgId,
      'REVIEWER',
      'SUBMITTED',
      this.data(approval)
    );
    return this.getBatch(orgId, batchId);
  }

  async reviewApprove(
    orgId: string,
    batchId: string,
    version: number,
    actor: Actor
  ) {
    const approval = await this.load(orgId, batchId);
    await this._approvalPolicyService.assertCan(
      actor.id,
      orgId,
      'REVIEW_APPROVED',
      approval
    );
    this.assertStage(approval, ['IN_REVIEW']);

    const fingerprints = await this.assertUnchanged(orgId, approval);
    const roots = await this._approvalsRepository.getBatchRootPosts(
      orgId,
      batchId
    );

    await this.move(orgId, approval, version, { stage: 'AWAITING_FINAL' }, [
      {
        actorUserId: actor.id,
        actorRole: 'REVIEWER',
        action: 'REVIEW_APPROVED',
        surface: 'WEB',
        fingerprints,
        snapshot: this.snapshot(roots),
      },
    ]);

    await this._approvalNotifyService.notifyRole(
      orgId,
      'MONTHLY_REVIEWER',
      'REVIEW_APPROVED',
      this.data(approval)
    );
    return this.getBatch(orgId, batchId);
  }

  async reject(
    orgId: string,
    batchId: string,
    version: number,
    actor: Actor,
    commentText: string
  ) {
    const approval = await this.load(orgId, batchId);
    await this._approvalPolicyService.assertCan(
      actor.id,
      orgId,
      'REJECTED',
      approval
    );
    this.assertStage(approval, ['IN_REVIEW', 'AWAITING_FINAL']);
    this.assertVersion(approval, version);

    const commentId = await this.comment(orgId, batchId, actor, commentText);
    await this.move(orgId, approval, version, { stage: 'CHANGES_REQUESTED' }, [
      {
        actorUserId: actor.id,
        actorRole: await this._approvalPolicyService.actorRoleFor(
          orgId,
          actor.id,
          'REJECTED'
        ),
        action: 'REJECTED',
        surface: 'WEB',
        commentId,
        reason: commentText.trim(),
      },
    ]);

    // back to whoever sent it, or to every creator if nobody did
    const submitter = await this._approvalsRepository.lastActorOf(
      orgId,
      approval.id,
      'SUBMITTED'
    );
    if (submitter?.actorUserId) {
      await this._approvalNotifyService.notifyUser(
        orgId,
        submitter.actorUserId,
        'REJECTED',
        this.data(approval)
      );
    } else {
      await this._approvalNotifyService.notifyRole(
        orgId,
        'CREATOR',
        'REJECTED',
        this.data(approval)
      );
    }
    return this.getBatch(orgId, batchId);
  }

  // each batch on its own: one invalid batch doesn't stop the others
  async finalApprove(
    orgId: string,
    items: { batchId: string; version: number }[],
    actor: Actor
  ) {
    const results: { batchId: string; ok: boolean; error?: string }[] = [];
    for (const item of items) {
      try {
        await this.finalApproveOne(orgId, item.batchId, item.version, actor);
        results.push({ batchId: item.batchId, ok: true });
      } catch (err) {
        results.push({
          batchId: item.batchId,
          ok: false,
          error: (err as Error).message,
        });
      }
    }
    return results;
  }

  private async finalApproveOne(
    orgId: string,
    batchId: string,
    version: number,
    actor: Actor
  ) {
    const approval = await this.load(orgId, batchId);
    await this._approvalPolicyService.assertCan(
      actor.id,
      orgId,
      'FINAL_APPROVED',
      approval
    );
    this.assertStage(approval, ['AWAITING_FINAL']);

    const fingerprints = await this.assertUnchanged(orgId, approval);
    const roots = await this._approvalsRepository.getBatchRootPosts(
      orgId,
      batchId
    );
    const pending = roots.filter((p) => p.state !== 'PUBLISHED');
    if (pending.some((p) => !dayjs(p.publishDate).isAfter(dayjs()))) {
      throw new BadRequestException('La fecha de publicación ya pasó');
    }

    await this.move(
      orgId,
      approval,
      version,
      { stage: 'APPROVED', approvedFingerprints: fingerprints },
      [
        {
          actorUserId: actor.id,
          actorRole: 'MONTHLY_REVIEWER',
          action: 'FINAL_APPROVED',
          surface: 'WEB',
          fingerprints,
          snapshot: this.snapshot(roots),
        },
      ]
    );

    await this.schedule(
      orgId,
      approval,
      version + 1,
      pending,
      'AWAITING_FINAL'
    );
  }

  async force(
    orgId: string,
    batchId: string,
    version: number,
    actor: Actor,
    reason: string
  ) {
    if (!reason || reason.trim().length < 10) {
      throw new BadRequestException(
        'El motivo debe tener al menos 10 caracteres'
      );
    }

    const approval = await this.load(orgId, batchId);
    await this._approvalPolicyService.assertCan(
      actor.id,
      orgId,
      'FORCED',
      approval
    );
    this.assertStage(approval, PRE_APPROVAL);

    const roots = await this.validateBatch(orgId, batchId);
    const fingerprints = await this._approvalGateService.fingerprintsFromDb(
      orgId,
      batchId
    );

    await this.move(
      orgId,
      approval,
      version,
      { stage: 'APPROVED', approvedFingerprints: fingerprints, forced: true },
      [
        {
          actorUserId: actor.id,
          actorRole: 'MONTHLY_REVIEWER',
          action: 'FORCED',
          surface: 'WEB',
          reason: reason.trim(),
          fingerprints,
          snapshot: this.snapshot(roots),
        },
      ]
    );

    // a date that already passed publishes right away
    await this.schedule(
      orgId,
      approval,
      version + 1,
      roots.filter((p) => p.state !== 'PUBLISHED'),
      approval.stage,
      actor
    );

    Sentry.metrics.count('approval_forced', 1);
    this._logger.log(
      `FORCED approval ${approval.id}, batch ${batchId}, actor ${actor.id}`
    );
    await this._approvalNotifyService.notifyTeam(
      orgId,
      'FORCED',
      this.data(approval)
    );
    await this._approvalNotifyService.notifyAdmins(
      orgId,
      'FORCED',
      this.data(approval)
    );
    return this.getBatch(orgId, batchId);
  }

  async verify(orgId: string, batchId: string, version: number, actor: Actor) {
    const approval = await this.load(orgId, batchId);
    await this._approvalPolicyService.assertCan(
      actor.id,
      orgId,
      'VERIFIED',
      approval
    );
    this.assertStage(approval, ['PUBLISHED']);

    await this.move(
      orgId,
      approval,
      version,
      { stage: 'VERIFIED', verifiedAt: new Date(), verifiedById: actor.id },
      [
        {
          actorUserId: actor.id,
          actorRole: 'TECHNICAL_WRITER',
          action: 'VERIFIED',
          surface: 'WEB',
        },
      ]
    );
    return this.getBatch(orgId, batchId);
  }

  async markProblem(
    orgId: string,
    batchId: string,
    version: number,
    actor: Actor,
    commentText: string
  ) {
    const approval = await this.load(orgId, batchId);
    await this._approvalPolicyService.assertCan(
      actor.id,
      orgId,
      'VERIFICATION_PROBLEM',
      approval
    );
    this.assertStage(approval, ['PUBLISHED']);
    this.assertVersion(approval, version);

    const commentId = await this.comment(orgId, batchId, actor, commentText);
    await this.move(
      orgId,
      approval,
      version,
      { stage: 'VERIFICATION_PROBLEM' },
      [
        {
          actorUserId: actor.id,
          actorRole: 'TECHNICAL_WRITER',
          action: 'VERIFICATION_PROBLEM',
          surface: 'WEB',
          commentId,
          reason: commentText.trim(),
        },
      ]
    );

    await this._approvalsRepository.createBrief(orgId, actor.id, {
      topic: `Corrección: ${approval.brief?.topic || '(sin tema)'}`,
      correctionOfApprovalId: approval.id,
    });

    await this._approvalNotifyService.notifyTeam(
      orgId,
      'VERIFICATION_PROBLEM',
      this.data(approval)
    );
    return this.getBatch(orgId, batchId);
  }

  async linkBrief(
    orgId: string,
    batchId: string,
    version: number,
    briefId: string,
    actor: Actor
  ) {
    const approval = await this.load(orgId, batchId);
    await this._approvalPolicyService.assertCan(
      actor.id,
      orgId,
      'LINKED_BRIEF',
      approval
    );
    this.assertStage(approval, ['IN_PRODUCTION', 'CHANGES_REQUESTED']);

    const brief = await this._approvalsRepository.getBrief(orgId, briefId);
    if (!brief) {
      throw new NotFoundException('Brief not found');
    }
    if (brief.status === 'DONE' || brief.status === 'CANCELLED') {
      throw new BadRequestException(
        'Este tema ya está cerrado y no se puede enlazar'
      );
    }

    await this.move(orgId, approval, version, { briefId }, [
      {
        actorUserId: actor.id,
        actorRole: await this._approvalPolicyService.actorRoleFor(
          orgId,
          actor.id,
          'LINKED_BRIEF'
        ),
        action: 'LINKED_BRIEF',
        surface: 'WEB',
      },
    ]);

    if (brief.status === 'OPEN') {
      await this._approvalsRepository.updateBrief(orgId, briefId, {
        status: 'IN_PRODUCTION',
      });
    }
    return this.getBatch(orgId, batchId);
  }

  async setRoles(
    orgId: string,
    userId: string,
    roles: WorkflowRole[],
    actor: Actor
  ) {
    await this._approvalPolicyService.assertIsOrgAdmin(actor.id, orgId);
    if (!(await this._approvalsRepository.isMember(orgId, userId))) {
      throw new NotFoundException('User not found');
    }

    await this._approvalsRepository.setRoles(orgId, userId, roles, actor.id);
    return this.getRoles(orgId);
  }

  // ---- reads ----

  async getInbox(orgId: string, actor: Actor): Promise<InboxItem[]> {
    const roles = await this._approvalsRepository.getRoles(orgId, actor.id);
    const stages = [...new Set(roles.flatMap((role) => INBOX_STAGES[role]))];
    if (!stages.length) {
      return [];
    }

    const now = new Date();
    return (await this._approvalsRepository.listInbox(orgId, stages)).map(
      (item) => ({
        batchId: item.batchId,
        version: item.version,
        stage: item.stage,
        expired:
          PRE_APPROVAL.includes(item.stage) && item.earliestPublishDate < now,
        brief: item.brief,
        earliestPublishDate: item.earliestPublishDate,
        posts: item.posts,
      })
    );
  }

  async getBatch(orgId: string, batchId: string): Promise<BatchDetail> {
    const approval = await this.load(orgId, batchId);
    const [roots, history] = await Promise.all([
      this._approvalsRepository.getBatchRootPosts(orgId, batchId),
      this._approvalsRepository.history(orgId, approval.id),
    ]);

    return {
      batchId,
      version: approval.version,
      stage: approval.stage,
      expired:
        PRE_APPROVAL.includes(approval.stage) &&
        approval.earliestPublishDate < new Date(),
      forced: approval.forced,
      brief: approval.brief
        ? {
            id: approval.brief.id,
            topic: approval.brief.topic,
            quickBrief: approval.brief.quickBrief,
          }
        : null,
      posts: roots.map((p) => ({
        id: p.id,
        group: p.group,
        integrationId: p.integrationId,
        state: p.state,
        error: p.error,
        publishDate: p.publishDate,
      })),
      history: history.map((event) => ({
        action: event.action,
        actorName: event.actor
          ? [event.actor.name, event.actor.lastName]
              .filter((f) => f)
              .join(' ') || event.actor.email
          : null,
        actorRole: event.actorRole,
        surface: event.surface,
        reason: event.reason,
        createdAt: event.createdAt,
      })),
    };
  }

  getStages(orgId: string, postIds: string[]): Promise<StagesMap> {
    return this._approvalsRepository.getStagesForPosts(orgId, postIds);
  }

  getRoles(orgId: string): Promise<RoleRow[]> {
    return this._approvalsRepository.listRoles(orgId);
  }

  // same mapping as the public preview: no tokens of the integration
  async getPreview(orgId: string, postId: string) {
    const posts = await this._postsService.getPostsRecursively(
      postId,
      true,
      orgId
    );
    if (!posts.length) {
      throw new NotFoundException('Post not found');
    }

    return posts.map(({ childrenPost, batchId, ...p }) => ({
      ...p,
      ...(p.integration
        ? {
            integration: {
              id: p.integration.id,
              name: p.integration.name,
              picture: p.integration.picture,
              providerIdentifier: p.integration.providerIdentifier,
              profile: p.integration.profile,
            },
          }
        : {}),
    }));
  }

  async getPreviewComments(orgId: string, postId: string) {
    const posts = await this._postsService.getPostsRecursively(
      postId,
      false,
      orgId
    );
    if (!posts.length) {
      throw new NotFoundException('Post not found');
    }

    return { comments: await this._postsService.getComments(postId) };
  }

  // ---- helpers ----

  private async load(orgId: string, batchId: string) {
    const approval = await this._approvalsRepository.getApprovalByBatch(
      orgId,
      batchId
    );
    if (!approval) {
      throw new NotFoundException('Approval not found');
    }
    return approval;
  }

  private assertStage(approval: PostApproval, stages: ApprovalStage[]) {
    if (!stages.includes(approval.stage)) {
      throw new BadRequestException(
        'El post no está en una etapa que permita esta acción'
      );
    }
  }

  // checked before writing anything that a conflict would leave behind
  private assertVersion(approval: PostApproval, version: number) {
    if (approval.version !== version) {
      throw new ConflictException(
        'El post cambió mientras lo revisabas, vuelve a cargarlo'
      );
    }
  }

  private async move(
    orgId: string,
    approval: PostApproval,
    version: number,
    data: Parameters<ApprovalsRepository['transition']>[3],
    events: ApprovalEventInput[]
  ) {
    const moved = await this._approvalsRepository.transition(
      orgId,
      approval.id,
      version,
      data,
      events
    );
    if (!moved) {
      throw new ConflictException(
        'El post cambió mientras lo revisabas, vuelve a cargarlo'
      );
    }

    this._logger.log(
      `${events.map((p) => p.action).join(', ')} approval ${
        approval.id
      }, batch ${approval.batchId}, actor ${events[0].actorUserId}`
    );
  }

  // the content has to be what was sent or reviewed
  private async assertUnchanged(orgId: string, approval: PostApproval) {
    // review compares with what was sent, the final approval with what was
    // reviewed: a CONTENT_EDITED whose reset failed is never a reference
    const [current, event] = await Promise.all([
      this._approvalGateService.fingerprintsFromDb(orgId, approval.batchId),
      this._approvalsRepository.lastEventWithFingerprints(
        orgId,
        approval.id,
        approval.stage === 'AWAITING_FINAL'
          ? ['REVIEW_APPROVED']
          : ['SUBMITTED', 'RESET_BY_EDIT']
      ),
    ]);
    const reference = event?.fingerprints as Record<string, string> | null;

    const keys = new Set([
      ...Object.keys(current),
      ...Object.keys(reference || {}),
    ]);
    if (
      !reference ||
      [...keys].some((key) => current[key] !== reference[key])
    ) {
      throw new ConflictException(
        'El contenido cambió desde la última revisión, vuelve a cargarlo'
      );
    }
    return current;
  }

  // the same checks as updatePostSettings, for every channel of the batch
  private async validateBatch(orgId: string, batchId: string) {
    const roots = await this._approvalsRepository.getBatchRootPosts(
      orgId,
      batchId
    );
    if (!roots.length) {
      throw new BadRequestException('El lote no tiene canales');
    }

    for (const root of roots) {
      const ordered = await this._postsService.getPostsRecursively(
        root.id,
        true,
        orgId,
        true
      );
      // the root is loaded with its integration
      const integration = ordered[0]?.integration;
      if (!integration) {
        throw new BadRequestException('Uno de los canales ya no existe');
      }

      let settings: Record<string, any>;
      try {
        settings = JSON.parse(root.settings || '{}');
      } catch (err) {
        settings = {};
      }

      const [validation] = await this._postsService.validatePosts(orgId, [
        {
          integration: { id: root.integrationId },
          settings: {
            ...settings,
            __type: integration.providerIdentifier,
          },
          value: ordered.map((p) => {
            let image = [];
            try {
              image = JSON.parse(p.image || '[]');
            } catch (err) {}
            return { content: p.content, image };
          }),
        },
      ]);

      if (validation.emptyContent) {
        throw new BadRequestException(
          `${validation.name}: Your post should have at least one character or one image.`
        );
      }
      if (!validation.valid) {
        throw new BadRequestException(
          `${validation.name}: ${
            validation.settingsError || 'Please fix your settings'
          }`
        );
      }
      if (validation.errors !== true) {
        throw new BadRequestException(
          `${validation.name}: ${validation.errors}`
        );
      }
      if (validation.tooLong) {
        throw new BadRequestException(
          `${validation.name}: The maximum characters is ${validation.maximumCharacters}`
        );
      }
    }

    return roots;
  }

  // queues every root that isn't published. If one fails, the ones already
  // queued go back to DRAFT and the batch returns to `rollbackStage`. With
  // `bumpPastDatesFor` (force), a date that passed moves to now plus a minute
  private async schedule(
    orgId: string,
    approval: PostApproval,
    version: number,
    roots: { id: string; publishDate: Date }[],
    rollbackStage: ApprovalStage,
    bumpPastDatesFor?: Actor
  ) {
    const scheduled: string[] = [];
    try {
      for (const root of roots) {
        if (bumpPastDatesFor && !dayjs(root.publishDate).isAfter(dayjs())) {
          await this._postsService.changeDate(
            orgId,
            root.id,
            dayjs().add(1, 'minute').toISOString(),
            'update',
            false,
            bumpPastDatesFor.id,
            'WEB'
          );
        }
        await this._postsService.changePostStatus(orgId, root.id, 'schedule');
        scheduled.push(root.id);
      }
    } catch (err) {
      for (const id of scheduled) {
        await this._postsService
          .changePostStatus(orgId, id, 'draft')
          .catch((e: Error) => this._logger.error(`rollback ${id}`, e.stack));
      }

      const rolledBack = await this._approvalsRepository.transition(
        orgId,
        approval.id,
        version,
        {
          stage: rollbackStage,
          approvedFingerprints: Prisma.DbNull,
          forced: false,
        },
        [
          {
            actorRole: 'SYSTEM',
            action: 'BLOCKED',
            surface: 'WEB',
            reason: 'final_approval_failed',
          },
        ]
      );
      if (!rolledBack) {
        // the publish check still stops the drafts, the sweep reconciles it
        this._logger.error(
          `could not roll back approval ${approval.id}: version changed`
        );
      }
      throw err;
    }
  }

  private async comment(
    orgId: string,
    batchId: string,
    actor: Actor,
    commentText: string
  ) {
    if (!commentText || commentText.trim().length < 3) {
      throw new BadRequestException(
        'El comentario debe tener al menos 3 caracteres'
      );
    }

    const root = await this._approvalsRepository.getFirstRootPostId(
      orgId,
      batchId
    );
    if (!root) {
      throw new BadRequestException('El lote no tiene canales');
    }

    const comment = await this._postsService.createPublicComment(
      root.id,
      { content: commentText.trim() } as CreatePublicCommentDto,
      actor.id,
      '',
      orgId
    );
    return comment.id;
  }

  // text and media of every channel, as it was when the step was taken
  private snapshot(
    roots: Awaited<ReturnType<ApprovalsRepository['getBatchRootPosts']>>
  ) {
    return roots.reduce((all, root) => {
      all[root.integrationId] = [root, ...root.children].map((p) => ({
        content: p.content,
        image: p.image,
      }));
      return all;
    }, {} as Record<string, { content: string; image: string | null }[]>);
  }

  private data(approval: PostApproval) {
    return { approvalId: approval.id, batchId: approval.batchId };
  }
}
