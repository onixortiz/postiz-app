import { Injectable, Logger } from '@nestjs/common';
import {
  ApprovalStage,
  PostApproval,
  Prisma,
  State,
  WorkflowRole,
} from '@prisma/client';
import dayjs from 'dayjs';
import * as Sentry from '@sentry/nestjs';
import { ApprovalsRepository } from '@gitroom/nestjs-libraries/database/prisma/approvals/approvals.repository';
import { ApprovalGateService } from '@gitroom/nestjs-libraries/database/prisma/approvals/approval.gate.service';
import {
  ApprovalNotifyData,
  ApprovalNotifyService,
} from '@gitroom/nestjs-libraries/database/prisma/approvals/approval.notify.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';

// FORK: approvals. What depends on time (expirations, warnings, confirming the
// publication) and the reconciliation that sends back to DRAFT whatever is
// scheduled without a valid approval. Every step only acts while its
// condition still holds, so running it twice changes nothing.

const PRE_APPROVAL: ApprovalStage[] = [
  'IN_PRODUCTION',
  'CHANGES_REQUESTED',
  'IN_REVIEW',
  'AWAITING_FINAL',
];

// who gets the 48 h / 24 h warning, by the stage the batch is in
const STAGE_ROLE: Partial<Record<ApprovalStage, WorkflowRole>> = {
  IN_PRODUCTION: 'CREATOR',
  CHANGES_REQUESTED: 'CREATOR',
  IN_REVIEW: 'REVIEWER',
  AWAITING_FINAL: 'MONTHLY_REVIEWER',
};

const DONE_STAGES: ApprovalStage[] = [
  'PUBLISHED',
  'VERIFIED',
  'VERIFICATION_PROBLEM',
];

@Injectable()
export class ApprovalSweepService {
  private readonly _logger = new Logger(ApprovalSweepService.name);

  constructor(
    private _approvalsRepository: ApprovalsRepository,
    private _approvalGateService: ApprovalGateService,
    private _approvalNotifyService: ApprovalNotifyService,
    private _postsService: PostsService
  ) {}

  async run(now: Date) {
    if (!this._approvalGateService.enabled()) {
      return;
    }

    for (const orgId of await this._approvalsRepository.listOrgIdsToSweep()) {
      await this.step('expired', orgId, () => this.expired(orgId, now));
      await this.step('warnings', orgId, () => this.warnings(orgId, now));
      await this.step('published', orgId, () => this.published(orgId, now));
      await this.step('verify overdue', orgId, () =>
        this.verifyOverdue(orgId, now)
      );
      await this.reconcileOrg(orgId, false);
    }
  }

  async reconcile({ startup }: { startup: boolean }) {
    if (!this._approvalGateService.enabled()) {
      return;
    }

    for (const orgId of await this._approvalsRepository.listOrgIdsToSweep()) {
      await this.reconcileOrg(orgId, startup);
    }
  }

  // 5d goes first: a batch saved while the fork was off is adopted (CREATED
  // by SYSTEM) before 5b would take its queued posts as unapproved
  private async reconcileOrg(orgId: string, startup: boolean) {
    await this.step('batches without approval', orgId, () =>
      this.batchesWithoutApproval(orgId)
    );
    await this.step('blocked at publish', orgId, () =>
      this.blockedAtPublish(orgId, startup)
    );
    await this.step('queued without approval', orgId, () =>
      this.queuedWithoutApproval(orgId, startup)
    );
    await this.step('errors before approval', orgId, () =>
      this.errorsBeforeApproval(orgId, startup)
    );
    await this.step('lost channels', orgId, () => this.lostChannels(orgId));
  }

  // one failing step doesn't stop the others
  private async step(name: string, orgId: string, run: () => Promise<void>) {
    try {
      await run();
    } catch (err) {
      this._logger.error(
        `sweep step "${name}" failed for org ${orgId}`,
        (err as Error)?.stack
      );
    }
  }

  // ---- 1: expired before the final approval ----

  private async expired(orgId: string, now: Date) {
    for (const approval of await this._approvalsRepository.findExpired(
      orgId,
      now
    )) {
      if (
        !(await this._approvalsRepository.markWarned(
          orgId,
          approval.id,
          'warnedExpiredAt',
          now
        ))
      ) {
        continue;
      }

      await this.systemEvent(orgId, approval, 'EXPIRED');
      Sentry.metrics.count('approval_expired', 1);
      await this._approvalNotifyService.notifyTeam(
        orgId,
        'EXPIRED',
        this.data(approval)
      );
    }
  }

  // ---- 2: 48 h and 24 h warnings ----

  // the closest threshold wins: a batch already inside 24 h gets only that one
  private async warnings(orgId: string, now: Date) {
    for (const approval of await this._approvalsRepository.findWarnable(
      orgId,
      now,
      24
    )) {
      if (
        await this._approvalsRepository.markWarned(
          orgId,
          approval.id,
          'warned24At',
          now,
          ['warned48At']
        )
      ) {
        await this.warnStageRole(orgId, approval, 'WARN_24H');
      }
    }

    const in24 = dayjs(now).add(24, 'hour').toDate();
    for (const approval of await this._approvalsRepository.findWarnable(
      orgId,
      now,
      48
    )) {
      if (
        approval.earliestPublishDate > in24 &&
        (await this._approvalsRepository.markWarned(
          orgId,
          approval.id,
          'warned48At',
          now
        ))
      ) {
        await this.warnStageRole(orgId, approval, 'WARN_48H');
      }
    }
  }

  private async warnStageRole(
    orgId: string,
    approval: PostApproval,
    template: 'WARN_24H' | 'WARN_48H'
  ) {
    const role = STAGE_ROLE[approval.stage];
    if (role) {
      await this._approvalNotifyService.notifyRole(
        orgId,
        role,
        template,
        this.data(approval)
      );
    }
  }

  // ---- 3: every remaining channel was published ----

  private async published(orgId: string, now: Date) {
    for (const approval of await this._approvalsRepository.findPublishedCandidates(
      orgId
    )) {
      const moved = await this._approvalsRepository.transition(
        orgId,
        approval.id,
        approval.version,
        {
          stage: 'PUBLISHED',
          verifyDueAt: dayjs(now).add(24, 'hour').toDate(),
        },
        [{ actorRole: 'SYSTEM', action: 'PUBLISHED', surface: 'UNKNOWN' }]
      );
      if (!moved) {
        continue;
      }

      await this.closeBrief(orgId, approval.briefId);
      await this._approvalNotifyService.notifyRole(
        orgId,
        'TECHNICAL_WRITER',
        'PUBLISHED',
        this.data(approval)
      );
    }
  }

  // a brief is done once every batch linked to it was published
  private async closeBrief(orgId: string, briefId: string | null) {
    if (!briefId) {
      return;
    }

    const brief = await this._approvalsRepository.getBrief(orgId, briefId);
    if (
      brief?.status === 'IN_PRODUCTION' &&
      brief.approvals.every((p) => DONE_STAGES.includes(p.stage))
    ) {
      await this._approvalsRepository.updateBrief(orgId, briefId, {
        status: 'DONE',
      });
    }
  }

  // ---- 4: published but not verified in 24 h ----

  private async verifyOverdue(orgId: string, now: Date) {
    for (const approval of await this._approvalsRepository.findVerificationOverdue(
      orgId,
      now
    )) {
      if (
        !(await this._approvalsRepository.markWarned(
          orgId,
          approval.id,
          'warnedVerifyAt',
          now
        ))
      ) {
        continue;
      }

      for (const role of ['TECHNICAL_WRITER', 'MONTHLY_REVIEWER'] as const) {
        await this._approvalNotifyService.notifyRole(
          orgId,
          role,
          'VERIFY_OVERDUE',
          this.data(approval)
        );
      }
    }
  }

  // ---- 5a: the publish check stopped a post ----

  // isPublishAllowed already recorded BLOCKED_AT_PUBLISH, so no event here
  private async blockedAtPublish(orgId: string, startup: boolean) {
    for (const post of await this._approvalsRepository.findBlockedAtPublish(
      orgId
    )) {
      const { allowed, reason } =
        await this._approvalGateService.evaluatePublish(orgId, post.id);
      // a valid approval: the post failed for another reason, it can be retried
      if (allowed) {
        continue;
      }

      // first move it, then tell: a post that can't be moved is not notified
      // again every 15 minutes, and a second sweep finds nothing to claim
      if (!(await this.toDraft(orgId, post.id, 'ERROR'))) {
        continue;
      }

      const approval = post.batchId
        ? await this._approvalsRepository.getApprovalByBatch(
            orgId,
            post.batchId
          )
        : null;

      if (!startup && post.batchId) {
        const data = {
          approvalId: approval?.id || '',
          batchId: post.batchId,
        };
        if (reason === 'fingerprint_drift') {
          await this._approvalNotifyService.notifyRole(
            orgId,
            'MONTHLY_REVIEWER',
            'BLOCKED_AT_PUBLISH',
            data
          );
        } else {
          await this._approvalNotifyService.notifyAdmins(
            orgId,
            'BLOCKED_AT_PUBLISH',
            data
          );
        }
      }

      if (approval?.stage === 'APPROVED') {
        await this.backToReview(orgId, approval);
      }
    }
  }

  // an approved batch whose content no longer matches goes back to review
  private async backToReview(orgId: string, approval: PostApproval) {
    const moved = await this._approvalsRepository.transition(
      orgId,
      approval.id,
      approval.version,
      { stage: 'IN_REVIEW', approvedFingerprints: Prisma.DbNull },
      [
        {
          actorRole: 'SYSTEM',
          action: 'RESET_BY_EDIT',
          surface: 'UNKNOWN',
          fingerprints: await this._approvalGateService.fingerprintsFromDb(
            orgId,
            approval.batchId
          ),
        },
      ]
    );
    if (!moved) {
      return;
    }

    for (const root of await this._approvalsRepository.getBatchRootPosts(
      orgId,
      approval.batchId
    )) {
      if (root.state !== 'PUBLISHED' && root.state !== 'DRAFT') {
        await this.toDraft(orgId, root.id, root.state);
      }
    }

    await this._approvalNotifyService.notifyRole(
      orgId,
      'REVIEWER',
      'RESET_BY_EDIT',
      this.data(approval)
    );
  }

  // ---- 5b: scheduled without a valid approval ----

  private async queuedWithoutApproval(orgId: string, startup: boolean) {
    for (const post of await this._approvalsRepository.findQueueRoots(orgId)) {
      const { allowed, reason } =
        await this._approvalGateService.evaluatePublish(orgId, post.id);
      if (allowed || !(await this.toDraft(orgId, post.id, 'QUEUE'))) {
        continue;
      }

      Sentry.metrics.count('approval_reconciled', 1);

      const approval = post.batchId
        ? await this._approvalsRepository.getApprovalByBatch(
            orgId,
            post.batchId
          )
        : null;
      await this._approvalsRepository.insertEvent({
        organizationId: orgId,
        approvalId: approval?.id || null,
        actorRole: 'SYSTEM',
        action: 'RECONCILED',
        surface: 'UNKNOWN',
        reason: startup ? 'startup' : reason,
      });
      this._logger.warn(
        `RECONCILED post ${post.id}, batch ${post.batchId}, reason ${reason}`
      );

      if (!startup && post.batchId) {
        await this._approvalNotifyService.notifyAdmins(orgId, 'RECONCILED', {
          approvalId: approval?.id || '',
          batchId: post.batchId,
        });
      }
    }
  }

  // ---- 5c: a failed post in a batch that was never approved ----

  private async errorsBeforeApproval(orgId: string, startup: boolean) {
    for (const post of await this._approvalsRepository.findErrorRootsInUnapproved(
      orgId
    )) {
      if (!(await this.toDraft(orgId, post.id, 'ERROR'))) {
        continue;
      }
      const approval = await this._approvalsRepository.getApprovalByBatch(
        orgId,
        post.batchId!
      );
      await this._approvalsRepository.insertEvent({
        organizationId: orgId,
        approvalId: approval?.id || null,
        actorRole: 'SYSTEM',
        action: 'RECONCILED',
        surface: 'UNKNOWN',
        reason: startup ? 'startup' : 'error_before_approval',
      });
    }
  }

  // ---- 5d: posts saved while the fork was off ----

  private async batchesWithoutApproval(orgId: string) {
    for (const batchId of await this._approvalsRepository.findBatchesWithoutApproval(
      orgId
    )) {
      const roots = await this._approvalsRepository.getBatchRootPosts(
        orgId,
        batchId
      );
      try {
        await this._approvalsRepository.createApproval(
          orgId,
          batchId,
          roots.reduce(
            (min, p) => (p.publishDate < min ? p.publishDate : min),
            roots[0].publishDate
          ),
          {
            actorRole: 'SYSTEM',
            action: 'CREATED',
            surface: 'UNKNOWN',
            fingerprints: await this._approvalGateService.fingerprintsFromDb(
              orgId,
              batchId
            ),
          }
        );
      } catch (err) {
        // another sweep created it first (batchId is unique)
        continue;
      }

      for (const root of roots) {
        if (root.state !== 'PUBLISHED' && root.state !== 'DRAFT') {
          await this.toDraft(orgId, root.id, root.state);
        }
      }
    }
  }

  // ---- 5e: a channel deleted without going through deletePost ----

  private async lostChannels(orgId: string) {
    for (const approval of await this._approvalsRepository.listApprovals(
      orgId,
      [...PRE_APPROVAL, 'APPROVED']
    )) {
      const reference = await this._approvalGateService.referenceFingerprints(
        orgId,
        approval
      );
      if (!reference) {
        continue;
      }

      const present = new Set(
        (
          await this._approvalsRepository.getBatchRootPosts(
            orgId,
            approval.batchId
          )
        ).map((p) => p.integrationId)
      );
      const discarded = await this._approvalsRepository.discardedIntegrations(
        orgId,
        approval.id
      );

      for (const integrationId of Object.keys(reference)) {
        if (!present.has(integrationId) && !discarded.has(integrationId)) {
          await this._approvalsRepository.insertEvent({
            organizationId: orgId,
            approvalId: approval.id,
            actorRole: 'SYSTEM',
            action: 'CHANNEL_DISCARDED',
            surface: 'UNKNOWN',
            snapshot: { integrationId },
          });
        }
      }
    }
  }

  // ---- helpers ----

  // claims the post with a conditional update, then lets Postiz terminate its
  // workflows (startWorkflow with DRAFT). False when another sweep got it first
  private async toDraft(orgId: string, postId: string, from: State) {
    if (!(await this._approvalsRepository.claimDraft(orgId, postId, from))) {
      return false;
    }
    await this._postsService.changePostStatus(orgId, postId, 'draft');
    return true;
  }

  private systemEvent(
    orgId: string,
    approval: PostApproval,
    action: 'EXPIRED'
  ) {
    return this._approvalsRepository.insertEvent({
      organizationId: orgId,
      approvalId: approval.id,
      actorRole: 'SYSTEM',
      action,
      surface: 'UNKNOWN',
    });
  }

  private data(approval: PostApproval): ApprovalNotifyData {
    return { approvalId: approval.id, batchId: approval.batchId };
  }
}
