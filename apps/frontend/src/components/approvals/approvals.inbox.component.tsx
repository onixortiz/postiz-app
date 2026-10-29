'use client';

import { FC, useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import dayjs from 'dayjs';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { Button } from '@gitroom/react/form/button';
import {
  ApprovalStage,
  useApprovalActions,
  useApprovalInbox,
} from '@gitroom/frontend/components/approvals/use.approvals';
import {
  ApprovalStageBadge,
  useStageName,
} from '@gitroom/frontend/components/approvals/approval.stage.badge';

// FORK: approvals. "Waiting for me": the batches of the stages each role of
// the user works on. The Monthly Reviewer approves several at once.

const STAGE_ORDER: ApprovalStage[] = [
  'CHANGES_REQUESTED',
  'IN_PRODUCTION',
  'IN_REVIEW',
  'AWAITING_FINAL',
  'PUBLISHED',
];

export const ApprovalsInboxComponent: FC = () => {
  const t = useT();
  const toaster = useToaster();
  const stageName = useStageName();
  const actions = useApprovalActions();
  const { data, isLoading } = useApprovalInbox();
  const [selected, setSelected] = useState<string[]>([]);
  const [results, setResults] = useState<
    Record<string, { ok: boolean; error?: string }>
  >({});
  const [loading, setLoading] = useState(false);

  const groups = useMemo(
    () =>
      STAGE_ORDER.map((stage) => ({
        stage,
        items: (data || []).filter((p) => p.stage === stage),
      })).filter((p) => p.items.length),
    [data]
  );

  const toggle = useCallback(
    (batchId: string) =>
      setSelected((list) =>
        list.includes(batchId)
          ? list.filter((p) => p !== batchId)
          : [...list, batchId]
      ),
    []
  );

  const approveSelected = useCallback(async () => {
    setLoading(true);
    const result = await actions.finalApprove(
      (data || [])
        .filter((p) => selected.includes(p.batchId))
        .map((p) => ({ batchId: p.batchId, version: p.version }))
    );
    setLoading(false);
    if (!result.ok) {
      toaster.show(
        result.message ||
          t('approvals_action_failed', 'The action could not be completed'),
        'warning'
      );
      return;
    }
    const list = result.data || [];
    setResults(
      list.reduce(
        (all, p) => ({ ...all, [p.batchId]: { ok: p.ok, error: p.error } }),
        {}
      )
    );
    setSelected([]);
    const approved = list.filter((p) => p.ok).length;
    toaster.show(
      t('approvals_approved_count', '{{approved}} of {{total}} approved', {
        approved,
        total: list.length,
      }),
      approved === list.length ? 'success' : 'warning'
    );
  }, [actions, data, selected, toaster, t]);

  return (
    <div className="flex flex-col gap-[24px] p-[24px] mobile:p-[16px] flex-1 bg-newBgColorInner rounded-[12px]">
      <div className="flex items-center gap-[12px]">
        <h1 className="text-[22px] font-[600] flex-1">
          {t('approvals_inbox_title', 'Waiting for me')}
        </h1>
        {!!selected.length && (
          <Button loading={loading} onClick={approveSelected}>
            {t('approvals_approve_selected', 'Approve selected')} (
            {selected.length})
          </Button>
        )}
      </div>

      {!isLoading && !groups.length && (
        <div className="text-textItemBlur text-[14px]">
          {t(
            'approvals_inbox_empty',
            'Nothing is waiting for you. Ask an admin to assign you a workflow role in Settings > Team if you expected something here.'
          )}
        </div>
      )}

      {groups.map((group) => (
        <div key={group.stage} className="flex flex-col gap-[8px]">
          <div className="text-[15px] font-[600] text-textItemBlur">
            {stageName(group.stage)} ({group.items.length})
          </div>
          <div className="flex flex-col border border-newTableBorder rounded-[8px] overflow-hidden">
            {group.items.map((item) => (
              <div
                key={item.batchId}
                className="flex items-center gap-[12px] px-[16px] py-[12px] border-b border-newTableBorder last:border-b-0 mobile:flex-wrap"
              >
                {group.stage === 'AWAITING_FINAL' && (
                  <input
                    type="checkbox"
                    className="w-[16px] h-[16px] cursor-pointer"
                    checked={selected.includes(item.batchId)}
                    onChange={() => toggle(item.batchId)}
                    aria-label={t('approvals_select', 'Select')}
                  />
                )}
                <div className="flex-1 min-w-0 flex flex-col gap-[2px]">
                  <div className="text-[14px] font-[600] truncate">
                    {item.brief?.topic || t('approvals_no_topic', '(no topic)')}
                    {item.brief?.quickBrief && (
                      <span className="ms-[8px] text-[11px] text-textItemBlur font-[400]">
                        {t('approvals_quick_brief', 'Quick topic')}
                      </span>
                    )}
                  </div>
                  <div className="text-[12px] text-textItemBlur">
                    {t('approvals_channels_count', '{{count}} channels', {
                      count: item.posts.length,
                    })}{' '}
                    ·{' '}
                    {dayjs(item.earliestPublishDate).format('YYYY-MM-DD HH:mm')}
                  </div>
                  {!!results[item.batchId] && !results[item.batchId].ok && (
                    <div className="text-[12px] text-red-400">
                      {results[item.batchId].error}
                    </div>
                  )}
                </div>
                <ApprovalStageBadge stage={item.stage} expired={item.expired} />
                {!!item.posts[0] && (
                  <Link
                    href={`/launches?approvalGroup=${item.posts[0].group}`}
                    className="h-[32px] px-[12px] rounded-[8px] bg-btnSimple text-[13px] font-[600] flex items-center"
                  >
                    {t('approvals_open', 'Open')}
                  </Link>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
};
