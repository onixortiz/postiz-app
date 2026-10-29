import {
  PrismaRepository,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { Injectable } from '@nestjs/common';
import {
  ApprovalAction,
  ApprovalStage,
  BriefStatus,
  Prisma,
  Role,
  WorkflowRole,
} from '@prisma/client';
import { StagesMap } from '@gitroom/nestjs-libraries/dtos/approvals/approval.actions.dto';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
dayjs.extend(utc);

// FORK: approvals. Single access point to the fork tables.

export type ApprovalEventInput = Omit<
  Prisma.PostApprovalEventUncheckedCreateInput,
  'id' | 'createdAt' | 'organizationId' | 'approvalId'
>;

export type ApprovalUpdate = Omit<
  Prisma.PostApprovalUncheckedUpdateManyInput,
  'id' | 'organizationId' | 'batchId' | 'version' | 'createdAt' | 'updatedAt'
>;

// stages before the final approval: the batch can't be published from them
const PRE_APPROVAL_STAGES: ApprovalStage[] = [
  'IN_PRODUCTION',
  'IN_REVIEW',
  'AWAITING_FINAL',
  'CHANGES_REQUESTED',
];

const FINGERPRINT_ACTIONS: ApprovalAction[] = [
  'CREATED',
  'CONTENT_EDITED',
  'SUBMITTED',
  'RESET_BY_EDIT',
  'REVIEW_APPROVED',
];

const AUTHOR_ACTIONS: ApprovalAction[] = [
  'CREATED',
  'SUBMITTED',
  'CONTENT_EDITED',
];

const userSelect = {
  id: true,
  email: true,
  name: true,
  lastName: true,
} satisfies Prisma.UserSelect;

const postSelect = {
  id: true,
  group: true,
  integrationId: true,
  state: true,
  error: true,
  publishDate: true,
  content: true,
  image: true,
  delay: true,
  settings: true,
  parentPostId: true,
} satisfies Prisma.PostSelect;

const briefSelect = {
  id: true,
  topic: true,
  baseCopy: true,
  targetDate: true,
  assignedCreatorId: true,
  status: true,
  quickBrief: true,
  correctionOfApprovalId: true,
  createdById: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ContentBriefSelect;

@Injectable()
export class ApprovalsRepository {
  constructor(
    private _postApproval: PrismaRepository<'postApproval'>,
    private _postApprovalEvent: PrismaRepository<'postApprovalEvent'>,
    private _workflowRoleAssignment: PrismaRepository<'workflowRoleAssignment'>,
    private _contentBrief: PrismaRepository<'contentBrief'>,
    private _post: PrismaRepository<'post'>,
    private _media: PrismaRepository<'media'>,
    private _userOrganization: PrismaRepository<'userOrganization'>,
    private _transaction: PrismaTransaction
  ) {}

  // ---- approvals and events ----

  getApprovalByBatch(orgId: string, batchId: string) {
    return this._postApproval.model.postApproval.findFirst({
      where: {
        organizationId: orgId,
        batchId,
      },
      include: {
        brief: {
          select: briefSelect,
        },
      },
    });
  }

  async getApprovalByPost(orgId: string, postId: string) {
    const post = await this._post.model.post.findFirst({
      where: {
        organizationId: orgId,
        id: postId,
        deletedAt: null,
      },
      select: {
        batchId: true,
      },
    });

    if (!post?.batchId) {
      return null;
    }

    return this.getApprovalByBatch(orgId, post.batchId);
  }

  createApproval(
    orgId: string,
    batchId: string,
    earliestPublishDate: Date,
    event: ApprovalEventInput
  ) {
    return this._transaction.model.$transaction(async (tx) => {
      const approval = await tx.postApproval.create({
        data: {
          organizationId: orgId,
          batchId,
          earliestPublishDate,
        },
      });

      await tx.postApprovalEvent.create({
        data: {
          ...event,
          organizationId: orgId,
          approvalId: approval.id,
          action: 'CREATED',
        },
      });

      return approval;
    });
  }

  // optimistic lock: only one writer per version moves the row, the others get false
  transition(
    orgId: string,
    id: string,
    expectedVersion: number,
    data: ApprovalUpdate,
    events: ApprovalEventInput[]
  ): Promise<boolean> {
    return this._transaction.model.$transaction(async (tx) => {
      const { count } = await tx.postApproval.updateMany({
        where: {
          id,
          organizationId: orgId,
          version: expectedVersion,
        },
        data: {
          ...data,
          version: {
            increment: 1,
          },
        },
      });

      if (count === 0) {
        return false;
      }

      if (events.length) {
        await tx.postApprovalEvent.createMany({
          data: events.map((event) => ({
            ...event,
            organizationId: orgId,
            approvalId: id,
          })),
        });
      }

      return true;
    });
  }

  insertEvent(event: Prisma.PostApprovalEventUncheckedCreateInput) {
    return this._postApprovalEvent.model.postApprovalEvent.create({
      data: event,
      select: {
        id: true,
      },
    });
  }

  lastEventWithFingerprints(
    orgId: string,
    approvalId: string,
    actions: ApprovalAction[] = FINGERPRINT_ACTIONS
  ) {
    return this._postApprovalEvent.model.postApprovalEvent.findFirst({
      where: {
        organizationId: orgId,
        approvalId,
        action: {
          in: actions,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async authorIds(orgId: string, approvalId: string) {
    const events =
      await this._postApprovalEvent.model.postApprovalEvent.findMany({
        where: {
          organizationId: orgId,
          approvalId,
          action: {
            in: AUTHOR_ACTIONS,
          },
          actorUserId: {
            not: null,
          },
        },
        select: {
          actorUserId: true,
        },
        distinct: ['actorUserId'],
      });

    return events.map((p) => p.actorUserId!);
  }

  lastActorOf(orgId: string, approvalId: string, action: ApprovalAction) {
    return this._postApprovalEvent.model.postApprovalEvent.findFirst({
      where: {
        organizationId: orgId,
        approvalId,
        action,
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        actorUserId: true,
        actorRole: true,
        createdAt: true,
      },
    });
  }

  history(orgId: string, approvalId: string) {
    return this._postApprovalEvent.model.postApprovalEvent.findMany({
      where: {
        organizationId: orgId,
        approvalId,
      },
      orderBy: {
        createdAt: 'asc',
      },
      select: {
        id: true,
        action: true,
        actorRole: true,
        surface: true,
        reason: true,
        commentId: true,
        targetRole: true,
        createdAt: true,
        actor: {
          select: userSelect,
        },
        targetUser: {
          select: userSelect,
        },
      },
    });
  }

  previousEventOf(
    orgId: string,
    approvalId: string,
    action: ApprovalAction,
    before: Date
  ) {
    return this._postApprovalEvent.model.postApprovalEvent.findFirst({
      where: {
        organizationId: orgId,
        approvalId,
        action,
        createdAt: {
          lt: before,
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        id: true,
        createdAt: true,
      },
    });
  }

  // ---- batch and posts ----

  // the comments of a thread are chained by parentPostId and share the group
  // of their root, so they are loaded by group and put back in chain order
  async getBatchRootPosts(orgId: string, batchId: string) {
    const roots = await this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        batchId,
        parentPostId: null,
        deletedAt: null,
      },
      select: postSelect,
      orderBy: [{ publishDate: 'asc' }, { id: 'asc' }],
    });

    if (!roots.length) {
      return [];
    }

    const children = await this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        group: {
          in: roots.map((p) => p.group),
        },
        parentPostId: {
          not: null,
        },
        deletedAt: null,
      },
      select: postSelect,
    });

    return roots.map((root) => {
      const chain: typeof children = [];
      let parentId = root.id;
      for (;;) {
        const next = children.find((p) => p.parentPostId === parentId);
        if (!next) {
          break;
        }
        chain.push(next);
        parentId = next.id;
      }

      return {
        ...root,
        children: chain,
      };
    });
  }

  getBatchIdsForPosts(orgId: string, postIds: string[]) {
    return this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        id: {
          in: postIds,
        },
        deletedAt: null,
        batchId: {
          not: null,
        },
      },
      select: {
        id: true,
        batchId: true,
      },
    });
  }

  getRootPostByGroup(orgId: string, group: string) {
    return this._post.model.post.findFirst({
      where: {
        organizationId: orgId,
        group,
        parentPostId: null,
        deletedAt: null,
      },
      select: {
        id: true,
        state: true,
        batchId: true,
        integrationId: true,
      },
    });
  }

  // only PostsService calls it, right before startWorkflow(DRAFT)
  async setRootPostsDraft(orgId: string, postIds: string[]) {
    if (!postIds.length) {
      return;
    }

    const roots = await this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        id: {
          in: postIds,
        },
        parentPostId: null,
        deletedAt: null,
      },
      select: {
        group: true,
      },
    });

    await this._post.model.post.updateMany({
      where: {
        organizationId: orgId,
        group: {
          in: roots.map((p) => p.group),
        },
        deletedAt: null,
      },
      data: {
        state: 'DRAFT',
      },
    });
  }

  // a new date only clears the warning marks whose threshold no longer applies,
  // so an edit that doesn't move the date doesn't send the warnings again
  async updateEarliestPublishDate(orgId: string, approvalId: string) {
    const approval =
      await this._postApproval.model.postApproval.findFirstOrThrow({
        where: { id: approvalId, organizationId: orgId },
        select: {
          organizationId: true,
          batchId: true,
          earliestPublishDate: true,
        },
      });

    const earliest = await this._post.model.post.findFirst({
      where: {
        organizationId: approval.organizationId,
        batchId: approval.batchId,
        parentPostId: null,
        deletedAt: null,
      },
      orderBy: {
        publishDate: 'asc',
      },
      select: {
        publishDate: true,
      },
    });

    if (
      !earliest ||
      earliest.publishDate.getTime() === approval.earliestPublishDate.getTime()
    ) {
      return approval.earliestPublishDate;
    }

    const now = dayjs.utc();
    const date = dayjs.utc(earliest.publishDate);

    await this._postApproval.model.postApproval.update({
      where: { id: approvalId },
      data: {
        earliestPublishDate: earliest.publishDate,
        ...(date.isAfter(now) ? { warnedExpiredAt: null } : {}),
        ...(date.isAfter(now.add(24, 'hour')) ? { warned24At: null } : {}),
        ...(date.isAfter(now.add(48, 'hour')) ? { warned48At: null } : {}),
      },
      select: {
        id: true,
      },
    });

    return earliest.publishDate;
  }

  // no deletedAt filter: a media deleted from the library is still a known media
  async findExistingMediaIds(orgId: string, ids: string[]) {
    if (!ids.length) {
      return new Map<
        string,
        { alt: string | null; thumbnail: string | null }
      >();
    }

    const media = await this._media.model.media.findMany({
      where: {
        organizationId: orgId,
        id: {
          in: ids,
        },
      },
      select: {
        id: true,
        alt: true,
        thumbnail: true,
      },
    });

    return new Map(
      media.map((p) => [p.id, { alt: p.alt, thumbnail: p.thumbnail }])
    );
  }

  getPostForGate(orgId: string, postId: string) {
    return this._post.model.post.findFirst({
      where: {
        organizationId: orgId,
        id: postId,
        deletedAt: null,
      },
      select: {
        id: true,
        state: true,
        batchId: true,
        integrationId: true,
        parentPostId: true,
        publishDate: true,
      },
    });
  }

  getFirstRootPostId(orgId: string, batchId: string) {
    return this._post.model.post.findFirst({
      where: {
        organizationId: orgId,
        batchId,
        parentPostId: null,
        deletedAt: null,
      },
      orderBy: {
        createdAt: 'asc',
      },
      select: {
        id: true,
      },
    });
  }

  // ---- inbox and calendar ----

  async listInbox(orgId: string, stages: ApprovalStage[]) {
    const approvals = await this._postApproval.model.postApproval.findMany({
      where: {
        organizationId: orgId,
        stage: {
          in: stages,
        },
      },
      orderBy: {
        earliestPublishDate: 'asc',
      },
      select: {
        id: true,
        batchId: true,
        version: true,
        stage: true,
        forced: true,
        earliestPublishDate: true,
        brief: {
          select: {
            id: true,
            topic: true,
            quickBrief: true,
          },
        },
      },
    });

    if (!approvals.length) {
      return [];
    }

    const posts = await this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        batchId: {
          in: approvals.map((p) => p.batchId),
        },
        parentPostId: null,
        deletedAt: null,
      },
      orderBy: {
        publishDate: 'asc',
      },
      select: {
        id: true,
        group: true,
        integrationId: true,
        publishDate: true,
        state: true,
        batchId: true,
      },
    });

    return approvals
      .map((approval) => ({
        ...approval,
        posts: posts
          .filter((p) => p.batchId === approval.batchId)
          .map(({ batchId, ...post }) => post),
      }))
      .filter((p) => p.posts.length);
  }

  async getStagesForPosts(
    orgId: string,
    postIds: string[]
  ): Promise<StagesMap> {
    const posts = await this.getBatchIdsForPosts(orgId, postIds);
    if (!posts.length) {
      return {};
    }

    const approvals = await this._postApproval.model.postApproval.findMany({
      where: {
        organizationId: orgId,
        batchId: {
          in: [...new Set(posts.map((p) => p.batchId!))],
        },
      },
      select: {
        batchId: true,
        stage: true,
        version: true,
        earliestPublishDate: true,
      },
    });

    const now = new Date();
    return posts.reduce((all, post) => {
      const approval = approvals.find((p) => p.batchId === post.batchId);
      if (!approval) {
        return all;
      }

      all[post.id] = {
        batchId: approval.batchId,
        stage: approval.stage,
        version: approval.version,
        expired:
          PRE_APPROVAL_STAGES.includes(approval.stage) &&
          approval.earliestPublishDate < now,
      };
      return all;
    }, {} as StagesMap);
  }

  // ---- roles and team ----

  async getRoles(orgId: string, userId: string) {
    const roles =
      await this._workflowRoleAssignment.model.workflowRoleAssignment.findMany({
        where: {
          organizationId: orgId,
          userId,
          user: {
            deletedAt: null,
            organizations: {
              some: {
                organizationId: orgId,
                disabled: false,
              },
            },
          },
        },
        select: {
          role: true,
        },
      });

    return roles.map((p) => p.role);
  }

  async listRoles(orgId: string) {
    const members =
      await this._userOrganization.model.userOrganization.findMany({
        where: {
          organizationId: orgId,
          disabled: false,
          user: {
            deletedAt: null,
          },
        },
        select: {
          user: {
            select: {
              ...userSelect,
              workflowRoles: {
                where: {
                  organizationId: orgId,
                },
                select: {
                  role: true,
                },
              },
            },
          },
        },
      });

    return members.map(({ user }) => ({
      userId: user.id,
      name: [user.name, user.lastName].filter((f) => f).join(' ') || user.email,
      email: user.email,
      roles: user.workflowRoles.map((p) => p.role),
    }));
  }

  async listUsersWithRole(orgId: string, role: WorkflowRole) {
    const rows =
      await this._workflowRoleAssignment.model.workflowRoleAssignment.findMany({
        where: {
          organizationId: orgId,
          role,
          user: {
            deletedAt: null,
            organizations: {
              some: {
                organizationId: orgId,
                disabled: false,
              },
            },
          },
        },
        select: {
          user: {
            select: userSelect,
          },
        },
      });

    return rows.map((p) => p.user);
  }

  async listOrgAdmins(orgId: string) {
    const rows = await this._userOrganization.model.userOrganization.findMany({
      where: {
        organizationId: orgId,
        disabled: false,
        role: {
          in: [Role.SUPERADMIN, Role.ADMIN],
        },
        user: {
          deletedAt: null,
        },
      },
      select: {
        user: {
          select: {
            id: true,
            email: true,
          },
        },
      },
    });

    return rows.map((p) => p.user);
  }

  async isMember(orgId: string, userId: string) {
    const count = await this._userOrganization.model.userOrganization.count({
      where: {
        organizationId: orgId,
        userId,
        disabled: false,
        user: {
          deletedAt: null,
        },
      },
    });

    return count > 0;
  }

  async getMemberEmail(orgId: string, userId: string) {
    const row = await this._userOrganization.model.userOrganization.findFirst({
      where: {
        organizationId: orgId,
        userId,
        disabled: false,
        user: {
          deletedAt: null,
        },
      },
      select: {
        user: {
          select: {
            email: true,
          },
        },
      },
    });

    return row?.user.email || null;
  }

  async getOrgRole(orgId: string, userId: string) {
    const row = await this._userOrganization.model.userOrganization.findFirst({
      where: {
        organizationId: orgId,
        userId,
        disabled: false,
      },
      select: {
        role: true,
      },
    });

    return row?.role || null;
  }

  setRoles(
    orgId: string,
    userId: string,
    roles: WorkflowRole[],
    byUserId: string
  ) {
    return this._transaction.model.$transaction(async (tx) => {
      const current = (
        await tx.workflowRoleAssignment.findMany({
          where: {
            organizationId: orgId,
            userId,
          },
          select: {
            role: true,
          },
        })
      ).map((p) => p.role);

      const added = roles.filter((role) => !current.includes(role));
      const removed = current.filter((role) => !roles.includes(role));

      if (removed.length) {
        await tx.workflowRoleAssignment.deleteMany({
          where: {
            organizationId: orgId,
            userId,
            role: {
              in: removed,
            },
          },
        });
      }

      if (added.length) {
        await tx.workflowRoleAssignment.createMany({
          data: added.map((role) => ({
            organizationId: orgId,
            userId,
            role,
            createdById: byUserId,
          })),
        });
      }

      const events = [
        ...added.map((role) => ({ role, action: 'ROLE_ASSIGNED' as const })),
        ...removed.map((role) => ({ role, action: 'ROLE_REMOVED' as const })),
      ];

      if (events.length) {
        await tx.postApprovalEvent.createMany({
          data: events.map(({ role, action }) => ({
            organizationId: orgId,
            actorUserId: byUserId,
            actorRole: 'MEMBER' as const,
            action,
            targetUserId: userId,
            targetRole: role,
          })),
        });
      }

      return { added, removed };
    });
  }

  // ---- briefs ----

  createBrief(
    orgId: string,
    createdById: string,
    data: Omit<
      Prisma.ContentBriefUncheckedCreateInput,
      'id' | 'organizationId' | 'createdById' | 'createdAt' | 'updatedAt'
    >
  ) {
    return this._contentBrief.model.contentBrief.create({
      data: {
        ...data,
        organizationId: orgId,
        createdById,
      },
      select: briefSelect,
    });
  }

  // null when the brief doesn't exist in the org or was deleted
  async updateBrief(
    orgId: string,
    id: string,
    data: Omit<
      Prisma.ContentBriefUncheckedUpdateManyInput,
      'id' | 'organizationId' | 'createdById' | 'createdAt' | 'updatedAt'
    >
  ) {
    const { count } = await this._contentBrief.model.contentBrief.updateMany({
      where: {
        id,
        organizationId: orgId,
        deletedAt: null,
      },
      data,
    });

    if (!count) {
      return null;
    }

    return this.getBrief(orgId, id);
  }

  listBriefs(orgId: string, status?: BriefStatus) {
    return this._contentBrief.model.contentBrief.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        ...(status ? { status } : {}),
      },
      orderBy: {
        createdAt: 'desc',
      },
      select: {
        ...briefSelect,
        assignedCreator: {
          select: userSelect,
        },
        approvals: {
          select: {
            batchId: true,
            stage: true,
          },
        },
      },
    });
  }

  getBrief(orgId: string, id: string) {
    return this._contentBrief.model.contentBrief.findFirst({
      where: {
        id,
        organizationId: orgId,
        deletedAt: null,
      },
      select: {
        ...briefSelect,
        assignedCreator: {
          select: userSelect,
        },
        approvals: {
          select: {
            batchId: true,
            stage: true,
          },
        },
      },
    });
  }

  // ---- sweep ----

  // also the organizations whose posts were created with APPROVALS_ENABLED=false
  async listOrgIdsToSweep() {
    const [approvals, posts] = await Promise.all([
      this._postApproval.model.postApproval.groupBy({
        by: ['organizationId'],
      }),
      this._post.model.post.groupBy({
        by: ['organizationId'],
        where: {
          parentPostId: null,
          deletedAt: null,
          state: {
            in: ['QUEUE', 'ERROR'],
          },
        },
      }),
    ]);

    return [...new Set([...approvals, ...posts].map((p) => p.organizationId))];
  }

  findExpired(orgId: string, now: Date) {
    return this._postApproval.model.postApproval.findMany({
      where: {
        organizationId: orgId,
        stage: {
          in: PRE_APPROVAL_STAGES,
        },
        earliestPublishDate: {
          lt: now,
        },
        warnedExpiredAt: null,
      },
    });
  }

  findWarnable(orgId: string, now: Date, hours: 24 | 48) {
    return this._postApproval.model.postApproval.findMany({
      where: {
        organizationId: orgId,
        stage: {
          in: PRE_APPROVAL_STAGES,
        },
        earliestPublishDate: {
          gt: now,
          lte: dayjs.utc(now).add(hours, 'hour').toDate(),
        },
        ...(hours === 24 ? { warned24At: null } : { warned48At: null }),
      },
    });
  }

  // APPROVED batches whose remaining root posts are all PUBLISHED
  async findPublishedCandidates(orgId: string) {
    const approvals = await this._postApproval.model.postApproval.findMany({
      where: {
        organizationId: orgId,
        stage: 'APPROVED',
      },
    });

    if (!approvals.length) {
      return [];
    }

    const posts = await this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        batchId: {
          in: approvals.map((p) => p.batchId),
        },
        parentPostId: null,
        deletedAt: null,
      },
      select: {
        batchId: true,
        state: true,
      },
    });

    return approvals.filter((approval) => {
      const list = posts.filter((p) => p.batchId === approval.batchId);
      return list.length && list.every((p) => p.state === 'PUBLISHED');
    });
  }

  findVerificationOverdue(orgId: string, now: Date) {
    return this._postApproval.model.postApproval.findMany({
      where: {
        organizationId: orgId,
        stage: 'PUBLISHED',
        verifyDueAt: {
          lt: now,
        },
        warnedVerifyAt: null,
      },
    });
  }

  findBlockedAtPublish(orgId: string) {
    return this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        parentPostId: null,
        deletedAt: null,
        state: 'ERROR',
        error: 'No Post',
      },
      select: {
        id: true,
        group: true,
        batchId: true,
        integrationId: true,
        publishDate: true,
      },
    });
  }

  findQueueRoots(orgId: string) {
    return this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        parentPostId: null,
        deletedAt: null,
        state: 'QUEUE',
      },
      select: {
        id: true,
        group: true,
        batchId: true,
        integrationId: true,
        publishDate: true,
      },
    });
  }

  async findErrorRootsInUnapproved(orgId: string) {
    const approvals = await this._postApproval.model.postApproval.findMany({
      where: {
        organizationId: orgId,
        stage: {
          in: PRE_APPROVAL_STAGES,
        },
      },
      select: {
        batchId: true,
      },
    });

    if (!approvals.length) {
      return [];
    }

    return this._post.model.post.findMany({
      where: {
        organizationId: orgId,
        batchId: {
          in: approvals.map((p) => p.batchId),
        },
        parentPostId: null,
        deletedAt: null,
        state: 'ERROR',
      },
      select: {
        id: true,
        group: true,
        batchId: true,
        integrationId: true,
        error: true,
      },
    });
  }

  // only batches with a channel still to publish: fully published history is
  // left alone
  async findBatchesWithoutApproval(orgId: string) {
    const posts = await this._post.model.post.groupBy({
      by: ['batchId'],
      where: {
        organizationId: orgId,
        parentPostId: null,
        deletedAt: null,
        batchId: {
          not: null,
        },
        state: {
          not: 'PUBLISHED',
        },
      },
    });

    if (!posts.length) {
      return [];
    }

    const approvals = await this._postApproval.model.postApproval.findMany({
      where: {
        organizationId: orgId,
        batchId: {
          in: posts.map((p) => p.batchId!),
        },
      },
      select: {
        batchId: true,
      },
    });

    const known = new Set(approvals.map((p) => p.batchId));
    return posts.map((p) => p.batchId!).filter((p) => !known.has(p));
  }
}
