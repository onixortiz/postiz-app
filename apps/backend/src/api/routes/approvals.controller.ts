import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import {
  ApprovalsEnabledGuard,
  assertNotImpersonating,
} from '@gitroom/backend/services/auth/approvals.guard';
import { Organization, User } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { GetUserFromRequest } from '@gitroom/nestjs-libraries/user/user.from.request';
import { ApprovalService } from '@gitroom/nestjs-libraries/database/prisma/approvals/approval.service';
import {
  FinalApproveDto,
  ForceApprovalDto,
  LinkBriefDto,
  ProblemApprovalDto,
  RejectApprovalDto,
  SetWorkflowRolesDto,
  StagesQueryDto,
  SubmitApprovalDto,
  VersionDto,
} from '@gitroom/nestjs-libraries/dtos/approvals/approval.actions.dto';

// FORK: approvals. The only entry to the workflow actions: web session only,
// never with an API key, from MCP or while impersonating.
@ApiTags('Approvals')
@Controller('/approvals')
@UseGuards(ApprovalsEnabledGuard)
export class ApprovalsController {
  constructor(private _approvalService: ApprovalService) {}

  @Get('/inbox')
  getInbox(
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User
  ) {
    return this._approvalService.getInbox(org.id, user);
  }

  @Get('/batch/:batchId')
  getBatch(
    @GetOrgFromRequest() org: Organization,
    @Param('batchId') batchId: string
  ) {
    return this._approvalService.getBatch(org.id, batchId);
  }

  @Post('/stages')
  getStages(
    @GetOrgFromRequest() org: Organization,
    @Body() body: StagesQueryDto
  ) {
    return this._approvalService.getStages(org.id, body.postIds);
  }

  @Get('/preview/:postId')
  getPreview(
    @GetOrgFromRequest() org: Organization,
    @Param('postId') postId: string
  ) {
    return this._approvalService.getPreview(org.id, postId);
  }

  @Get('/preview/:postId/comments')
  getPreviewComments(
    @GetOrgFromRequest() org: Organization,
    @Param('postId') postId: string
  ) {
    return this._approvalService.getPreviewComments(org.id, postId);
  }

  @Get('/roles')
  getRoles(@GetOrgFromRequest() org: Organization) {
    return this._approvalService.getRoles(org.id);
  }

  @Post('/batch/:batchId/submit')
  submit(
    @Req() req: Request,
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('batchId') batchId: string,
    @Body() body: SubmitApprovalDto
  ) {
    assertNotImpersonating(req);
    return this._approvalService.submit(
      org.id,
      batchId,
      body.version,
      user,
      body.quickTopic
    );
  }

  @Post('/batch/:batchId/review-approve')
  reviewApprove(
    @Req() req: Request,
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('batchId') batchId: string,
    @Body() body: VersionDto
  ) {
    assertNotImpersonating(req);
    return this._approvalService.reviewApprove(
      org.id,
      batchId,
      body.version,
      user
    );
  }

  @Post('/batch/:batchId/reject')
  reject(
    @Req() req: Request,
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('batchId') batchId: string,
    @Body() body: RejectApprovalDto
  ) {
    assertNotImpersonating(req);
    return this._approvalService.reject(
      org.id,
      batchId,
      body.version,
      user,
      body.comment
    );
  }

  @Post('/final-approve')
  finalApprove(
    @Req() req: Request,
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: FinalApproveDto
  ) {
    assertNotImpersonating(req);
    return this._approvalService.finalApprove(org.id, body.items, user);
  }

  @Post('/batch/:batchId/force')
  force(
    @Req() req: Request,
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('batchId') batchId: string,
    @Body() body: ForceApprovalDto
  ) {
    assertNotImpersonating(req);
    return this._approvalService.force(
      org.id,
      batchId,
      body.version,
      user,
      body.reason
    );
  }

  @Post('/batch/:batchId/verify')
  verify(
    @Req() req: Request,
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('batchId') batchId: string,
    @Body() body: VersionDto
  ) {
    assertNotImpersonating(req);
    return this._approvalService.verify(org.id, batchId, body.version, user);
  }

  @Post('/batch/:batchId/problem')
  markProblem(
    @Req() req: Request,
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('batchId') batchId: string,
    @Body() body: ProblemApprovalDto
  ) {
    assertNotImpersonating(req);
    return this._approvalService.markProblem(
      org.id,
      batchId,
      body.version,
      user,
      body.comment
    );
  }

  @Post('/batch/:batchId/link-brief')
  linkBrief(
    @Req() req: Request,
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('batchId') batchId: string,
    @Body() body: LinkBriefDto
  ) {
    assertNotImpersonating(req);
    return this._approvalService.linkBrief(
      org.id,
      batchId,
      body.version,
      body.briefId,
      user
    );
  }

  @Put('/roles/:userId')
  setRoles(
    @Req() req: Request,
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('userId') userId: string,
    @Body() body: SetWorkflowRolesDto
  ) {
    assertNotImpersonating(req);
    return this._approvalService.setRoles(org.id, userId, body.roles, user);
  }
}
