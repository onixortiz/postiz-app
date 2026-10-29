import { ApprovalTemplate } from './approval.notify.service';
import {
  ApprovalsTestContext,
  cleanDatabase,
  createApprovalsTestModule,
  createIntegration,
  createOrg,
  createUser,
  postBody,
} from './test/approvals.test.helpers';

describe('ApprovalNotifyService', () => {
  let ctx: ApprovalsTestContext;
  let orgId: string;
  let adminId: string;
  let approval: { id: string; batchId: string };
  let rootId: string;
  const secret = 'SECRET POST CONTENT';

  beforeAll(async () => {
    ctx = await createApprovalsTestModule();
  });

  afterAll(async () => {
    await ctx.module.close();
  });

  beforeEach(async () => {
    process.env.APPROVALS_ENABLED = 'true';
    await cleanDatabase(ctx.prisma);
    ({ orgId, adminId } = await createOrg(ctx.prisma));
    const channel = await createIntegration(ctx.prisma, orgId);
    const [saved] = await ctx.posts.createPost(
      orgId,
      postBody('draft', [
        { integrationId: channel, values: [{ content: secret }] },
      ]),
      'WEB',
      false,
      adminId
    );
    rootId = saved.postId;
    const post = await ctx.prisma.post.findUniqueOrThrow({
      where: { id: rootId },
    });
    approval = await ctx.prisma.postApproval.findUniqueOrThrow({
      where: { batchId: post.batchId! },
    });
    ctx.notifications.reset();
  });

  const data = () => ({ approvalId: approval.id, batchId: approval.batchId });
  const emails = () => ctx.notifications.sent.filter((p) => p.kind === 'email');

  const reset = (minutesAgo: number) =>
    ctx.prisma.postApprovalEvent.create({
      data: {
        organizationId: orgId,
        approvalId: approval.id,
        actorRole: 'MEMBER',
        action: 'RESET_BY_EDIT',
        createdAt: new Date(Date.now() - minutesAgo * 60000),
      },
    });

  it('skips a second RESET_BY_EDIT notice inside 15 minutes and sends it after', async () => {
    await createUser(ctx.prisma, orgId, ['REVIEWER']);

    await reset(0);
    await ctx.notify.notifyRole(orgId, 'REVIEWER', 'RESET_BY_EDIT', data());
    expect(emails()).toHaveLength(1);

    await reset(-0.01);
    await ctx.notify.notifyRole(orgId, 'REVIEWER', 'RESET_BY_EDIT', data());
    expect(emails()).toHaveLength(1);

    await ctx.prisma.postApprovalEvent.deleteMany({
      where: { action: 'RESET_BY_EDIT' },
    });
    await reset(20);
    await reset(0);
    await ctx.notify.notifyRole(orgId, 'REVIEWER', 'RESET_BY_EDIT', data());
    expect(emails()).toHaveLength(2);
  });

  it('never puts the post content or a comment in the notices', async () => {
    await ctx.prisma.contentBrief.create({
      data: {
        organizationId: orgId,
        topic: 'Launch <b>day</b>',
        createdById: adminId,
        approvals: { connect: { id: approval.id } },
      },
    });
    const templates: ApprovalTemplate[] = [
      'SUBMITTED',
      'REVIEW_APPROVED',
      'REJECTED',
      'RESET_BY_EDIT',
      'WARN_48H',
      'WARN_24H',
      'EXPIRED',
      'PUBLISHED',
      'VERIFY_OVERDUE',
      'FORCED',
      'BLOCKED_AT_PUBLISH',
      'RECONCILED',
      'VERIFICATION_PROBLEM',
    ];
    for (const template of templates) {
      await ctx.notify.notifyTeam(orgId, template, data());
    }
    expect(ctx.notifications.sent).toHaveLength(templates.length);
    for (const notice of ctx.notifications.sent) {
      expect(notice.body).not.toContain(secret);
      expect(notice.body).toContain(`/p/${rootId}`);
      expect(notice.subject).toContain('Launch <b>day</b>');
      expect(notice.type).toBe('info');
      expect(notice.sendEmail).toBe(true);
    }

    await ctx.notify.notifyAdmins(orgId, 'FORCED', data());
    expect(emails().pop()!.body).not.toContain('<b>');
  });

  it('uses "(sin tema)" without a brief', async () => {
    await ctx.notify.notifyTeam(orgId, 'EXPIRED', data());
    expect(ctx.notifications.sent[0].subject).toBe(
      'Venció sin aprobación: (sin tema)'
    );
  });

  it('sends each kind of notice to its recipients', async () => {
    const reviewer = await createUser(ctx.prisma, orgId, ['REVIEWER']);
    const writer = await createUser(ctx.prisma, orgId, ['TECHNICAL_WRITER']);
    const creator = await createUser(ctx.prisma, orgId, ['CREATOR']);
    const emailOf = async (id: string) =>
      (await ctx.prisma.user.findUniqueOrThrow({ where: { id } })).email;
    const adminEmail = await emailOf(adminId);

    await ctx.notify.notifyRole(orgId, 'REVIEWER', 'SUBMITTED', data());
    expect(emails().map((p) => p.to)).toEqual([await emailOf(reviewer)]);
    expect(ctx.notifications.sent[0]).toMatchObject({
      kind: 'inApp',
      sendEmail: false,
    });

    ctx.notifications.reset();
    await ctx.notify.notifyRole(orgId, 'TECHNICAL_WRITER', 'PUBLISHED', data());
    expect(emails().map((p) => p.to)).toEqual([await emailOf(writer)]);

    ctx.notifications.reset();
    await ctx.notify.notifyUser(orgId, creator, 'REJECTED', data());
    expect(emails().map((p) => p.to)).toEqual([await emailOf(creator)]);

    ctx.notifications.reset();
    await ctx.notify.notifyAdmins(orgId, 'RECONCILED', data());
    expect(ctx.notifications.sent.map((p) => p.to)).toEqual([adminEmail]);

    ctx.notifications.reset();
    await ctx.notify.notifyUser(orgId, 'not-a-member', 'REJECTED', data());
    expect(emails()).toHaveLength(0);
  });

  it('logs a failed notice instead of throwing', async () => {
    (
      ctx.notifications.service.inAppNotification as jest.Mock
    ).mockRejectedValueOnce(new Error('down'));
    (
      ctx.notifications.service.inAppNotification as jest.Mock
    ).mockRejectedValueOnce(new Error('down'));
    (
      ctx.notifications.service.inAppNotification as jest.Mock
    ).mockRejectedValueOnce(new Error('down'));
    (ctx.notifications.service.sendEmail as jest.Mock).mockRejectedValueOnce(
      new Error('down')
    );
    await expect(
      ctx.notify.notifyRole(orgId, 'REVIEWER', 'SUBMITTED', data())
    ).resolves.toBeUndefined();
    await expect(
      ctx.notify.notifyUser(orgId, adminId, 'REJECTED', data())
    ).resolves.toBeUndefined();
    await expect(
      ctx.notify.notifyTeam(orgId, 'EXPIRED', data())
    ).resolves.toBeUndefined();
    await expect(
      ctx.notify.notifyAdmins(orgId, 'FORCED', data())
    ).resolves.toBeUndefined();
  });

  it('warns at start when there is no email provider', () => {
    const warn = jest
      .spyOn((ctx.notify as any)._logger, 'warn')
      .mockImplementation(() => undefined);
    (
      ctx.notifications.service.hasEmailProvider as jest.Mock
    ).mockReturnValueOnce(false);
    ctx.notify.onModuleInit();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
