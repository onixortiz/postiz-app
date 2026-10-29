import { BriefStatus } from '@prisma/client';
import {
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

// FORK: approvals

export class CreateBriefDto {
  @IsString()
  @MaxLength(200)
  topic: string;

  @IsOptional()
  @IsString()
  baseCopy?: string;

  @IsOptional()
  @IsDateString()
  targetDate?: string;

  @IsOptional()
  @IsString()
  assignedCreatorId?: string;
}

// null clears a field
export class UpdateBriefDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  topic?: string;

  @IsOptional()
  @IsString()
  baseCopy?: string | null;

  @IsOptional()
  @IsDateString()
  targetDate?: string | null;

  @IsOptional()
  @IsString()
  assignedCreatorId?: string | null;
}

export class ListBriefsQueryDto {
  @IsOptional()
  @IsEnum(BriefStatus)
  status?: BriefStatus;
}
