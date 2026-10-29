import { InfiniteWorkflowRegister } from '@gitroom/nestjs-libraries/temporal/infinite.workflow.register';
import { ApprovalSweepService } from './approval.sweep.service';
import {
  approveBatch,
  ApprovalsTestContext,
  cleanDatabase,
  createApprovalsTestModule,
  createIntegration,
  createOrg,
  createUser,
  eventsOf,
  futureDate,
  pastDate,
  postBody,
  rootsOf,
  setStage,
  statesOf,
} from './test/approvals.test.helpers';

describe('ApprovalSweepService', () => {
  let ctx: ApprovalsTestContext;
  let sweep: ApprovalSweepService;
  let orgId: string;
  let adminEmail: string;
  let creatorId: string;
  let emails: Record<'creator' | 'reviewer' | 'boss' | 'writer', string>;
  let channelA: string;
  let channelB: string;

  beforeAll(async () => {
    ctx = await createApprovalsTestModule();
    sweep = ctx.module.get(ApprovalSweepService);
  });

  afterAll(async () => {
    await ctx.module.close();
  });

  beforeEach(async () => {
    process.env.APPROVALS_ENABLED = 'true';
    await cleanDatabase(ctx.prisma);
    ctx.temporal.reset();
    ctx.notifications.reset();
    const org = await createOrg(ctx.prisma);
    orgId = org.orgId;
    const emailOf = async (id: string) =>
      (await ctx.prisma.user.findUniqueOrThrow({ where: { id } })).email;
    adminEmail = await emailOf(org.adminId);
    creatorId = await createUser(ctx.prisma, orgId, ['CREATOR']);
    emails = {
      creator: await emailOf(creatorId),
      reviewer: await emailOf(
        await createUser(ctx.prisma, orgId, ['REVIEWER'])
      ),
      boss: await emailOf(
        await createUser(ctx.prisma, orgId, ['MONTHLY_REVIEWER'])
      ),
      writer: await emailOf(
        await createUser(ctx.prisma, orgId, ['TECHNICAL_WRITER'])
      ),
    };
    channelA = await createIntegration(ctx.prisma, orgId);
    channelB = await createIntegration(ctx.prisma, orgId);
  });

  const draft = async (
    channels = [channelA],
    extra: Parameters<typeof postBody>[2] = {}
  ) => {
    const [saved] = await ctx.posts.createPost(
      orgId,
      postBody(
        'draft',
        channels.map((integrationId) => ({ integrationId })),
        extra
      ),
      'WEB',
      false,
      creatorId
    );
    const post = await ctx.prisma.post.findUniqueOrThrow({
      where: { id: saved.postId },
    });
    ctx.notifications.reset();
    return post.batchId!;
  };

  const approval = (batchId: string) =>
    ctx.prisma.postApproval.findUniqueOrThrow({ where: { batchId } });
  const sentTo = (email: string) =>
    ctx.notifications.sent.filter((p) => p.to === email);
  const subjects = () => ctx.notifications.sent.map((p) => p.subject);

  const runTwice = async () => {
    await sweep.run(new Date());
    const events = await ctx.prisma.postApprovalEvent.count();
    const sent = ctx.notifications.sent.length;
    await sweep.run(new Date());
    expect(await ctx.prisma.postApprovalEvent.count()).toBe(events);
    expect(ctx.notifications.sent.length).toBe(sent);
  };

  it('changes nothing with APPROVALS_ENABLED=false', async () => {
    const batchId = await draft([channelA], { date: pastDate() });
    const [root] = await rootsOf(ctx.prisma, batchId);
    await ctx.prisma.post.update({
      where: { id: root.id },
      data: { state: 'QUEUE' },
    });
    const events = await ctx.prisma.postApprovalEvent.count();
    process.env.APPROVALS_ENABLED = 'false';

    await sweep.run(new Date());
    await sweep.reconcile({ startup: true });

    expect(await ctx.prisma.postApprovalEvent.count()).toBe(events);
    expect(await statesOf(ctx.prisma, batchId)).toEqual(['QUEUE']);
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('1: records EXPIRED once and tells the whole team', async () => {
    const batchId = await draft([channelA], { date: pastDate() });
    await runTwice();
    const current = await approval(batchId);
    expect(current.stage).toBe('IN_PRODUCTION');
    expect(current.warnedExpiredAt).not.toBeNull();
    expect(await eventsOf(ctx.prisma, current.id)).toEqual([
      'CREATED',
      'EXPIRED',
    ]);
    expect(
      ctx.notifications.sent.filter((p) => p.type === 'info')
    ).toHaveLength(1);
  });

  it('2: warns the role of the stage at 48 h and at 24 h, once each', async () => {
    const in40 = await draft([channelA], { date: futureDate(40) });
    await setStage(ctx.prisma, in40, 'IN_REVIEW');
    const in20 = await draft([channelB], { date: futureDate(20) });

    await runTwice();

    expect(sentTo(emails.reviewer).map((p) => p.subject)).toEqual([
      'Vence en 48 h: (sin tema)',
    ]);
    // inside 24 h only the closest warning goes out
    expect(sentTo(emails.creator).map((p) => p.subject)).toEqual([
      'Vence en 24 h: (sin tema)',
    ]);
    const closest = await approval(in20);
    expect(closest.warned24At).not.toBeNull();
    expect(closest.warned48At).not.toBeNull();
    expect((await approval(in40)).warned24At).toBeNull();
  });

  it('2: warns the monthly reviewers of a batch waiting for the final approval', async () => {
    const batchId = await draft([channelA], { date: futureDate(10) });
    await setStage(ctx.prisma, batchId, 'AWAITING_FINAL');
    await sweep.run(new Date());
    expect(sentTo(emails.boss)).toHaveLength(1);
  });

  it('3: moves an approved batch to PUBLISHED once every channel went out, and closes its brief', async () => {
    const batchId = await draft([channelA, channelB]);
    await approveBatch(ctx, orgId, batchId);
    const brief = await ctx.prisma.contentBrief.create({
      data: {
        organizationId: orgId,
        topic: 'Launch',
        status: 'IN_PRODUCTION',
        createdById: creatorId,
        approvals: { connect: { batchId } },
      },
    });
    const [first, second] = await rootsOf(ctx.prisma, batchId);
    await ctx.prisma.post.update({
      where: { id: first.id },
      data: { state: 'PUBLISHED' },
    });
    await ctx.prisma.post.update({
      where: { id: second.id },
      data: { state: 'ERROR' },
    });

    // a channel in ERROR keeps the batch APPROVED until it is retried or dropped
    await sweep.run(new Date());
    expect((await approval(batchId)).stage).toBe('APPROVED');

    await ctx.prisma.post.update({
      where: { id: second.id },
      data: { state: 'PUBLISHED' },
    });
    await runTwice();

    const current = await approval(batchId);
    expect(current.stage).toBe('PUBLISHED');
    expect(current.verifyDueAt!.getTime()).toBeGreaterThan(
      Date.now() + 23 * 3600000
    );
    expect(
      (
        await ctx.prisma.contentBrief.findUniqueOrThrow({
          where: { id: brief.id },
        })
      ).status
    ).toBe('DONE');
    expect(sentTo(emails.writer).map((p) => p.subject)).toEqual([
      'Publicado, falta verificar: Launch',
    ]);
  });

  it('3: keeps a brief open while another linked batch is not published', async () => {
    const done = await draft([channelA]);
    const pending = await draft([channelB]);
    await approveBatch(ctx, orgId, done);
    const brief = await ctx.prisma.contentBrief.create({
      data: {
        organizationId: orgId,
        topic: 'Series',
        status: 'IN_PRODUCTION',
        createdById: creatorId,
        approvals: { connect: [{ batchId: done }, { batchId: pending }] },
      },
    });
    await ctx.prisma.post.updateMany({
      where: { batchId: done },
      data: { state: 'PUBLISHED' },
    });
    await sweep.run(new Date());
    expect((await approval(done)).stage).toBe('PUBLISHED');
    expect(
      (
        await ctx.prisma.contentBrief.findUniqueOrThrow({
          where: { id: brief.id },
        })
      ).status
    ).toBe('IN_PRODUCTION');
  });

  it('4: reminds the writers and the monthly reviewers of an overdue verification once', async () => {
    const batchId = await draft([channelA]);
    await ctx.prisma.post.updateMany({
      where: { batchId },
      data: { state: 'PUBLISHED' },
    });
    await ctx.prisma.postApproval.update({
      where: { batchId },
      data: { stage: 'PUBLISHED', verifyDueAt: new Date(pastDate(1)) },
    });
    await runTwice();
    expect(sentTo(emails.writer).map((p) => p.subject)).toEqual([
      'Verificación pendiente: (sin tema)',
    ]);
    expect(sentTo(emails.boss)).toHaveLength(1);
    expect((await approval(batchId)).warnedVerifyAt).not.toBeNull();
  });

  it('5a: a drifted approved batch goes back to review and only the monthly reviewers hear about it', async () => {
    const batchId = await draft([channelA, channelB]);
    await approveBatch(ctx, orgId, batchId);
    const [blocked, other] = await rootsOf(ctx.prisma, batchId);
    await ctx.prisma.post.update({
      where: { id: blocked.id },
      data: {
        content: 'changed behind the gate',
        state: 'ERROR',
        error: 'No Post',
      },
    });

    await runTwice();

    const current = await approval(batchId);
    expect(current.stage).toBe('IN_REVIEW');
    expect(current.approvedFingerprints).toBeNull();
    expect(await eventsOf(ctx.prisma, current.id)).toContain('RESET_BY_EDIT');
    expect(await statesOf(ctx.prisma, batchId)).toEqual(['DRAFT', 'DRAFT']);
    expect(ctx.temporal.calls).toContainEqual({
      type: 'terminate',
      postId: other.id,
    });
    expect(sentTo(emails.boss).map((p) => p.subject)).toEqual([
      'Se impidió publicar sin aprobación: (sin tema)',
    ]);
    expect(sentTo(adminEmail)).toHaveLength(0);
  });

  it('5a: a post blocked for another reason goes to DRAFT and the admins hear about it', async () => {
    const batchId = await draft([channelA]);
    const [root] = await rootsOf(ctx.prisma, batchId);
    await ctx.prisma.post.update({
      where: { id: root.id },
      data: { state: 'ERROR', error: 'No Post' },
    });
    await sweep.run(new Date());
    expect(await statesOf(ctx.prisma, batchId)).toEqual(['DRAFT']);
    expect(sentTo(adminEmail)).toHaveLength(1);
  });

  it('5a: leaves alone a post that failed although it is approved', async () => {
    const batchId = await draft([channelA]);
    await approveBatch(ctx, orgId, batchId);
    const [root] = await rootsOf(ctx.prisma, batchId);
    await ctx.prisma.post.update({
      where: { id: root.id },
      data: { state: 'ERROR', error: 'No Post' },
    });
    await sweep.run(new Date());
    expect(await statesOf(ctx.prisma, batchId)).toEqual(['ERROR']);
  });

  it('5b: a queued post without approval goes to DRAFT, RECONCILED, and the admins get an email', async () => {
    const batchId = await draft([channelA]);
    const [root] = await rootsOf(ctx.prisma, batchId);
    await ctx.prisma.post.update({
      where: { id: root.id },
      data: { state: 'QUEUE' },
    });
    ctx.temporal.running.set(`post_${root.id}`, root.id);

    await runTwice();

    expect(await statesOf(ctx.prisma, batchId)).toEqual(['DRAFT']);
    expect(ctx.temporal.running.size).toBe(0);
    const event = await ctx.prisma.postApprovalEvent.findFirstOrThrow({
      where: { action: 'RECONCILED' },
    });
    expect(event.reason).toBe('stage');
    expect(sentTo(adminEmail).map((p) => p.subject)).toEqual([
      'Post sin aprobación desprogramado: (sin tema)',
    ]);
  });

  it('5b: at start records reason startup and sends nothing', async () => {
    const batchId = await draft([channelA]);
    const [root] = await rootsOf(ctx.prisma, batchId);
    await ctx.prisma.post.update({
      where: { id: root.id },
      data: { state: 'QUEUE' },
    });
    await sweep.reconcile({ startup: true });
    const event = await ctx.prisma.postApprovalEvent.findFirstOrThrow({
      where: { action: 'RECONCILED' },
    });
    expect(event.reason).toBe('startup');
    expect(ctx.notifications.sent).toHaveLength(0);
  });

  it('5c: a failed post in an unapproved batch goes to DRAFT', async () => {
    const batchId = await draft([channelA]);
    await setStage(ctx.prisma, batchId, 'IN_REVIEW');
    const [root] = await rootsOf(ctx.prisma, batchId);
    await ctx.prisma.post.update({
      where: { id: root.id },
      data: { state: 'ERROR', error: 'Already posted' },
    });
    await runTwice();
    expect(await statesOf(ctx.prisma, batchId)).toEqual(['DRAFT']);
    const event = await ctx.prisma.postApprovalEvent.findFirstOrThrow({
      where: { action: 'RECONCILED' },
    });
    expect(event.reason).toBe('error_before_approval');
  });

  it('5d: adopts the posts saved while the fork was off, and leaves published history alone', async () => {
    process.env.APPROVALS_ENABLED = 'false';
    const [queued] = await ctx.posts.createPost(
      orgId,
      postBody('schedule', [{ integrationId: channelA }]),
      'WEB'
    );
    const [old] = await ctx.posts.createPost(
      orgId,
      postBody('draft', [{ integrationId: channelB }]),
      'WEB'
    );
    await ctx.prisma.post.update({
      where: { id: old.postId },
      data: { state: 'PUBLISHED' },
    });
    process.env.APPROVALS_ENABLED = 'true';

    await runTwice();

    const post = await ctx.prisma.post.findUniqueOrThrow({
      where: { id: queued.postId },
    });
    expect(post.state).toBe('DRAFT');
    const adopted = await approval(post.batchId!);
    expect(adopted.stage).toBe('IN_PRODUCTION');
    const created = await ctx.prisma.postApprovalEvent.findFirstOrThrow({
      where: { approvalId: adopted.id, action: 'CREATED' },
    });
    expect(created).toMatchObject({ actorRole: 'SYSTEM', actorUserId: null });
    const published = await ctx.prisma.post.findUniqueOrThrow({
      where: { id: old.postId },
    });
    expect(
      await ctx.prisma.postApproval.count({
        where: { batchId: published.batchId! },
      })
    ).toBe(0);
  });

  it('5d: skips a batch another sweep adopted first', async () => {
    process.env.APPROVALS_ENABLED = 'false';
    const [queued] = await ctx.posts.createPost(
      orgId,
      postBody('schedule', [{ integrationId: channelA }]),
      'WEB'
    );
    process.env.APPROVALS_ENABLED = 'true';
    const spy = jest
      .spyOn(ctx.repository, 'createApproval')
      .mockRejectedValueOnce(new Error('unique constraint'));
    await sweep.reconcile({ startup: true });
    spy.mockRestore();
    // 5b already moved it to DRAFT, and 5d did not touch it
    expect(
      (
        await ctx.prisma.post.findUniqueOrThrow({
          where: { id: queued.postId },
        })
      ).state
    ).toBe('DRAFT');
  });

  it('5e: records a channel deleted outside deletePost once, and not one already discarded', async () => {
    const batchId = await draft([channelA, channelB]);
    await approveBatch(ctx, orgId, batchId);
    const [gone, failed] = await rootsOf(ctx.prisma, batchId);
    // Postiz deletes posts with updateMany when a channel is reconnected
    await ctx.prisma.post.update({
      where: { id: gone.id },
      data: { deletedAt: new Date() },
    });
    // and this one went through deletePost
    await ctx.prisma.post.update({
      where: { id: failed.id },
      data: { state: 'ERROR' },
    });
    await ctx.posts.deletePost(orgId, failed.group, creatorId, 'WEB');

    await runTwice();

    const discarded = await ctx.prisma.postApprovalEvent.findMany({
      where: { action: 'CHANNEL_DISCARDED' },
      orderBy: { createdAt: 'asc' },
    });
    expect(
      discarded.map((p) => [(p.snapshot as any)?.integrationId, p.actorRole])
    ).toEqual([
      [failed.integrationId, 'CREATOR'],
      [gone.integrationId, 'SYSTEM'],
    ]);
  });

  it('two sweeps at the same time record and notify a reconciled post once', async () => {
    const batchId = await draft([channelA]);
    const [root] = await rootsOf(ctx.prisma, batchId);
    await ctx.prisma.post.update({
      where: { id: root.id },
      data: { state: 'QUEUE' },
    });

    await Promise.all([sweep.run(new Date()), sweep.run(new Date())]);

    expect(
      await ctx.prisma.postApprovalEvent.count({
        where: { action: 'RECONCILED' },
      })
    ).toBe(1);
    expect(sentTo(adminEmail)).toHaveLength(1);
  });

  it('5d: leaves alone drafts and old errors saved while the fork was off', async () => {
    process.env.APPROVALS_ENABLED = 'false';
    const [plain] = await ctx.posts.createPost(
      orgId,
      postBody('draft', [{ integrationId: channelA }]),
      'WEB'
    );
    const [failed] = await ctx.posts.createPost(
      orgId,
      postBody('draft', [{ integrationId: channelB }], {
        date: pastDate(24 * 40),
      }),
      'WEB'
    );
    await ctx.prisma.post.update({
      where: { id: failed.postId },
      data: { state: 'ERROR' },
    });
    process.env.APPROVALS_ENABLED = 'true';

    await sweep.run(new Date());

    expect(await ctx.prisma.postApproval.count()).toBe(0);
    expect(
      (
        await ctx.prisma.post.findUniqueOrThrow({
          where: { id: failed.postId },
        })
      ).state
    ).toBe('ERROR');
    expect(
      (await ctx.prisma.post.findUniqueOrThrow({ where: { id: plain.postId } }))
        .state
    ).toBe('DRAFT');
  });

  it('5a: tells the reviewers when a batch goes back to review', async () => {
    const batchId = await draft([channelA]);
    await approveBatch(ctx, orgId, batchId);
    const [blocked] = await rootsOf(ctx.prisma, batchId);
    await ctx.prisma.post.update({
      where: { id: blocked.id },
      data: { content: 'changed', state: 'ERROR', error: 'No Post' },
    });
    await sweep.run(new Date());
    expect(sentTo(emails.reviewer).map((p) => p.subject)).toEqual([
      'Post editado, vuelve a revisión: (sin tema)',
    ]);
  });

  it('runs the other steps when one fails', async () => {
    const expired = await draft([channelA], { date: pastDate() });
    const spy = jest
      .spyOn(ctx.repository, 'findExpired')
      .mockRejectedValueOnce(new Error('db hiccup'));
    const [root] = await rootsOf(ctx.prisma, expired);
    await ctx.prisma.post.update({
      where: { id: root.id },
      data: { state: 'QUEUE' },
    });

    await sweep.run(new Date());
    spy.mockRestore();

    expect((await approval(expired)).warnedExpiredAt).toBeNull();
    expect(await statesOf(ctx.prisma, expired)).toEqual(['DRAFT']);
  });

  describe('InfiniteWorkflowRegister', () => {
    const register = () =>
      new InfiniteWorkflowRegister(ctx.temporal.service, sweep);

    afterEach(() => {
      delete process.env.RUN_CRON;
    });

    it('starts the sweep workflow next to missingPostWorkflow with RUN_CRON', async () => {
      process.env.RUN_CRON = 'true';
      const reconcile = jest.spyOn(sweep, 'reconcile').mockResolvedValue();
      await register().onModuleInit();
      const start = ctx.temporal.service.client.getRawClient().workflow
        .start as jest.Mock;
      expect(start.mock.calls.map((p) => p[1].workflowId)).toEqual(
        expect.arrayContaining([
          'missing-post-workflow',
          'approval-sweep-workflow',
        ])
      );
      expect(reconcile).toHaveBeenCalledWith({ startup: true });
      reconcile.mockRestore();
    });

    it('logs an error without RUN_CRON and does not reconcile', async () => {
      const instance = register();
      const error = jest
        .spyOn((instance as any)._logger, 'error')
        .mockImplementation(() => undefined);
      const reconcile = jest.spyOn(sweep, 'reconcile');
      await instance.onModuleInit();
      expect(error.mock.calls[0][0]).toContain('RUN_CRON is not set');
      expect(reconcile).not.toHaveBeenCalled();
      reconcile.mockRestore();
      error.mockRestore();
    });

    it('retries a failed reconciliation at start 3 times', async () => {
      process.env.RUN_CRON = 'true';
      jest.useFakeTimers();
      const instance = register();
      const error = jest
        .spyOn((instance as any)._logger, 'error')
        .mockImplementation(() => undefined);
      const reconcile = jest
        .spyOn(sweep, 'reconcile')
        .mockRejectedValue(new Error('db down'));

      await instance.onModuleInit();
      for (let i = 0; i < 3; i++) {
        await jest.advanceTimersByTimeAsync(10000);
      }
      jest.useRealTimers();

      expect(reconcile).toHaveBeenCalledTimes(3);
      expect(error.mock.calls.map((p) => p[0])).toEqual([
        'approval reconciliation at start failed',
      ]);
      reconcile.mockRestore();
      error.mockRestore();
    });

    it('does nothing for approvals with the fork off', async () => {
      process.env.APPROVALS_ENABLED = 'false';
      const reconcile = jest.spyOn(sweep, 'reconcile');
      await register().onModuleInit();
      expect(reconcile).not.toHaveBeenCalled();
      reconcile.mockRestore();
    });
  });
});
