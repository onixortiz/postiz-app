import { mock } from 'jest-mock-extended';
import { PostActivity } from '@gitroom/orchestrator/activities/post.activity';
import {
  approveBatch,
  ApprovalsTestContext,
  cleanDatabase,
  createApprovalsTestModule,
  createIntegration,
  createOrg,
  createUser,
  postBody,
} from '@gitroom/nestjs-libraries/database/prisma/approvals/test/approvals.test.helpers';

// FORK: approvals. getPostsList is the publish-time guarantee: postWorkflowV112
// calls it after sleeping, and with [] ends in ERROR 'No Post' without publishing.
describe('PostActivity.getPostsList with approvals', () => {
  let ctx: ApprovalsTestContext;
  let activity: PostActivity;
  let orgId: string;
  let creatorId: string;
  let channel: string;

  beforeAll(async () => {
    ctx = await createApprovalsTestModule();
    activity = new PostActivity(
      ctx.posts,
      mock(),
      mock(),
      mock(),
      mock(),
      mock(),
      ctx.temporal.service,
      mock(),
      ctx.gate
    );
  });

  afterAll(async () => {
    await ctx.module.close();
  });

  beforeEach(async () => {
    process.env.APPROVALS_ENABLED = 'true';
    await cleanDatabase(ctx.prisma);
    ({ orgId } = await createOrg(ctx.prisma));
    creatorId = await createUser(ctx.prisma, orgId, ['CREATOR']);
    channel = await createIntegration(ctx.prisma, orgId);
  });

  const queuedPost = async () => {
    const [saved] = await ctx.posts.createPost(
      orgId,
      postBody('draft', [{ integrationId: channel }]),
      'WEB',
      false,
      creatorId
    );
    const post = await ctx.prisma.post.update({
      where: { id: saved.postId },
      data: { state: 'QUEUE' },
    });
    return post;
  };

  it('returns [] for a post of an unapproved batch and records BLOCKED_AT_PUBLISH', async () => {
    const post = await queuedPost();
    expect(await activity.getPostsList(orgId, post.id)).toEqual([]);
    const event = await ctx.prisma.postApprovalEvent.findFirstOrThrow({
      where: { action: 'BLOCKED_AT_PUBLISH' },
    });
    expect(event.reason).toBe('stage');
  });

  it('returns the posts of an approved batch', async () => {
    const post = await queuedPost();
    await approveBatch(ctx, orgId, post.batchId!);
    const list = await activity.getPostsList(orgId, post.id);
    expect(list.map((p: any) => p.id)).toEqual([post.id]);
  });

  it('returns the posts as upstream with APPROVALS_ENABLED=false', async () => {
    process.env.APPROVALS_ENABLED = 'false';
    const [saved] = await ctx.posts.createPost(
      orgId,
      postBody('schedule', [{ integrationId: channel }]),
      'WEB'
    );
    const list = await activity.getPostsList(orgId, saved.postId);
    expect(list.map((p: any) => p.id)).toEqual([saved.postId]);
    expect(await ctx.prisma.postApprovalEvent.count()).toBe(0);
  });
});
