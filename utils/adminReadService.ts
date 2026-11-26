import { getFunctions, httpsCallable } from 'firebase/functions';
import { getApp } from 'firebase/app';

// Client wrapper for the requireCurrentAdmin-gated adminReadView callable
// (functions/index.js, view logic in functions/adminReadViews.js). Replaces
// the Admin Dashboard's former direct Firestore reads of users, reports,
// adminAuditLog, parkingSessions, parseFailures, and spots (admin branch) —
// all previously authorized only by firestore.rules' token-only isAdmin()
// check, which a stale admin token (demoted/deleted/disabled after the token
// was minted) could still pass. See firestore.rules for the corresponding
// removed read permissions.

async function callAdminReadView<T>(view: string, params: Record<string, unknown> = {}): Promise<T> {
  const fn = httpsCallable(getFunctions(getApp(), 'us-central1'), 'adminReadView');
  const res = await fn({ view, params });
  return res.data as T;
}

type UserMap = Record<string, { fullName?: string; username?: string; email?: string }>;

interface ListPage {
  nextCursor: string | null;
  done: boolean;
}

// Loops a paginated view until done, assembling the full item list and
// merging any per-page userMap enrichment — reconstructs exactly the same
// complete result the pre-migration unbounded/single direct Firestore query
// used to return in one call, while every individual server request stays
// bounded (mirrors the adminBackfillStreetIntelligence pagination pattern).
async function fetchAllPages<TPage extends ListPage, TItem>(
  view: string,
  baseParams: Record<string, unknown>,
  itemsKey: string,
): Promise<{ items: TItem[]; userMap: UserMap }> {
  const items: TItem[] = [];
  const userMap: UserMap = {};
  let cursor: string | null = null;
  let done = false;
  while (!done) {
    const page = await callAdminReadView<TPage & Record<string, any>>(view, { ...baseParams, cursor, limit: 200 });
    items.push(...page[itemsKey]);
    Object.assign(userMap, page.userMap ?? {});
    cursor = page.nextCursor;
    done = page.done;
  }
  return { items, userMap };
}

// Loops the paginated usersList view until done, assembling the full list —
// preserves UsersPage.tsx's existing client-side search/filter UX exactly.
export async function fetchAllUsers(): Promise<Record<string, any>[]> {
  const { items } = await fetchAllPages<ListPage, Record<string, any>>('usersList', {}, 'users');
  return items;
}

export function fetchUserDetail(uid: string): Promise<{
  trustEvents: Record<string, any>[];
  session: Record<string, any> | null;
  recentPings: Record<string, any>[];
  reportsAgainst: Record<string, any>[];
  reportsFiled: Record<string, any>[];
  auditEntries: Record<string, any>[];
  errors: Record<string, boolean>;
}> {
  return callAdminReadView('userDetail', { uid });
}

// reportsList is cursor-paginated server-side (the pre-migration client
// query had no limit() at all — see functions/adminReadViews.js); looping
// here reconstructs the exact old "every matching report" result.
export async function fetchReportsList(status: 'pending' | 'reviewed' | 'dismissed' | 'all'): Promise<{
  reports: Record<string, any>[];
  userMap: UserMap;
}> {
  const { items, userMap } = await fetchAllPages<ListPage, Record<string, any>>('reportsList', { status }, 'reports');
  return { reports: items, userMap };
}

export function fetchAuditLogList(): Promise<{ entries: Record<string, any>[] }> {
  return callAdminReadView('auditLogList');
}

// pingsList's 'active'/'claimed'/'recent' filters are cursor-paginated
// server-side (the pre-migration client query had no limit() for these —
// see functions/adminReadViews.js); looping reconstructs the exact old
// complete result. The 'all' filter is a fixed single bounded page
// (limit(100), matching the original client exactly) and returns
// done:true immediately, so this loop still terminates in one call for it.
export async function fetchPingsList(filter: 'active' | 'claimed' | 'recent' | 'all'): Promise<{
  pings: Record<string, any>[];
  userMap: UserMap;
}> {
  const { items, userMap } = await fetchAllPages<ListPage, Record<string, any>>('pingsList', { filter }, 'pings');
  return { pings: items, userMap };
}

export function fetchParseFailuresList(): Promise<{ failures: Record<string, any>[] }> {
  return callAdminReadView('parseFailuresList');
}

export interface AdminScheduleWindow {
  side: string | null;
  days: string[];
  startTime: string | null;
  endTime: string | null;
  type: string | null;
}

export interface AdminScheduleRule {
  id: string;
  type: string | null;
  schedules: AdminScheduleWindow[];
}

export function fetchStreetSchedules(segmentId: string, cursor: string | null = null): Promise<{
  rules: AdminScheduleRule[];
  nextCursor: string | null;
  done: boolean;
  segmentFound: boolean;
}> {
  return callAdminReadView('streetScheduleList', { segmentId, cursor, limit: 100 });
}

export function appendSchedulePage(current: AdminScheduleRule[], incoming: AdminScheduleRule[]): AdminScheduleRule[] {
  const seen = new Set(current.map(rule => rule.id));
  const next = current.slice();
  for (const rule of incoming) {
    if (seen.has(rule.id)) continue;
    seen.add(rule.id);
    next.push(rule);
  }
  return next;
}

export function fetchStreetIntelligenceHealth(): Promise<{
  totalSegments: number;
  activeSegments: number;
  sweepnycSegments: number;
  adminSegments: number;
  archivedSegments: number;
  needsReviewSegments: number;
  activeRules: number;
}> {
  return callAdminReadView('streetIntelligenceHealth');
}

export function fetchDashboardCounts(): Promise<{
  totalUsers: number;
  activePings: number;
  activeSessions: number;
  parseFailures: number;
  needsReview: number;
  reports: number;
  recentUsers: Record<string, any>[];
}> {
  return callAdminReadView('dashboardCounts');
}
