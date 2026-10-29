import {
  Global,
  Injectable,
  Logger,
  Module,
  OnModuleInit,
} from '@nestjs/common';
import { TemporalService } from 'nestjs-temporal-core';
// FORK: approvals
import { ApprovalSweepService } from '@gitroom/nestjs-libraries/database/prisma/approvals/approval.sweep.service';

@Injectable()
export class InfiniteWorkflowRegister implements OnModuleInit {
  // FORK: approvals
  private readonly _logger = new Logger(InfiniteWorkflowRegister.name);

  constructor(
    private _temporalService: TemporalService,
    // FORK: approvals
    private _approvalSweepService: ApprovalSweepService
  ) {}

  async onModuleInit(): Promise<void> {
    if (!!process.env.RUN_CRON) {
      try {
        await this._temporalService.client
          ?.getRawClient()
          ?.workflow?.start('missingPostWorkflow', {
            workflowId: 'missing-post-workflow',
            taskQueue: 'main',
          });
      } catch (err) {}

      // FORK: approvals
      try {
        await this._temporalService.client
          ?.getRawClient()
          ?.workflow?.start('approvalSweepWorkflow', {
            workflowId: 'approval-sweep-workflow',
            taskQueue: 'main',
          });
      } catch (err) {}
    }

    // FORK: approvals - one reconciliation at start, in the background, on
    // the replica that runs the cron only
    if (process.env.APPROVALS_ENABLED === 'true') {
      if (!process.env.RUN_CRON) {
        this._logger.error(
          'APPROVALS_ENABLED is on but RUN_CRON is not set: the approval sweep will not run'
        );
        return;
      }
      this.reconcileOnStart().catch(() => undefined);
    }
  }

  // FORK: approvals - idempotent, so several replicas can run it at once
  private async reconcileOnStart(attempt = 1): Promise<void> {
    try {
      await this._approvalSweepService.reconcile({ startup: true });
    } catch (err) {
      if (attempt >= 3) {
        this._logger.error(
          'approval reconciliation at start failed',
          (err as Error)?.stack
        );
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 10000));
      return this.reconcileOnStart(attempt + 1);
    }
  }
}

@Global()
@Module({
  imports: [],
  controllers: [],
  providers: [InfiniteWorkflowRegister],
  get exports() {
    return this.providers;
  },
})
export class InfiniteWorkflowRegisterModule {}
