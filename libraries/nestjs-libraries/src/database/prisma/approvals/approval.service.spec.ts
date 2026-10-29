import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  ApprovalsTestContext,
  cleanDatabase,
  createApprovalsTestModule,
  createIntegration,
  createOrg,
  createUser,
  editChannels,
  eventsOf,
  pastDate,
  postBody,
  rootsOf,
  statesOf,
} from './test/approvals.test.helpers';

const VALID = {
  valid: true,
  errors: true,
  emptyContent: false,
  tooLong: false,
  name: 'channel',
} as any;

describe('ApprovalService', () => {
  let ctx: ApprovalsTestContext;
  let orgId: string;
  let adminId: string;
  let writer: { id: string };
  let creator: { id: string };
  let reviewer: { id: string };
  let boss: { id: string };
  let channelA: string;
  let channelB: string;
  let validate: jest.SpyInstance;

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
    ({ orgId, adminId } = await createOrg(ctx.prisma));
    writer = { id: await createUser(ctx.prisma, orgId, ['TECHNICAL_WRITER']) };
    creator = { id: await createUser(ctx.prisma, orgId, ['CREATOR']) };
    reviewer = { id: await createUser(ctx.prisma, orgId, ['REVIEWER']) };
    boss = { id: await createUser(ctx.prisma, orgId, ['MONTHLY_REVIEWER']) };
    channelA = await createIntegration(ctx.prisma, orgId);
    channelB = await createIntegration(ctx.prisma, orgId);
    validate = jest
      .spyOn(ctx.posts, 'validatePosts')
      .mockResolvedValue([VALID]);
  });

  afterEach(() => {
    validate.mockRestore();
  });

  const draft = async (
    channels = [channelA, channelB],
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
      creator.id
    );
    const post = await ctx.prisma.post.findUniqueOrThrow({
      where: { id: saved.postId },
    });
    return post.batchId!;
  };

  const approval = (batchId: string) =>
    ctx.prisma.postApproval.findUniqueOrThrow({ where: { batchId } });
  const version = async (batchId: string) => (await approval(batchId)).version;

  const submitted = async (batchId?: string) => {
    const id = batchId || (await draft());
    await ctx.approvals.submit(orgId, id, await version(id), creator, 'Topic');
    return id;
  };

  const reviewed = async (batchId?: string) => {
    const id = await submitted(batchId);
    await ctx.approvals.reviewApprove(orgId, id, await version(id), reviewer);
    return id;
  };

  const approved = async () => {
    const id = await reviewed();
    const [result] = await ctx.approvals.finalApprove(
      orgId,
      [{ batchId: id, version: await version(id) }],
      boss
    );
    expect(result.ok).toBe(true);
    return id;
  };

  const published = async () => {
    const id = await approved();
    await ctx.prisma.post.updateMany({
      where: { batchId: id },
      data: { state: 'PUBLISHED' },
    });
    await ctx.prisma.postApproval.update({
      where: { batchId: id },
      data: { stage: 'PUBLISHED', version: { increment: 1 } },
    });
    return id;
  };

  it('CUJ 1: a post goes through the whole chain', async () => {
    const brief = await ctx.briefs.create(orgId, writer, { topic: 'Launch' });
    const batchId = await draft();
    await ctx.approvals.linkBrief(
      orgId,
      batchId,
      await version(batchId),
      brief.id,
      creator
    );
    expect((await ctx.briefs.get(orgId, brief.id)).status).toBe(
      'IN_PRODUCTION'
    );

    await ctx.approvals.submit(orgId, batchId, await version(batchId), creator);
    expect((await approval(batchId)).stage).toBe('IN_REVIEW');

    await ctx.approvals.reviewApprove(
      orgId,
      batchId,
      await version(batchId),
      reviewer
    );
    expect((await approval(batchId)).stage).toBe('AWAITING_FINAL');

    const [result] = await ctx.approvals.finalApprove(
      orgId,
      [{ batchId, version: await version(batchId) }],
      boss
    );
    expect(result).toEqual({ batchId, ok: true });
    expect((await approval(batchId)).stage).toBe('APPROVED');
    expect(await statesOf(ctx.prisma, batchId)).toEqual(['QUEUE', 'QUEUE']);
    expect(ctx.temporal.calls.filter((p) => p.type === 'start')).toHaveLength(
      2
    );

    // the publish check lets it through
    for (const root of await rootsOf(ctx.prisma, batchId)) {
      expect(await ctx.gate.isPublishAllowed(orgId, root.id)).toBe(true);
    }

    await ctx.prisma.post.updateMany({
      where: { batchId },
      data: { state: 'PUBLISHED' },
    });
    await ctx.prisma.postApproval.update({
      where: { batchId },
      data: { stage: 'PUBLISHED', version: { increment: 1 } },
    });
    await ctx.approvals.verify(orgId, batchId, await version(batchId), writer);

    const detail = await ctx.approvals.getBatch(orgId, batchId);
    expect(detail.stage).toBe('VERIFIED');
    expect(detail.brief?.topic).toBe('Launch');
    expect(detail.history.map((p) => p.action)).toEqual([
      'CREATED',
      'LINKED_BRIEF',
      'SUBMITTED',
      'REVIEW_APPROVED',
      'FINAL_APPROVED',
      'VERIFIED',
    ]);
    expect(detail.history.every((p) => p.actorName)).toBe(true);
    const done = await approval(batchId);
    expect(done.verifiedById).toBe(writer.id);
    expect(done.verifiedAt).not.toBeNull();
  });

  describe('stale version', () => {
    it.each([
      [
        'submit',
        async (id: string, v: number) =>
          ctx.approvals.submit(orgId, id, v, creator, 'Topic'),
      ],
      [
        'linkBrief',
        async (id: string, v: number) => {
          const brief = await ctx.briefs.create(orgId, writer, { topic: 'x' });
          return ctx.approvals.linkBrief(orgId, id, v, brief.id, creator);
        },
      ],
      [
        'force',
        async (id: string, v: number) =>
          ctx.approvals.force(orgId, id, v, boss, 'Urgent notice for the team'),
      ],
    ])('%s answers 409 with an old version', async (_name, action) => {
      const batchId = await draft();
      const v = await version(batchId);
      await ctx.prisma.postApproval.update({
        where: { batchId },
        data: { version: { increment: 1 } },
      });
      await expect(action(batchId, v)).rejects.toBeInstanceOf(
        ConflictException
      );
    });

    it('reviewApprove, reject, verify and markProblem answer 409 with an old version', async () => {
      const inReview = await submitted();
      const old = (await version(inReview)) - 1;
      await expect(
        ctx.approvals.reviewApprove(orgId, inReview, old, reviewer)
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        ctx.approvals.reject(orgId, inReview, old, reviewer, 'Wrong image')
      ).rejects.toBeInstanceOf(ConflictException);

      const done = await published();
      const stale = (await version(done)) - 1;
      await expect(
        ctx.approvals.verify(orgId, done, stale, writer)
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        ctx.approvals.markProblem(orgId, done, stale, writer, 'Wrong link')
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('finalApprove reports the conflict for that batch only', async () => {
      const batchId = await reviewed();
      const [result] = await ctx.approvals.finalApprove(
        orgId,
        [{ batchId, version: (await version(batchId)) - 1 }],
        boss
      );
      expect(result.ok).toBe(false);
      expect((await approval(batchId)).stage).toBe('AWAITING_FINAL');
    });

    it('cancels the quick brief when submit loses the race', async () => {
      const batchId = await draft();
      await expect(
        ctx.approvals.submit(
          orgId,
          batchId,
          (await version(batchId)) + 5,
          creator,
          'Topic'
        )
      ).rejects.toBeInstanceOf(ConflictException);
      const brief = await ctx.prisma.contentBrief.findFirstOrThrow({});
      expect(brief.status).toBe('CANCELLED');
      expect(brief.deletedAt).not.toBeNull();
    });
  });

  describe('submit', () => {
    it('needs a topic when the batch has no brief', async () => {
      const batchId = await draft();
      await expect(
        ctx.approvals.submit(orgId, batchId, await version(batchId), creator)
      ).rejects.toThrow('Falta el tema');
    });

    it('creates a quick brief from quickTopic and records it', async () => {
      const batchId = await submitted();
      const brief = await ctx.prisma.contentBrief.findFirstOrThrow({});
      expect(brief).toMatchObject({
        quickBrief: true,
        topic: 'Topic',
        createdById: creator.id,
      });
      expect((await approval(batchId)).briefId).toBe(brief.id);
      const events = await eventsOf(ctx.prisma, (await approval(batchId)).id);
      expect(events).toEqual(['CREATED', 'LINKED_BRIEF', 'SUBMITTED']);
      const sent = await ctx.prisma.postApprovalEvent.findFirstOrThrow({
        where: { action: 'SUBMITTED' },
      });
      expect(Object.keys(sent.fingerprints as object)).toHaveLength(2);
      expect(Object.keys(sent.snapshot as object)).toHaveLength(2);
      // the reviewers get the notice
      expect(
        ctx.notifications.sent.some(
          (p) => p.subject === 'Post para revisar: Topic'
        )
      ).toBe(true);
    });

    it.each([
      [{ ...VALID, emptyContent: true }, 'at least one character'],
      [
        { ...VALID, valid: false, settingsError: 'Bad settings' },
        'Bad settings',
      ],
      [{ ...VALID, valid: false }, 'Please fix your settings'],
      [{ ...VALID, errors: 'Image too big' }, 'Image too big'],
      [
        { ...VALID, tooLong: true, maximumCharacters: 10 },
        'The maximum characters is 10',
      ],
    ])(
      'rejects a channel that fails validatePosts (%#)',
      async (result, message) => {
        const batchId = await draft();
        validate.mockResolvedValueOnce([result]);
        await expect(
          ctx.approvals.submit(
            orgId,
            batchId,
            await version(batchId),
            creator,
            'Topic'
          )
        ).rejects.toThrow(message);
        expect((await approval(batchId)).stage).toBe('IN_PRODUCTION');
      }
    );

    it('is only for creators, and only from IN_PRODUCTION or CHANGES_REQUESTED', async () => {
      const batchId = await draft();
      await expect(
        ctx.approvals.submit(
          orgId,
          batchId,
          await version(batchId),
          reviewer,
          'Topic'
        )
      ).rejects.toBeInstanceOf(ForbiddenException);
      await submitted(batchId);
      await expect(
        ctx.approvals.submit(
          orgId,
          batchId,
          await version(batchId),
          creator,
          'Topic'
        )
      ).rejects.toThrow('El post no está en una etapa que permita esta acción');
    });

    it('answers 404 for a batch of another organization', async () => {
      await expect(
        ctx.approvals.submit(orgId, 'missing', 0, creator, 'Topic')
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('reviewApprove', () => {
    it('refuses a batch whose content changed after the submit', async () => {
      const batchId = await submitted();
      const [root] = await rootsOf(ctx.prisma, batchId);
      await ctx.prisma.post.update({
        where: { id: root.id },
        data: { content: 'sneaky' },
      });
      await expect(
        ctx.approvals.reviewApprove(
          orgId,
          batchId,
          await version(batchId),
          reviewer
        )
      ).rejects.toThrow('El contenido cambió');
    });

    it('refuses a batch that gained a channel after the submit', async () => {
      const batchId = await submitted();
      await ctx.prisma.postApprovalEvent.updateMany({
        where: { action: 'SUBMITTED' },
        data: { fingerprints: {} },
      });
      await expect(
        ctx.approvals.reviewApprove(
          orgId,
          batchId,
          await version(batchId),
          reviewer
        )
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('notifies the monthly reviewers', async () => {
      await reviewed();
      expect(
        ctx.notifications.sent.some((p) =>
          p.subject.startsWith('Post para aprobación final')
        )
      ).toBe(true);
    });
  });

  describe('reject', () => {
    it('needs a comment', async () => {
      const batchId = await submitted();
      await expect(
        ctx.approvals.reject(
          orgId,
          batchId,
          await version(batchId),
          reviewer,
          ' '
        )
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('CUJ 2: stores the comment, goes back to the submitter, and can be sent again', async () => {
      const batchId = await submitted();
      await ctx.approvals.reject(
        orgId,
        batchId,
        await version(batchId),
        reviewer,
        'La imagen no es la de la campaña'
      );
      const current = await approval(batchId);
      expect(current.stage).toBe('CHANGES_REQUESTED');
      const event = await ctx.prisma.postApprovalEvent.findFirstOrThrow({
        where: { action: 'REJECTED' },
      });
      expect(event.reason).toBe('La imagen no es la de la campaña');
      const comment = await ctx.prisma.comments.findUniqueOrThrow({
        where: { id: event.commentId! },
      });
      expect(comment.content).toBe('La imagen no es la de la campaña');
      expect(comment.userId).toBe(reviewer.id);
      const creatorEmail = (
        await ctx.prisma.user.findUniqueOrThrow({ where: { id: creator.id } })
      ).email;
      expect(ctx.notifications.sent.some((p) => p.to === creatorEmail)).toBe(
        true
      );
      expect(await statesOf(ctx.prisma, batchId)).toEqual(['DRAFT', 'DRAFT']);

      await ctx.approvals.submit(
        orgId,
        batchId,
        await version(batchId),
        creator
      );
      expect((await approval(batchId)).stage).toBe('IN_REVIEW');
    });

    it('works from AWAITING_FINAL for the monthly reviewer, and tells the creators when nobody submitted', async () => {
      const batchId = await reviewed();
      await ctx.prisma.postApprovalEvent.deleteMany({
        where: { action: 'SUBMITTED' },
      });
      ctx.notifications.reset();
      await ctx.approvals.reject(
        orgId,
        batchId,
        await version(batchId),
        boss,
        'Not this week'
      );
      expect((await approval(batchId)).stage).toBe('CHANGES_REQUESTED');
      const creatorEmail = (
        await ctx.prisma.user.findUniqueOrThrow({ where: { id: creator.id } })
      ).email;
      expect(ctx.notifications.sent.some((p) => p.to === creatorEmail)).toBe(
        true
      );
    });
  });

  describe('finalApprove', () => {
    it('approves 2 of 3 batches when one is not ready', async () => {
      const first = await reviewed();
      const second = await reviewed();
      const notReady = await submitted();
      const results = await ctx.approvals.finalApprove(
        orgId,
        await Promise.all(
          [first, notReady, second].map(async (batchId) => ({
            batchId,
            version: await version(batchId),
          }))
        ),
        boss
      );
      expect(results.map((p) => p.ok)).toEqual([true, false, true]);
      expect((await approval(notReady)).stage).toBe('IN_REVIEW');
    });

    it('rolls back when scheduling the second channel fails', async () => {
      const batchId = await reviewed();
      const original = ctx.posts.changePostStatus.bind(ctx.posts);
      let call = 0;
      const spy = jest
        .spyOn(ctx.posts, 'changePostStatus')
        .mockImplementation(async (org, id, status) => {
          if (status === 'schedule' && ++call === 2) {
            throw new Error('provider down');
          }
          return original(org, id, status);
        });

      const [result] = await ctx.approvals.finalApprove(
        orgId,
        [{ batchId, version: await version(batchId) }],
        boss
      );
      spy.mockRestore();

      expect(result).toMatchObject({ ok: false, error: 'provider down' });
      const current = await approval(batchId);
      expect(current.stage).toBe('AWAITING_FINAL');
      expect(current.approvedFingerprints).toBeNull();
      expect(await statesOf(ctx.prisma, batchId)).toEqual(['DRAFT', 'DRAFT']);
      const blocked = await ctx.prisma.postApprovalEvent.findFirstOrThrow({
        where: { action: 'BLOCKED' },
      });
      expect(blocked.reason).toBe('final_approval_failed');
    });

    it('refuses a past date (CUJ 4)', async () => {
      const batchId = await reviewed();
      await ctx.prisma.post.updateMany({
        where: { batchId },
        data: { publishDate: new Date(pastDate()) },
      });
      const [result] = await ctx.approvals.finalApprove(
        orgId,
        [{ batchId, version: await version(batchId) }],
        boss
      );
      expect(result).toMatchObject({
        ok: false,
        error: 'La fecha de publicación ya pasó',
      });
    });

    it('refuses the reviewer and the author', async () => {
      const batchId = await reviewed();
      const both = {
        id: await createUser(ctx.prisma, orgId, [
          'MONTHLY_REVIEWER',
          'REVIEWER',
        ]),
      };
      await ctx.prisma.postApprovalEvent.updateMany({
        where: { action: 'REVIEW_APPROVED' },
        data: { actorUserId: both.id },
      });
      const [result] = await ctx.approvals.finalApprove(
        orgId,
        [{ batchId, version: await version(batchId) }],
        both
      );
      expect(result.ok).toBe(false);
    });

    it('skips channels that are already published', async () => {
      const batchId = await reviewed();
      const [first] = await rootsOf(ctx.prisma, batchId);
      await ctx.prisma.post.update({
        where: { id: first.id },
        data: { state: 'PUBLISHED' },
      });
      const [result] = await ctx.approvals.finalApprove(
        orgId,
        [{ batchId, version: await version(batchId) }],
        boss
      );
      expect(result.ok).toBe(true);
      const roots = await rootsOf(ctx.prisma, batchId);
      expect(roots.find((p) => p.id === first.id)!.state).toBe('PUBLISHED');
      expect(roots.filter((p) => p.state === 'QUEUE')).toHaveLength(1);
    });
  });

  describe('force', () => {
    it('needs a reason of 10 characters', async () => {
      const batchId = await draft();
      await expect(
        ctx.approvals.force(
          orgId,
          batchId,
          await version(batchId),
          boss,
          'short'
        )
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('CUJ 6: moves a past date to now plus a minute, schedules and tells everyone', async () => {
      const batchId = await draft([channelA], { date: pastDate() });
      await ctx.approvals.force(
        orgId,
        batchId,
        await version(batchId),
        boss,
        'Urgent notice for the team'
      );

      const current = await approval(batchId);
      expect(current).toMatchObject({ stage: 'APPROVED', forced: true });
      const [root] = await rootsOf(ctx.prisma, batchId);
      expect(root.state).toBe('QUEUE');
      expect(root.publishDate.getTime()).toBeGreaterThan(Date.now());
      expect(root.publishDate.getTime()).toBeLessThan(Date.now() + 2 * 60000);
      const forced = await ctx.prisma.postApprovalEvent.findFirstOrThrow({
        where: { action: 'FORCED' },
      });
      expect(forced.reason).toBe('Urgent notice for the team');
      expect(await ctx.gate.isPublishAllowed(orgId, root.id)).toBe(true);
      const adminEmail = (
        await ctx.prisma.user.findUniqueOrThrow({ where: { id: adminId } })
      ).email;
      expect(ctx.notifications.sent.some((p) => p.to === adminEmail)).toBe(
        true
      );
      expect(ctx.notifications.sent.some((p) => p.type === 'info')).toBe(true);
    });

    it('can not be done by the author', async () => {
      const both = {
        id: await createUser(ctx.prisma, orgId, [
          'MONTHLY_REVIEWER',
          'CREATOR',
        ]),
      };
      const [saved] = await ctx.posts.createPost(
        orgId,
        postBody('draft', [{ integrationId: channelA }]),
        'WEB',
        false,
        both.id
      );
      const post = await ctx.prisma.post.findUniqueOrThrow({
        where: { id: saved.postId },
      });
      await expect(
        ctx.approvals.force(
          orgId,
          post.batchId!,
          await version(post.batchId!),
          both,
          'Urgent notice for the team'
        )
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('rolls back to the original stage when scheduling fails', async () => {
      const batchId = await submitted();
      const spy = jest
        .spyOn(ctx.posts, 'changePostStatus')
        .mockRejectedValueOnce(new Error('provider down'));
      await expect(
        ctx.approvals.force(
          orgId,
          batchId,
          await version(batchId),
          boss,
          'Urgent notice for the team'
        )
      ).rejects.toThrow('provider down');
      spy.mockRestore();
      expect(await approval(batchId)).toMatchObject({
        stage: 'IN_REVIEW',
        forced: false,
      });
    });

    it('is not available once approved', async () => {
      const batchId = await approved();
      await expect(
        ctx.approvals.force(
          orgId,
          batchId,
          await version(batchId),
          boss,
          'Urgent notice for the team'
        )
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('verify and markProblem', () => {
    it('verify needs PUBLISHED and the writer', async () => {
      const batchId = await approved();
      await expect(
        ctx.approvals.verify(orgId, batchId, await version(batchId), writer)
      ).rejects.toBeInstanceOf(BadRequestException);
      const done = await published();
      await expect(
        ctx.approvals.verify(orgId, done, await version(done), creator)
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('markProblem needs a comment and creates a correction brief', async () => {
      const batchId = await published();
      await expect(
        ctx.approvals.markProblem(
          orgId,
          batchId,
          await version(batchId),
          writer,
          ''
        )
      ).rejects.toBeInstanceOf(BadRequestException);

      await ctx.approvals.markProblem(
        orgId,
        batchId,
        await version(batchId),
        writer,
        'The link is broken'
      );
      const current = await approval(batchId);
      expect(current.stage).toBe('VERIFICATION_PROBLEM');
      const correction = await ctx.prisma.contentBrief.findFirstOrThrow({
        where: { correctionOfApprovalId: current.id },
      });
      expect(correction.topic).toBe('Corrección: Topic');
      const event = await ctx.prisma.postApprovalEvent.findFirstOrThrow({
        where: { action: 'VERIFICATION_PROBLEM' },
      });
      expect(event.commentId).not.toBeNull();
      expect(event.reason).toBe('The link is broken');
    });
  });

  describe('linkBrief', () => {
    it('only from IN_PRODUCTION or CHANGES_REQUESTED', async () => {
      const brief = await ctx.briefs.create(orgId, writer, { topic: 'x' });
      const batchId = await submitted();
      await expect(
        ctx.approvals.linkBrief(
          orgId,
          batchId,
          await version(batchId),
          brief.id,
          writer
        )
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a closed or missing brief', async () => {
      const brief = await ctx.briefs.create(orgId, writer, { topic: 'x' });
      await ctx.briefs.cancel(orgId, brief.id, writer);
      const batchId = await draft();
      await expect(
        ctx.approvals.linkBrief(
          orgId,
          batchId,
          await version(batchId),
          brief.id,
          writer
        )
      ).rejects.toThrow('Este tema ya está cerrado');
      await expect(
        ctx.approvals.linkBrief(
          orgId,
          batchId,
          await version(batchId),
          'missing',
          writer
        )
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('links one brief to several batches', async () => {
      const brief = await ctx.briefs.create(orgId, writer, { topic: 'Series' });
      for (const batchId of [await draft(), await draft()]) {
        await ctx.approvals.linkBrief(
          orgId,
          batchId,
          await version(batchId),
          brief.id,
          writer
        );
      }
      expect((await ctx.briefs.get(orgId, brief.id)).approvals).toHaveLength(2);
    });
  });

  describe('roles', () => {
    it('setRoles needs an admin, answers 404 for a user of another organization and records the change', async () => {
      const other = await createOrg(ctx.prisma);
      await expect(
        ctx.approvals.setRoles(orgId, other.adminId, ['REVIEWER'], {
          id: adminId,
        })
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        ctx.approvals.setRoles(orgId, creator.id, ['REVIEWER'], creator)
      ).rejects.toBeInstanceOf(ForbiddenException);

      const rows = await ctx.approvals.setRoles(
        orgId,
        creator.id,
        ['CREATOR', 'MONTHLY_REVIEWER'],
        { id: adminId }
      );
      expect(rows.find((p) => p.userId === creator.id)!.roles.sort()).toEqual([
        'CREATOR',
        'MONTHLY_REVIEWER',
      ]);
      // every member, with roles or not
      expect(rows.find((p) => p.userId === adminId)!.roles).toEqual([]);
      const event = await ctx.prisma.postApprovalEvent.findFirstOrThrow({
        where: { action: 'ROLE_ASSIGNED' },
      });
      expect(event).toMatchObject({
        actorUserId: adminId,
        targetUserId: creator.id,
        targetRole: 'MONTHLY_REVIEWER',
      });
    });
  });

  describe('reads', () => {
    it('getInbox shows each role its stages', async () => {
      const inProduction = await draft();
      const inReview = await submitted();
      const awaiting = await reviewed();

      const batchesOf = async (actor: { id: string }) =>
        (await ctx.approvals.getInbox(orgId, actor))
          .map((p) => p.batchId)
          .sort();

      expect(await batchesOf(creator)).toEqual([inProduction].sort());
      expect(await batchesOf(reviewer)).toEqual([inReview]);
      expect(await batchesOf(boss)).toEqual([awaiting]);
      expect(await batchesOf({ id: adminId })).toEqual([]);
    });

    it('marks an expired batch', async () => {
      await draft([channelA], { date: pastDate() });
      const [item] = await ctx.approvals.getInbox(orgId, creator);
      expect(item.expired).toBe(true);
    });

    it('getPreview leaves the tokens out and answers 404 from another organization', async () => {
      const batchId = await draft();
      const [root] = await rootsOf(ctx.prisma, batchId);
      const preview = await ctx.approvals.getPreview(orgId, root.id);
      expect(JSON.stringify(preview)).not.toContain('token');
      expect(preview[0]).not.toHaveProperty('batchId');
      expect(Object.keys((preview[0] as any).integration).sort()).toEqual(
        ['id', 'name', 'picture', 'profile', 'providerIdentifier'].sort()
      );

      const other = await createOrg(ctx.prisma);
      await expect(
        ctx.approvals.getPreview(other.orgId, root.id)
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        ctx.approvals.getPreviewComments(other.orgId, root.id)
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(await ctx.approvals.getPreviewComments(orgId, root.id)).toEqual({
        comments: [],
      });
    });

    it('getStages maps posts to their batch stage', async () => {
      const batchId = await submitted();
      const [root] = await rootsOf(ctx.prisma, batchId);
      expect(await ctx.approvals.getStages(orgId, [root.id])).toEqual({
        [root.id]: {
          batchId,
          stage: 'IN_REVIEW',
          version: await version(batchId),
          expired: false,
        },
      });
    });
  });

  describe('edge cases', () => {
    it('refuses a batch without channels', async () => {
      const batchId = await draft();
      await ctx.prisma.post.updateMany({
        where: { batchId },
        data: { deletedAt: new Date() },
      });
      await expect(
        ctx.approvals.submit(
          orgId,
          batchId,
          await version(batchId),
          creator,
          'Topic'
        )
      ).rejects.toThrow('El lote no tiene canales');

      const inReview = await submitted();
      await ctx.prisma.post.updateMany({
        where: { batchId: inReview },
        data: { deletedAt: new Date() },
      });
      await expect(
        ctx.approvals.reject(
          orgId,
          inReview,
          await version(inReview),
          reviewer,
          'No channels'
        )
      ).rejects.toThrow('El lote no tiene canales');
    });

    it('validates rows with odd stored settings and images', async () => {
      const batchId = await draft([channelA]);
      await ctx.prisma.post.updateMany({
        where: { batchId },
        data: { settings: null, image: 'not json' },
      });
      await ctx.approvals.submit(
        orgId,
        batchId,
        await version(batchId),
        creator,
        'Topic'
      );
      expect(validate.mock.calls[0][1][0].value[0].image).toEqual([]);
      expect(validate.mock.calls[0][1][0].settings.__type).toBe('facebook');
    });

    it('refuses to review a batch without reference fingerprints', async () => {
      const batchId = await submitted();
      await ctx.prisma.postApprovalEvent.deleteMany({});
      await expect(
        ctx.approvals.reviewApprove(
          orgId,
          batchId,
          await version(batchId),
          reviewer
        )
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('names a correction without topic, an actor without name and a system event', async () => {
      const batchId = await published();
      await ctx.prisma.postApproval.update({
        where: { batchId },
        data: { briefId: null },
      });
      await ctx.prisma.user.update({
        where: { id: writer.id },
        data: { name: null, lastName: null },
      });
      await ctx.prisma.postApprovalEvent.create({
        data: {
          organizationId: orgId,
          approvalId: (await approval(batchId)).id,
          actorRole: 'SYSTEM',
          action: 'RECONCILED',
        },
      });
      await ctx.approvals.markProblem(
        orgId,
        batchId,
        await version(batchId),
        writer,
        'Broken link'
      );
      expect(
        (
          await ctx.prisma.contentBrief.findFirstOrThrow({
            where: { correctionOfApprovalId: { not: null } },
          })
        ).topic
      ).toBe('Corrección: (sin tema)');

      const history = (await ctx.approvals.getBatch(orgId, batchId)).history;
      const email = (
        await ctx.prisma.user.findUniqueOrThrow({ where: { id: writer.id } })
      ).email;
      expect(
        history.find((p) => p.action === 'VERIFICATION_PROBLEM')!.actorName
      ).toBe(email);
      expect(
        history.find((p) => p.action === 'RECONCILED')!.actorName
      ).toBeNull();
    });

    it('shows the comments of a thread in the preview without integration', async () => {
      const batchId = await draft([channelA]);
      const [root] = await rootsOf(ctx.prisma, batchId);
      await ctx.prisma.post.create({
        data: {
          organizationId: orgId,
          integrationId: channelA,
          content: 'first comment',
          group: root.group,
          batchId,
          parentPostId: root.id,
          publishDate: root.publishDate,
        },
      });
      const preview = await ctx.approvals.getPreview(orgId, root.id);
      expect(preview).toHaveLength(2);
      expect(preview[1]).not.toHaveProperty('integration');
    });

    it('logs a rollback that fails too', async () => {
      const batchId = await reviewed();
      const original = ctx.posts.changePostStatus.bind(ctx.posts);
      let call = 0;
      const spy = jest
        .spyOn(ctx.posts, 'changePostStatus')
        .mockImplementation(async (org, id, status) => {
          if (status === 'draft') {
            throw new Error('rollback failed');
          }
          if (++call === 2) {
            throw new Error('provider down');
          }
          return original(org, id, status);
        });
      const [result] = await ctx.approvals.finalApprove(
        orgId,
        [{ batchId, version: await version(batchId) }],
        boss
      );
      spy.mockRestore();
      expect(result.ok).toBe(false);
      expect((await approval(batchId)).stage).toBe('AWAITING_FINAL');
    });
  });

  describe('review findings', () => {
    it('whoever approved the review can not force the batch', async () => {
      const both = {
        id: await createUser(ctx.prisma, orgId, [
          'REVIEWER',
          'MONTHLY_REVIEWER',
        ]),
      };
      const batchId = await submitted();
      await ctx.approvals.reviewApprove(
        orgId,
        batchId,
        await version(batchId),
        both
      );
      await expect(
        ctx.approvals.force(
          orgId,
          batchId,
          await version(batchId),
          both,
          'Urgent notice for the team'
        )
      ).rejects.toThrow(
        'La aprobación final debe darla alguien distinto de quien revisó'
      );
    });

    it('the final approval compares with what was reviewed, not with a later edit', async () => {
      const batchId = await reviewed();
      const [root] = await rootsOf(ctx.prisma, batchId);
      await ctx.prisma.post.update({
        where: { id: root.id },
        data: { content: 'not reviewed' },
      });
      // an edit recorded whose reset did not happen
      await ctx.prisma.postApprovalEvent.create({
        data: {
          organizationId: orgId,
          approvalId: (await approval(batchId)).id,
          actorRole: 'MEMBER',
          action: 'CONTENT_EDITED',
          fingerprints: await ctx.gate.fingerprintsFromDb(orgId, batchId),
        },
      });
      const [result] = await ctx.approvals.finalApprove(
        orgId,
        [{ batchId, version: await version(batchId) }],
        boss
      );
      expect(result.ok).toBe(false);
      expect(result.error).toContain('El contenido cambió');
    });

    it('rolls back a force whose date move fails', async () => {
      const batchId = await draft([channelA], { date: pastDate() });
      const spy = jest
        .spyOn(ctx.posts, 'changeDate')
        .mockRejectedValueOnce(new Error('date failed'));
      await expect(
        ctx.approvals.force(
          orgId,
          batchId,
          await version(batchId),
          boss,
          'Urgent notice for the team'
        )
      ).rejects.toThrow('date failed');
      spy.mockRestore();
      expect(await approval(batchId)).toMatchObject({
        stage: 'IN_PRODUCTION',
        forced: false,
        approvedFingerprints: null,
      });
      expect(await statesOf(ctx.prisma, batchId)).toEqual(['DRAFT']);
    });

    it('logs a rollback that loses the race', async () => {
      const batchId = await reviewed();
      const transition = jest.spyOn(ctx.repository, 'transition');
      const status = jest
        .spyOn(ctx.posts, 'changePostStatus')
        .mockImplementationOnce(async () => {
          transition.mockResolvedValueOnce(false);
          throw new Error('provider down');
        });
      const [result] = await ctx.approvals.finalApprove(
        orgId,
        [{ batchId, version: await version(batchId) }],
        boss
      );
      status.mockRestore();
      transition.mockRestore();
      expect(result.ok).toBe(false);
    });

    it('leaves no comment behind when the version is old', async () => {
      const batchId = await submitted();
      await expect(
        ctx.approvals.reject(
          orgId,
          batchId,
          (await version(batchId)) - 1,
          reviewer,
          'Wrong image'
        )
      ).rejects.toBeInstanceOf(ConflictException);
      expect(await ctx.prisma.comments.count()).toBe(0);
    });

    it('answers 400 for a channel whose integration is gone', async () => {
      const batchId = await draft([channelA]);
      jest
        .spyOn(ctx.posts, 'getPostsRecursively')
        .mockResolvedValueOnce([{ id: 'x' } as any]);
      await expect(
        ctx.approvals.submit(
          orgId,
          batchId,
          await version(batchId),
          creator,
          'Topic'
        )
      ).rejects.toThrow('Uno de los canales ya no existe');
    });

    it('does not let the dashboard comment on a post of another organization', async () => {
      const batchId = await draft([channelA]);
      const [root] = await rootsOf(ctx.prisma, batchId);
      const other = await createOrg(ctx.prisma);
      await expect(
        ctx.posts.createPublicComment(
          root.id,
          { content: 'hi' } as any,
          other.adminId,
          '',
          other.orgId
        )
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('an edit after approval still resets the batch (CUJ 3)', async () => {
    const batchId = await approved();
    const channels = await editChannels(ctx.prisma, batchId, (id, channel) =>
      id === channelA
        ? {
            ...channel,
            values: [{ ...channel.values![0], content: 'one word fixed' }],
          }
        : channel
    );
    await ctx.posts.createPost(
      orgId,
      postBody('schedule', channels),
      'WEB',
      false,
      creator.id
    );
    expect((await approval(batchId)).stage).toBe('IN_REVIEW');
    expect(await statesOf(ctx.prisma, batchId)).toEqual(['DRAFT', 'DRAFT']);
  });
});
