'use client';

import { FC } from 'react';
import dayjs from 'dayjs';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import type { BatchDetail } from '@gitroom/nestjs-libraries/dtos/approvals/approval.actions.dto';

// FORK: approvals. The timeline of the batch: action, person, role, surface,
// local time and the comment or reason.
export const useActionName = () => {
  const t = useT();
  return (action: BatchDetail['history'][number]['action']) =>
    ({
      CREATED: t('approvals_action_created', 'Created'),
      LINKED_BRIEF: t('approvals_action_linked_brief', 'Topic linked'),
      SUBMITTED: t('approvals_action_submitted', 'Sent to review'),
      REVIEW_APPROVED: t('approvals_action_review_approved', 'Review approved'),
      FINAL_APPROVED: t('approvals_action_final_approved', 'Final approval'),
      REJECTED: t('approvals_action_rejected', 'Changes requested'),
      CONTENT_EDITED: t('approvals_action_content_edited', 'Content edited'),
      RESET_BY_EDIT: t(
        'approvals_action_reset_by_edit',
        'Back to review after an edit'
      ),
      DATE_CHANGED: t('approvals_action_date_changed', 'Date changed'),
      EXPIRED: t('approvals_action_expired', 'Expired without approval'),
      FORCED: t('approvals_action_forced', 'Publication forced'),
      PUBLISHED: t('approvals_action_published', 'Published'),
      VERIFIED: t('approvals_action_verified', 'Verified'),
      VERIFICATION_PROBLEM: t(
        'approvals_action_verification_problem',
        'Problem reported'
      ),
      BLOCKED: t('approvals_action_blocked', 'Scheduling blocked'),
      BLOCKED_AT_PUBLISH: t(
        'approvals_action_blocked_at_publish',
        'Publishing blocked'
      ),
      RECONCILED: t('approvals_action_reconciled', 'Unscheduled by the system'),
      CHANNEL_DISCARDED: t(
        'approvals_action_channel_discarded',
        'Channel discarded'
      ),
      ROLE_ASSIGNED: t('approvals_action_role_assigned', 'Role assigned'),
      ROLE_REMOVED: t('approvals_action_role_removed', 'Role removed'),
    }[action] || action);
};

export const useRoleName = () => {
  const t = useT();
  return (role: string) =>
    ({
      TECHNICAL_WRITER: t(
        'approvals_role_technical_writer',
        'Technical Writer'
      ),
      CREATOR: t('approvals_role_creator', 'Creator'),
      REVIEWER: t('approvals_role_reviewer', 'Reviewer'),
      MONTHLY_REVIEWER: t(
        'approvals_role_monthly_reviewer',
        'Monthly Reviewer'
      ),
      MEMBER: t('approvals_role_member', 'Member'),
      SYSTEM: t('approvals_role_system', 'System'),
    }[role] || role);
};

export const ApprovalHistory: FC<{ history: BatchDetail['history'] }> = ({
  history,
}) => {
  const t = useT();
  const actionName = useActionName();
  const roleName = useRoleName();

  return (
    <div className="flex flex-col gap-[10px]">
      <div className="text-[14px] font-[600]">
        {t('approvals_history', 'History')}
      </div>
      <div className="flex flex-col border-s border-newBorder ms-[4px]">
        {[...history].reverse().map((event, index) => (
          <div key={index} className="relative ps-[14px] pb-[12px]">
            <div className="absolute -start-[5px] top-[5px] w-[9px] h-[9px] rounded-full bg-btnPrimary" />
            <div className="text-[13px] font-[600]">
              {actionName(event.action)}
            </div>
            <div className="text-[12px] text-textItemBlur">
              {[
                event.actorName || roleName('SYSTEM'),
                roleName(event.actorRole),
                event.surface !== 'UNKNOWN' ? event.surface : null,
                dayjs(event.createdAt).format('YYYY-MM-DD HH:mm'),
              ]
                .filter((p) => p)
                .join(' · ')}
            </div>
            {!!event.reason && (
              <div className="text-[12px] mt-[2px] whitespace-pre-wrap break-words">
                {event.reason}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
