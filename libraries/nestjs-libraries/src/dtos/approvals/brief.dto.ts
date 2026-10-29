import { IsDateString, IsOptional, IsString, MaxLength } from 'class-validator';

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

export class UpdateBriefDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  topic?: string;

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
