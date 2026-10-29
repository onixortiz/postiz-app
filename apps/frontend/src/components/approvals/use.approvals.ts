'use client';

import { useCallback, useMemo } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useVariables } from '@gitroom/react/helpers/variable.context';
import type { ApprovalStage, BriefStatus, WorkflowRole } from '@prisma/client';
import type {
  BatchDetail,
  InboxItem,
  RoleRow,
  StagesMap,
} from '@gitroom/nestjs-libraries/dtos/approvals/approval.actions.dto';

// FORK: approvals. One SWR hook per resource, plus the actions, which are plain
// requests that revalidate what they change.

export type { ApprovalStage, BriefStatus, WorkflowRole };

export interface Brief {
  id: string;
  topic: string;
  baseCopy: string | null;
  targetDate: string | null;
  assignedCreatorId: string | null;
  status: BriefStatus;
  quickBrief: boolean;
  correctionOfApprovalId: string | null;
  createdById: string;
  createdAt: string;
  assignedCreator: {
    id: string;
    email: string;
    name: string | null;
    lastName: string | null;
  } | null;
  approvals: { batchId: string; stage: ApprovalStage }[];
}

// an error answer is an SWR error, never data
const read = async (response: Response) => {
  if (!response.ok) {
    throw new Error(`${response.status}`);
  }
  return response.json();
};

const chunk = <T>(list: T[], size: number) =>
  Array.from({ length: Math.ceil(list.length / size) }, (_, i) =>
    list.slice(i * size, (i + 1) * size)
  );

const swrOptions = {
  revalidateOnFocus: false,
  revalidateOnReconnect: false,
};

export const useApprovalInbox = () => {
  const fetch = useFetch();
  const { approvalsEnabled } = useVariables();
  const load = useCallback(async () => {
    return (await read(await fetch('/approvals/inbox'))) as InboxItem[];
  }, [fetch]);
  return useSWR(approvalsEnabled ? '/approvals/inbox' : null, load, swrOptions);
};

export const useApprovalBatch = (batchId?: string) => {
  const fetch = useFetch();
  const { approvalsEnabled } = useVariables();
  const load = useCallback(async () => {
    return (await read(
      await fetch(`/approvals/batch/${batchId}`)
    )) as BatchDetail;
  }, [batchId, fetch]);
  return useSWR(
    approvalsEnabled && batchId ? `/approvals/batch/${batchId}` : null,
    load,
    swrOptions
  );
};

// a POST: the key is derived from the sorted ids, so the same set of posts
// shares one request
export const useApprovalStages = (postIds: string[]) => {
  const fetch = useFetch();
  const { approvalsEnabled } = useVariables();
  const idsKey = [...new Set(postIds.filter((p) => p))].sort().join(',');
  const ids = useMemo(() => (idsKey ? idsKey.split(',') : []), [idsKey]);
  const load = useCallback(async () => {
    // the endpoint takes up to 500 ids per request
    const maps = await Promise.all(
      chunk(ids, 500).map(
        async (postIds) =>
          (await read(
            await fetch('/approvals/stages', {
              method: 'POST',
              body: JSON.stringify({ postIds }),
            })
          )) as StagesMap
      )
    );
    return Object.assign({}, ...maps) as StagesMap;
  }, [ids, fetch]);
  return useSWR(
    approvalsEnabled && ids.length ? `approvals-stages-${ids.join(',')}` : null,
    load,
    swrOptions
  );
};

export const useWorkflowRoles = () => {
  const fetch = useFetch();
  const { approvalsEnabled } = useVariables();
  const load = useCallback(async () => {
    return (await read(await fetch('/approvals/roles'))) as RoleRow[];
  }, [fetch]);
  return useSWR(approvalsEnabled ? '/approvals/roles' : null, load, swrOptions);
};

export const useBriefs = (status?: BriefStatus) => {
  const fetch = useFetch();
  const { approvalsEnabled } = useVariables();
  const path = status ? `/briefs?status=${status}` : '/briefs';
  const load = useCallback(async () => {
    return (await read(await fetch(path))) as Brief[];
  }, [path, fetch]);
  return useSWR(approvalsEnabled ? path : null, load, swrOptions);
};

export const useBrief = (id?: string | null) => {
  const fetch = useFetch();
  const { approvalsEnabled } = useVariables();
  const load = useCallback(async () => {
    return (await read(await fetch(`/briefs/${id}`))) as Brief;
  }, [id, fetch]);
  return useSWR(
    approvalsEnabled && id ? `/briefs/${id}` : null,
    load,
    swrOptions
  );
};

export interface ActionResult<T = any> {
  ok: boolean;
  data?: T;
  message?: string;
}

// the actions return the server message on failure, for the toasts
export const useApprovalActions = () => {
  const fetch = useFetch();
  const { mutate } = useSWRConfig();

  const refresh = useCallback(
    (batchId?: string) =>
      mutate(
        (key) =>
          typeof key === 'string' &&
          (key === '/approvals/inbox' ||
            key.startsWith('approvals-stages-') ||
            key.startsWith('/briefs') ||
            (!!batchId && key === `/approvals/batch/${batchId}`))
      ),
    [mutate]
  );

  const send = useCallback(
    async <T = any>(
      path: string,
      method: 'POST' | 'PUT' | 'DELETE',
      body?: any,
      batchId?: string
    ): Promise<ActionResult<T>> => {
      const response = await fetch(path, {
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const data = await response.json().catch(() => ({}));
      await refresh(batchId);
      if (!response.ok) {
        const message = Array.isArray(data?.message)
          ? data.message[0]
          : data?.message;
        return { ok: false, message: message || '' };
      }
      return { ok: true, data };
    },
    [refresh, fetch]
  );

  return useMemo(
    () => ({
      submit: (batchId: string, version: number, quickTopic?: string) =>
        send(
          `/approvals/batch/${batchId}/submit`,
          'POST',
          { version, ...(quickTopic ? { quickTopic } : {}) },
          batchId
        ),
      reviewApprove: (batchId: string, version: number) =>
        send(
          `/approvals/batch/${batchId}/review-approve`,
          'POST',
          { version },
          batchId
        ),
      reject: (batchId: string, version: number, comment: string) =>
        send(
          `/approvals/batch/${batchId}/reject`,
          'POST',
          { version, comment },
          batchId
        ),
      // several batches in one request, so each one is revalidated here
      finalApprove: (items: { batchId: string; version: number }[]) =>
        send<{ batchId: string; ok: boolean; error?: string }[]>(
          '/approvals/final-approve',
          'POST',
          { items }
        ).then(async (result) => {
          await Promise.all(
            items.map((p) => mutate(`/approvals/batch/${p.batchId}`))
          );
          return result;
        }),
      force: (batchId: string, version: number, reason: string) =>
        send(
          `/approvals/batch/${batchId}/force`,
          'POST',
          { version, reason },
          batchId
        ),
      verify: (batchId: string, version: number) =>
        send(
          `/approvals/batch/${batchId}/verify`,
          'POST',
          { version },
          batchId
        ),
      markProblem: (batchId: string, version: number, comment: string) =>
        send(
          `/approvals/batch/${batchId}/problem`,
          'POST',
          { version, comment },
          batchId
        ),
      linkBrief: (batchId: string, version: number, briefId: string) =>
        send(
          `/approvals/batch/${batchId}/link-brief`,
          'POST',
          { version, briefId },
          batchId
        ),
      setRoles: (userId: string, roles: WorkflowRole[]) =>
        send<RoleRow[]>(`/approvals/roles/${userId}`, 'PUT', { roles }).then(
          async (result) => {
            await mutate('/approvals/roles');
            return result;
          }
        ),
      createBrief: (body: Record<string, any>) =>
        send<Brief>('/briefs', 'POST', body),
      updateBrief: (id: string, body: Record<string, any>) =>
        send<Brief>(`/briefs/${id}`, 'PUT', body),
      cancelBrief: (id: string) => send<Brief>(`/briefs/${id}`, 'DELETE'),
      // the batches of the saved posts that have no topic yet get this one
      // true when every batch is linked or already had a topic
      linkSavedToBrief: async (postIds: string[], briefId: string) => {
        const response = await fetch('/approvals/stages', {
          method: 'POST',
          body: JSON.stringify({ postIds }),
        });
        if (!response.ok) {
          return false;
        }
        let linked = true;
        const stages = (await response.json()) as StagesMap;
        const batchIds = [
          ...new Set(Object.values(stages).map((p) => p.batchId)),
        ];
        for (const batchId of batchIds) {
          const answer = await fetch(`/approvals/batch/${batchId}`);
          if (!answer.ok) {
            linked = false;
            continue;
          }
          const batch = (await answer.json()) as BatchDetail;
          if (
            !batch.brief &&
            (batch.stage === 'IN_PRODUCTION' ||
              batch.stage === 'CHANGES_REQUESTED')
          ) {
            const result = await send(
              `/approvals/batch/${batchId}/link-brief`,
              'POST',
              { version: batch.version, briefId },
              batchId
            );
            linked = linked && result.ok;
          }
        }
        return linked;
      },
    }),
    [send, mutate, fetch]
  );
};
