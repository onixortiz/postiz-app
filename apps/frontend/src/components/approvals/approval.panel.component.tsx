'use client';

import { FC, ReactNode, useCallback, useMemo, useState } from 'react';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import {
  ActionResult,
  ApprovalStage,
  useApprovalActions,
  useApprovalBatch,
  useApprovalStages,
  useWorkflowRoles,
  WorkflowRole,
} from '@gitroom/frontend/components/approvals/use.approvals';
import { ApprovalStageBadge } from '@gitroom/frontend/components/approvals/approval.stage.badge';
import { ApprovalHistory } from '@gitroom/frontend/components/approvals/approval.history.component';
import { TextPromptModal } from '@gitroom/frontend/components/approvals/quick.brief.modal';

// FORK: approvals. The approval side of the editor: the stage, the buttons the
// user can use with their roles, and the history of the batch.

const PRE_APPROVAL: ApprovalStage[] = [
  'IN_PRODUCTION',
  'CHANGES_REQUESTED',
  'IN_REVIEW',
  'AWAITING_FINAL',
];

const PanelButton: FC<{
  onClick: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'simple' | 'danger';
  children: ReactNode;
}> = ({ onClick, disabled, variant = 'simple', children }) => (
  <button
    type="button"
    disabled={disabled}
    onClick={onClick}
    className={
      'h-[36px] px-[14px] rounded-[8px] text-[13px] font-[600] disabled:opacity-50 disabled:cursor-not-allowed ' +
      (variant === 'primary'
        ? 'bg-btnPrimary text-white'
        : variant === 'danger'
        ? 'bg-red-600 text-white'
        : 'bg-btnSimple')
    }
  >
    {children}
  </button>
);

export const ApprovalPanel: FC<{ rootPostId?: string }> = ({ rootPostId }) => {
  const t = useT();
  const toaster = useToaster();
  const modals = useModals();
  const user = useUser();
  const actions = useApprovalActions();
  const [busy, setBusy] = useState(false);

  const { data: stages } = useApprovalStages(rootPostId ? [rootPostId] : []);
  const batchId = rootPostId ? stages?.[rootPostId]?.batchId : undefined;
  const { data: batch } = useApprovalBatch(batchId);
  const { data: members } = useWorkflowRoles();

  const roles = useMemo(
    () =>
      (members || []).find((p) => p.userId === user?.id)?.roles ||
      ([] as WorkflowRole[]),
    [members, user?.id]
  );

  const run = useCallback(
    async (action: () => Promise<ActionResult>, done: string) => {
      setBusy(true);
      const result = await action();
      setBusy(false);
      if (!result.ok) {
        toaster.show(
          result.message ||
            t('approvals_action_failed', 'The action could not be completed'),
          'warning'
        );
        return false;
      }
      toaster.show(done);
      return true;
    },
    [toaster, t]
  );

  const prompt = useCallback(
    (params: {
      title: string;
      label: string;
      submitLabel: string;
      minLength: number;
      maxLength: number;
      multiline?: boolean;
      onSubmit: (value: string) => Promise<boolean>;
    }) => {
      modals.openModal({
        title: params.title,
        withCloseButton: true,
        classNames: { modal: 'text-textColor' },
        children: (close) => (
          <TextPromptModal
            label={params.label}
            submitLabel={params.submitLabel}
            minLength={params.minLength}
            maxLength={params.maxLength}
            multiline={params.multiline}
            onSubmit={params.onSubmit}
            close={close}
          />
        ),
      });
    },
    [modals]
  );

  if (!rootPostId) {
    return (
      <div className="rounded-[12px] bg-newBgColor p-[16px] text-[13px] text-textItemBlur">
        {t(
          'approvals_save_first',
          'Save the post to send it to review. It stays a draft until it gets the final approval.'
        )}
      </div>
    );
  }

  if (!batch) {
    return null;
  }

  const { version, stage } = batch;
  const has = (role: WorkflowRole) => roles.includes(role);

  const submit = () => {
    if (batch.brief) {
      return run(
        () => actions.submit(batch.batchId, version),
        t('approvals_sent_to_review', 'Sent to review')
      );
    }
    prompt({
      title: t('approvals_send_to_review', 'Send to review'),
      label: t('approvals_quick_topic', 'Topic (one line)'),
      submitLabel: t('approvals_send_to_review', 'Send to review'),
      minLength: 1,
      maxLength: 140,
      onSubmit: (topic) =>
        run(
          () => actions.submit(batch.batchId, version, topic),
          t('approvals_sent_to_review', 'Sent to review')
        ),
    });
  };

  const withComment = (
    title: string,
    send: (comment: string) => Promise<ActionResult>,
    done: string,
    minLength = 3
  ) =>
    prompt({
      title,
      label: title,
      submitLabel: title,
      minLength,
      maxLength: 2000,
      multiline: true,
      onSubmit: (value) => run(() => send(value), done),
    });

  const buttons: ReactNode[] = [];
  if (
    (stage === 'IN_PRODUCTION' || stage === 'CHANGES_REQUESTED') &&
    has('CREATOR')
  ) {
    buttons.push(
      <PanelButton
        key="submit"
        variant="primary"
        disabled={busy}
        onClick={submit}
      >
        {t('approvals_send_to_review', 'Send to review')}
      </PanelButton>
    );
  }
  if (stage === 'IN_REVIEW' && has('REVIEWER')) {
    buttons.push(
      <PanelButton
        key="approve"
        variant="primary"
        disabled={busy}
        onClick={() =>
          run(
            () => actions.reviewApprove(batch.batchId, version),
            t(
              'approvals_review_done',
              'Approved, waiting for the final approval'
            )
          )
        }
      >
        {t('approvals_approve', 'Approve')}
      </PanelButton>
    );
  }
  if (stage === 'AWAITING_FINAL' && has('MONTHLY_REVIEWER')) {
    buttons.push(
      <PanelButton
        key="final"
        variant="primary"
        disabled={busy}
        onClick={() =>
          run(async () => {
            const result = await actions.finalApprove([
              { batchId: batch.batchId, version },
            ]);
            if (result.ok && !result.data?.[0]?.ok) {
              return { ok: false, message: result.data?.[0]?.error || '' };
            }
            return result;
          }, t('approvals_final_done', 'Approved and scheduled'))
        }
      >
        {t('approvals_final_approve', 'Final approval')}
      </PanelButton>
    );
  }
  if (
    (stage === 'IN_REVIEW' && has('REVIEWER')) ||
    (stage === 'AWAITING_FINAL' && has('MONTHLY_REVIEWER'))
  ) {
    buttons.push(
      <PanelButton
        key="reject"
        disabled={busy}
        onClick={() =>
          withComment(
            t('approvals_reject', 'Request changes'),
            (comment) => actions.reject(batch.batchId, version, comment),
            t('approvals_rejected', 'Changes requested')
          )
        }
      >
        {t('approvals_reject', 'Request changes')}
      </PanelButton>
    );
  }
  if (PRE_APPROVAL.includes(stage) && has('MONTHLY_REVIEWER')) {
    buttons.push(
      <PanelButton
        key="force"
        variant="danger"
        disabled={busy}
        onClick={() =>
          withComment(
            t('approvals_force', 'Force publication'),
            (reason) => actions.force(batch.batchId, version, reason),
            t('approvals_forced', 'Publication forced'),
            10
          )
        }
      >
        {t('approvals_force', 'Force publication')}
      </PanelButton>
    );
  }
  if (stage === 'PUBLISHED' && has('TECHNICAL_WRITER')) {
    buttons.push(
      <PanelButton
        key="verify"
        variant="primary"
        disabled={busy}
        onClick={() =>
          run(
            () => actions.verify(batch.batchId, version),
            t('approvals_verified', 'Verified')
          )
        }
      >
        {t('approvals_verify', 'Verify')}
      </PanelButton>,
      <PanelButton
        key="problem"
        disabled={busy}
        onClick={() =>
          withComment(
            t('approvals_mark_problem', 'Report a problem'),
            (comment) => actions.markProblem(batch.batchId, version, comment),
            t('approvals_problem_reported', 'Problem reported')
          )
        }
      >
        {t('approvals_mark_problem', 'Report a problem')}
      </PanelButton>
    );
  }

  return (
    <div className="rounded-[12px] bg-newBgColor p-[16px] flex flex-col gap-[16px]">
      <div className="flex items-center gap-[8px]">
        <div className="text-[14px] font-[600] flex-1">
          {t('approvals_title', 'Approval')}
        </div>
        <ApprovalStageBadge stage={stage} expired={batch.expired} />
      </div>
      {!!batch.brief && (
        <div className="text-[13px]">
          <span className="text-textItemBlur">
            {t('approvals_topic', 'Topic')}:{' '}
          </span>
          {batch.brief.topic}
        </div>
      )}
      {batch.forced && (
        <div className="text-[12px] text-red-400">
          {t(
            'approvals_was_forced',
            'This post was published without the full chain'
          )}
        </div>
      )}
      {!!buttons.length && (
        <div className="flex flex-col gap-[6px]">
          <div className="flex flex-wrap gap-[8px]">{buttons}</div>
          <div className="text-[12px] text-textItemBlur">
            {t(
              'approvals_saved_version_hint',
              'The actions use the last saved version: save your changes first.'
            )}
          </div>
        </div>
      )}
      <ApprovalHistory history={batch.history} />
    </div>
  );
};
