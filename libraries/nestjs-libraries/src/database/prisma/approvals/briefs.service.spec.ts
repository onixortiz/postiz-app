import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  ApprovalsTestContext,
  cleanDatabase,
  createApprovalsTestModule,
  createOrg,
  createUser,
  futureDate,
} from './test/approvals.test.helpers';

describe('BriefsService', () => {
  let ctx: ApprovalsTestContext;
  let orgId: string;
  let writer: { id: string };
  let creator: { id: string };

  beforeAll(async () => {
    ctx = await createApprovalsTestModule();
  });

  afterAll(async () => {
    await ctx.module.close();
  });

  beforeEach(async () => {
    process.env.APPROVALS_ENABLED = 'true';
    await cleanDatabase(ctx.prisma);
    ({ orgId } = await createOrg(ctx.prisma));
    writer = { id: await createUser(ctx.prisma, orgId, ['TECHNICAL_WRITER']) };
    creator = { id: await createUser(ctx.prisma, orgId, ['CREATOR']) };
  });

  it('only the technical writer creates, edits and cancels', async () => {
    await expect(
      ctx.briefs.create(orgId, creator, { topic: 'x' })
    ).rejects.toBeInstanceOf(ForbiddenException);

    const brief = await ctx.briefs.create(orgId, writer, {
      topic: 'Launch',
      baseCopy: 'Base text',
      targetDate: futureDate(),
      assignedCreatorId: creator.id,
    });
    expect(brief).toMatchObject({
      topic: 'Launch',
      status: 'OPEN',
      quickBrief: false,
      assignedCreatorId: creator.id,
    });

    await expect(
      ctx.briefs.update(orgId, brief.id, creator, { topic: 'y' })
    ).rejects.toBeInstanceOf(ForbiddenException);
    const updated = await ctx.briefs.update(orgId, brief.id, writer, {
      topic: 'Launch day',
      baseCopy: 'New text',
      targetDate: futureDate(10),
      assignedCreatorId: writer.id,
    });
    expect(updated).toMatchObject({
      topic: 'Launch day',
      baseCopy: 'New text',
    });

    await expect(
      ctx.briefs.cancel(orgId, brief.id, creator)
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect((await ctx.briefs.cancel(orgId, brief.id, writer))!.status).toBe(
      'CANCELLED'
    );
    await expect(
      ctx.briefs.cancel(orgId, brief.id, writer)
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('clears a field sent as null', async () => {
    const brief = await ctx.briefs.create(orgId, writer, {
      topic: 'Launch',
      baseCopy: 'Base',
      targetDate: futureDate(),
      assignedCreatorId: creator.id,
    });
    const cleared = await ctx.briefs.update(orgId, brief.id, writer, {
      baseCopy: null,
      targetDate: null,
      assignedCreatorId: null,
    });
    expect(cleared).toMatchObject({
      topic: 'Launch',
      baseCopy: null,
      targetDate: null,
      assignedCreatorId: null,
    });
  });

  it('lets whoever wrote a quick brief edit it', async () => {
    const quick = await ctx.prisma.contentBrief.create({
      data: {
        organizationId: orgId,
        topic: 'Quick',
        quickBrief: true,
        createdById: creator.id,
      },
    });
    expect(
      (await ctx.briefs.update(orgId, quick.id, creator, { topic: 'Quick 2' }))!
        .topic
    ).toBe('Quick 2');

    const other = { id: await createUser(ctx.prisma, orgId, ['CREATOR']) };
    await expect(
      ctx.briefs.update(orgId, quick.id, other, { topic: 'no' })
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('lists by status, answers 404 for a missing brief and refuses a creator from outside', async () => {
    const open = await ctx.briefs.create(orgId, writer, { topic: 'Open' });
    const closed = await ctx.briefs.create(orgId, writer, { topic: 'Closed' });
    await ctx.briefs.cancel(orgId, closed.id, writer);

    expect((await ctx.briefs.list(orgId)).map((p) => p.id).sort()).toEqual(
      [open.id, closed.id].sort()
    );
    expect((await ctx.briefs.list(orgId, 'OPEN')).map((p) => p.id)).toEqual([
      open.id,
    ]);
    await expect(ctx.briefs.get(orgId, 'missing')).rejects.toBeInstanceOf(
      NotFoundException
    );

    const other = await createOrg(ctx.prisma);
    await expect(
      ctx.briefs.create(orgId, writer, {
        topic: 'x',
        assignedCreatorId: other.adminId,
      })
    ).rejects.toThrow('La persona asignada no es del equipo');
    await expect(ctx.briefs.get(other.orgId, open.id)).rejects.toBeInstanceOf(
      NotFoundException
    );
  });
});
