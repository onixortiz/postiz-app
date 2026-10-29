import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  approveBatch,
  ApprovalsTestContext,
  cleanDatabase,
  createApprovalsTestModule,
  createIntegration,
  createOrg,
  createUser,
  editChannels,
  eventsOf,
  futureDate,
  pastDate,
  postBody,
  rootsOf,
  setStage,
  statesOf,
} from './test/approvals.test.helpers';

describe('ApprovalGateService', () => {
  let ctx: ApprovalsTestContext;
  let orgId: string;
  let creatorId: string;
  let channelA: string;
  let channelB: string;
  let channelC: string;

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
    channelA = await createIntegration(ctx.prisma, orgId);
    channelB = await createIntegration(ctx.prisma, orgId);
    channelC = await createIntegration(ctx.prisma, orgId);
  });

  const save = async (
    type: 'draft' | 'schedule' | 'now' | 'update',
    channels: Parameters<typeof postBody>[1],
    extra: Parameters<typeof postBody>[2] = {}
  ) => {
    const list = await ctx.posts.createPost(
      orgId,
      postBody(type, channels, extra),
      'WEB',
      false,
      creatorId
    );
    const root = await ctx.prisma.post.findUniqueOrThrow({
      where: { id: list[0].postId },
    });
    return { list, batchId: root.batchId! };
  };

  const approvalOf = (batchId: string) =>
    ctx.prisma.postApproval.findUniqueOrThrow({ where: { batchId } });

  const approvedBatch = async (channels = [channelA, channelB]) => {
    const { batchId } = await save(
      'draft',
      channels.map((integrationId) => ({ integrationId }))
    );
    await approveBatch(ctx, orgId, batchId);
    return batchId;
  };

  describe('fingerprintsFromDb', () => {
    let batchId: string;
    let rootId: string;
    let mediaId: string;

    const hash = async () =>
      (await ctx.gate.fingerprintsFromDb(orgId, batchId))[channelA];

    const image = (overrides: Record<string, any> = {}) =>
      JSON.stringify([
        {
          id: mediaId,
          path: '/uploads/library.png',
          alt: 'alt text',
          thumbnail: '/uploads/thumb.png',
          ...overrides,
        },
      ]);

    beforeEach(async () => {
      mediaId = (
        await ctx.prisma.media.create({
          data: {
            organizationId: orgId,
            name: 'library.png',
            path: '/uploads/library.png',
          },
        })
      ).id;
      ({ batchId } = await save('draft', [
        {
          integrationId: channelA,
          settings: { title: 'x' },
          values: [{ content: 'Hello' }],
        },
      ]));
      rootId = (await rootsOf(ctx.prisma, batchId))[0].id;
      await ctx.prisma.post.update({
        where: { id: rootId },
        data: { image: image() },
      });
    });

    const update = (data: Record<string, any>) =>
      ctx.prisma.post.update({ where: { id: rootId }, data });

    it.each([
      ['the text', { content: 'Bye' }],
      ['a file', { image: JSON.stringify([]) }],
      ['the alt text', { image: '' }],
      ['the thumbnail', { image: '' }],
      ['the delay', { delay: 5 }],
      [
        'the settings',
        { settings: JSON.stringify({ __type: 'facebook', title: 'y' }) },
      ],
    ])('changes when %s changes', async (what, data) => {
      const before = await hash();
      if (what === 'the alt text') {
        data = { image: image({ alt: 'other' }) };
      }
      if (what === 'the thumbnail') {
        data = { image: image({ thumbnail: '/uploads/other.png' }) };
      }
      await update(data);
      expect(await hash()).not.toBe(before);
    });

    it('does not change with the date, release, tags, library path or media row', async () => {
      const before = await hash();
      await update({
        publishDate: new Date(futureDate(200)),
        releaseURL: 'https://example.com/1',
        image: image({ path: '/uploads/renamed.png', url: 'x', name: 'n' }),
      });
      const tag = await ctx.prisma.tags.create({
        data: { name: 't', color: 'red', orgId },
      });
      await ctx.prisma.tagsPosts.create({
        data: { postId: rootId, tagId: tag.id },
      });
      await ctx.prisma.media.update({
        where: { id: mediaId },
        data: { alt: 'changed in the library', deletedAt: new Date() },
      });
      expect(await hash()).toBe(before);
    });

    it('ignores the UPLOAD_DIRECTORY prefix of a local file and tells other paths apart', async () => {
      await update({ image: JSON.stringify([{ path: '/uploads/local.png' }]) });
      const withPrefix = await hash();
      await update({ image: JSON.stringify([{ path: '/local.png' }]) });
      expect(await hash()).toBe(withPrefix);
      await update({ image: JSON.stringify([{ path: '/other.png' }]) });
      expect(await hash()).not.toBe(withPrefix);
    });

    it('drops media that does not pass isAllowedMediaPath', async () => {
      await update({ image: JSON.stringify([]) });
      const empty = await hash();
      await update({ image: JSON.stringify([{ path: '../../etc/passwd' }]) });
      expect(await hash()).toBe(empty);
    });

    it('treats empty settings keys and empty alt as absent', async () => {
      await update({
        settings: JSON.stringify({ __type: 'facebook', title: 'x' }),
        image: image({ alt: undefined }),
      });
      const before = await hash();
      await update({
        settings: JSON.stringify({
          __type: 'other',
          title: 'x',
          empty: '',
          none: null,
          list: [],
          nested: { a: '' },
        }),
        image: image({ alt: '' }),
      });
      const after = await hash();
      // nested ends as an empty object, which is kept
      expect(after).not.toBe(before);
      await update({
        settings: JSON.stringify({
          title: 'x',
          empty: '',
          none: null,
          list: [],
        }),
      });
      expect(await hash()).toBe(before);
    });

    it('includes the comments of the thread', async () => {
      const before = await hash();
      const root = await ctx.prisma.post.findUniqueOrThrow({
        where: { id: rootId },
      });
      await ctx.prisma.post.create({
        data: {
          organizationId: orgId,
          integrationId: channelA,
          content: 'a comment',
          group: root.group,
          batchId,
          parentPostId: rootId,
          publishDate: root.publishDate,
        },
      });
      expect(await hash()).not.toBe(before);
    });

    it('limits the result to the asked channels', async () => {
      expect(
        Object.keys(
          await ctx.gate.fingerprintsFromDb(orgId, batchId, [channelB])
        )
      ).toEqual([]);
    });
  });

  describe('isPublishAllowed and evaluatePublish', () => {
    it('allows everything with APPROVALS_ENABLED=false', async () => {
      process.env.APPROVALS_ENABLED = 'false';
      expect(await ctx.gate.isPublishAllowed(orgId, 'missing')).toBe(true);
      expect(await ctx.gate.evaluatePublish(orgId, 'missing')).toEqual({
        allowed: true,
      });
    });

    it('denies a post without PostApproval', async () => {
      const post = await ctx.prisma.post.create({
        data: {
          organizationId: orgId,
          integrationId: channelA,
          content: 'x',
          group: 'g',
          batchId: 'no-approval',
          publishDate: new Date(futureDate()),
          state: 'QUEUE',
        },
      });
      expect(await ctx.gate.evaluatePublish(orgId, post.id)).toEqual({
        allowed: false,
        reason: 'no_approval',
      });
      expect(await ctx.gate.isPublishAllowed(orgId, post.id)).toBe(false);
      const event = await ctx.prisma.postApprovalEvent.findFirstOrThrow({
        where: { action: 'BLOCKED_AT_PUBLISH' },
      });
      expect(event.approvalId).toBeNull();
    });

    it('denies a post without batch', async () => {
      const post = await ctx.prisma.post.create({
        data: {
          organizationId: orgId,
          integrationId: channelA,
          content: 'x',
          group: 'g',
          publishDate: new Date(futureDate()),
          state: 'QUEUE',
        },
      });
      expect(await ctx.gate.evaluatePublish(orgId, post.id)).toEqual({
        allowed: false,
        reason: 'no_approval',
      });
    });

    it.each([
      'IN_PRODUCTION',
      'IN_REVIEW',
      'AWAITING_FINAL',
      'CHANGES_REQUESTED',
    ] as const)('denies a batch in %s', async (stage) => {
      const { batchId, list } = await save('draft', [
        { integrationId: channelA },
      ]);
      await setStage(ctx.prisma, batchId, stage);
      await ctx.prisma.post.update({
        where: { id: list[0].postId },
        data: { state: 'QUEUE' },
      });
      expect(await ctx.gate.isPublishAllowed(orgId, list[0].postId)).toBe(
        false
      );
      const event = await ctx.prisma.postApprovalEvent.findFirstOrThrow({
        where: { action: 'BLOCKED_AT_PUBLISH' },
      });
      expect(event.reason).toBe('stage');
    });

    it('denies a post that is not in QUEUE', async () => {
      const batchId = await approvedBatch([channelA]);
      const [root] = await rootsOf(ctx.prisma, batchId);
      await ctx.prisma.post.update({
        where: { id: root.id },
        data: { state: 'DRAFT' },
      });
      expect(await ctx.gate.isPublishAllowed(orgId, root.id)).toBe(false);
      const event = await ctx.prisma.postApprovalEvent.findFirstOrThrow({
        where: { action: 'BLOCKED_AT_PUBLISH' },
      });
      expect(event.reason).toBe('not_queued');
    });

    it('denies a changed fingerprint and records fingerprint_drift', async () => {
      const batchId = await approvedBatch([channelA]);
      const [root] = await rootsOf(ctx.prisma, batchId);
      await ctx.prisma.post.update({
        where: { id: root.id },
        data: { content: 'changed behind the gate' },
      });
      expect(await ctx.gate.isPublishAllowed(orgId, root.id)).toBe(false);
      const event = await ctx.prisma.postApprovalEvent.findFirstOrThrow({
        where: { action: 'BLOCKED_AT_PUBLISH' },
      });
      expect(event.reason).toBe('fingerprint_drift');
    });

    it('denies a channel missing from the approved fingerprints', async () => {
      const batchId = await approvedBatch([channelA]);
      await ctx.prisma.postApproval.update({
        where: { batchId },
        data: { approvedFingerprints: {} },
      });
      const [root] = await rootsOf(ctx.prisma, batchId);
      expect(await ctx.gate.evaluatePublish(orgId, root.id)).toEqual({
        allowed: false,
        reason: 'fingerprint_drift',
      });
    });

    it('denies a published post', async () => {
      const batchId = await approvedBatch([channelA]);
      const [root] = await rootsOf(ctx.prisma, batchId);
      await ctx.prisma.post.update({
        where: { id: root.id },
        data: { state: 'PUBLISHED' },
      });
      expect(await ctx.gate.evaluatePublish(orgId, root.id)).toEqual({
        allowed: false,
        reason: 'published',
      });
    });

    it('allows an approved batch with the same fingerprint', async () => {
      const batchId = await approvedBatch([channelA]);
      const [root] = await rootsOf(ctx.prisma, batchId);
      expect(await ctx.gate.isPublishAllowed(orgId, root.id)).toBe(true);
    });

    it('evaluatePublish writes no events', async () => {
      const { list } = await save('draft', [{ integrationId: channelA }]);
      const before = await ctx.prisma.postApprovalEvent.count();
      await ctx.gate.evaluatePublish(orgId, list[0].postId);
      expect(await ctx.prisma.postApprovalEvent.count()).toBe(before);
    });
  });

  describe('typeForSave', () => {
    it('saves schedule and now as draft and keeps update and draft', async () => {
      for (const [type, expected] of [
        ['schedule', 'draft'],
        ['now', 'draft'],
        ['update', 'update'],
        ['draft', 'draft'],
      ] as const) {
        const decision = await ctx.gate.typeForSave(
          orgId,
          postBody(type, [{ integrationId: channelA }], { inter: 7 })
        );
        expect(decision.typeByIntegration[channelA]).toBe(expected);
        expect(decision.inter).toBeUndefined();
      }
    });

    it('saves a published channel as update and rejects republish on it', async () => {
      const { list } = await save('draft', [{ integrationId: channelA }]);
      await ctx.prisma.post.update({
        where: { id: list[0].postId },
        data: { state: 'PUBLISHED' },
      });
      const body = postBody('schedule', [
        { integrationId: channelA, ids: [list[0].postId] },
      ]);
      expect(
        (await ctx.gate.typeForSave(orgId, body)).typeByIntegration[channelA]
      ).toBe('update');
      await expect(
        ctx.gate.typeForSave(orgId, { ...body, republish: true })
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ignores republish on a channel that is not published', async () => {
      const { list } = await save('draft', [{ integrationId: channelA }]);
      const body = postBody(
        'schedule',
        [{ integrationId: channelA, ids: [list[0].postId] }],
        { republish: true }
      );
      expect(
        (await ctx.gate.typeForSave(orgId, body)).typeByIntegration[channelA]
      ).toBe('draft');
    });

    it('keeps the requested type and inter with APPROVALS_ENABLED=false', async () => {
      process.env.APPROVALS_ENABLED = 'false';
      const decision = await ctx.gate.typeForSave(
        orgId,
        postBody('schedule', [{ integrationId: channelA }], { inter: 7 })
      );
      expect(decision).toEqual({
        typeByIntegration: { [channelA]: 'schedule' },
        inter: 7,
      });
    });
  });

  describe('afterSave', () => {
    it('creates the PostApproval with CREATED on the first save', async () => {
      const { batchId, list } = await save('schedule', [
        { integrationId: channelA },
        { integrationId: channelB },
      ]);
      const approval = await approvalOf(batchId);
      expect(approval.stage).toBe('IN_PRODUCTION');
      const created = await ctx.prisma.postApprovalEvent.findFirstOrThrow({
        where: { approvalId: approval.id, action: 'CREATED' },
      });
      expect(created.actorUserId).toBe(creatorId);
      expect(created.actorRole).toBe('CREATOR');
      expect(created.surface).toBe('WEB');
      expect(Object.keys(created.fingerprints as object).sort()).toEqual(
        [channelA, channelB].sort()
      );
      expect(await statesOf(ctx.prisma, batchId)).toEqual(['DRAFT', 'DRAFT']);
      expect(list[0].approvalStage).toBe('IN_PRODUCTION');
      // schedule on an unapproved batch is recorded
      expect(await eventsOf(ctx.prisma, approval.id)).toEqual([
        'CREATED',
        'BLOCKED',
      ]);
    });

    it('records past_date when a schedule date already passed', async () => {
      const { batchId } = await save(
        'schedule',
        [{ integrationId: channelA }],
        {
          date: pastDate(),
        }
      );
      const approval = await approvalOf(batchId);
      const blocked = await ctx.prisma.postApprovalEvent.findFirstOrThrow({
        where: { approvalId: approval.id, action: 'BLOCKED' },
      });
      expect(blocked.reason).toBe('past_date');
    });

    it('queues an approved batch saved again without changes, except published channels', async () => {
      const batchId = await approvedBatch([channelA, channelB, channelC]);
      const roots = await rootsOf(ctx.prisma, batchId);
      const published = roots.find((p) => p.integrationId === channelC)!;
      await ctx.prisma.post.update({
        where: { id: published.id },
        data: { state: 'PUBLISHED' },
      });

      const channels = await editChannels(ctx.prisma, batchId);
      const result = await save('schedule', channels);

      const after = await rootsOf(ctx.prisma, batchId);
      expect(after.find((p) => p.integrationId === channelA)!.state).toBe(
        'QUEUE'
      );
      expect(after.find((p) => p.integrationId === channelB)!.state).toBe(
        'QUEUE'
      );
      expect(after.find((p) => p.id === published.id)!.state).toBe('PUBLISHED');
      expect(
        result.list.every((p: any) => p.approvalStage === 'APPROVED')
      ).toBe(true);
    });

    it('resets an approved batch when one channel changes', async () => {
      const batchId = await approvedBatch([channelA, channelB, channelC]);
      const channels = await editChannels(ctx.prisma, batchId, (id, channel) =>
        id === channelA
          ? {
              ...channel,
              values: [{ ...channel.values![0], content: 'new text' }],
            }
          : channel
      );
      await save('schedule', [
        channels.find((p) => p.integrationId === channelA)!,
      ]);

      const approval = await approvalOf(batchId);
      expect(approval.stage).toBe('IN_REVIEW');
      expect(approval.approvedFingerprints).toBeNull();
      const events = await eventsOf(ctx.prisma, approval.id);
      expect(events.slice(-2)).toEqual(['RESET_BY_EDIT', 'BLOCKED']);
      expect(events).toContain('CONTENT_EDITED');
      expect(await statesOf(ctx.prisma, batchId)).toEqual([
        'DRAFT',
        'DRAFT',
        'DRAFT',
      ]);
      // the notice goes to the reviewers
      expect(
        ctx.notifications.sent.some((p) => p.subject.startsWith('Post editado'))
      ).toBe(true);
    });

    it('records CONTENT_EDITED without moving the stage in IN_PRODUCTION', async () => {
      const { batchId } = await save('draft', [{ integrationId: channelA }]);
      const channels = await editChannels(
        ctx.prisma,
        batchId,
        (_id, channel) => ({
          ...channel,
          values: [{ ...channel.values![0], content: 'edited' }],
        })
      );
      await save('update', channels);
      const approval = await approvalOf(batchId);
      expect(approval.stage).toBe('IN_PRODUCTION');
      expect(await eventsOf(ctx.prisma, approval.id)).toEqual([
        'CREATED',
        'CONTENT_EDITED',
      ]);
    });

    it('rereads and retries once when transition loses the race', async () => {
      const batchId = await approvedBatch([channelA]);
      const spy = jest
        .spyOn(ctx.repository, 'transition')
        .mockResolvedValueOnce(false);
      const channels = await editChannels(
        ctx.prisma,
        batchId,
        (_id, channel) => ({
          ...channel,
          values: [{ ...channel.values![0], content: 'edited' }],
        })
      );
      await save('update', channels);
      expect(spy).toHaveBeenCalledTimes(2);
      expect((await approvalOf(batchId)).stage).toBe('IN_REVIEW');
      spy.mockRestore();
    });

    it('logs and gives up when transition loses the race twice', async () => {
      const batchId = await approvedBatch([channelA]);
      const spy = jest
        .spyOn(ctx.repository, 'transition')
        .mockResolvedValue(false);
      const channels = await editChannels(
        ctx.prisma,
        batchId,
        (_id, channel) => ({
          ...channel,
          values: [{ ...channel.values![0], content: 'edited' }],
        })
      );
      await save('schedule', channels);
      expect(spy).toHaveBeenCalledTimes(2);
      expect((await approvalOf(batchId)).stage).toBe('APPROVED');
      // nothing was queued
      expect(await statesOf(ctx.prisma, batchId)).toEqual(['DRAFT']);
      spy.mockRestore();
    });

    it('stops retrying when the batch left the reset stages', async () => {
      const batchId = await approvedBatch([channelA]);
      const spy = jest
        .spyOn(ctx.repository, 'transition')
        .mockImplementationOnce(async () => {
          await ctx.prisma.postApproval.update({
            where: { batchId },
            data: { stage: 'CHANGES_REQUESTED', version: { increment: 1 } },
          });
          return false;
        });
      const channels = await editChannels(
        ctx.prisma,
        batchId,
        (_id, channel) => ({
          ...channel,
          values: [{ ...channel.values![0], content: 'edited' }],
        })
      );
      await save('update', channels);
      expect(spy).toHaveBeenCalledTimes(1);
      expect((await approvalOf(batchId)).stage).toBe('CHANGES_REQUESTED');
      spy.mockRestore();
    });

    it('handles each batch of a mixed body on its own', async () => {
      const first = await save('draft', [{ integrationId: channelA }]);
      const second = await save('draft', [{ integrationId: channelB }]);
      const channels = [
        ...(await editChannels(ctx.prisma, first.batchId, (_id, c) => ({
          ...c,
          values: [{ ...c.values![0], content: 'one' }],
        }))),
        ...(await editChannels(ctx.prisma, second.batchId)),
      ];
      await save('update', channels);
      expect(
        await eventsOf(ctx.prisma, (await approvalOf(first.batchId)).id)
      ).toEqual(['CREATED', 'CONTENT_EDITED']);
      expect(
        await eventsOf(ctx.prisma, (await approvalOf(second.batchId)).id)
      ).toEqual(['CREATED']);
    });

    it('does nothing with APPROVALS_ENABLED=false', async () => {
      process.env.APPROVALS_ENABLED = 'false';
      const result = await ctx.gate.afterSave(
        orgId,
        ['x'],
        'schedule',
        creatorId,
        'WEB'
      );
      expect(result).toEqual({ toQueue: [], toDraft: [], stageByPostId: {} });
      const { batchId } = await save('schedule', [{ integrationId: channelA }]);
      expect(await ctx.prisma.postApproval.count()).toBe(0);
      expect(await statesOf(ctx.prisma, batchId)).toEqual(['QUEUE']);
    });
  });

  describe('beforeChangeDate and afterChangeDate', () => {
    it('turns update into schedule on a queued post and keeps update on a published one', async () => {
      const batchId = await approvedBatch([channelA, channelB]);
      const [queued, published] = await rootsOf(ctx.prisma, batchId);
      await ctx.prisma.post.update({
        where: { id: published.id },
        data: { state: 'PUBLISHED' },
      });

      expect(
        await ctx.gate.beforeChangeDate(
          orgId,
          queued.id,
          futureDate(100),
          'update',
          false
        )
      ).toEqual({ action: 'schedule', toDraft: [] });
      expect(
        await ctx.gate.beforeChangeDate(
          orgId,
          published.id,
          futureDate(100),
          'schedule',
          false
        )
      ).toEqual({ action: 'update', toDraft: [] });
      await expect(
        ctx.gate.beforeChangeDate(
          orgId,
          published.id,
          futureDate(100),
          'schedule',
          true
        )
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('moves a failed post of an unapproved batch to DRAFT instead of scheduling it', async () => {
      const { batchId, list } = await save('draft', [
        { integrationId: channelA },
      ]);
      await setStage(ctx.prisma, batchId, 'IN_REVIEW');
      await ctx.prisma.post.update({
        where: { id: list[0].postId },
        data: { state: 'ERROR' },
      });

      expect(
        await ctx.gate.beforeChangeDate(
          orgId,
          list[0].postId,
          futureDate(100),
          'schedule',
          false
        )
      ).toEqual({ action: 'update', toDraft: [list[0].postId] });

      await ctx.posts.changeDate(
        orgId,
        list[0].postId,
        futureDate(100),
        'schedule',
        false,
        creatorId,
        'WEB'
      );
      expect(await statesOf(ctx.prisma, batchId)).toEqual(['DRAFT']);
    });

    it('rejects a past date', async () => {
      const { list } = await save('draft', [{ integrationId: channelA }]);
      await expect(
        ctx.gate.beforeChangeDate(
          orgId,
          list[0].postId,
          pastDate(),
          'schedule',
          false
        )
      ).rejects.toThrow('La fecha de publicación ya pasó');
    });

    it('passes through with APPROVALS_ENABLED=false or an unknown post', async () => {
      expect(
        await ctx.gate.beforeChangeDate(
          orgId,
          'missing',
          pastDate(),
          'update',
          false
        )
      ).toEqual({ action: 'update', toDraft: [] });
      process.env.APPROVALS_ENABLED = 'false';
      expect(
        await ctx.gate.beforeChangeDate(
          orgId,
          'missing',
          pastDate(),
          'schedule',
          true
        )
      ).toEqual({ action: 'schedule', toDraft: [] });
      await ctx.gate.afterChangeDate(orgId, 'missing', creatorId);
    });

    it('recalculates earliestPublishDate and clears the warnings once every date is in the future', async () => {
      const { batchId, list } = await save('draft', [
        { integrationId: channelA, date: pastDate() },
        { integrationId: channelB, date: futureDate(100) },
      ]);
      await ctx.prisma.postApproval.update({
        where: { batchId },
        data: {
          warnedExpiredAt: new Date(),
          warned24At: new Date(),
          warned48At: new Date(),
        },
      });
      const late = list.find((p: any) => p.integration === channelA).postId;

      await ctx.posts.changeDate(
        orgId,
        late,
        futureDate(80),
        'update',
        false,
        creatorId,
        'WEB'
      );

      const approval = await approvalOf(batchId);
      const dates = (await rootsOf(ctx.prisma, batchId)).map((p) =>
        p.publishDate.getTime()
      );
      expect(approval.earliestPublishDate.getTime()).toBe(Math.min(...dates));
      expect(approval.earliestPublishDate.getTime()).toBeGreaterThan(
        Date.now()
      );
      expect(approval.warnedExpiredAt).toBeNull();
      expect(approval.warned24At).toBeNull();
      expect(approval.warned48At).toBeNull();
    });

    it('records DATE_CHANGED on an approved batch', async () => {
      const batchId = await approvedBatch([channelA]);
      const [root] = await rootsOf(ctx.prisma, batchId);
      await ctx.posts.changeDate(
        orgId,
        root.id,
        futureDate(100),
        'schedule',
        false,
        creatorId,
        'WEB'
      );
      const approval = await approvalOf(batchId);
      expect(await eventsOf(ctx.prisma, approval.id)).toContain('DATE_CHANGED');
      expect(await statesOf(ctx.prisma, batchId)).toEqual(['QUEUE']);
    });

    it('keeps warned48At when an edit inside 48 h does not move the date', async () => {
      const { batchId } = await save('draft', [
        { integrationId: channelA, date: futureDate(30) },
      ]);
      const warnedAt = new Date();
      await ctx.prisma.postApproval.update({
        where: { batchId },
        data: { warned48At: warnedAt },
      });
      const channels = await editChannels(ctx.prisma, batchId, (_id, c) => ({
        ...c,
        values: [{ ...c.values![0], content: 'edited' }],
      }));
      await save('update', channels);
      expect((await approvalOf(batchId)).warned48At).toEqual(warnedAt);
    });
  });

  describe('beforeChangePostStatus', () => {
    it('lets draft through always', async () => {
      await ctx.gate.beforeChangePostStatus(orgId, 'missing', 'draft');
    });

    it('rejects schedule without approval, and on a published post', async () => {
      const { list } = await save('draft', [{ integrationId: channelA }]);
      await expect(
        ctx.gate.beforeChangePostStatus(orgId, list[0].postId, 'schedule')
      ).rejects.toThrow('Este post necesita aprobación final');

      const batchId = await approvedBatch([channelB]);
      const [root] = await rootsOf(ctx.prisma, batchId);
      await ctx.prisma.post.update({
        where: { id: root.id },
        data: { state: 'PUBLISHED' },
      });
      await expect(
        ctx.gate.beforeChangePostStatus(orgId, root.id, 'schedule')
      ).rejects.toThrow('Este post necesita aprobación final');
    });

    it('rejects schedule with a past date', async () => {
      const batchId = await approvedBatch([channelA]);
      const [root] = await rootsOf(ctx.prisma, batchId);
      await ctx.prisma.post.update({
        where: { id: root.id },
        data: { publishDate: new Date(pastDate()) },
      });
      await expect(
        ctx.gate.beforeChangePostStatus(orgId, root.id, 'schedule')
      ).rejects.toThrow('La fecha de publicación ya pasó');
    });

    it('lets schedule through on an approved batch', async () => {
      const batchId = await approvedBatch([channelA]);
      const [root] = await rootsOf(ctx.prisma, batchId);
      await ctx.gate.beforeChangePostStatus(orgId, root.id, 'schedule');
    });
  });

  describe('beforeDeletePost and afterDeletePost', () => {
    it('records CHANNEL_DISCARDED for a failed channel of an approved batch', async () => {
      const batchId = await approvedBatch([channelA, channelB]);
      const [failed] = await rootsOf(ctx.prisma, batchId);
      await ctx.prisma.post.update({
        where: { id: failed.id },
        data: { state: 'ERROR' },
      });

      await ctx.posts.deletePost(orgId, failed.group, creatorId, 'WEB');

      const approval = await approvalOf(batchId);
      expect(approval.stage).toBe('APPROVED');
      expect(await eventsOf(ctx.prisma, approval.id)).toContain(
        'CHANNEL_DISCARDED'
      );
      expect(await statesOf(ctx.prisma, batchId)).toEqual(['QUEUE']);
    });

    it('resets the batch when a healthy channel is deleted', async () => {
      const batchId = await approvedBatch([channelA, channelB, channelC]);
      const [removed] = await rootsOf(ctx.prisma, batchId);

      await ctx.posts.deletePost(orgId, removed.group, creatorId, 'WEB');

      const approval = await approvalOf(batchId);
      expect(approval.stage).toBe('IN_REVIEW');
      const reset = await ctx.prisma.postApprovalEvent.findFirstOrThrow({
        where: { approvalId: approval.id, action: 'RESET_BY_EDIT' },
      });
      expect(Object.keys(reset.fingerprints as object)).not.toContain(
        removed.integrationId
      );
      expect(await statesOf(ctx.prisma, batchId)).toEqual(['DRAFT', 'DRAFT']);
      // the workflows of the other two were terminated too
      const terminated = ctx.temporal.calls
        .filter((p) => p.type === 'terminate')
        .map((p) => p.postId)
        .sort();
      expect(terminated).toEqual(
        (await ctx.prisma.post.findMany({ where: { batchId } }))
          .map((p) => p.id)
          .sort()
      );
    });

    it('records CONTENT_EDITED only in IN_PRODUCTION', async () => {
      const { batchId } = await save('draft', [
        { integrationId: channelA },
        { integrationId: channelB },
      ]);
      const [removed] = await rootsOf(ctx.prisma, batchId);
      await ctx.posts.deletePost(orgId, removed.group, creatorId, 'WEB');
      const approval = await approvalOf(batchId);
      expect(approval.stage).toBe('IN_PRODUCTION');
      expect(await eventsOf(ctx.prisma, approval.id)).toEqual([
        'CREATED',
        'CONTENT_EDITED',
      ]);
    });

    it('leaves no event when the upstream delete fails', async () => {
      const batchId = await approvedBatch([channelA, channelB]);
      const [removed] = await rootsOf(ctx.prisma, batchId);
      const repository = (ctx.posts as any)._postRepository;
      const spy = jest
        .spyOn(repository, 'deletePost')
        .mockRejectedValueOnce(new Error('db down'));
      const before = await ctx.prisma.postApprovalEvent.count();

      await expect(
        ctx.posts.deletePost(orgId, removed.group, creatorId, 'WEB')
      ).rejects.toThrow('db down');
      expect(await ctx.prisma.postApprovalEvent.count()).toBe(before);
      spy.mockRestore();
    });

    it('returns no context with APPROVALS_ENABLED=false, for an unknown group or a batch without approval', async () => {
      expect(await ctx.gate.beforeDeletePost(orgId, 'missing')).toBeNull();
      const post = await ctx.prisma.post.create({
        data: {
          organizationId: orgId,
          integrationId: channelA,
          content: 'x',
          group: 'loose',
          publishDate: new Date(futureDate()),
        },
      });
      const context = await ctx.gate.beforeDeletePost(orgId, 'loose');
      expect(context?.root.id).toBe(post.id);
      expect(context?.approval).toBeNull();
      expect(
        await ctx.gate.afterDeletePost(orgId, context, creatorId, 'WEB')
      ).toEqual({ toDraft: [] });
      process.env.APPROVALS_ENABLED = 'false';
      expect(await ctx.gate.beforeDeletePost(orgId, 'loose')).toBeNull();
    });
  });

  describe('edge cases', () => {
    it('hashes odd stored rows without failing', async () => {
      const { batchId, list } = await save('draft', [
        { integrationId: channelA },
      ]);
      const id = list[0].postId;
      const hash = async () =>
        (await ctx.gate.fingerprintsFromDb(orgId, batchId))[channelA];

      await ctx.prisma.post.update({
        where: { id },
        data: {
          content: '',
          image: JSON.stringify([
            null,
            { path: 12 },
            { id: 'unknown', path: 'https://cdn/x.png' },
          ]),
          settings: JSON.stringify({ list: [{ b: 1, a: [2] }], __type: 'x' }),
        },
      });
      const odd = await hash();
      expect(odd).toHaveLength(64);

      await ctx.prisma.post.update({
        where: { id },
        data: { image: 'not json', settings: 'plain text' },
      });
      expect(await hash()).not.toBe(odd);

      await ctx.prisma.post.update({
        where: { id },
        data: { image: null, settings: null },
      });
      expect(await hash()).toHaveLength(64);
    });

    it('reads the reference fingerprints of every stage', async () => {
      expect(
        await ctx.gate.referenceFingerprints(orgId, {
          id: 'none',
          stage: 'APPROVED',
          approvedFingerprints: null,
        })
      ).toBeNull();
      expect(
        await ctx.gate.referenceFingerprints(orgId, {
          id: 'none',
          stage: 'IN_REVIEW',
          approvedFingerprints: null,
        })
      ).toBeNull();
    });

    it('treats an APPROVED batch without stored fingerprints as drift', async () => {
      const batchId = await approvedBatch([channelA]);
      await ctx.prisma.postApproval.update({
        where: { batchId },
        data: { approvedFingerprints: Prisma.DbNull },
      });
      const [root] = await rootsOf(ctx.prisma, batchId);
      expect((await ctx.gate.evaluatePublish(orgId, root.id)).reason).toBe(
        'fingerprint_drift'
      );
    });

    it('blocks a post that does not exist', async () => {
      expect(await ctx.gate.isPublishAllowed(orgId, 'missing')).toBe(false);
      await expect(
        ctx.gate.beforeChangePostStatus(orgId, 'missing', 'schedule')
      ).rejects.toThrow('Este post necesita aprobación final');
    });

    it('accepts a body without posts or values', async () => {
      expect(
        await ctx.gate.typeForSave(orgId, { type: 'schedule' } as any)
      ).toEqual({ typeByIntegration: {}, inter: undefined });
      expect(
        (
          await ctx.gate.typeForSave(orgId, {
            type: 'now',
            posts: [{ integration: { id: channelA } }],
          } as any)
        ).typeByIntegration[channelA]
      ).toBe('draft');
    });

    it('queues an approved batch with now even though the saved minute already started', async () => {
      const batchId = await approvedBatch([channelA]);
      const channels = await editChannels(ctx.prisma, batchId);
      await save('now', channels);
      expect(await statesOf(ctx.prisma, batchId)).toEqual(['QUEUE']);
    });

    it('takes the earliest date of the batch on creation', async () => {
      const { batchId } = await save('draft', [
        { integrationId: channelA, date: futureDate(100) },
        { integrationId: channelB, date: futureDate(50) },
        { integrationId: channelC, date: futureDate(80) },
      ]);
      const dates = (await rootsOf(ctx.prisma, batchId)).map((p) =>
        p.publishDate.getTime()
      );
      expect((await approvalOf(batchId)).earliestPublishDate.getTime()).toBe(
        Math.min(...dates)
      );
    });

    it('skips afterChangeDate for a post without approval', async () => {
      const post = await ctx.prisma.post.create({
        data: {
          organizationId: orgId,
          integrationId: channelA,
          content: 'x',
          group: 'loose',
          publishDate: new Date(futureDate()),
        },
      });
      await ctx.gate.afterChangeDate(orgId, post.id, undefined);
      expect(await ctx.prisma.postApprovalEvent.count()).toBe(0);
    });

    it('records system actions without actor', async () => {
      const batchId = await approvedBatch([channelA, channelB]);
      const [failed] = await rootsOf(ctx.prisma, batchId);
      await ctx.prisma.post.update({
        where: { id: failed.id },
        data: { state: 'DRAFT' },
      });
      await ctx.posts.deletePost(orgId, failed.group);
      const event = await ctx.prisma.postApprovalEvent.findFirstOrThrow({
        where: { action: 'CHANNEL_DISCARDED' },
      });
      expect(event).toMatchObject({
        actorUserId: null,
        actorRole: 'SYSTEM',
        surface: 'UNKNOWN',
      });

      const [other] = await rootsOf(ctx.prisma, batchId);
      await ctx.gate.afterChangeDate(orgId, other.id, undefined);
      const changed = await ctx.prisma.postApprovalEvent.findFirstOrThrow({
        where: { action: 'DATE_CHANGED' },
      });
      expect(changed).toMatchObject({
        actorUserId: null,
        actorRole: 'SYSTEM',
        surface: 'WEB',
      });
    });

    it('does nothing after a delete when the context has no batch', async () => {
      expect(
        await ctx.gate.afterDeletePost(
          orgId,
          {
            root: {
              id: 'x',
              state: 'QUEUE',
              batchId: null,
              integrationId: channelA,
            },
            approval: { id: 'a' } as any,
          },
          creatorId,
          'WEB'
        )
      ).toEqual({ toDraft: [] });
    });

    it('deleting the last channel of a batch does not send it to review', async () => {
      const batchId = await approvedBatch([channelA]);
      const [only] = await rootsOf(ctx.prisma, batchId);
      await ctx.posts.deletePost(orgId, only.group, creatorId, 'WEB');
      const approval = await approvalOf(batchId);
      expect(approval.stage).toBe('APPROVED');
      expect(await eventsOf(ctx.prisma, approval.id)).toContain(
        'CHANNEL_DISCARDED'
      );
      expect(ctx.notifications.sent).toHaveLength(0);
    });

    it('deleting a published channel of an approved batch keeps the others scheduled', async () => {
      const batchId = await approvedBatch([channelA, channelB]);
      const [published] = await rootsOf(ctx.prisma, batchId);
      await ctx.prisma.post.update({
        where: { id: published.id },
        data: { state: 'PUBLISHED' },
      });
      await ctx.posts.deletePost(orgId, published.group, creatorId, 'WEB');
      const approval = await approvalOf(batchId);
      expect(approval.stage).toBe('APPROVED');
      expect(await eventsOf(ctx.prisma, approval.id)).toContain(
        'CHANNEL_DISCARDED'
      );
      expect(await statesOf(ctx.prisma, batchId)).toEqual(['QUEUE']);
    });

    it('keeps the hash when updateMedia fills a library item with its media row', async () => {
      const media = await ctx.prisma.media.create({
        data: {
          organizationId: orgId,
          name: 'lib.png',
          path: '/uploads/lib.png',
          alt: 'library alt',
          thumbnail: '/uploads/lib-thumb.png',
        },
      });
      const { batchId, list } = await save('draft', [
        { integrationId: channelA },
      ]);
      const hash = async () =>
        (await ctx.gate.fingerprintsFromDb(orgId, batchId))[channelA];
      await ctx.prisma.post.update({
        where: { id: list[0].postId },
        data: { image: JSON.stringify([{ id: media.id }]) },
      });
      const before = await hash();
      await ctx.prisma.post.update({
        where: { id: list[0].postId },
        data: {
          image: JSON.stringify([
            {
              id: media.id,
              path: media.path,
              alt: media.alt,
              thumbnail: media.thumbnail,
            },
          ]),
        },
      });
      expect(await hash()).toBe(before);
    });

    it('strips UPLOAD_DIRECTORY as many times as updateMedia added it', async () => {
      const { batchId, list } = await save('draft', [
        { integrationId: channelA },
      ]);
      const hash = async () =>
        (await ctx.gate.fingerprintsFromDb(orgId, batchId))[channelA];
      await ctx.prisma.post.update({
        where: { id: list[0].postId },
        data: { image: JSON.stringify([{ path: '/local.png' }]) },
      });
      const before = await hash();
      await ctx.prisma.post.update({
        where: { id: list[0].postId },
        data: {
          image: JSON.stringify([{ path: '/uploads/uploads/local.png' }]),
        },
      });
      expect(await hash()).toBe(before);
    });
  });

  it('turns the plugs off while the fork is on', () => {
    expect(ctx.gate.plugsEnabled()).toBe(false);
    process.env.APPROVALS_ENABLED = 'false';
    expect(ctx.gate.plugsEnabled()).toBe(true);
  });
});
