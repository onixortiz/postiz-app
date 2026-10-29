'use client';

import { FC } from 'react';
import clsx from 'clsx';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { useCalendar } from '@gitroom/frontend/components/launches/calendar.context';
import { useStageName } from '@gitroom/frontend/components/approvals/approval.stage.badge';
import type { ApprovalStage } from '@gitroom/frontend/components/approvals/use.approvals';

// FORK: approvals. The "Stage" filter of the calendar, kept in the url by
// setFilters.
const STAGES: ApprovalStage[] = [
  'IN_PRODUCTION',
  'IN_REVIEW',
  'AWAITING_FINAL',
  'CHANGES_REQUESTED',
  'APPROVED',
  'PUBLISHED',
  'VERIFIED',
  'VERIFICATION_PROBLEM',
];

export const ApprovalStageFilter: FC<{ list?: boolean }> = ({ list }) => {
  const t = useT();
  const { approvalsEnabled } = useVariables();
  const calendar = useCalendar();
  const stageName = useStageName();

  if (!approvalsEnabled) {
    return null;
  }

  return (
    <select
      aria-label={t('approvals_stage_filter', 'Stage')}
      value={calendar.approvalStage || ''}
      onChange={(e) =>
        calendar.setFilters({
          startDate: calendar.startDate,
          endDate: calendar.endDate,
          display: calendar.display as 'day' | 'week' | 'month' | 'list',
          customer: calendar.customer,
          approvalStage: (e.target.value as ApprovalStage) || null,
        })
      }
      className={clsx(
        'h-[42px] rounded-[8px] border border-newTableBorder bg-newBgColorInner px-[12px] text-[14px] outline-none cursor-pointer',
        list && 'w-full'
      )}
    >
      <option value="">{t('approvals_all_stages', 'All stages')}</option>
      {STAGES.map((stage) => (
        <option key={stage} value={stage}>
          {stageName(stage)}
        </option>
      ))}
    </select>
  );
};
