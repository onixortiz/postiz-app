import { Injectable } from '@nestjs/common';
import { Activity, ActivityMethod } from 'nestjs-temporal-core';
import { ApprovalSweepService } from '@gitroom/nestjs-libraries/database/prisma/approvals/approval.sweep.service';

// FORK: approvals
@Injectable()
@Activity()
export class ApprovalActivity {
  constructor(private _approvalSweepService: ApprovalSweepService) {}

  @ActivityMethod()
  async approvalSweep() {
    await this._approvalSweepService.run(new Date());
  }
}
