'use client';

import { FC, useEffect, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import { useCalendar } from '@gitroom/frontend/components/launches/calendar.context';
import { fromUtc } from '@gitroom/frontend/components/layout/set.timezone';
import { AddEditModal } from '@gitroom/frontend/components/new-launch/add.edit.modal';
import { usePostActions } from '@gitroom/frontend/components/launches/calendar';
import { useLaunchStore } from '@gitroom/frontend/components/new-launch/store';
import { useBrief } from '@gitroom/frontend/components/approvals/use.approvals';

// FORK: approvals. The editor is a modal that upstream only opens from the
// calendar: this opens it from a link, once on mount (setFiltersWrapper
// rewrites the url afterwards).
//   ?briefId=<id>       a new post with the base text of the topic
//   ?approvalGroup=<g>  an existing post, from the approvals inbox
export const OpenFromBrief: FC = () => {
  const { approvalsEnabled } = useVariables();
  const searchParams = useSearchParams();
  const initial = useRef({
    briefId: searchParams.get('briefId'),
    group: searchParams.get('approvalGroup'),
  });
  const opened = useRef(false);
  const fetch = useFetch();
  const modal = useModals();
  const { integrations, reloadCalendarView } = useCalendar();
  const setBriefId = useLaunchStore((state) => state.setBriefId);
  const { data: brief } = useBrief(
    approvalsEnabled ? initial.current.briefId : null
  );

  const ready = approvalsEnabled && integrations.length > 0;
  const { editPost } = usePostActions();

  // a reload doesn't open the editor again
  const dropParams = () => {
    const url = new URL(window.location.href);
    url.searchParams.delete('briefId');
    url.searchParams.delete('approvalGroup');
    window.history.replaceState(null, '', url.pathname + url.search);
  };

  // a new post from a topic
  useEffect(() => {
    if (!ready || !brief || opened.current) {
      return;
    }
    opened.current = true;
    dropParams();
    (async () => {
      const date = (await (await fetch('/posts/find-slot')).json()).date;
      // the editor store resets when the modal closes, so the topic is set
      // right before it opens
      setBriefId(brief.id);
      modal.openModal({
        id: 'add-edit-modal',
        closeOnClickOutside: false,
        removeLayout: true,
        closeOnEscape: false,
        withCloseButton: false,
        askClose: true,
        fullScreen: true,
        classNames: {
          modal: 'w-[100%] max-w-[1400px] text-textColor',
        },
        children: (
          <AddEditModal
            allIntegrations={integrations.map((p) => ({ ...p }))}
            {...(brief.baseCopy
              ? { onlyValues: [{ content: brief.baseCopy }] }
              : {})}
            reopenModal={() => undefined}
            mutate={reloadCalendarView}
            integrations={integrations}
            date={fromUtc(brief.targetDate || date)}
          />
        ),
        size: '80%',
        title: ``,
      });
    })();
  }, [
    ready,
    brief,
    fetch,
    integrations,
    modal,
    reloadCalendarView,
    setBriefId,
  ]);

  // an existing post, from the inbox: the same opener as the calendar
  useEffect(() => {
    const group = initial.current.group;
    if (!ready || !group || opened.current) {
      return;
    }
    opened.current = true;
    dropParams();
    editPost({ group })();
  }, [ready, editPost]);

  return null;
};
