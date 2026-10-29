'use client';

import 'reflect-metadata';
import {
  createContext,
  FC,
  ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import dayjs from 'dayjs';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { Post, Integration, Tags } from '@prisma/client';
import { useSearchParams } from 'next/navigation';
import isoWeek from 'dayjs/plugin/isoWeek';
import weekOfYear from 'dayjs/plugin/weekOfYear';
import { extend } from 'dayjs';
import useCookie from 'react-use-cookie';
import {
  fromUtc,
  newDayjs,
} from '@gitroom/frontend/components/layout/set.timezone';
import { timer } from '@gitroom/helpers/utils/timer';
import { expandPostsList, expandPosts } from '@gitroom/helpers/utils/posts.list.minify';
// FORK: approvals
import {
  ApprovalStage,
  useApprovalStages,
} from '@gitroom/frontend/components/approvals/use.approvals';
import type { StagesMap } from '@gitroom/nestjs-libraries/dtos/approvals/approval.actions.dto';
import { useVariables } from '@gitroom/react/helpers/variable.context';
extend(isoWeek);
extend(weekOfYear);

export type ListStateFilter = 'all' | 'scheduled' | 'draft' | 'published';

export const CalendarContext = createContext({
  startDate: newDayjs().startOf('isoWeek').format('YYYY-MM-DD'),
  endDate: newDayjs().endOf('isoWeek').format('YYYY-MM-DD'),
  customer: null as string | null,
  loading: true,
  sets: [] as { name: string; id: string; content: string[] }[],
  signature: undefined as any,
  comments: [] as Array<{
    date: string;
    total: number;
  }>,
  integrations: [] as (Integrations & {
    refreshNeeded?: boolean;
  })[],
  trendings: [] as string[],
  posts: [] as Array<
    Post & {
      integration: Integration;
      tags: {
        tag: Tags;
      }[];
    }
  >,
  // the publish date of each post, in the user's timezone. Keyed by the post
  // itself, the occurrences of a recurring post share the same id
  postDates: new Map<object, dayjs.Dayjs>(),
  reloadCalendarView: () => {
    /** empty **/
  },
  display: 'week',
  setFilters: (filters: {
    startDate: string;
    endDate: string;
    display: 'week' | 'month' | 'day' | 'list';
    customer: string | null;
    // FORK: approvals
    approvalStage?: ApprovalStage | null;
  }) => {
    /** empty **/
  },
  // FORK: approvals
  approvalStage: null as ApprovalStage | null,
  stagesByPostId: {} as StagesMap,
  changeDate: (id: string, date: dayjs.Dayjs) => {
    /** empty **/
  },
  // List view specific
  listPosts: [] as Array<
    Post & {
      integration: Integration;
      tags: {
        tag: Tags;
      }[];
    }
  >,
  listPage: 0,
  listTotalPages: 0,
  setListPage: (page: number) => {
    /** empty **/
  },
  listState: 'all' as ListStateFilter,
  setListState: (state: ListStateFilter) => {
    /** empty **/
  },
  selectedChannels: null as string[] | null,
  setSelectedChannels: (channels: string[] | null) => {
    /** empty **/
  },
  currentHour: newDayjs().startOf('hour'),
});

export interface Integrations {
  name: string;
  originalName?: string;
  id: string;
  disabled?: boolean;
  inBetweenSteps: boolean;
  editor: 'none' | 'normal' | 'markdown' | 'html';
  stripLinks?: boolean;
  display: string;
  identifier: string;
  type: string;
  picture: string;
  changeProfilePicture: boolean;
  additionalSettings: string;
  changeNickName: boolean;
  time: {
    time: number;
  }[];
  customer?: {
    name?: string;
    id?: string;
  };
}

// Helper function to get start and end dates based on display type
function getDateRange(display: string, referenceDate?: string) {
  const date = referenceDate ? newDayjs(referenceDate) : newDayjs();

  switch (display) {
    case 'day':
      return {
        startDate: date.format('YYYY-MM-DD'),
        endDate: date.format('YYYY-MM-DD'),
      };
    case 'week':
      return {
        startDate: date.startOf('isoWeek').format('YYYY-MM-DD'),
        endDate: date.endOf('isoWeek').format('YYYY-MM-DD'),
      };
    case 'month':
      return {
        startDate: date.startOf('month').format('YYYY-MM-DD'),
        endDate: date.endOf('month').format('YYYY-MM-DD'),
      };
    default:
      return {
        startDate: date.startOf('isoWeek').format('YYYY-MM-DD'),
        endDate: date.endOf('isoWeek').format('YYYY-MM-DD'),
      };
  }
}

// The current time rounded down to the unit. It checks on every minute, so it
// also catches up within a minute after the computer wakes up from sleep.
export const useNow = (unit: 'minute' | 'hour' = 'minute') => {
  const [now, setNow] = useState(() => newDayjs().startOf(unit).valueOf());
  useEffect(() => {
    let timeout: NodeJS.Timeout;
    const tick = () => {
      // same number = no re-render, so the hour clock only renders once an hour
      setNow(newDayjs().startOf(unit).valueOf());
      timeout = setTimeout(tick, 60000 - (Date.now() % 60000));
    };
    tick();
    return () => clearTimeout(timeout);
  }, [unit]);
  return useMemo(() => newDayjs(now), [now]);
};

export const CalendarWeekProvider: FC<{
  children: ReactNode;
  integrations: Integrations[];
}> = ({ children, integrations }) => {
  const fetch = useFetch();
  const [internalData, setInternalData] = useState([] as any[]);
  const [trendings] = useState<string[]>([]);
  const searchParams = useSearchParams();
  // A 7-column week doesn't fit a phone, so default small screens (tailwind `mobile`) to the day view
  const [displaySaved, setDisplaySaved] = useCookie(
    'calendar-display',
    typeof window !== 'undefined' &&
      window.matchMedia('(max-width: 1025px)').matches
      ? 'day'
      : 'week'
  );
  const display = searchParams.get('display') || displaySaved;

  // List view state
  const [listPage, setListPage] = useState(0);
  const [listState, setListStateRaw] = useState<ListStateFilter>('all');
  const setListState = useCallback((next: ListStateFilter) => {
    setListStateRaw(next);
    setListPage(0);
  }, []);

  // Initialize with current date range based on URL params or defaults
  const initStartDate = searchParams.get('startDate');
  const initEndDate = searchParams.get('endDate');
  const initCustomer = searchParams.get('customer');
  // FORK: approvals
  const { approvalsEnabled } = useVariables();
  const [approvalStage, setApprovalStage] = useState<ApprovalStage | null>(
    approvalsEnabled
      ? (searchParams.get('approvalStage') as ApprovalStage) || null
      : null
  );
  // the calls that don't send a stage keep the current one
  const approvalStageRef = useRef(approvalStage);

  const initialRange =
    initStartDate && initEndDate
      ? { startDate: initStartDate, endDate: initEndDate }
      : getDateRange(display);

  const [selectedChannels, setSelectedChannelsRaw] = useState<
    string[] | null
  >(null);
  const setSelectedChannels = useCallback((next: string[] | null) => {
    setSelectedChannelsRaw(next);
    setListPage(0);
  }, []);

  const [filters, setFilters] = useState({
    startDate: initialRange.startDate,
    endDate: initialRange.endDate,
    customer: initCustomer || null,
    display,
  });

  useEffect(() => {
    setSelectedChannels(null);
  }, [filters.customer]);

  const params = useMemo(() => {
    return new URLSearchParams({
      display: filters.display,
      startDate: filters.startDate,
      endDate: filters.endDate,
      customer: filters?.customer?.toString() || '',
    }).toString();
  }, [filters]);

  // Calendar view data fetcher
  const loadData = useCallback(async () => {
    const modifiedParams = new URLSearchParams({
      display: filters.display,
      customer: filters?.customer?.toString() || '',
      startDate: newDayjs(filters.startDate).startOf('day').utc().format(),
      endDate: newDayjs(filters.endDate).endOf('day').utc().format(),
    }).toString();

    const data = await (await fetch(`/posts?${modifiedParams}`)).json();
    return expandPosts(data);
  }, [filters, params]);

  // List view data fetcher
  const listParams = useMemo(() => {
    return new URLSearchParams({
      page: listPage.toString(),
      limit: '100',
      customer: filters?.customer?.toString() || '',
      state: listState,
      ...(selectedChannels ? { integrations: selectedChannels.join(',') } : {}),
    }).toString();
  }, [listPage, filters.customer, listState, selectedChannels]);

  const loadListData = useCallback(async () => {
    const response = await fetch(`/posts/list?${listParams}`);
    return expandPostsList(await response.json());
  }, [listParams]);

  // SWR for calendar view
  const {
    data: calendarData,
    isLoading: calendarIsLoading,
    mutate: mutateCalendar,
  } = useSWR(
    filters.display !== 'list' ? `/posts-${params}` : null,
    loadData,
    {
      refreshInterval: 3600000,
      refreshWhenOffline: false,
      refreshWhenHidden: false,
      revalidateOnFocus: false,
    }
  );

  // SWR for list view
  const {
    data: listData,
    isLoading: listIsLoading,
    mutate: mutateList,
  } = useSWR(
    filters.display === 'list' ? `/posts-list-${listParams}` : null,
    loadListData,
    {
      refreshInterval: 3600000,
      refreshWhenOffline: false,
      refreshWhenHidden: false,
      revalidateOnFocus: false,
    }
  );

  const defaultSign = useCallback(async () => {
    return await (await fetch('/signatures/default')).json();
  }, []);

  const setList = useCallback(async () => {
    return (await fetch('/sets')).json();
  }, []);

  const { data: sets, mutate } = useSWR('sets', setList, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    revalidateOnMount: true,
    refreshWhenHidden: false,
    refreshWhenOffline: false,
  });
  const { data: sign } = useSWR('default-sign', defaultSign, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    revalidateOnMount: true,
    refreshWhenHidden: false,
    refreshWhenOffline: false,
  });

  const setFiltersWrapper = useCallback(
    (newFilters: {
      startDate: string;
      endDate: string;
      display: 'week' | 'month' | 'day' | 'list';
      customer: string | null;
      // FORK: approvals
      approvalStage?: ApprovalStage | null;
    }) => {
      const { approvalStage: sent, ...rest } = newFilters;
      // FORK: approvals
      const stage = sent === undefined ? approvalStageRef.current : sent;
      approvalStageRef.current = stage;
      setApprovalStage(stage);
      setDisplaySaved(newFilters.display);
      setFilters(rest);
      setInternalData([]);

      // Reset page when switching to list view
      if (newFilters.display === 'list') {
        setListPage(0);
      }

      const path = [
        `startDate=${newFilters.startDate}`,
        `endDate=${newFilters.endDate}`,
        `display=${newFilters.display}`,
        newFilters.customer ? `customer=${newFilters.customer}` : ``,
        // FORK: approvals
        stage ? `approvalStage=${stage}` : ``,
      ].filter((f) => f);
      window.history.replaceState(null, '', `/launches?${path.join('&')}`);
    },
    []
  );

  const posts = useMemo(() => calendarData?.posts || [], [calendarData?.posts]);
  const comments = useMemo(() => calendarData?.comments || [], [calendarData?.comments]);

  // FORK: approvals - one request for the stages of every visible post
  const { data: stagesByPostId, mutate: mutateStages } = useApprovalStages([
    ...posts.map((p: Post) => p.id),
    ...(listData?.posts || []).map((p: Post) => p.id),
  ]);

  const filterByChannels = useCallback(
    (list: any[]) =>
      (selectedChannels
        ? list.filter((p) => selectedChannels.includes(p.integration.id))
        : list
      ).filter(
        // FORK: approvals
        (p) => !approvalStage || stagesByPostId?.[p.id]?.stage === approvalStage
      ),
    [selectedChannels, approvalStage, stagesByPostId]
  );

  // List view data
  const listPosts = useMemo(
    () =>
      // FORK: approvals
      (listData?.posts || []).filter(
        (p: Post) =>
          !approvalStage || stagesByPostId?.[p.id]?.stage === approvalStage
      ),
    [listData?.posts, approvalStage, stagesByPostId]
  );
  const listTotal = listData?.total || 0;
  const listTotalPages = Math.ceil(listTotal / 100);

  const changeDate = useCallback(
    (id: string, date: dayjs.Dayjs) => {
      setInternalData((d) =>
        d.map((post: Post) => {
          if (post.id === id) {
            return {
              ...post,
              publishDate: date.utc().format('YYYY-MM-DDTHH:mm:ss'),
            };
          }
          return post;
        })
      );
    },
    [posts, internalData]
  );

  useEffect(() => {
    if (posts) {
      setInternalData(posts);
    }
  }, [posts]);

  // Combined reload function that handles both calendar and list views
  const reloadCalendarView = useCallback(() => {
    mutateCalendar();
    mutateList();
    // FORK: approvals - a save keeps the post ids, so the stages key stays
    mutateStages();
  }, [mutateCalendar, mutateList, mutateStages]);

  // Determine loading state based on current view
  const loading = filters.display === 'list' ? listIsLoading : calendarIsLoading;

  // one clock for every calendar cell, instead of a timer per cell
  const currentHour = useNow('hour');

  // every calendar cell looks for its posts in the whole list, so the dates
  // are parsed once here instead of in each cell
  const postDates = useMemo(
    () =>
      new Map<object, dayjs.Dayjs>(
        internalData.map((post: Post) => [post, fromUtc(post.publishDate)])
      ),
    [internalData]
  );

  return (
    <CalendarContext.Provider
      value={{
        trendings,
        reloadCalendarView,
        ...filters,
        posts: calendarIsLoading ? [] : filterByChannels(internalData),
        postDates,
        loading,
        integrations,
        setFilters: setFiltersWrapper,
        // FORK: approvals
        approvalStage,
        stagesByPostId: stagesByPostId || {},
        changeDate,
        comments,
        sets: sets || [],
        signature: sign,
        // List view specific
        listPosts,
        listPage,
        listTotalPages,
        setListPage,
        listState,
        setListState,
        selectedChannels,
        setSelectedChannels,
        currentHour,
      }}
    >
      {children}
    </CalendarContext.Provider>
  );
};

export const useCalendar = () => useContext(CalendarContext);
