import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mock firebase/functions before importing adminReadService ───────────────
// Mirrors services/geminiService.test.ts's established pattern.

const mockCallable = vi.fn();
vi.mock('firebase/functions', () => ({
  getFunctions: vi.fn(() => ({})),
  httpsCallable: vi.fn(() => mockCallable),
}));
vi.mock('firebase/app', () => ({ getApp: vi.fn(() => ({})) }));

import {
  fetchAllUsers, fetchUserDetail, fetchReportsList, fetchAuditLogList,
  fetchPingsList, fetchParseFailuresList, fetchDashboardCounts,
  fetchStreetSchedules, fetchStreetIntelligenceHealth, appendSchedulePage,
} from './adminReadService';
import { httpsCallable } from 'firebase/functions';

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Callable name contract — every fetch* wires to the adminReadView callable,
// never a bespoke Function name (there is exactly one requireCurrentAdmin-gated
// read entry point) ─────────────────────────────────────────────────────────
describe('adminReadService — callable name contract', () => {
  it('every fetch* function calls the single "adminReadView" callable', async () => {
    mockCallable.mockResolvedValue({ data: { users: [], nextCursor: null, done: true } });
    await fetchAllUsers();
    mockCallable.mockResolvedValue({ data: { trustEvents: [], session: null, recentPings: [], reportsAgainst: [], reportsFiled: [], auditEntries: [], errors: {} } });
    await fetchUserDetail('u1');
    mockCallable.mockResolvedValue({ data: { reports: [], userMap: {}, nextCursor: null, done: true } });
    await fetchReportsList('pending');
    mockCallable.mockResolvedValue({ data: { entries: [] } });
    await fetchAuditLogList();
    mockCallable.mockResolvedValue({ data: { pings: [], userMap: {}, nextCursor: null, done: true } });
    await fetchPingsList('active');
    mockCallable.mockResolvedValue({ data: { failures: [] } });
    await fetchParseFailuresList();
    mockCallable.mockResolvedValue({ data: { totalUsers: 0, activePings: 0, activeSessions: 0, parseFailures: 0, needsReview: 0, reports: 0, recentUsers: [] } });
    await fetchDashboardCounts();
    mockCallable.mockResolvedValue({ data: { rules: [], nextCursor: null, done: true, segmentFound: true } });
    await fetchStreetSchedules('curb2_public');
    mockCallable.mockResolvedValue({ data: { totalSegments: 0, activeSegments: 0, sweepnycSegments: 0, adminSegments: 0, archivedSegments: 0, needsReviewSegments: 0, activeRules: 0 } });
    await fetchStreetIntelligenceHealth();

    expect(httpsCallable).toHaveBeenCalledWith(expect.anything(), 'adminReadView');
    // Never a bespoke per-view callable name — confirms no direct Firestore
    // or ad hoc callable was reintroduced for any migrated read.
    expect(httpsCallable).not.toHaveBeenCalledWith(expect.anything(), 'usersList');
    expect(httpsCallable).not.toHaveBeenCalledWith(expect.anything(), 'reportsList');
  });
});

// ─── View/param wiring ────────────────────────────────────────────────────────
describe('adminReadService — view name and param wiring', () => {
  it('fetchUserDetail sends view:userDetail with the requested uid', async () => {
    mockCallable.mockResolvedValue({ data: { trustEvents: [], session: null, recentPings: [], reportsAgainst: [], reportsFiled: [], auditEntries: [], errors: {} } });
    await fetchUserDetail('target-uid');
    expect(mockCallable).toHaveBeenCalledWith({ view: 'userDetail', params: { uid: 'target-uid' } });
  });

  it('fetchReportsList sends the requested status filter', async () => {
    mockCallable.mockResolvedValue({ data: { reports: [], userMap: {}, nextCursor: null, done: true } });
    await fetchReportsList('reviewed');
    expect(mockCallable).toHaveBeenCalledWith({
      view: 'reportsList',
      params: { status: 'reviewed', cursor: null, limit: 200 },
    });
  });

  it('fetchPingsList sends the requested ping filter', async () => {
    mockCallable.mockResolvedValue({ data: { pings: [], userMap: {}, nextCursor: null, done: true } });
    await fetchPingsList('recent');
    expect(mockCallable).toHaveBeenCalledWith({
      view: 'pingsList',
      params: { filter: 'recent', cursor: null, limit: 200 },
    });
  });

  it('fetchAuditLogList and fetchParseFailuresList and fetchDashboardCounts send no params', async () => {
    mockCallable.mockResolvedValue({ data: { entries: [] } });
    await fetchAuditLogList();
    expect(mockCallable).toHaveBeenLastCalledWith({ view: 'auditLogList', params: {} });

    mockCallable.mockResolvedValue({ data: { failures: [] } });
    await fetchParseFailuresList();
    expect(mockCallable).toHaveBeenLastCalledWith({ view: 'parseFailuresList', params: {} });

    mockCallable.mockResolvedValue({ data: { totalUsers: 0, activePings: 0, activeSessions: 0, parseFailures: 0, needsReview: 0, reports: 0, recentUsers: [] } });
    await fetchDashboardCounts();
    expect(mockCallable).toHaveBeenLastCalledWith({ view: 'dashboardCounts', params: {} });

    mockCallable.mockResolvedValue({ data: { rules: [], nextCursor: null, done: true, segmentFound: false } });
    await fetchStreetSchedules('curb2_public');
    expect(mockCallable).toHaveBeenLastCalledWith({
      view: 'streetScheduleList',
      params: { segmentId: 'curb2_public', cursor: null, limit: 100 },
    });
    await fetchStreetSchedules('curb2_public', 'rule-100');
    expect(mockCallable).toHaveBeenLastCalledWith({
      view: 'streetScheduleList',
      params: { segmentId: 'curb2_public', cursor: 'rule-100', limit: 100 },
    });
    expect(appendSchedulePage(
      [{ id: 'rule-001', type: null, schedules: [] }],
      [{ id: 'rule-001', type: null, schedules: [] }, { id: 'rule-101', type: null, schedules: [] }],
    ).map(rule => rule.id)).toEqual(['rule-001', 'rule-101']);

    mockCallable.mockResolvedValue({ data: { activeRules: 0 } });
    await fetchStreetIntelligenceHealth();
    expect(mockCallable).toHaveBeenLastCalledWith({ view: 'streetIntelligenceHealth', params: {} });
  });
});

// ─── Pagination looping — the core migrated behavior for usersList/
// reportsList/pingsList: the server bounds each call, the client reassembles
// the complete result exactly like the old unbounded/single direct query ────
describe('adminReadService — pagination looping and ordering', () => {
  it('fetchAllUsers loops multiple pages in returned order, with no duplicate call once done', async () => {
    mockCallable
      .mockResolvedValueOnce({ data: { users: [{ id: 'a' }, { id: 'b' }], nextCursor: 'b', done: false } })
      .mockResolvedValueOnce({ data: { users: [{ id: 'c' }], nextCursor: null, done: true } });

    const result = await fetchAllUsers();

    expect(result.map(u => u.id)).toEqual(['a', 'b', 'c']); // order preserved across pages
    expect(mockCallable).toHaveBeenCalledTimes(2);
    expect(mockCallable).toHaveBeenNthCalledWith(1, { view: 'usersList', params: { cursor: null, limit: 200 } });
    expect(mockCallable).toHaveBeenNthCalledWith(2, { view: 'usersList', params: { cursor: 'b', limit: 200 } });
  });

  it('fetchAllUsers makes exactly one call when the first page is already done', async () => {
    mockCallable.mockResolvedValueOnce({ data: { users: [{ id: 'only' }], nextCursor: null, done: true } });
    const result = await fetchAllUsers();
    expect(result).toEqual([{ id: 'only' }]);
    expect(mockCallable).toHaveBeenCalledTimes(1);
  });

  it('fetchReportsList aggregates reports across pages and merges userMap without losing earlier entries', async () => {
    mockCallable
      .mockResolvedValueOnce({
        data: {
          reports: [{ id: 'r1', reporterId: 'u1' }],
          userMap: { u1: { fullName: 'Alice' } },
          nextCursor: 'r1', done: false,
        },
      })
      .mockResolvedValueOnce({
        data: {
          reports: [{ id: 'r2', reporterId: 'u2' }],
          userMap: { u2: { fullName: 'Bob' } },
          nextCursor: null, done: true,
        },
      });

    const { reports, userMap } = await fetchReportsList('pending');

    expect(reports.map(r => r.id)).toEqual(['r1', 'r2']);
    expect(userMap.u1.fullName).toBe('Alice'); // first page's enrichment preserved
    expect(userMap.u2.fullName).toBe('Bob');   // second page's enrichment merged in
  });

  it('fetchPingsList aggregates pings across pages for the active filter', async () => {
    mockCallable
      .mockResolvedValueOnce({ data: { pings: [{ id: 'p1' }], userMap: {}, nextCursor: 'p1', done: false } })
      .mockResolvedValueOnce({ data: { pings: [{ id: 'p2' }], userMap: {}, nextCursor: null, done: true } });

    const { pings } = await fetchPingsList('active');
    expect(pings.map(p => p.id)).toEqual(['p1', 'p2']);
    expect(mockCallable).toHaveBeenCalledTimes(2);
  });

  it('fetchPingsList(\'all\') terminates in a single call (fixed bounded page, matches original limit(100))', async () => {
    mockCallable.mockResolvedValueOnce({ data: { pings: [{ id: 'p1' }], userMap: {}, nextCursor: null, done: true } });
    const { pings } = await fetchPingsList('all');
    expect(pings).toEqual([{ id: 'p1' }]);
    expect(mockCallable).toHaveBeenCalledTimes(1);
  });
});

// ─── userDetail bundle passthrough ────────────────────────────────────────────
describe('adminReadService — fetchUserDetail bundle passthrough', () => {
  it('returns every bundled section exactly as the callable provided it', async () => {
    const bundle = {
      trustEvents: [{ id: 't1' }],
      session: { active: true, streetName: 'Main St' },
      recentPings: [{ id: 'ping1' }],
      reportsAgainst: [{ id: 'rA' }],
      reportsFiled: [{ id: 'rF' }],
      auditEntries: [{ id: 'audit1' }],
      errors: {},
    };
    mockCallable.mockResolvedValue({ data: bundle });
    const result = await fetchUserDetail('u1');
    expect(result).toEqual(bundle);
  });
});

// ─── Error propagation — callable rejections must propagate to the caller
// (each admin page's own catch block is responsible for sanitized display;
// the service itself must not swallow or transform errors) ──────────────────
describe('adminReadService — error propagation', () => {
  it('a rejected callable rejects fetchAllUsers', async () => {
    mockCallable.mockRejectedValue(Object.assign(new Error('Admin only.'), { code: 'permission-denied' }));
    await expect(fetchAllUsers()).rejects.toThrow('Admin only.');
  });

  it('a rejected callable rejects fetchReportsList without altering the error message', async () => {
    mockCallable.mockRejectedValue(new Error('Admin only.'));
    await expect(fetchReportsList('pending')).rejects.toThrow('Admin only.');
  });

  it('a rejected callable rejects fetchDashboardCounts', async () => {
    mockCallable.mockRejectedValue(new Error('Admin only.'));
    await expect(fetchDashboardCounts()).rejects.toThrow('Admin only.');
  });
});
