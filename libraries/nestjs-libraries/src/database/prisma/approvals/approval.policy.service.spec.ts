import { ForbiddenException } from '@nestjs/common';
import { ApprovalAction } from '@prisma/client';
import {
  ApprovalsTestContext,
  cleanDatabase,
  createApprovalsTestModule,
  createIntegration,
  createOrg,
  createUser,
  postBody,
} from './test/approvals.test.helpers';

describe('ApprovalPolicyService', () => {
  let ctx: ApprovalsTestContext;
  let orgId: string;
  let adminId: string;
  let channel: string;

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
    channel = await createIntegration(ctx.prisma, orgId);
  });

  // a batch created by `authorId`, as the editor does
  const batchBy = async (authorId: string) => {
    const [saved] = await ctx.posts.createPost(
      orgId,
      postBody('draft', [{ integrationId: channel }]),
      'WEB',
      false,
      authorId
    );
    const post = await ctx.prisma.post.findUniqueOrThrow({
      where: { id: saved.postId },
    });
    return ctx.prisma.postApproval.findUniqueOrThrow({
      where: { batchId: post.batchId! },
    });
  };

  const event = (
    approvalId: string,
    actorUserId: string,
    action: ApprovalAction
  ) =>
    ctx.prisma.postApprovalEvent.create({
      data: {
        organizationId: orgId,
        approvalId,
        actorUserId,
        actorRole: 'MEMBER',
        action,
      },
    });

  it.each([
    ['SUBMITTED', 'CREATOR', 'REVIEWER'],
    ['REVIEW_APPROVED', 'REVIEWER', 'CREATOR'],
    ['REJECTED', 'MONTHLY_REVIEWER', 'CREATOR'],
    ['FINAL_APPROVED', 'MONTHLY_REVIEWER', 'REVIEWER'],
    ['FORCED', 'MONTHLY_REVIEWER', 'TECHNICAL_WRITER'],
    ['LINKED_BRIEF', 'TECHNICAL_WRITER', 'REVIEWER'],
    ['VERIFIED', 'TECHNICAL_WRITER', 'CREATOR'],
    ['VERIFICATION_PROBLEM', 'TECHNICAL_WRITER', 'MONTHLY_REVIEWER'],
  ] as const)('%s needs its role', async (action, allowed, denied) => {
    const authorId = await createUser(ctx.prisma, orgId, ['CREATOR']);
    const approval = await batchBy(authorId);
    const yes = await createUser(ctx.prisma, orgId, [allowed]);
    const no = await createUser(ctx.prisma, orgId, [denied]);

    await expect(
      ctx.policy.assertCan(yes, orgId, action, approval)
    ).resolves.toBeUndefined();
    await expect(
      ctx.policy.assertCan(no, orgId, action, approval)
    ).rejects.toThrow('Esta acción necesita uno de estos roles');
  });

  it('rejects an action that is not a workflow action', async () => {
    const approval = await batchBy(adminId);
    await expect(
      ctx.policy.assertCan(adminId, orgId, 'CREATED', approval)
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('does not let the one who CREATED the batch force it from IN_PRODUCTION', async () => {
    const boss = await createUser(ctx.prisma, orgId, [
      'MONTHLY_REVIEWER',
      'CREATOR',
    ]);
    const approval = await batchBy(boss);
    await expect(
      ctx.policy.assertCan(boss, orgId, 'FORCED', approval)
    ).rejects.toThrow('El autor de un post no puede aprobarlo ni forzarlo');
  });

  it('does not let a reviewer who edited before the submit approve', async () => {
    const creator = await createUser(ctx.prisma, orgId, ['CREATOR']);
    const reviewer = await createUser(ctx.prisma, orgId, ['REVIEWER']);
    const approval = await batchBy(creator);
    await event(approval.id, reviewer, 'CONTENT_EDITED');
    await event(approval.id, creator, 'SUBMITTED');
    await expect(
      ctx.policy.assertCan(reviewer, orgId, 'REVIEW_APPROVED', approval)
    ).rejects.toThrow('El autor de un post no puede aprobarlo ni forzarlo');
  });

  it('does not let the creator approve after someone else submitted it again', async () => {
    const creator = await createUser(ctx.prisma, orgId, [
      'CREATOR',
      'REVIEWER',
    ]);
    const other = await createUser(ctx.prisma, orgId, ['CREATOR']);
    const approval = await batchBy(creator);
    await event(approval.id, other, 'SUBMITTED');
    await expect(
      ctx.policy.assertCan(creator, orgId, 'REVIEW_APPROVED', approval)
    ).rejects.toThrow('El autor de un post no puede aprobarlo ni forzarlo');
  });

  it('does not let the reviewer give the final approval too', async () => {
    const creator = await createUser(ctx.prisma, orgId, ['CREATOR']);
    const both = await createUser(ctx.prisma, orgId, [
      'REVIEWER',
      'MONTHLY_REVIEWER',
    ]);
    const approval = await batchBy(creator);
    await event(approval.id, both, 'REVIEW_APPROVED');
    await expect(
      ctx.policy.assertCan(both, orgId, 'FINAL_APPROVED', approval)
    ).rejects.toThrow(
      'La aprobación final debe darla alguien distinto de quien revisó'
    );

    const boss = await createUser(ctx.prisma, orgId, ['MONTHLY_REVIEWER']);
    await expect(
      ctx.policy.assertCan(boss, orgId, 'FINAL_APPROVED', approval)
    ).resolves.toBeUndefined();
  });

  it('ignores the roles of a disabled member', async () => {
    const creator = await createUser(ctx.prisma, orgId, ['CREATOR']);
    const approval = await batchBy(creator);
    const reviewer = await createUser(ctx.prisma, orgId, ['REVIEWER']);
    await ctx.prisma.userOrganization.updateMany({
      where: { userId: reviewer },
      data: { disabled: true },
    });
    await expect(
      ctx.policy.assertCan(reviewer, orgId, 'REVIEW_APPROVED', approval)
    ).rejects.toThrow('Esta acción necesita uno de estos roles');
  });

  describe('actorRoleFor', () => {
    it('returns the role the action needs, CREATOR or MEMBER on edits and SYSTEM without user', async () => {
      const both = await createUser(ctx.prisma, orgId, [
        'REVIEWER',
        'MONTHLY_REVIEWER',
      ]);
      const creator = await createUser(ctx.prisma, orgId, ['CREATOR']);
      const member = await createUser(ctx.prisma, orgId, []);

      expect(await ctx.policy.actorRoleFor(orgId, both, 'REJECTED')).toBe(
        'REVIEWER'
      );
      expect(await ctx.policy.actorRoleFor(orgId, both, 'FINAL_APPROVED')).toBe(
        'MONTHLY_REVIEWER'
      );
      expect(
        await ctx.policy.actorRoleFor(orgId, creator, 'CONTENT_EDITED')
      ).toBe('CREATOR');
      expect(await ctx.policy.actorRoleFor(orgId, creator, 'CREATED')).toBe(
        'CREATOR'
      );
      expect(
        await ctx.policy.actorRoleFor(orgId, member, 'CONTENT_EDITED')
      ).toBe('MEMBER');
      expect(
        await ctx.policy.actorRoleFor(orgId, undefined, 'CONTENT_EDITED')
      ).toBe('SYSTEM');
      expect(await ctx.policy.actorRoleFor(orgId, null, 'CREATED')).toBe(
        'SYSTEM'
      );
    });
  });

  describe('assertIsOrgAdmin', () => {
    it('accepts ADMIN and SUPERADMIN only', async () => {
      const superAdmin = await createUser(ctx.prisma, orgId, [], 'SUPERADMIN');
      const user = await createUser(ctx.prisma, orgId, ['MONTHLY_REVIEWER']);
      await expect(
        ctx.policy.assertIsOrgAdmin(adminId, orgId)
      ).resolves.toBeUndefined();
      await expect(
        ctx.policy.assertIsOrgAdmin(superAdmin, orgId)
      ).resolves.toBeUndefined();
      await expect(
        ctx.policy.assertIsOrgAdmin(user, orgId)
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        ctx.policy.assertIsOrgAdmin('missing', orgId)
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
