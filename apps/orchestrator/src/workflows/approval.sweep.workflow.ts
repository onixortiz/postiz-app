import {
  continueAsNew,
  proxyActivities,
  sleep,
  workflowInfo,
} from '@temporalio/workflow';
import { ApprovalActivity } from '@gitroom/orchestrator/activities/approval.activity';

// FORK: approvals. Expirations, warnings, the publication check and the
// reconciliation, every 15 minutes. With APPROVALS_ENABLED=false the activity
// does nothing, so turning the fork on again doesn't need a restart.
const { approvalSweep } = proxyActivities<ApprovalActivity>({
  startToCloseTimeout: '10 minute',
  retry: {
    maximumAttempts: 3,
    backoffCoefficient: 1,
    initialInterval: '1 minute',
  },
});

// a failed sweep (after its retries) waits for the next turn instead of
// ending the workflow, which only starts again when the backend restarts
async function sweepOnce() {
  try {
    await approvalSweep();
  } catch (err) {}
}

export async function approvalSweepWorkflow() {
  let loops = 0;
  await sweepOnce();
  while (true) {
    await sleep('15 minutes');

    // keep the history small, the new run sweeps right away
    if (++loops >= 96 || workflowInfo().historyLength > 1000) {
      return await continueAsNew<typeof approvalSweepWorkflow>();
    }

    await sweepOnce();
  }
}
