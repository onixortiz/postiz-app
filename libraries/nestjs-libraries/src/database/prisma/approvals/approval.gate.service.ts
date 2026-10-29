import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  ApprovalStage,
  CreationMethod,
  PostApproval,
  Prisma,
  State,
} from '@prisma/client';
import { createHash } from 'crypto';
import dayjs from 'dayjs';
import * as Sentry from '@sentry/nestjs';
import { ApprovalsRepository } from '@gitroom/nestjs-libraries/database/prisma/approvals/approvals.repository';
import { ApprovalPolicyService } from '@gitroom/nestjs-libraries/database/prisma/approvals/approval.policy.service';
import { ApprovalNotifyService } from '@gitroom/nestjs-libraries/database/prisma/approvals/approval.notify.service';
import { CreatePostDto } from '@gitroom/nestjs-libraries/dtos/posts/create.post.dto';
import { isAllowedMediaPath } from '@gitroom/helpers/utils/is.allowed.media.path';

// FORK: approvals. The only place where the central rule is applied: a root
// post is published only when its batch is APPROVED and the fingerprint of its
// channel matches the one stored at approval time.

export type SaveType = 'draft' | 'schedule' | 'now' | 'update';

export type PublishDenyReason =
  | 'no_approval'
  | 'stage'
  | 'published'
  | 'fingerprint_drift';

export type Fingerprints = Record<string, string>;

export interface DeleteContext {
  root: {
    id: string;
    state: State;
    batchId: string | null;
    integrationId: string;
  };
  approval: PostApproval | null;
}

// an edit in these stages sends the batch back to review
const RESET_STAGES: ApprovalStage[] = [
  'IN_REVIEW',
  'AWAITING_FINAL',
  'APPROVED',
];

type BatchRoot = Awaited<
  ReturnType<ApprovalsRepository['getBatchRootPosts']>
>[number];

const parseJson = (value: string | null | undefined) => {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value);
  } catch (err) {
    return value;
  }
};

const isEmpty = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === '' ||
  (Array.isArray(value) && value.length === 0);

// keys sorted at every level and empty values dropped, so two equal contents
// always serialize the same way
const normalize = (value: any, dropType = false): any => {
  if (Array.isArray(value)) {
    return value.map((p) => normalize(p));
  }

  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((all, key) => {
        if ((dropType && key === '__type') || isEmpty(value[key])) {
          return all;
        }
        all[key] = normalize(value[key]);
        return all;
      }, {} as Record<string, any>);
  }

  return value;
};

@Injectable()
export class ApprovalGateService {
  private readonly _logger = new Logger(ApprovalGateService.name);

  constructor(
    private _approvalsRepository: ApprovalsRepository,
    private _approvalPolicyService: ApprovalPolicyService,
    private _approvalNotifyService: ApprovalNotifyService
  ) {}

  enabled() {
    return process.env.APPROVALS_ENABLED === 'true';
  }

  plugsEnabled() {
    return !this.enabled();
  }

  // only PostsService calls it, right before startWorkflow(DRAFT)
  setRootPostsDraft(orgId: string, postIds: string[]) {
    return this._approvalsRepository.setRootPostsDraft(orgId, postIds);
  }

  // ---- fingerprint ----

  async fingerprintsFromDb(
    orgId: string,
    batchId: string,
    integrationIds?: string[]
  ): Promise<Fingerprints> {
    const roots = await this._approvalsRepository.getBatchRootPosts(
      orgId,
      batchId
    );

    return this.fingerprintsOf(
      orgId,
      integrationIds
        ? roots.filter((p) => integrationIds.includes(p.integrationId))
        : roots
    );
  }

  private async fingerprintsOf(
    orgId: string,
    roots: BatchRoot[]
  ): Promise<Fingerprints> {
    const posts = roots.flatMap((root) => [root, ...root.children]);
    const mediaIds = posts.flatMap((post) =>
      this.mediaList(post.image)
        .map((media) => media?.id)
        .filter((id): id is string => typeof id === 'string' && !!id)
    );
    const knownMedia = await this._approvalsRepository.findExistingMediaIds(
      orgId,
      mediaIds
    );

    // a channel normally has one root in the batch, but if it has more they
    // are hashed together in id order
    const byIntegration = [...roots]
      .sort((a, b) => a.id.localeCompare(b.id))
      .reduce((all, root) => {
        all[root.integrationId] = all[root.integrationId] || [];
        all[root.integrationId].push(
          [root, ...root.children].map((post) =>
            this.postStructure(post, knownMedia)
          )
        );
        return all;
      }, {} as Record<string, any[]>);

    return Object.keys(byIntegration).reduce((all, integrationId) => {
      all[integrationId] = createHash('sha256')
        .update(JSON.stringify(byIntegration[integrationId]))
        .digest('hex');
      return all;
    }, {} as Fingerprints);
  }

  private mediaList(image: string | null): any[] {
    const list = parseJson(image);
    return Array.isArray(list) ? list : [];
  }

  private postStructure(
    post: Pick<BatchRoot, 'content' | 'image' | 'delay' | 'settings'>,
    knownMedia: Map<string, { alt: string | null; thumbnail: string | null }>
  ) {
    const media = this.mediaList(post.image)
      .filter((p) => isAllowedMediaPath(p?.path))
      .map((p) => {
        // the library id when there is a media row (even a deleted one): the
        // path of a library file is rewritten by updateMedia
        const library = p?.id ? knownMedia.get(p.id) : undefined;
        // updateMedia fills an item that has an id and no path with the whole
        // media row, so a value equal to the library one counts as absent
        const own = (key: 'alt' | 'thumbnail') =>
          p?.[key] && p[key] !== library?.[key] ? p[key] : null;
        return {
          ...(library ? { id: p.id } : { path: this.mediaPath(p?.path) }),
          alt: own('alt'),
          thumbnail: own('thumbnail'),
        };
      });

    const settings = parseJson(post.settings);

    return {
      content: post.content || '',
      media,
      delay: post.delay || 0,
      settings:
        settings && typeof settings === 'object'
          ? normalize(settings, true)
          : settings ?? null,
    };
  }

  // updateMedia only ever prepends UPLOAD_DIRECTORY to a local path, once per
  // rewrite, so it is stripped as many times as it was added
  private mediaPath(path: unknown) {
    if (typeof path !== 'string') {
      return null;
    }

    const prefix = process.env.UPLOAD_DIRECTORY;
    let local = path;
    while (prefix && local.indexOf('http') === -1 && local.startsWith(prefix)) {
      local = local.slice(prefix.length);
    }

    return local;
  }

  async referenceFingerprints(
    orgId: string,
    approval: Pick<PostApproval, 'id' | 'stage' | 'approvedFingerprints'>
  ): Promise<Fingerprints | null> {
    if (approval.stage === 'APPROVED') {
      return (approval.approvedFingerprints as Fingerprints) || null;
    }

    const event = await this._approvalsRepository.lastEventWithFingerprints(
      orgId,
      approval.id
    );
    return (event?.fingerprints as Fingerprints) || null;
  }

  // ---- publish check ----

  // no side effects, and it doesn't look at whether the post is in QUEUE
  async evaluatePublish(
    orgId: string,
    postId: string
  ): Promise<{ allowed: boolean; reason?: PublishDenyReason }> {
    if (!this.enabled()) {
      return { allowed: true };
    }

    const post = await this._approvalsRepository.getPostForGate(orgId, postId);
    return this.evaluatePost(orgId, post);
  }

  private async evaluatePost(
    orgId: string,
    post: Awaited<ReturnType<ApprovalsRepository['getPostForGate']>>
  ): Promise<{ allowed: boolean; reason?: PublishDenyReason }> {
    if (!post?.batchId) {
      return { allowed: false, reason: 'no_approval' };
    }

    const approval = await this._approvalsRepository.getApprovalByBatch(
      orgId,
      post.batchId
    );
    if (!approval) {
      return { allowed: false, reason: 'no_approval' };
    }

    if (approval.stage !== 'APPROVED') {
      return { allowed: false, reason: 'stage' };
    }

    if (post.state === 'PUBLISHED') {
      return { allowed: false, reason: 'published' };
    }

    const current = await this.fingerprintsFromDb(orgId, post.batchId, [
      post.integrationId,
    ]);
    const approved = (approval.approvedFingerprints as Fingerprints) || {};
    if (
      !current[post.integrationId] ||
      current[post.integrationId] !== approved[post.integrationId]
    ) {
      return { allowed: false, reason: 'fingerprint_drift' };
    }

    return { allowed: true };
  }

  // only getPostsList calls it, right before publishing
  async isPublishAllowed(orgId: string, postId: string) {
    if (!this.enabled()) {
      return true;
    }

    const post = await this._approvalsRepository.getPostForGate(orgId, postId);
    const result =
      post?.state === 'QUEUE'
        ? await this.evaluatePost(orgId, post)
        : { allowed: false, reason: 'not_queued' };

    if (result.allowed) {
      return true;
    }

    Sentry.metrics.count('approval_blocked_at_publish', 1);
    const approval = post?.batchId
      ? await this._approvalsRepository.getApprovalByBatch(orgId, post.batchId)
      : null;

    await this._approvalsRepository.insertEvent({
      organizationId: orgId,
      approvalId: approval?.id || null,
      actorRole: 'SYSTEM',
      action: 'BLOCKED_AT_PUBLISH',
      reason: result.reason,
    });

    this._logger.warn(
      `blocked at publish: post ${postId}, batch ${post?.batchId}, reason ${result.reason}`
    );

    return false;
  }

  // ---- createPost ----

  async typeForSave(
    orgId: string,
    body: Pick<CreatePostDto, 'type' | 'posts' | 'inter' | 'republish'>
  ): Promise<{
    typeByIntegration: Record<string, SaveType>;
    inter: number | undefined;
  }> {
    const typeByIntegration: Record<string, SaveType> = {};

    for (const post of body.posts || []) {
      const integrationId = post.integration.id;
      if (!this.enabled()) {
        typeByIntegration[integrationId] = body.type;
        continue;
      }

      const rootId = post.value?.[0]?.id;
      const existing = rootId
        ? await this._approvalsRepository.getPostForGate(orgId, rootId)
        : null;

      // a published channel is never scheduled again by the workflow
      if (existing?.state === 'PUBLISHED') {
        if (body.republish) {
          throw new BadRequestException(
            'Este post ya se publicó y no se puede volver a publicar'
          );
        }
        typeByIntegration[integrationId] = 'update';
        continue;
      }

      typeByIntegration[integrationId] =
        body.type === 'schedule' || body.type === 'now' ? 'draft' : body.type;
    }

    return {
      typeByIntegration,
      inter: this.enabled() ? undefined : body.inter,
    };
  }

  // decides after the save, from the stored rows. It never writes Post.state
  // nor touches Temporal: PostsService does it with the returned lists
  async afterSave(
    orgId: string,
    savedRootIds: string[],
    requestedType: SaveType,
    actorUserId: string | undefined,
    surface: CreationMethod
  ): Promise<{
    toQueue: string[];
    toDraft: string[];
    stageByPostId: Record<string, ApprovalStage>;
  }> {
    const result = {
      toQueue: [] as string[],
      toDraft: [] as string[],
      stageByPostId: {} as Record<string, ApprovalStage>,
    };

    if (!this.enabled() || !savedRootIds.length) {
      return result;
    }

    const rows = await this._approvalsRepository.getBatchIdsForPosts(
      orgId,
      savedRootIds
    );
    const batches = rows.reduce((all, row) => {
      all[row.batchId!] = all[row.batchId!] || [];
      all[row.batchId!].push(row.id);
      return all;
    }, {} as Record<string, string[]>);

    for (const [batchId, savedIds] of Object.entries(batches)) {
      const batch = await this.afterSaveBatch(
        orgId,
        batchId,
        savedIds,
        requestedType,
        actorUserId,
        surface
      );
      result.toQueue.push(...batch.toQueue);
      result.toDraft.push(...batch.toDraft);
      Object.assign(result.stageByPostId, batch.stageByPostId);
    }

    return result;
  }

  private async afterSaveBatch(
    orgId: string,
    batchId: string,
    savedIds: string[],
    requestedType: SaveType,
    actorUserId: string | undefined,
    surface: CreationMethod
  ) {
    const toQueue: string[] = [];
    const toDraft: string[] = [];
    const roots = await this._approvalsRepository.getBatchRootPosts(
      orgId,
      batchId
    );
    const saved = roots.filter((p) => savedIds.includes(p.id));
    const savedIntegrations = [...new Set(saved.map((p) => p.integrationId))];
    const all = await this.fingerprintsOf(orgId, roots);

    let approval: PostApproval | null =
      await this._approvalsRepository.getApprovalByBatch(orgId, batchId);

    if (!approval) {
      await this._approvalsRepository.createApproval(
        orgId,
        batchId,
        this.earliest(roots),
        {
          actorUserId: actorUserId || null,
          actorRole: await this._approvalPolicyService.actorRoleFor(
            orgId,
            actorUserId,
            'CREATED'
          ),
          action: 'CREATED',
          surface,
          fingerprints: all,
        }
      );
      approval = (await this._approvalsRepository.getApprovalByBatch(
        orgId,
        batchId
      ))!;
    } else {
      const reference = await this.referenceFingerprints(orgId, approval);
      const changed = savedIntegrations.some(
        (integrationId) => all[integrationId] !== reference?.[integrationId]
      );

      if (changed) {
        const reset = await this.contentEdited(
          orgId,
          approval,
          roots,
          all,
          actorUserId,
          surface
        );
        toDraft.push(...reset.toDraft);
        approval = reset.approval;
      } else if (
        approval.stage === 'APPROVED' &&
        (requestedType === 'schedule' || requestedType === 'now')
      ) {
        toQueue.push(
          ...saved
            .filter(
              (p) =>
                p.state !== 'PUBLISHED' &&
                (requestedType === 'now' ||
                  dayjs(p.publishDate).isAfter(dayjs()))
            )
            .map((p) => p.id)
        );
      }
    }

    if (requestedType === 'schedule' || requestedType === 'now') {
      const blocked = saved.filter(
        (p) => p.state !== 'PUBLISHED' && !toQueue.includes(p.id)
      );
      if (blocked.length) {
        Sentry.metrics.count('approval_blocked', 1);
        const pastDate =
          requestedType === 'schedule' &&
          blocked.some((p) => !dayjs(p.publishDate).isAfter(dayjs()));
        await this._approvalsRepository.insertEvent({
          organizationId: orgId,
          approvalId: approval.id,
          actorUserId: actorUserId || null,
          actorRole: await this._approvalPolicyService.actorRoleFor(
            orgId,
            actorUserId,
            'CONTENT_EDITED'
          ),
          action: 'BLOCKED',
          surface,
          reason: pastDate ? 'past_date' : 'not_approved',
        });
      }
    }

    await this._approvalsRepository.updateEarliestPublishDate(
      orgId,
      approval.id
    );

    return {
      toQueue,
      toDraft,
      stageByPostId: saved.reduce((list, post) => {
        list[post.id] = approval!.stage;
        return list;
      }, {} as Record<string, ApprovalStage>),
    };
  }

  // records CONTENT_EDITED and, in IN_REVIEW, AWAITING_FINAL or APPROVED,
  // sends the batch back to IN_REVIEW
  private async contentEdited(
    orgId: string,
    approval: PostApproval,
    roots: BatchRoot[],
    fingerprints: Fingerprints,
    actorUserId: string | undefined,
    surface: CreationMethod
  ): Promise<{ approval: PostApproval; toDraft: string[] }> {
    const actorRole = await this._approvalPolicyService.actorRoleFor(
      orgId,
      actorUserId,
      'CONTENT_EDITED'
    );
    const event = {
      actorUserId: actorUserId || null,
      actorRole,
      surface,
      fingerprints,
    };

    await this._approvalsRepository.insertEvent({
      ...event,
      organizationId: orgId,
      approvalId: approval.id,
      action: 'CONTENT_EDITED',
    });

    let current: PostApproval | null = approval;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!current || !RESET_STAGES.includes(current.stage)) {
        return { approval: current || approval, toDraft: [] };
      }

      const moved = await this._approvalsRepository.transition(
        orgId,
        current.id,
        current.version,
        {
          stage: 'IN_REVIEW',
          approvedFingerprints: Prisma.DbNull,
        },
        [{ ...event, action: 'RESET_BY_EDIT' }]
      );

      if (moved) {
        Sentry.metrics.count('approval_reset', 1);
        this._logger.log(
          `RESET_BY_EDIT approval ${current.id}, batch ${
            current.batchId
          }, actor ${actorUserId || 'none'}`
        );
        await this._approvalNotifyService.notifyRole(
          orgId,
          'REVIEWER',
          'RESET_BY_EDIT',
          { approvalId: current.id, batchId: current.batchId }
        );

        return {
          approval: {
            ...current,
            stage: 'IN_REVIEW',
            version: current.version + 1,
          },
          toDraft: roots
            .filter((p) => p.state !== 'PUBLISHED' && p.state !== 'DRAFT')
            .map((p) => p.id),
        };
      }

      current = await this._approvalsRepository.getApprovalByBatch(
        orgId,
        current.batchId
      );
    }

    this._logger.error(
      `could not reset approval ${approval.id} after a content edit: version changed twice`
    );
    return { approval: current || approval, toDraft: [] };
  }

  private earliest(roots: { publishDate: Date }[]) {
    return roots.reduce(
      (min, p) => (p.publishDate < min ? p.publishDate : min),
      roots[0]?.publishDate || new Date()
    );
  }

  // ---- changeDate ----

  async beforeChangeDate(
    orgId: string,
    postId: string,
    date: string,
    action: 'schedule' | 'update',
    republish: boolean
  ): Promise<{ action: 'schedule' | 'update'; toDraft: string[] }> {
    if (!this.enabled()) {
      return { action, toDraft: [] };
    }

    const post = await this._approvalsRepository.getPostForGate(orgId, postId);
    if (!post) {
      return { action, toDraft: [] };
    }

    if (post.state === 'PUBLISHED') {
      if (republish) {
        throw new BadRequestException(
          'Este post ya se publicó y no se puede volver a publicar'
        );
      }
      return { action: 'update', toDraft: [] };
    }

    if (!dayjs(date).isAfter(dayjs())) {
      throw new BadRequestException('La fecha de publicación ya pasó');
    }

    // a queued post is rescheduled so its workflow wakes up at the new date
    const finalAction =
      post.state === 'QUEUE' && action === 'update' ? 'schedule' : action;

    if (
      finalAction === 'schedule' &&
      post.state !== 'DRAFT' &&
      !(await this.evaluatePost(orgId, post)).allowed
    ) {
      return { action: 'update', toDraft: [postId] };
    }

    return { action: finalAction, toDraft: [] };
  }

  async afterChangeDate(
    orgId: string,
    postId: string,
    actorUserId: string | undefined,
    surface: CreationMethod = 'WEB'
  ) {
    if (!this.enabled()) {
      return;
    }

    const approval = await this._approvalsRepository.getApprovalByPost(
      orgId,
      postId
    );
    if (!approval) {
      return;
    }

    if (approval.stage === 'APPROVED') {
      await this._approvalsRepository.insertEvent({
        organizationId: orgId,
        approvalId: approval.id,
        actorUserId: actorUserId || null,
        actorRole: await this._approvalPolicyService.actorRoleFor(
          orgId,
          actorUserId,
          'CONTENT_EDITED'
        ),
        action: 'DATE_CHANGED',
        surface,
      });
    }

    await this._approvalsRepository.updateEarliestPublishDate(
      orgId,
      approval.id
    );
  }

  // ---- changePostStatus ----

  async beforeChangePostStatus(
    orgId: string,
    postId: string,
    status: 'draft' | 'schedule'
  ) {
    if (!this.enabled() || status === 'draft') {
      return;
    }

    const post = await this._approvalsRepository.getPostForGate(orgId, postId);
    if (!(await this.evaluatePost(orgId, post)).allowed) {
      throw new BadRequestException('Este post necesita aprobación final');
    }

    if (!dayjs(post!.publishDate).isAfter(dayjs())) {
      throw new BadRequestException('La fecha de publicación ya pasó');
    }
  }

  // ---- deletePost ----

  // read only, so a failed upstream delete leaves no event behind
  async beforeDeletePost(
    orgId: string,
    group: string
  ): Promise<DeleteContext | null> {
    if (!this.enabled()) {
      return null;
    }

    const root = await this._approvalsRepository.getRootPostByGroup(
      orgId,
      group
    );
    if (!root) {
      return null;
    }

    return {
      root,
      approval: root.batchId
        ? await this._approvalsRepository.getApprovalByBatch(
            orgId,
            root.batchId
          )
        : null,
    };
  }

  async afterDeletePost(
    orgId: string,
    context: DeleteContext | null,
    actorUserId: string | undefined,
    surface: CreationMethod
  ): Promise<{ toDraft: string[] }> {
    if (!this.enabled() || !context?.approval || !context.root.batchId) {
      return { toDraft: [] };
    }

    const { root, approval } = context;

    const roots = await this._approvalsRepository.getBatchRootPosts(
      orgId,
      root.batchId
    );

    // a failed, paused or already published channel of an approved batch
    // doesn't change what the others publish, and an empty batch has nothing
    // left to review
    if (
      !roots.length ||
      (approval.stage === 'APPROVED' &&
        (root.state === 'ERROR' ||
          root.state === 'DRAFT' ||
          root.state === 'PUBLISHED'))
    ) {
      await this._approvalsRepository.insertEvent({
        organizationId: orgId,
        approvalId: approval.id,
        actorUserId: actorUserId || null,
        actorRole: await this._approvalPolicyService.actorRoleFor(
          orgId,
          actorUserId,
          'CONTENT_EDITED'
        ),
        action: 'CHANNEL_DISCARDED',
        surface,
        // the channel, so the sweep knows this one was already recorded
        snapshot: { integrationId: root.integrationId },
      });
      return { toDraft: [] };
    }

    const { toDraft } = await this.contentEdited(
      orgId,
      approval,
      roots,
      await this.fingerprintsOf(orgId, roots),
      actorUserId,
      surface
    );

    await this._approvalsRepository.updateEarliestPublishDate(
      orgId,
      approval.id
    );

    return { toDraft };
  }
}
