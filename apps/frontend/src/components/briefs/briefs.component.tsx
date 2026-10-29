'use client';

import { FC, useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import dayjs from 'dayjs';
import { useT } from '@gitroom/react/translation/get.transation.service.client';
import { useToaster } from '@gitroom/react/toaster/toaster';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { Button } from '@gitroom/react/form/button';
import { deleteDialog } from '@gitroom/react/helpers/delete.dialog';
import {
  Brief,
  BriefStatus,
  useApprovalActions,
  useBriefs,
  useWorkflowRoles,
} from '@gitroom/frontend/components/approvals/use.approvals';

// FORK: approvals. The topics and base texts of the Technical Writer, before
// there is a post.

const STATUSES: BriefStatus[] = ['OPEN', 'IN_PRODUCTION', 'DONE', 'CANCELLED'];

const useStatusName = () => {
  const t = useT();
  return (status: BriefStatus) =>
    ({
      OPEN: t('approvals_brief_open', 'Open'),
      IN_PRODUCTION: t('approvals_brief_in_production', 'In production'),
      DONE: t('approvals_brief_done', 'Done'),
      CANCELLED: t('approvals_brief_cancelled', 'Cancelled'),
    }[status]);
};

const BriefForm: FC<{
  brief?: Brief;
  creators: { userId: string; name: string }[];
  close: () => void;
}> = ({ brief, creators, close }) => {
  const t = useT();
  const toaster = useToaster();
  const actions = useApprovalActions();
  const [loading, setLoading] = useState(false);
  const [values, setValues] = useState({
    topic: brief?.topic || '',
    baseCopy: brief?.baseCopy || '',
    targetDate: brief?.targetDate
      ? dayjs(brief.targetDate).format('YYYY-MM-DDTHH:mm')
      : '',
    assignedCreatorId: brief?.assignedCreatorId || '',
  });

  const save = async () => {
    setLoading(true);
    // on edit an emptied field is sent as null, so it is cleared
    const body = {
      topic: values.topic.trim(),
      baseCopy: values.baseCopy || (brief ? null : undefined),
      targetDate: values.targetDate
        ? dayjs(values.targetDate).toISOString()
        : brief
        ? null
        : undefined,
      assignedCreatorId: values.assignedCreatorId || (brief ? null : undefined),
    };
    const result = brief
      ? await actions.updateBrief(brief.id, body)
      : await actions.createBrief(body);
    setLoading(false);
    if (!result.ok) {
      toaster.show(
        result.message ||
          t('approvals_action_failed', 'The action could not be completed'),
        'warning'
      );
      return;
    }
    toaster.show(t('approvals_brief_saved', 'Topic saved'));
    close();
  };

  const field =
    'w-full rounded-[8px] bg-newBgColor border border-newBorder px-[12px] py-[10px] text-[14px] outline-none';

  return (
    <div className="flex flex-col gap-[12px] p-[16px] pt-0 min-w-[360px]">
      <label className="flex flex-col gap-[4px] text-[13px]">
        {t('approvals_topic', 'Topic')}
        <input
          className={field}
          maxLength={200}
          value={values.topic}
          onChange={(e) => setValues({ ...values, topic: e.target.value })}
        />
      </label>
      <label className="flex flex-col gap-[4px] text-[13px]">
        {t('approvals_base_copy', 'Base text')}
        <textarea
          className={field}
          rows={6}
          value={values.baseCopy}
          onChange={(e) => setValues({ ...values, baseCopy: e.target.value })}
        />
      </label>
      <label className="flex flex-col gap-[4px] text-[13px]">
        {t('approvals_target_date', 'Target date')}
        <input
          type="datetime-local"
          className={field}
          value={values.targetDate}
          onChange={(e) => setValues({ ...values, targetDate: e.target.value })}
        />
      </label>
      <label className="flex flex-col gap-[4px] text-[13px]">
        {t('approvals_assigned_creator', 'Creator')}
        <select
          className={field}
          value={values.assignedCreatorId}
          onChange={(e) =>
            setValues({ ...values, assignedCreatorId: e.target.value })
          }
        >
          <option value="">{t('approvals_anyone', 'Anyone')}</option>
          {creators.map((p) => (
            <option key={p.userId} value={p.userId}>
              {p.name}
            </option>
          ))}
        </select>
      </label>
      <Button loading={loading} disabled={!values.topic.trim()} onClick={save}>
        {t('approvals_save', 'Save')}
      </Button>
    </div>
  );
};

export const BriefsComponent: FC = () => {
  const t = useT();
  const toaster = useToaster();
  const modals = useModals();
  const user = useUser();
  const statusName = useStatusName();
  const actions = useApprovalActions();
  const [status, setStatus] = useState<BriefStatus | ''>('');
  const { data: briefs, isLoading } = useBriefs(status || undefined);
  const { data: members } = useWorkflowRoles();

  const myRoles = useMemo(
    () => (members || []).find((p) => p.userId === user?.id)?.roles || [],
    [members, user?.id]
  );
  const isWriter = myRoles.includes('TECHNICAL_WRITER');
  const creators = useMemo(
    () => (members || []).filter((p) => p.roles.includes('CREATOR')),
    [members]
  );

  const openForm = useCallback(
    (brief?: Brief) => {
      modals.openModal({
        title: brief
          ? t('approvals_edit_brief', 'Edit topic')
          : t('approvals_new_brief', 'New topic'),
        withCloseButton: true,
        classNames: { modal: 'text-textColor' },
        children: (close) => (
          <BriefForm brief={brief} creators={creators} close={close} />
        ),
      });
    },
    [modals, creators, t]
  );

  const cancel = useCallback(
    async (brief: Brief) => {
      if (
        !(await deleteDialog(
          t('approvals_cancel_brief_question', 'Cancel this topic?'),
          t('approvals_cancel_brief', 'Cancel topic')
        ))
      ) {
        return;
      }
      const result = await actions.cancelBrief(brief.id);
      if (!result.ok) {
        toaster.show(
          result.message ||
            t('approvals_action_failed', 'The action could not be completed'),
          'warning'
        );
      }
    },
    [actions, toaster, t]
  );

  return (
    <div className="flex flex-col gap-[24px] p-[24px] mobile:p-[16px] flex-1 bg-newBgColorInner rounded-[12px]">
      <div className="flex items-center gap-[12px] mobile:flex-wrap">
        <h1 className="text-[22px] font-[600] flex-1">
          {t('approvals_briefs_title', 'Topics')}
        </h1>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as BriefStatus | '')}
          className="h-[40px] rounded-[8px] bg-newBgColor border border-newBorder px-[12px] text-[14px] outline-none"
        >
          <option value="">{t('approvals_all', 'All')}</option>
          {STATUSES.map((p) => (
            <option key={p} value={p}>
              {statusName(p)}
            </option>
          ))}
        </select>
        {isWriter && (
          <Button onClick={() => openForm()}>
            {t('approvals_new_brief', 'New topic')}
          </Button>
        )}
      </div>

      {!isLoading && !briefs?.length && (
        <div className="text-textItemBlur text-[14px]">
          {t('approvals_no_briefs', 'There are no topics yet.')}
        </div>
      )}

      <div className="flex flex-col border border-newTableBorder rounded-[8px] overflow-hidden">
        {(briefs || []).map((brief) => {
          const canEdit =
            isWriter || (brief.quickBrief && brief.createdById === user?.id);
          const open =
            brief.status === 'OPEN' || brief.status === 'IN_PRODUCTION';
          return (
            <div
              key={brief.id}
              className="flex items-start gap-[12px] px-[16px] py-[12px] border-b border-newTableBorder last:border-b-0 mobile:flex-wrap"
            >
              <div className="flex-1 min-w-0 flex flex-col gap-[4px]">
                <div className="text-[14px] font-[600] flex items-center gap-[8px]">
                  <span className="truncate">{brief.topic}</span>
                  {brief.quickBrief && (
                    <span className="text-[11px] px-[6px] rounded-[4px] bg-btnSimple font-[400]">
                      {t('approvals_quick_brief', 'Quick topic')}
                    </span>
                  )}
                  {!!brief.correctionOfApprovalId && (
                    <span className="text-[11px] px-[6px] rounded-[4px] bg-red-600 text-white font-[400]">
                      {t('approvals_correction', 'Correction')}
                    </span>
                  )}
                </div>
                {!!brief.baseCopy && (
                  <div className="text-[13px] text-textItemBlur line-clamp-2 whitespace-pre-wrap">
                    {brief.baseCopy}
                  </div>
                )}
                <div className="text-[12px] text-textItemBlur">
                  {[
                    statusName(brief.status),
                    brief.targetDate
                      ? dayjs(brief.targetDate).format('YYYY-MM-DD HH:mm')
                      : null,
                    brief.assignedCreator
                      ? [
                          brief.assignedCreator.name,
                          brief.assignedCreator.lastName,
                        ]
                          .filter((p) => p)
                          .join(' ') || brief.assignedCreator.email
                      : null,
                    t('approvals_posts_count', '{{count}} posts', {
                      count: brief.approvals.length,
                    }),
                  ]
                    .filter((p) => p)
                    .join(' · ')}
                </div>
              </div>
              <div className="flex gap-[8px] flex-wrap">
                {open && (
                  <Link
                    href={`/launches?briefId=${brief.id}`}
                    className="h-[32px] px-[12px] rounded-[8px] bg-btnPrimary text-white text-[13px] font-[600] flex items-center"
                  >
                    {t(
                      'approvals_create_from_brief',
                      'Create post from this topic'
                    )}
                  </Link>
                )}
                {canEdit && open && (
                  <button
                    type="button"
                    onClick={() => openForm(brief)}
                    className="h-[32px] px-[12px] rounded-[8px] bg-btnSimple text-[13px] font-[600]"
                  >
                    {t('approvals_edit', 'Edit')}
                  </button>
                )}
                {isWriter && open && (
                  <button
                    type="button"
                    onClick={() => cancel(brief)}
                    className="h-[32px] px-[12px] rounded-[8px] bg-btnSimple text-red-400 text-[13px] font-[600]"
                  >
                    {t('approvals_cancel_brief', 'Cancel topic')}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
