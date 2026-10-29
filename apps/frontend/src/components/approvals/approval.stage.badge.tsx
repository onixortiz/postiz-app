'use client';

import { FC } from 'react';
import clsx from 'clsx';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import type { ApprovalStage } from '@gitroom/frontend/components/approvals/use.approvals';

// FORK: approvals

const STAGE_CLASSES: Record<ApprovalStage, string> = {
  IN_PRODUCTION: 'bg-btnSimple text-newTextColor',
  IN_REVIEW: 'bg-approvalReview text-white',
  AWAITING_FINAL: 'bg-approvalFinal text-black',
  CHANGES_REQUESTED: 'bg-approvalChanges text-white',
  APPROVED: 'bg-btnPrimary text-white',
  PUBLISHED: 'bg-approvalPublished text-white',
  VERIFIED: 'bg-approvalVerified text-white',
  VERIFICATION_PROBLEM: 'bg-approvalProblem text-white',
};

export const useStageName = () => {
  const t = useT();
  return (stage: ApprovalStage) =>
    ({
      IN_PRODUCTION: t('approvals_stage_in_production', 'In production'),
      IN_REVIEW: t('approvals_stage_in_review', 'In review'),
      AWAITING_FINAL: t(
        'approvals_stage_awaiting_final',
        'Awaiting final approval'
      ),
      CHANGES_REQUESTED: t(
        'approvals_stage_changes_requested',
        'Changes requested'
      ),
      APPROVED: t('approvals_stage_approved', 'Approved'),
      PUBLISHED: t(
        'approvals_stage_published',
        'Published - waiting verification'
      ),
      VERIFIED: t('approvals_stage_verified', 'Verified'),
      VERIFICATION_PROBLEM: t(
        'approvals_stage_verification_problem',
        'Published with a problem'
      ),
    }[stage]);
};

export const ApprovalStageBadge: FC<{
  stage: ApprovalStage;
  expired?: boolean;
  size?: 'sm' | 'md';
}> = ({ stage, expired, size = 'md' }) => {
  const t = useT();
  const stageName = useStageName();
  return (
    <div className="flex items-center gap-[4px] min-w-0">
      <div
        className={clsx(
          'rounded-[4px] whitespace-nowrap overflow-hidden text-ellipsis font-[600]',
          size === 'sm'
            ? 'text-[10px] px-[4px] py-[1px]'
            : 'text-[12px] px-[8px] py-[2px]',
          STAGE_CLASSES[stage]
        )}
      >
        {stageName(stage)}
      </div>
      {expired && (
        <div
          className={clsx(
            'rounded-[4px] border border-approvalProblem text-approvalProblem whitespace-nowrap font-[600]',
            size === 'sm'
              ? 'text-[10px] px-[4px]'
              : 'text-[12px] px-[8px] py-[1px]'
          )}
        >
          {t('approvals_expired', 'Expired')}
        </div>
      )}
    </div>
  );
};
