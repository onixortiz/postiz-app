import './approvals.test.env';
import { Test, TestingModule } from '@nestjs/testing';
import { mock } from 'jest-mock-extended';
import { TemporalService } from 'nestjs-temporal-core';
import { State, WorkflowRole } from '@prisma/client';
import { v4 as uuidv4 } from 'uuid';
import {
  PrismaRepository,
  PrismaService,
  PrismaTransaction,
} from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { PostsRepository } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.repository';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { ShortLinkService } from '@gitroom/nestjs-libraries/short-linking/short.link.service';
import { OpenaiService } from '@gitroom/nestjs-libraries/openai/openai.service';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { NotificationService } from '@gitroom/nestjs-libraries/database/prisma/notifications/notification.service';
import { ApprovalsRepository } from '@gitroom/nestjs-libraries/database/prisma/approvals/approvals.repository';
import { ApprovalPolicyService } from '@gitroom/nestjs-libraries/database/prisma/approvals/approval.policy.service';
import { ApprovalNotifyService } from '@gitroom/nestjs-libraries/database/prisma/approvals/approval.notify.service';
import { ApprovalGateService } from '@gitroom/nestjs-libraries/database/prisma/approvals/approval.gate.service';
import { ApprovalService } from '@gitroom/nestjs-libraries/database/prisma/approvals/approval.service';
import { BriefsService } from '@gitroom/nestjs-libraries/database/prisma/approvals/briefs.service';
import { ApprovalSweepService } from '@gitroom/nestjs-libraries/database/prisma/approvals/approval.sweep.service';
import { CreatePostDto } from '@gitroom/nestjs-libraries/dtos/posts/create.post.dto';

// FORK: approvals. Shared setup for the fork tests: real Postgres, real
// repositories, fake Temporal and fake notifications. It grows every phase.

export type WorkflowCall = { type: 'start' | 'terminate'; postId: string };

// keeps the running workflows by postId and records every start / terminate,
// in order, so the tests can check what Postiz asked Temporal to do
export const createFakeTemporal = () => {
  const running = new Map<string, string>();
  const calls: WorkflowCall[] = [];

  const postIdOf = (query: string) => /postId="([^"]+)"/.exec(query)?.[1];

  const rawClient = {
    workflow: {
      list: jest.fn(({ query }: { query: string }) => {
        const postId = postIdOf(query);
        const list = [...running.entries()]
          .filter(([, id]) => id === postId)
          .map(([workflowId]) => ({ workflowId }));
        return (async function* () {
          yield* list;
        })();
      }),
      start: jest.fn(async (_name: string, options: any) => {
        const postId = options.args[0].postId;
        running.set(options.workflowId, postId);
        calls.push({ type: 'start', postId });
      }),
      signalWithStart: jest.fn(async () => undefined),
    },
  };

  const client = {
    getRawClient: () => rawClient,
    getWorkflowHandle: jest.fn(async (workflowId: string) => ({
      describe: async () => ({
        status: { name: running.has(workflowId) ? 'RUNNING' : 'TERMINATED' },
      }),
      terminate: async () => {
        const postId = running.get(workflowId);
        running.delete(workflowId);
        if (postId) {
          calls.push({ type: 'terminate', postId });
        }
      },
    })),
  };

  return {
    service: { client } as unknown as TemporalService,
    running,
    calls,
    reset() {
      running.clear();
      calls.length = 0;
    },
  };
};

export type SentNotice = {
  kind: 'inApp' | 'email';
  orgId?: string;
  to?: string;
  subject: string;
  body: string;
  sendEmail?: boolean;
  type?: string;
};

export const createFakeNotifications = () => {
  const sent: SentNotice[] = [];
  const service = {
    inAppNotification: jest.fn(
      async (
        orgId: string,
        subject: string,
        message: string,
        sendEmail = false,
        _digest = false,
        type = 'success'
      ) => {
        sent.push({
          kind: 'inApp',
          orgId,
          subject,
          body: message,
          sendEmail,
          type,
        });
      }
    ),
    sendEmail: jest.fn(async (to: string, subject: string, html: string) => {
      sent.push({ kind: 'email', to, subject, body: html });
    }),
    hasEmailProvider: jest.fn(() => true),
  };

  return {
    service: service as unknown as NotificationService,
    sent,
    reset() {
      sent.length = 0;
    },
  };
};

export interface ApprovalsTestContext {
  module: TestingModule;
  prisma: PrismaService;
  posts: PostsService;
  gate: ApprovalGateService;
  approvals: ApprovalService;
  briefs: BriefsService;
  policy: ApprovalPolicyService;
  notify: ApprovalNotifyService;
  repository: ApprovalsRepository;
  temporal: ReturnType<typeof createFakeTemporal>;
  notifications: ReturnType<typeof createFakeNotifications>;
}

export const createApprovalsTestModule =
  async (): Promise<ApprovalsTestContext> => {
    const temporal = createFakeTemporal();
    const notifications = createFakeNotifications();

    const module = await Test.createTestingModule({
      providers: [
        PrismaService,
        PrismaRepository,
        PrismaTransaction,
        PostsRepository,
        PostsService,
        ApprovalsRepository,
        ApprovalPolicyService,
        ApprovalNotifyService,
        ApprovalGateService,
        ApprovalService,
        BriefsService,
        ApprovalSweepService,
        { provide: NotificationService, useValue: notifications.service },
        { provide: TemporalService, useValue: temporal.service },
        { provide: IntegrationManager, useValue: mock<IntegrationManager>() },
        { provide: IntegrationService, useValue: mock<IntegrationService>() },
        { provide: MediaService, useValue: mock<MediaService>() },
        { provide: ShortLinkService, useValue: mock<ShortLinkService>() },
        { provide: OpenaiService, useValue: mock<OpenaiService>() },
        {
          provide: RefreshIntegrationService,
          useValue: mock<RefreshIntegrationService>(),
        },
      ],
    }).compile();

    await module.init();

    return {
      module,
      prisma: module.get(PrismaService),
      posts: module.get(PostsService),
      gate: module.get(ApprovalGateService),
      approvals: module.get(ApprovalService),
      briefs: module.get(BriefsService),
      policy: module.get(ApprovalPolicyService),
      notify: module.get(ApprovalNotifyService),
      repository: module.get(ApprovalsRepository),
      temporal,
      notifications,
    };
  };

// deleteMany in dependency order (no raw SQL in this repo)
export const cleanDatabase = async (prisma: PrismaService) => {
  await prisma.postApprovalEvent.deleteMany();
  await prisma.contentBrief.updateMany({
    data: { correctionOfApprovalId: null },
  });
  await prisma.postApproval.deleteMany();
  await prisma.contentBrief.deleteMany();
  await prisma.workflowRoleAssignment.deleteMany();
  await prisma.tagsPosts.deleteMany();
  await prisma.tags.deleteMany();
  await prisma.errors.deleteMany();
  await prisma.comments.deleteMany();
  await prisma.post.updateMany({ data: { parentPostId: null } });
  await prisma.post.deleteMany();
  await prisma.media.deleteMany();
  await prisma.integration.deleteMany();
  await prisma.notifications.deleteMany();
  await prisma.userOrganization.deleteMany();
  await prisma.user.deleteMany();
  await prisma.organization.deleteMany();
};

export const createOrg = async (prisma: PrismaService) => {
  const org = await prisma.organization.create({
    data: { name: `org-${uuidv4()}` },
  });
  const admin = await createUser(prisma, org.id, [], 'ADMIN');
  return { orgId: org.id, adminId: admin };
};

export const createUser = async (
  prisma: PrismaService,
  orgId: string,
  roles: WorkflowRole[] = [],
  orgRole: 'USER' | 'ADMIN' | 'SUPERADMIN' = 'USER'
) => {
  const user = await prisma.user.create({
    data: {
      email: `${uuidv4()}@test.local`,
      providerName: 'LOCAL',
      timezone: 0,
      name: 'Test',
      lastName: orgRole,
    },
  });
  await prisma.userOrganization.create({
    data: { userId: user.id, organizationId: orgId, role: orgRole },
  });
  if (roles.length) {
    await prisma.workflowRoleAssignment.createMany({
      data: roles.map((role) => ({
        organizationId: orgId,
        userId: user.id,
        role,
        createdById: user.id,
      })),
    });
  }
  return user.id;
};

export const createIntegration = async (
  prisma: PrismaService,
  orgId: string,
  providerIdentifier = 'facebook'
) => {
  const integration = await prisma.integration.create({
    data: {
      organizationId: orgId,
      internalId: uuidv4(),
      name: providerIdentifier,
      providerIdentifier,
      type: 'social',
      token: 'token',
    },
  });
  return integration.id;
};

export const futureDate = (hours = 72) =>
  new Date(Date.now() + hours * 3600 * 1000).toISOString();

export const pastDate = (hours = 2) =>
  new Date(Date.now() - hours * 3600 * 1000).toISOString();

export interface ChannelInput {
  integrationId: string;
  // ids of the existing rows (root first) when editing
  ids?: string[];
  group?: string;
  values?: {
    content: string;
    image?: any[];
    delay?: number;
  }[];
  settings?: Record<string, any>;
  date?: string;
}

export const postBody = (
  type: CreatePostDto['type'],
  channels: ChannelInput[],
  extra: Partial<CreatePostDto> = {}
): CreatePostDto =>
  ({
    type,
    shortLink: false,
    date: futureDate(),
    tags: [],
    ...extra,
    posts: channels.map((channel) => ({
      integration: { id: channel.integrationId },
      group: channel.group,
      date: channel.date,
      settings: { __type: 'facebook', ...(channel.settings || {}) },
      value: (channel.values || [{ content: 'Hello world' }]).map(
        (value, index) => ({
          id: channel.ids?.[index],
          content: value.content,
          delay: value.delay ?? 0,
          image: value.image || [],
        })
      ),
    })),
  } as unknown as CreatePostDto);

// the channels of a saved batch, ready to be sent again as an edit
export const editChannels = async (
  prisma: PrismaService,
  batchId: string,
  change: (integrationId: string, channel: ChannelInput) => ChannelInput = (
    _id,
    channel
  ) => channel
): Promise<ChannelInput[]> => {
  const roots = await prisma.post.findMany({
    where: { batchId, parentPostId: null, deletedAt: null },
    orderBy: { id: 'asc' },
  });

  return roots.map((root) =>
    change(root.integrationId, {
      integrationId: root.integrationId,
      ids: [root.id],
      group: root.group,
      date: root.publishDate.toISOString(),
      values: [
        {
          content: root.content,
          image: JSON.parse(root.image || '[]'),
          delay: root.delay,
        },
      ],
      settings: (({ __type, ...rest }) => rest)(
        JSON.parse(root.settings || '{}')
      ),
    })
  );
};

export const rootsOf = (prisma: PrismaService, batchId: string) =>
  prisma.post.findMany({
    where: { batchId, parentPostId: null, deletedAt: null },
    orderBy: { id: 'asc' },
  });

export const statesOf = async (prisma: PrismaService, batchId: string) =>
  (await rootsOf(prisma, batchId)).map((p) => p.state as State);

export const eventsOf = async (prisma: PrismaService, approvalId: string) =>
  (
    await prisma.postApprovalEvent.findMany({
      where: { approvalId },
      orderBy: { createdAt: 'asc' },
    })
  ).map((p) => p.action);

// moves a batch to APPROVED with the fingerprints it has now, as the final
// approval of phase 3 will do, and queues its roots
export const approveBatch = async (
  ctx: ApprovalsTestContext,
  orgId: string,
  batchId: string
) => {
  const fingerprints = await ctx.gate.fingerprintsFromDb(orgId, batchId);
  await ctx.prisma.postApproval.update({
    where: { batchId },
    data: {
      stage: 'APPROVED',
      approvedFingerprints: fingerprints,
      version: { increment: 1 },
    },
  });
  await ctx.prisma.post.updateMany({
    where: {
      batchId,
      parentPostId: null,
      deletedAt: null,
      state: { not: 'PUBLISHED' },
    },
    data: { state: 'QUEUE' },
  });
  // as if each queued root had its publish workflow sleeping in Temporal
  for (const root of await rootsOf(ctx.prisma, batchId)) {
    if (root.state === 'QUEUE') {
      ctx.temporal.running.set(`post_${root.id}`, root.id);
    }
  }
  return fingerprints;
};

export const setStage = (
  prisma: PrismaService,
  batchId: string,
  stage: 'IN_PRODUCTION' | 'IN_REVIEW' | 'AWAITING_FINAL' | 'CHANGES_REQUESTED'
) =>
  prisma.postApproval.update({
    where: { batchId },
    data: { stage, version: { increment: 1 } },
  });
