import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
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
import { BriefsService } from '@gitroom/nestjs-libraries/database/prisma/approvals/briefs.service';
import {
  CreateBriefDto,
  ListBriefsQueryDto,
  UpdateBriefDto,
} from '@gitroom/nestjs-libraries/dtos/approvals/brief.dto';

// FORK: approvals
@ApiTags('Briefs')
@Controller('/briefs')
@UseGuards(ApprovalsEnabledGuard)
export class BriefsController {
  constructor(private _briefsService: BriefsService) {}

  @Get('/')
  list(
    @GetOrgFromRequest() org: Organization,
    @Query() query: ListBriefsQueryDto
  ) {
    return this._briefsService.list(org.id, query.status);
  }

  @Get('/:id')
  get(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    return this._briefsService.get(org.id, id);
  }

  @Post('/')
  create(
    @Req() req: Request,
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Body() body: CreateBriefDto
  ) {
    assertNotImpersonating(req);
    return this._briefsService.create(org.id, user, body);
  }

  @Put('/:id')
  update(
    @Req() req: Request,
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string,
    @Body() body: UpdateBriefDto
  ) {
    assertNotImpersonating(req);
    return this._briefsService.update(org.id, id, user, body);
  }

  @Delete('/:id')
  cancel(
    @Req() req: Request,
    @GetOrgFromRequest() org: Organization,
    @GetUserFromRequest() user: User,
    @Param('id') id: string
  ) {
    assertNotImpersonating(req);
    return this._briefsService.cancel(org.id, id, user);
  }
}
