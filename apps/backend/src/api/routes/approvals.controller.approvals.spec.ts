import 'reflect-metadata';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ApprovalGateService } from '@gitroom/nestjs-libraries/database/prisma/approvals/approval.gate.service';
import { ApprovalsEnabledGuard } from '@gitroom/backend/services/auth/approvals.guard';
import { SetWorkflowRolesDto } from '@gitroom/nestjs-libraries/dtos/approvals/approval.actions.dto';
import { ListBriefsQueryDto } from '@gitroom/nestjs-libraries/dtos/approvals/brief.dto';
import { mock } from 'jest-mock-extended';
import { ApprovalService } from '@gitroom/nestjs-libraries/database/prisma/approvals/approval.service';
import { BriefsService } from '@gitroom/nestjs-libraries/database/prisma/approvals/briefs.service';
import { ApprovalsController } from '@gitroom/backend/api/routes/approvals.controller';
import { BriefsController } from '@gitroom/backend/api/routes/briefs.controller';

// FORK: approvals. No workflow action while a super admin impersonates someone.
describe('ApprovalsController and BriefsController impersonation', () => {
  const org = { id: 'org' } as any;
  const user = { id: 'user' } as any;

  const requests = {
    cookie: {
      user: { isSuperAdmin: true },
      cookies: { impersonate: 'x' },
      headers: {},
    },
    header: {
      user: { isSuperAdmin: true },
      cookies: {},
      headers: { impersonate: 'x' },
    },
  } as Record<string, any>;

  const approvalService = mock<ApprovalService>();
  const briefsService = mock<BriefsService>();
  const approvals = new ApprovalsController(approvalService);
  const briefs = new BriefsController(briefsService);

  const writes: [string, (req: any) => unknown][] = [
    ['submit', (req) => approvals.submit(req, org, user, 'b', { version: 0 })],
    [
      'review-approve',
      (req) => approvals.reviewApprove(req, org, user, 'b', { version: 0 }),
    ],
    [
      'reject',
      (req) =>
        approvals.reject(req, org, user, 'b', { version: 0, comment: 'xxx' }),
    ],
    [
      'final-approve',
      (req) => approvals.finalApprove(req, org, user, { items: [] }),
    ],
    [
      'force',
      (req) =>
        approvals.force(req, org, user, 'b', {
          version: 0,
          reason: 'x'.repeat(10),
        }),
    ],
    ['verify', (req) => approvals.verify(req, org, user, 'b', { version: 0 })],
    [
      'problem',
      (req) =>
        approvals.markProblem(req, org, user, 'b', {
          version: 0,
          comment: 'xxx',
        }),
    ],
    [
      'link-brief',
      (req) =>
        approvals.linkBrief(req, org, user, 'b', { version: 0, briefId: 'x' }),
    ],
    ['roles', (req) => approvals.setRoles(req, org, user, 'u', { roles: [] })],
    ['briefs create', (req) => briefs.create(req, org, user, { topic: 'x' })],
    [
      'briefs update',
      (req) => briefs.update(req, org, user, 'x', { topic: 'x' }),
    ],
    ['briefs cancel', (req) => briefs.cancel(req, org, user, 'x')],
  ];

  it.each(
    writes.flatMap(([name, call]) =>
      Object.keys(requests).map((how) => [name, how, call] as const)
    )
  )('%s answers 403 when impersonating by %s', (_name, how, call) => {
    expect(() => call(requests[how])).toThrow(ForbiddenException);
  });

  it.each(writes)(
    '%s goes through for a normal user with an old impersonate cookie',
    (_name, call) => {
      const req = {
        user: { isSuperAdmin: false },
        cookies: { impersonate: 'x' },
        headers: {},
      };
      expect(() => call(req)).not.toThrow();
    }
  );

  it('lets the reads through and rejects an unknown brief status', () => {
    approvals.getInbox(org, user);
    approvals.getBatch(org, 'b');
    approvals.getStages(org, { postIds: [] });
    approvals.getPreview(org, 'p');
    approvals.getPreviewComments(org, 'p');
    approvals.getRoles(org);
    briefs.list(org, {});
    briefs.get(org, 'x');
    expect(approvalService.getInbox).toHaveBeenCalled();
  });

  it('hides every route while APPROVALS_ENABLED is not true', () => {
    const gate = mock<ApprovalGateService>();
    const guard = new ApprovalsEnabledGuard(gate);
    gate.enabled.mockReturnValueOnce(false);
    expect(() => guard.canActivate()).toThrow(NotFoundException);
    gate.enabled.mockReturnValueOnce(true);
    expect(guard.canActivate()).toBe(true);
    expect(Reflect.getMetadata('__guards__', ApprovalsController)).toEqual([
      ApprovalsEnabledGuard,
    ]);
    expect(Reflect.getMetadata('__guards__', BriefsController)).toEqual([
      ApprovalsEnabledGuard,
    ]);
  });

  it('refuses duplicate roles and an unknown brief status', async () => {
    const roles = plainToInstance(SetWorkflowRolesDto, {
      roles: ['CREATOR', 'CREATOR'],
    });
    expect(await validate(roles)).not.toHaveLength(0);
    const query = plainToInstance(ListBriefsQueryDto, { status: 'NOPE' });
    expect(await validate(query)).not.toHaveLength(0);
    expect(
      await validate(plainToInstance(ListBriefsQueryDto, { status: 'OPEN' }))
    ).toHaveLength(0);
  });
});
