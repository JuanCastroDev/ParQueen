import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi, beforeEach } from 'vitest';

// Plain Node environment — i18n reads localStorage at module load time.
vi.hoisted(() => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => { store.clear(); },
    };
});

vi.mock('../firebase', () => ({ db: {} }));
vi.mock('firebase/storage', () => ({
    getStorage: () => ({}),
    ref: () => ({}),
    uploadBytes: async () => ({}),
}));

let avatarModerationListener: ((snapshot: { data: () => any }) => void) | null = null;
let pendingAvatarUploadId: string | null = null;
let avatarUnsubscribeCalls = 0;

let spotsDocs: Array<{ id: string; data: () => any }> = [];
let feedbackDocs: Array<{ id: string; data: () => any }> = [];
let spotsFoundCount: number | 'reject' | 'hang' = 0;
const getDocsCalls: string[] = [];
const queryLog: Array<{ name: string; constraints: any[] }> = [];
const countQueryLog: Array<{ name: string; constraints: any[] }> = [];

vi.mock('firebase/firestore', () => ({
    doc: (..._args: any[]) => ({}),
    setDoc: async (_ref: any, data: any) => {
        if (data?.pendingUploadId) pendingAvatarUploadId = data.pendingUploadId;
    },
    serverTimestamp: () => ({}),
    onSnapshot: (_ref: any, callback: (snapshot: { data: () => any }) => void) => {
        avatarModerationListener = callback;
        return () => { avatarUnsubscribeCalls += 1; avatarModerationListener = null; };
    },
    collection: (_db: any, name: string) => ({ __name: name }),
    query: (base: any, ...constraints: any[]) => ({ __name: base.__name, __constraints: constraints }),
    where: (field: string, op: string, value: any) => ({ __kind: 'where', field, op, value }),
    orderBy: (field: string, direction?: string) => ({ __kind: 'orderBy', field, direction: direction ?? 'asc' }),
    limit: (n: number) => ({ __kind: 'limit', n }),
    getDocs: async (q: any) => {
        getDocsCalls.push(q.__name);
        queryLog.push({ name: q.__name, constraints: q.__constraints ?? [] });
        return { docs: q.__name === 'spots' ? spotsDocs : feedbackDocs };
    },
    getCountFromServer: async (q: any) => {
        countQueryLog.push({ name: q.__name, constraints: q.__constraints ?? [] });
        if (spotsFoundCount === 'reject') throw new Error('aggregation failed');
        if (spotsFoundCount === 'hang') return new Promise(() => { });
        return { data: () => ({ count: spotsFoundCount }) };
    },
}));

import { ProfileView, describeJourney } from './ProfileView';
import { AppView } from '../types';

function spotDoc(id: string, ts: number, overrides: any = {}) {
    return { id, data: () => ({ finderId: 'me', status: 'available', address: `spot-${id}`, reportedAt: { toMillis: () => ts }, ...overrides }) };
}

function feedbackDoc(id: string, ts: number, outcome: string = 'success') {
    return { id, data: () => ({ userId: 'me', outcome, address: `fb-${id}`, createdAt: { toMillis: () => ts } }) };
}

async function renderProfile(user: any, navCounts: { unreadMessagesCount?: number; pendingUpdatesCount?: number } = {}) {
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
        renderer = TestRenderer.create(React.createElement(ProfileView, { user, onBack: () => { }, setView: () => { }, ...navCounts }));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    return renderer!;
}

function impactNumbers(renderer: TestRenderer.ReactTestRenderer): string[] {
    return renderer.root.findAll(
        node => node.type === 'span' && node.props.className === 'pq-stat-value',
    ).map(n => String(n.props.children));
}

function pingsSharedQualifier(renderer: TestRenderer.ReactTestRenderer): string | undefined {
    const nodes = renderer.root.findAll(
        node => node.type === 'span' && typeof node.props.className === 'string' && node.props.className.includes('pq-stat-since'),
    );
    return nodes[0] ? String(nodes[0].props.children) : undefined;
}

function activityAddresses(renderer: TestRenderer.ReactTestRenderer): string[] {
    return renderer.root.findAll(
        node => node.type === 'span' && typeof node.props.className === 'string' && node.props.className.includes('pq-activity-address'),
    )
        .map(n => (Array.isArray(n.props.children) ? n.props.children.join('') : String(n.props.children)))
        .filter(s => s.includes('spot-') || s.includes('fb-'));
}

function queryFor(name: string) {
    return queryLog.find(q => q.name === name)?.constraints ?? [];
}

describe('ProfileView — mobile primary navigation', () => {
    it('keeps Profile selected on its primary root', async () => {
        const renderer = await renderProfile({ id: 'me' }, { unreadMessagesCount: 2, pendingUpdatesCount: 3 });
        const nav = renderer.root.findByProps({ 'aria-label': 'Primary navigation' });
        expect(nav.findByProps({ 'aria-label': 'Profile' }).props['aria-current']).toBe('page');
        expect(nav.findByProps({ 'aria-label': 'Messages, 2 unread' })).toBeDefined();
        expect(nav.findByProps({ 'aria-label': 'Nearby Activity, 3 new' })).toBeDefined();
        act(() => renderer.unmount());
    });

    it('removes the primary navigation while the Crowns dialog is open', async () => {
        const renderer = await renderProfile({ id: 'me' });
        const info = renderer.root.findByProps({ 'aria-label': 'What are crowns?' });
        act(() => info.props.onClick());
        expect(renderer.root.findAllByProps({ 'aria-label': 'Primary navigation' })).toHaveLength(0);
        expect(renderer.root.findByProps({ role: 'dialog' })).toBeDefined();
        act(() => renderer.unmount());
    });
});

describe('ProfileView — impact card sourcing', () => {
    beforeEach(() => {
        getDocsCalls.length = 0;
        queryLog.length = 0;
        countQueryLog.length = 0;
        spotsDocs = [];
        feedbackDocs = [];
        spotsFoundCount = 0;
    });

    it('CASE 1: Pings shared reads user.impactStats.pingsShared', async () => {
        const renderer = await renderProfile({ id: 'me', impactStats: { pingsShared: 9 } });
        const [pingsShared] = impactNumbers(renderer);
        expect(pingsShared).toBe('9');
        act(() => renderer.unmount());
    });

    it('CASE 2: missing impactStats renders Pings shared as 0 (card shown via another nonzero metric)', async () => {
        const renderer = await renderProfile({ id: 'me', trustStats: { handoffsCompleted: 1 } });
        const [pingsShared] = impactNumbers(renderer);
        expect(pingsShared).toBe('0');
        act(() => renderer.unmount());
    });

    it('CASE 6: Successful handoffs still reads trustStats.handoffsCompleted', async () => {
        const renderer = await renderProfile({ id: 'me', trustStats: { handoffsCompleted: 11 }, impactStats: { pingsShared: 1 } });
        const [, successfulHandoffs] = impactNumbers(renderer);
        expect(successfulHandoffs).toBe('11');
        act(() => renderer.unmount());
    });

    it('20 / 21: Spots found displays the aggregation number exactly, including a count larger than 3', async () => {
        spotsFoundCount = 42;
        const renderer = await renderProfile({ id: 'me' });
        const numbers = impactNumbers(renderer);
        expect(numbers[2]).toBe('42');
        act(() => renderer.unmount());
    });

    it('22: a zero Spots found count displays 0 correctly', async () => {
        spotsFoundCount = 0;
        const renderer = await renderProfile({ id: 'me', trustStats: { handoffsCompleted: 1 } });
        const numbers = impactNumbers(renderer);
        expect(numbers[2]).toBe('0');
        act(() => renderer.unmount());
    });

    it('9/10: the tracking-boundary qualifier is rendered and distinct from the bare "Pings shared" label', async () => {
        const renderer = await renderProfile({ id: 'me', impactStats: { pingsShared: 5 } });
        const qualifier = pingsSharedQualifier(renderer);
        expect(qualifier).toBeDefined();
        expect(qualifier).toMatch(/2026/);
        expect(qualifier).not.toBe('Pings shared');
        act(() => renderer.unmount());
    });

    it('does not introduce any additional Firestore query — exactly one spots read, one feedback read, one count aggregation', async () => {
        await renderProfile({ id: 'me', impactStats: { pingsShared: 5 }, trustStats: { handoffsCompleted: 5 } });
        expect(getDocsCalls.filter(c => c === 'spots').length).toBe(1);
        expect(getDocsCalls.filter(c => c === 'spotFeedback').length).toBe(1);
        expect(countQueryLog.length).toBe(1);
    });

    it('source contract: deriveImpactCounts is called with the aggregation-sourced spotsFound, not a feedback array', async () => {
        const fs = require('fs');
        const source = fs.readFileSync(new URL('./ProfileView.tsx', import.meta.url), 'utf8');
        const callStart = source.indexOf('const counts = deriveImpactCounts(');
        const callEnd = source.indexOf(');', callStart);
        const call = source.slice(callStart, callEnd);

        expect(call).not.toMatch(/allFeedback|recentFeedback\.filter/);
        expect(call).toMatch(/spotsFound/);
    });
});

describe('ProfileView — RecentActivity bounded queries', () => {
    beforeEach(() => {
        getDocsCalls.length = 0;
        queryLog.length = 0;
        countQueryLog.length = 0;
        spotsDocs = [];
        feedbackDocs = [];
        spotsFoundCount = 0;
    });

    it('1: spots query — finderId ==, orderBy reportedAt desc, limit 3', async () => {
        await renderProfile({ id: 'me' });
        expect(queryFor('spots')).toEqual([
            { __kind: 'where', field: 'finderId', op: '==', value: 'me' },
            { __kind: 'orderBy', field: 'reportedAt', direction: 'desc' },
            { __kind: 'limit', n: 3 },
        ]);
    });

    it('2: feedback query (RecentActivity source) — userId ==, orderBy createdAt desc, limit 3', async () => {
        await renderProfile({ id: 'me' });
        expect(queryFor('spotFeedback')).toEqual([
            { __kind: 'where', field: 'userId', op: '==', value: 'me' },
            { __kind: 'orderBy', field: 'createdAt', direction: 'desc' },
            { __kind: 'limit', n: 3 },
        ]);
    });

    it('3: the RecentActivity feedback query has no outcome filter', async () => {
        await renderProfile({ id: 'me' });
        expect(queryFor('spotFeedback').some((c: any) => c.field === 'outcome')).toBe(false);
    });

    it('4: the Spots found count query — userId == and outcome == success, no orderBy, no limit', async () => {
        await renderProfile({ id: 'me' });
        expect(countQueryLog[0].constraints).toEqual([
            { __kind: 'where', field: 'userId', op: '==', value: 'me' },
            { __kind: 'where', field: 'outcome', op: '==', value: 'success' },
        ]);
    });

    it('5: the count query has no limit(3)', async () => {
        await renderProfile({ id: 'me' });
        expect(countQueryLog[0].constraints.some((c: any) => c.__kind === 'limit')).toBe(false);
    });

    it('6: the count query has no createdAt orderBy', async () => {
        await renderProfile({ id: 'me' });
        expect(countQueryLog[0].constraints.some((c: any) => c.__kind === 'orderBy')).toBe(false);
    });

    it('7: 5+ historical feedback docs with successes older than the newest-3 window — Spots found still returns the full aggregation count', async () => {
        // The mock's spotsDocs/feedbackDocs represent what a real bounded
        // query would already have limited server-side; the aggregation is
        // deliberately configured independently and larger than 3 to prove
        // it is NOT derived from whatever RecentActivity happens to fetch.
        const now = Date.now();
        feedbackDocs = [feedbackDoc('new1', now - 1000), feedbackDoc('new2', now - 2000), feedbackDoc('new3', now - 3000)];
        spotsFoundCount = 7; // 2 older successes exist beyond the newest-3 window
        const renderer = await renderProfile({ id: 'me' });
        const numbers = impactNumbers(renderer);
        expect(numbers[2]).toBe('7');
        act(() => renderer.unmount());
    });

    it('8: failure feedback can still appear in RecentActivity', async () => {
        const now = Date.now();
        feedbackDocs = [feedbackDoc('x', now - 1000, 'failed')];
        const renderer = await renderProfile({ id: 'me' });
        expect(activityAddresses(renderer)).toEqual(['fb-x']);
        act(() => renderer.unmount());
    });

    it('9: failure feedback does not contribute to Spots found (count is independent, aggregation-only)', async () => {
        const now = Date.now();
        feedbackDocs = [feedbackDoc('x', now - 1000, 'failed')];
        spotsFoundCount = 0;
        // hasImpact requires at least one nonzero metric to render the card
        // at all — trustStats supplies that here so spotsFound: 0 is observable.
        const renderer = await renderProfile({ id: 'me', trustStats: { handoffsCompleted: 1 } });
        const numbers = impactNumbers(renderer);
        expect(numbers[2]).toBe('0');
        act(() => renderer.unmount());
    });

    it('10: RecentActivity contains only the newest 3 across both sources', async () => {
        const now = Date.now();
        spotsDocs = [spotDoc('a', now - 1000), spotDoc('b', now - 2000)];
        feedbackDocs = [feedbackDoc('x', now - 3000), feedbackDoc('y', now - 4000)];
        const renderer = await renderProfile({ id: 'me' });
        expect(activityAddresses(renderer)).toEqual(['spot-a', 'spot-b', 'fb-x']);
        act(() => renderer.unmount());
    });

    it('11: mixed ordering — newest combined top 3 remains correct', async () => {
        const now = Date.now();
        spotsDocs = [spotDoc('a', now - 2000)];
        feedbackDocs = [feedbackDoc('x', now - 1000), feedbackDoc('y', now - 3000)];
        const renderer = await renderProfile({ id: 'me' });
        expect(activityAddresses(renderer)).toEqual(['fb-x', 'spot-a', 'fb-y']);
        act(() => renderer.unmount());
    });

    it('12: an exact timestamp tie preserves spot-before-feedback ordering', async () => {
        const now = Date.now();
        spotsDocs = [spotDoc('a', now)];
        feedbackDocs = [feedbackDoc('x', now)];
        const renderer = await renderProfile({ id: 'me' });
        expect(activityAddresses(renderer)).toEqual(['spot-a', 'fb-x']);
        act(() => renderer.unmount());
    });

    it('13: one source empty', async () => {
        const now = Date.now();
        feedbackDocs = [feedbackDoc('x', now - 1000)];
        const renderer = await renderProfile({ id: 'me' });
        expect(activityAddresses(renderer)).toEqual(['fb-x']);
        act(() => renderer.unmount());
    });

    it('14: both sources fewer than 3 total', async () => {
        const now = Date.now();
        spotsDocs = [spotDoc('a', now - 1000)];
        const renderer = await renderProfile({ id: 'me' });
        expect(activityAddresses(renderer)).toEqual(['spot-a']);
        act(() => renderer.unmount());
    });

    it('15/16/17: a rejected count aggregation does not show a fake zero, does not fall back to the recent-feedback success count, and reaches the existing Profile error state', async () => {
        feedbackDocs = [feedbackDoc('x', Date.now(), 'success')]; // would wrongly suggest "1" if used as a fallback
        spotsFoundCount = 'reject';
        const renderer = await renderProfile({ id: 'me' });
        // hasImpact requires impactState === 'loaded'; on error it never
        // reaches 'loaded', so the whole impact card (and any number,
        // correct or not) never renders at all.
        expect(impactNumbers(renderer)).toEqual([]);
        act(() => renderer.unmount());
    });
});

describe('ProfileView — journey math', () => {
    it('describeJourney: the band, target and percentage come from the existing thresholds', () => {
        expect(describeJourney(0)).toMatchObject({ tier: 0, from: 0, to: 10, pct: 0 });
        expect(describeJourney(1)).toMatchObject({ tier: 0, from: 0, to: 10, pct: 10 });
        expect(describeJourney(1).next).toMatchObject({ title: 'Trusted Driver', crownsNeeded: 9 });
        expect(describeJourney(10)).toMatchObject({ tier: 1, from: 10, to: 50, pct: 0 });
        expect(describeJourney(30)).toMatchObject({ tier: 1, from: 10, to: 50, pct: 50 });
    });

    it('describeJourney: at the highest title there is no next step and the bar is full', () => {
        for (const crowns of [3000, 9999]) {
            const j = describeJourney(crowns);
            expect(j.next).toBeNull();
            expect(j.tier).toBe(7);
            expect(j.pct).toBe(100);
        }
    });
});

describe('ProfileView — revamped screen', () => {
    beforeEach(() => {
        getDocsCalls.length = 0;
        queryLog.length = 0;
        countQueryLog.length = 0;
        spotsDocs = [];
        feedbackDocs = [];
        spotsFoundCount = 0;
    });

    const textOf = (n: any): string => typeof n === 'string' ? n : (n?.children ?? []).map(textOf).join('');
    const buttonNamed = (r: TestRenderer.ReactTestRenderer, label: string) =>
        r.root.findAll(n => n.type === 'button' && (n.props['aria-label'] === label || textOf(n).includes(label)))[0];
    const baseUser = { id: 'me', username: 'MainProfileTest', crowns: 1, title: 'Newcomer', impactStats: { pingsShared: 11 } };

    it('has exactly one h1, and it names the screen', async () => {
        const r = await renderProfile(baseUser);
        const h1s = r.root.findAllByType('h1');
        expect(h1s).toHaveLength(1);
        expect(textOf(h1s[0])).toBe('Profile');
        act(() => r.unmount());
    });

    it('Back is hidden on phones (bottom-nav tab) and kept for md+ where the nav is hidden', async () => {
        const r = await renderProfile(baseUser);
        const back = r.root.findByProps({ 'aria-label': 'Back' });
        expect(back.props.className).toMatch(/(^|\s)hidden(\s|$)/);
        expect(back.props.className).toContain('md:flex');
        act(() => r.unmount());
    });

    it('Settings is labelled and still navigates to Settings', async () => {
        const setView = vi.fn();
        const r = await renderProfile(baseUser, { setView } as any);
        act(() => r.root.findByProps({ 'aria-label': 'Settings' }).props.onClick());
        expect(setView).toHaveBeenCalledWith(AppView.SETTINGS);
        act(() => r.unmount());
    });

    it('the identity line carries the title and a correctly pluralised crown count', async () => {
        const one = await renderProfile(baseUser);
        expect(textOf(one.toJSON())).toContain('Newcomer·1 Crown');
        act(() => one.unmount());
        const many = await renderProfile({ ...baseUser, crowns: 12, title: 'Trusted Driver' });
        expect(textOf(many.toJSON())).toContain('Trusted Driver·12 Crowns');
        act(() => many.unmount());
    });

    it('the progress bar exposes the real band and "N to go"', async () => {
        const r = await renderProfile(baseUser);
        const bar = r.root.findByProps({ role: 'progressbar' });
        expect(bar.props['aria-valuemin']).toBe(0);
        expect(bar.props['aria-valuemax']).toBe(10);
        expect(bar.props['aria-valuenow']).toBe(1);
        expect(bar.props['aria-valuetext']).toBe('1 of 10 crowns toward Trusted Driver');
        expect(textOf(r.toJSON())).toContain('9 crowns to go');
        act(() => r.unmount());
    });

    it('one crown short reads "1 crown to go"', async () => {
        const r = await renderProfile({ ...baseUser, crowns: 9 });
        expect(textOf(r.toJSON())).toContain('1 crown to go');
        act(() => r.unmount());
    });

    it('the highest title renders a completed state instead of "to go"', async () => {
        const r = await renderProfile({ ...baseUser, crowns: 3200, title: 'Urban Legend' });
        const text = textOf(r.toJSON());
        expect(text).toContain('Urban Legend — max rank achieved');
        expect(text).not.toMatch(/to go/);
        expect(r.root.findByProps({ role: 'progressbar' }).props['aria-valuenow']).toBe(100);
        act(() => r.unmount());
    });

    it('all-zero impact still renders three intentional zeros', async () => {
        const r = await renderProfile({ id: 'me', crowns: 0 });
        expect(impactNumbers(r)).toEqual(['0', '0', '0']);
        act(() => r.unmount());
    });

    it('a count of one uses the singular label', async () => {
        spotsFoundCount = 1;
        const r = await renderProfile({ id: 'me', impactStats: { pingsShared: 1 }, trustStats: { handoffsCompleted: 1 } });
        const text = textOf(r.toJSON());
        expect(text).toContain('Ping shared');
        expect(text).toContain('Successful handoff');
        expect(text).toContain('Spot found');
        expect(text).not.toContain('Spots found');
        act(() => r.unmount());
    });

    it('while counts load, no number and no empty state is shown', async () => {
        spotsFoundCount = 'hang';
        const r = await renderProfile(baseUser);
        expect(impactNumbers(r)).toEqual([]);
        expect(textOf(r.toJSON())).not.toContain('No recent activity yet');
        act(() => r.unmount());
    });

    it('a failed load says so instead of claiming there is no activity', async () => {
        spotsFoundCount = 'reject';
        const r = await renderProfile(baseUser);
        const text = textOf(r.toJSON());
        expect(text).toContain('Could not load activity counts');
        expect(text).toContain('Couldn’t load recent activity.');
        expect(text).not.toContain('No recent activity yet');
        act(() => r.unmount());
    });

    it('an existing vehicle reads colour + make over type, and opens the vehicle editor', async () => {
        const setView = vi.fn();
        const r = await renderProfile({ ...baseUser, vehicleBrand: 'Alfa Romeo', vehicleColor: 'Yellow', vehicleType: 'Compact' }, { setView } as any);
        const row = buttonNamed(r, 'Yellow Alfa Romeo');
        expect(textOf(row)).toContain('Compact');
        act(() => row.props.onClick());
        expect(setView).toHaveBeenCalledWith(AppView.EDIT_VEHICLE);
        act(() => r.unmount());
    });

    it('no vehicle renders the add state, still through the vehicle editor', async () => {
        const setView = vi.fn();
        const r = await renderProfile(baseUser, { setView } as any);
        const row = buttonNamed(r, 'No vehicle added');
        expect(row).toBeDefined();
        act(() => row.props.onClick());
        expect(setView).toHaveBeenCalledWith(AppView.EDIT_VEHICLE);
        act(() => r.unmount());
    });

    it('a type-only vehicle shows the type and keeps the incomplete-setup prompt', async () => {
        const r = await renderProfile({ ...baseUser, vehicleType: 'SUV' });
        expect(buttonNamed(r, 'SUV')).toBeDefined();
        expect(buttonNamed(r, 'Complete your vehicle setup')).toBeDefined();
        act(() => r.unmount());
    });

    it('recent activity lists real events with their reward, and View all opens the full list', async () => {
        const setView = vi.fn();
        const now = Date.now();
        feedbackDocs = [feedbackDoc('x', now - 38 * 86_400_000)];
        const r = await renderProfile(baseUser, { setView } as any);
        const text = textOf(r.toJSON());
        expect(text).toContain('Parked');
        expect(text).toContain('38d ago');
        expect(r.root.findAll(n => n.props['aria-label'] === '+1 Crown')).toHaveLength(1);
        act(() => buttonNamed(r, 'View all activity').props.onClick());
        expect(setView).toHaveBeenCalledWith(AppView.PARKING_SPACE);
        act(() => r.unmount());
    });

    it('empty recent activity shows the small empty state', async () => {
        const r = await renderProfile(baseUser);
        expect(textOf(r.toJSON())).toContain('No recent activity yet');
        act(() => r.unmount());
    });

    it('a long username is truncated on one line with the full name available', async () => {
        const long = 'averyveryverylongusername_thatkeepsgoing_andgoing';
        const r = await renderProfile({ ...baseUser, username: long });
        const name = r.root.find(n => typeof n.props.className === 'string' && n.props.className.includes('pq-profile-name'));
        expect(name.props.className).toContain('truncate');
        expect(name.props.title).toBe(long);
        act(() => r.unmount());
    });

    it('keeps the labelled avatar and crowns-info controls', async () => {
        const r = await renderProfile(baseUser);
        expect(r.root.findAllByProps({ 'aria-label': 'Change profile photo' })).toHaveLength(1);
        expect(r.root.findAllByProps({ 'aria-label': 'What are crowns?' })).toHaveLength(1);
        act(() => r.unmount());
    });

    it('uses the themed section classes (light mode is designed in CSS, not inverted)', async () => {
        const r = await renderProfile(baseUser);
        const classes = r.root.findAll(n => typeof n.props.className === 'string').map(n => n.props.className).join(' ');
        for (const c of ['pq-journey', 'pq-progress-track', 'pq-util-card', 'pq-avatar-ring']) expect(classes).toContain(c);
        act(() => r.unmount());
    });
});


describe('ProfileView — avatar moderation timeout matches the 120-second server window', () => {
    const validJpeg = { size: 3, type: 'image/jpeg', name: 'safe.jpg' } as File;
    const avatarButton = (r: TestRenderer.ReactTestRenderer) =>
        r.root.findByProps({ 'aria-label': 'Change profile photo' });
    const visibleText = (n: any): string => typeof n === 'string' ? n
        : Array.isArray(n) ? n.map(visibleText).join('')
        : (n?.children ?? []).map(visibleText).join('');

    beforeEach(() => {
        avatarModerationListener = null;
        pendingAvatarUploadId = null;
        avatarUnsubscribeCalls = 0;
    });

    it('remains in review beyond 120 seconds and honors approval without a late timeout', async () => {
        const r = await renderProfile({ id: 'me', username: 'tester' });
        vi.useFakeTimers();
        try {
            const fileInput = r.root.findByType('input');
            await act(async () => {
                await fileInput.props.onChange({ target: { files: [validJpeg] } });
            });
            expect(pendingAvatarUploadId).toEqual(expect.any(String));
            expect(avatarModerationListener).toBeTypeOf('function');
            expect(avatarButton(r).props.disabled).toBe(true);

            await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
            expect(avatarButton(r).props.disabled).toBe(true);
            expect(visibleText(r.toJSON())).not.toContain('Photo check timed out');

            await act(async () => {
                avatarModerationListener!({
                    data: () => ({ uploadId: pendingAvatarUploadId, status: 'approved' }),
                });
            });
            expect(avatarUnsubscribeCalls).toBe(1);
            expect(avatarButton(r).props.disabled).toBe(false);

            await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
            expect(visibleText(r.toJSON())).not.toContain('Photo check timed out');
            expect(avatarUnsubscribeCalls).toBe(1);
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
            act(() => r.unmount());
        }
    });

    it('times out at three minutes when no terminal moderation event arrives', async () => {
        const r = await renderProfile({ id: 'me', username: 'tester' });
        vi.useFakeTimers();
        try {
            const fileInput = r.root.findByType('input');
            await act(async () => {
                await fileInput.props.onChange({ target: { files: [validJpeg] } });
            });
            expect(avatarButton(r).props.disabled).toBe(true);
            await act(async () => { await vi.advanceTimersByTimeAsync(179_999); });
            expect(avatarButton(r).props.disabled).toBe(true);
            expect(visibleText(r.toJSON())).not.toContain('Photo check timed out');

            await act(async () => { await vi.advanceTimersByTimeAsync(1); });
            expect(avatarButton(r).props.disabled).toBe(false);
            expect(visibleText(r.toJSON())).toContain('Photo check timed out');
            expect(avatarUnsubscribeCalls).toBe(1);
        } finally {
            vi.clearAllTimers();
            vi.useRealTimers();
            act(() => r.unmount());
        }
    });
});
