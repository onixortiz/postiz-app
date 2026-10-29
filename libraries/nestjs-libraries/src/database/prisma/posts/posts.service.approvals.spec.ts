import { BadRequestException } from '@nestjs/common';
import {
  approveBatch,
  ApprovalsTestContext,
  cleanDatabase,
  createApprovalsTestModule,
  createIntegration,
  createOrg,
  createUser,
  editChannels,
  futureDate,
  postBody,
  rootsOf,
  statesOf,
} from '@gitroom/nestjs-libraries/database/prisma/approvals/test/approvals.test.helpers';

// FORK: approvals. One test per row of the paths table of the design: every
// PostsService method that writes QUEUE goes through the approval gate.
describe('PostsService with approvals', () => {
  let ctx: ApprovalsTestContext;
  let orgId: string;
  let creatorId: string;
  let channels: string[];

  beforeAll(async () => {
    ctx = await createApprovalsTestModule();
  });

  afterAll(async () => {
    await ctx.module.close();
  });

  beforeEach(async () => {
    process.env.APPROVALS_ENABLED = 'true';
    await cleanDatabase(ctx.prisma);
    ctx.temporal.reset();
    ctx.notifications.reset();
    ({ orgId } = await createOrg(ctx.prisma));
    creatorId = await createUser(ctx.prisma, orgId, ['CREATOR']);
    channels = [
      await createIntegration(ctx.prisma, orgId),
      await createIntegration(ctx.prisma, orgId),
      await createIntegration(ctx.prisma, orgId),
    ];
  });

  const create = async (
    type: 'draft' | 'schedule' | 'now' | 'update',
    list = channels.map((integrationId) => ({ integrationId })),
    method: 'WEB' | 'API' | 'MCP' | 'AUTOPOST' = 'WEB',
    extra: Parameters<typeof postBody>[2] = {}
  ) => {
    const saved = await ctx.posts.createPost(
      orgId,
      postBody(type, list, extra),
      method,
      false,
      method === 'WEB' ? creatorId : undefined
    );
    const root = await ctx.prisma.post.findUniqueOrThrow({
      where: { id: saved[0].postId },
    });
    return { saved, batchId: root.batchId! };
  };

  const starts = () =>
    ctx.temporal.calls.filter((p) => p.type === 'start').map((p) => p.postId);
  const terminates = () =>
    ctx.temporal.calls
      .filter((p) => p.type === 'terminate')
      .map((p) => p.postId);

  const approved = async () => {
    const { batchId } = await create('draft');
    await approveBatch(ctx, orgId, batchId);
    ctx.temporal.calls.length = 0;
    return batchId;
  };

  it.each(['WEB', 'API', 'MCP'] as const)(
    '%s: schedule and now on an unapproved batch save DRAFT and never start a workflow',
    async (method) => {
      for (const type of ['schedule', 'now'] as const) {
        const { batchId } = await create(
          type,
          [{ integrationId: channels[0] }],
          method
        );
        expect(await statesOf(ctx.prisma, batchId)).toEqual(['DRAFT']);
      }
      expect(starts()).toEqual([]);
      // startWorkflow(DRAFT) still looked for running workflows to terminate
      expect(
        ctx.temporal.service.client.getRawClient().workflow.list
      ).toHaveBeenCalled();
    }
  );

  it('queues an approved batch saved again without changes, one workflow per root', async () => {
    const batchId = await approved();
    await create('schedule', await editChannels(ctx.prisma, batchId));

    expect(await statesOf(ctx.prisma, batchId)).toEqual([
      'QUEUE',
      'QUEUE',
      'QUEUE',
    ]);
    expect(starts().sort()).toEqual(
      (await rootsOf(ctx.prisma, batchId)).map((p) => p.id).sort()
    );
  });

  it('terminates the workflows of the 3 channels when one of them changes (B1), none ends in ERROR', async () => {
    const batchId = await approved();
    const edited = await editChannels(ctx.prisma, batchId, (id, channel) =>
      id === channels[0]
        ? {
            ...channel,
            values: [{ ...channel.values![0], content: 'changed' }],
          }
        : channel
    );
    await create('schedule', [
      edited.find((p) => p.integrationId === channels[0])!,
    ]);

    const roots = await rootsOf(ctx.prisma, batchId);
    expect(roots.map((p) => p.state)).toEqual(['DRAFT', 'DRAFT', 'DRAFT']);
    expect(terminates().sort()).toEqual(roots.map((p) => p.id).sort());
    expect(starts()).toEqual([]);
    expect(ctx.temporal.running.size).toBe(0);
  });

  it('does not race: every terminate of a post happens before its start', async () => {
    const batchId = await approved();
    await create('schedule', await editChannels(ctx.prisma, batchId));

    for (const root of await rootsOf(ctx.prisma, batchId)) {
      const calls = ctx.temporal.calls.filter((p) => p.postId === root.id);
      expect(calls[calls.length - 1].type).toBe('start');
    }
  });

  it('mixed batch: a published channel is saved with update and the others are scheduled', async () => {
    const batchId = await approved();
    const [published] = await rootsOf(ctx.prisma, batchId);
    await ctx.prisma.post.update({
      where: { id: published.id },
      data: { state: 'PUBLISHED' },
    });

    await create('schedule', await editChannels(ctx.prisma, batchId));

    const roots = await rootsOf(ctx.prisma, batchId);
    expect(roots.find((p) => p.id === published.id)!.state).toBe('PUBLISHED');
    expect(roots.filter((p) => p.state === 'QUEUE')).toHaveLength(2);
    expect(starts()).not.toContain(published.id);
  });

  it('updatePostSettings on an approved batch of 3 resets it and drafts the other two', async () => {
    const batchId = await approved();
    const [root] = await rootsOf(ctx.prisma, batchId);
    jest.spyOn(ctx.posts, 'validatePosts').mockResolvedValueOnce([
      {
        valid: true,
        errors: true,
        emptyContent: false,
        tooLong: false,
      } as any,
    ]);

    await ctx.posts.updatePostSettings(orgId, root.id, { title: 'new' }, 'API');

    const roots = await rootsOf(ctx.prisma, batchId);
    expect(roots.map((p) => p.state)).toEqual(['DRAFT', 'DRAFT', 'DRAFT']);
    expect(
      (await ctx.prisma.postApproval.findUniqueOrThrow({ where: { batchId } }))
        .stage
    ).toBe('IN_REVIEW');
    expect(terminates().sort()).toEqual(roots.map((p) => p.id).sort());
  });

  it('runs afterSave when the loop fails half way, and leaves nothing in QUEUE', async () => {
    const batchId = await approved();
    const repository = (ctx.posts as any)._postRepository;
    const original = repository.createOrUpdatePost.bind(repository);
    let call = 0;
    const spy = jest
      .spyOn(repository, 'createOrUpdatePost')
      .mockImplementation(async (...args: any[]) => {
        call++;
        if (call === 2) {
          throw new Error('provider failed');
        }
        return original(...args);
      });
    const afterSave = jest.spyOn(ctx.gate, 'afterSave');

    await expect(
      create(
        'schedule',
        await editChannels(ctx.prisma, batchId, (id, channel) =>
          id === channels[0]
            ? {
                ...channel,
                values: [{ ...channel.values![0], content: 'changed' }],
              }
            : channel
        )
      )
    ).rejects.toThrow('provider failed');

    expect(afterSave).toHaveBeenCalled();
    expect((await statesOf(ctx.prisma, batchId)).includes('QUEUE')).toBe(false);
    spy.mockRestore();
    afterSave.mockRestore();
  });

  it('calendar: changeDate(schedule, republish) keeps an approved post in QUEUE and restarts it at the new date', async () => {
    const batchId = await approved();
    const [root] = await rootsOf(ctx.prisma, batchId);
    const date = futureDate(120);

    await ctx.posts.changeDate(
      orgId,
      root.id,
      date,
      'schedule',
      true,
      creatorId,
      'WEB'
    );

    const after = await ctx.prisma.post.findUniqueOrThrow({
      where: { id: root.id },
    });
    expect(after.state).toBe('QUEUE');
    expect(after.publishDate.getTime()).toBe(new Date(date).getTime());
    expect(terminates()).toContain(root.id);
    expect(starts()).toEqual([root.id]);
  });

  it('republishing in two steps is rejected', async () => {
    const batchId = await approved();
    const [root] = await rootsOf(ctx.prisma, batchId);
    await ctx.prisma.post.update({
      where: { id: root.id },
      data: { state: 'PUBLISHED' },
    });

    await ctx.posts.changeDate(
      orgId,
      root.id,
      futureDate(120),
      'update',
      false,
      creatorId,
      'WEB'
    );
    await expect(
      ctx.posts.changePostStatus(orgId, root.id, 'schedule')
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(
      (await ctx.prisma.post.findUniqueOrThrow({ where: { id: root.id } }))
        .state
    ).toBe('PUBLISHED');
  });

  it('public API: changePostStatus(schedule) without approval answers 400, draft passes', async () => {
    const { saved } = await create(
      'draft',
      [{ integrationId: channels[0] }],
      'API'
    );
    await expect(
      ctx.posts.changePostStatus(orgId, saved[0].postId, 'schedule')
    ).rejects.toThrow('Este post necesita aprobación final');
    await expect(
      ctx.posts.changePostStatus(orgId, saved[0].postId, 'draft')
    ).resolves.toEqual({ id: saved[0].postId, state: 'DRAFT' });
  });

  it('plugs: checkInternalPlug and checkPlugs return []', async () => {
    expect(
      await ctx.posts.checkInternalPlug(
        { id: channels[0] } as any,
        orgId,
        'post',
        { 'plug--repost--integrations': [{ id: channels[1] }] }
      )
    ).toEqual([]);
    expect(await ctx.posts.checkPlugs(orgId, 'facebook', channels[0])).toEqual(
      []
    );
  });

  it('repeated posts: inter = 7 saves intervalInDays = null', async () => {
    const { batchId } = await create(
      'draft',
      [{ integrationId: channels[0] }],
      'WEB',
      { inter: 7 }
    );
    expect((await rootsOf(ctx.prisma, batchId))[0].intervalInDays).toBeNull();
  });

  it('autopost: creates a DRAFT and a PostApproval in IN_PRODUCTION', async () => {
    const { batchId } = await create(
      'draft',
      [{ integrationId: channels[0] }],
      'AUTOPOST'
    );
    expect(await statesOf(ctx.prisma, batchId)).toEqual(['DRAFT']);
    const approval = await ctx.prisma.postApproval.findUniqueOrThrow({
      where: { batchId },
    });
    expect(approval.stage).toBe('IN_PRODUCTION');
    const created = await ctx.prisma.postApprovalEvent.findFirstOrThrow({
      where: { approvalId: approval.id, action: 'CREATED' },
    });
    expect(created).toMatchObject({ actorRole: 'SYSTEM', surface: 'AUTOPOST' });
  });

  it('reports an afterSave failure after a good save, and leaves the post a draft', async () => {
    const afterSave = jest
      .spyOn(ctx.gate, 'afterSave')
      .mockRejectedValueOnce(new Error('gate down'));
    await expect(
      create('schedule', [{ integrationId: channels[0] }])
    ).rejects.toThrow('gate down');
    const [post] = await ctx.prisma.post.findMany({
      where: { integrationId: channels[0] },
    });
    expect(post.state).toBe('DRAFT');
    afterSave.mockRestore();
  });

  it('still runs afterSave for a post saved right before detachStaleAnchors failed', async () => {
    const batchId = await approved();
    const spy = jest
      .spyOn(ctx.posts, 'detachStaleAnchors')
      .mockRejectedValueOnce(new Error('anchors failed'));
    const edited = await editChannels(ctx.prisma, batchId, (id, channel) =>
      id === channels[0]
        ? {
            ...channel,
            values: [{ ...channel.values![0], content: 'changed' }],
          }
        : channel
    );
    await expect(
      create('schedule', [edited.find((p) => p.integrationId === channels[0])!])
    ).rejects.toThrow('anchors failed');
    expect(
      (await ctx.prisma.postApproval.findUniqueOrThrow({ where: { batchId } }))
        .stage
    ).toBe('IN_REVIEW');
    expect(await statesOf(ctx.prisma, batchId)).toEqual([
      'DRAFT',
      'DRAFT',
      'DRAFT',
    ]);
    spy.mockRestore();
  });

  it('changeDate logs an approval failure once the date is saved', async () => {
    const batchId = await approved();
    const [root] = await rootsOf(ctx.prisma, batchId);
    const spy = jest
      .spyOn(ctx.gate, 'afterChangeDate')
      .mockRejectedValueOnce(new Error('gate down'));
    const date = futureDate(150);
    await ctx.posts.changeDate(
      orgId,
      root.id,
      date,
      'update',
      false,
      creatorId,
      'WEB'
    );
    expect(
      (
        await ctx.prisma.post.findUniqueOrThrow({ where: { id: root.id } })
      ).publishDate.getTime()
    ).toBe(new Date(date).getTime());
    spy.mockRestore();
  });

  describe('with APPROVALS_ENABLED=false', () => {
    beforeEach(() => {
      process.env.APPROVALS_ENABLED = 'false';
    });

    it('behaves like upstream: schedule queues and starts the workflow, no approval rows', async () => {
      const { batchId, saved } = await create('schedule', [
        { integrationId: channels[0] },
      ]);
      // upstream starts the workflow without awaiting it
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await statesOf(ctx.prisma, batchId)).toEqual(['QUEUE']);
      expect(starts()).toEqual([saved[0].postId]);
      expect(saved[0]).not.toHaveProperty('approvalStage');
      expect(await ctx.prisma.postApproval.count()).toBe(0);
    });

    it('lets changePostStatus, changeDate and deletePost work as upstream', async () => {
      const { saved } = await create('draft', [{ integrationId: channels[0] }]);
      const id = saved[0].postId;
      await ctx.posts.changePostStatus(orgId, id, 'schedule');
      await ctx.posts.changeDate(orgId, id, futureDate(100), 'schedule');
      expect(
        (await ctx.prisma.post.findUniqueOrThrow({ where: { id } })).state
      ).toBe('QUEUE');
      const root = await ctx.prisma.post.findUniqueOrThrow({ where: { id } });
      expect(await ctx.posts.deletePost(orgId, root.group)).toEqual({ id });
      expect(await ctx.prisma.postApprovalEvent.count()).toBe(0);
    });

    it('keeps the repeat interval', async () => {
      const { batchId } = await create(
        'draft',
        [{ integrationId: channels[0] }],
        'WEB',
        { inter: 7 }
      );
      expect((await rootsOf(ctx.prisma, batchId))[0].intervalInDays).toBe(7);
    });
  });
});
