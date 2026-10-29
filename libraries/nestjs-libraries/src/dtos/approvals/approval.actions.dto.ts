import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import {
  ActorRole,
  ApprovalAction,
  ApprovalStage,
  CreationMethod,
  State,
  WorkflowRole,
} from '@prisma/client';

// FORK: approvals

export class VersionDto {
  @IsInt()
  @Min(0)
  version: number;
}

export class SubmitApprovalDto extends VersionDto {
  @IsOptional()
  @IsString()
  @MaxLength(140)
  quickTopic?: string;
}

export class RejectApprovalDto extends VersionDto {
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  comment: string;
}

export class FinalApproveItemDto extends VersionDto {
  @IsString()
  batchId: string;
}

export class FinalApproveDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @Type(() => FinalApproveItemDto)
  @ValidateNested({ each: true })
  items: FinalApproveItemDto[];
}

export class ForceApprovalDto extends VersionDto {
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  reason: string;
}

export class ProblemApprovalDto extends VersionDto {
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  comment: string;
}

export class LinkBriefDto extends VersionDto {
  @IsString()
  briefId: string;
}

export class StagesQueryDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsString({ each: true })
  @Transform(({ value }) =>
    Array.isArray(value) ? value : value ? String(value).split(',') : []
  )
  postIds: string[];
}

export class SetWorkflowRolesDto {
  @IsArray()
  @IsEnum(WorkflowRole, { each: true })
  roles: WorkflowRole[];
}

export interface InboxItem {
  batchId: string;
  version: number;
  stage: ApprovalStage;
  expired: boolean;
  brief: { id: string; topic: string; quickBrief: boolean } | null;
  earliestPublishDate: Date;
  posts: {
    id: string;
    group: string;
    integrationId: string;
    state: State;
    publishDate: Date;
  }[];
}

export interface BatchDetail {
  batchId: string;
  version: number;
  stage: ApprovalStage;
  expired: boolean;
  forced: boolean;
  brief: { id: string; topic: string; quickBrief: boolean } | null;
  posts: {
    id: string;
    group: string;
    integrationId: string;
    state: State;
    error: string | null;
    publishDate: Date;
  }[];
  history: {
    action: ApprovalAction;
    actorName: string | null;
    actorRole: ActorRole;
    surface: CreationMethod;
    reason: string | null;
    createdAt: Date;
  }[];
}

export interface RoleRow {
  userId: string;
  name: string;
  email: string;
  roles: WorkflowRole[];
}

export type StagesMap = Record<
  string,
  { batchId: string; stage: ApprovalStage; version: number; expired: boolean }
>;
