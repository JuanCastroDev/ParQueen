import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// This vitest environment (environment: 'node') has no DOM/window/localStorage
// globals at all — i18n's resolveInitialLang() reads localStorage at import time.
vi.hoisted(() => {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => { store.clear(); },
    };
    (globalThis as any).window = { location: { search: '' }, addEventListener: () => {}, removeEventListener: () => {} };
});

vi.mock('../../firebase', () => ({ db: {} }));

interface SuspensionRow { id: string; data: any }
let suspensionRows: SuspensionRow[] = [];
let segmentExists = true;
let segmentData: any = { status: 'active' };
let streetRuleRows: { id: string; data: any }[] = [];
interface SuspensionsQueryCall { constraints: any[] }
let suspensionsQueryCalls: SuspensionsQueryCall[] = [];

vi.mock('firebase/firestore', () => ({
    collection: (_db: any, ...path: string[]) => ({ __col: path }),
    doc: (_db: any, ...path: string[]) => ({ __doc: path }),
    query: (base: any, ...constraints: any[]) => ({ ...base, __constraints: constraints }),
    where: (field: string, op: string, value: any) => ({ __kind: 'where', field, op, value }),
    orderBy: (field: string, dir?: string) => ({ __kind: 'orderBy', field, dir }),
    getDoc: (_ref: any) => Promise.resolve({ exists: () => segmentExists, data: () => segmentData }),
    getDocs: (q: any) => {
        if (Array.isArray(q.__col) && q.__col[0] === 'suspensions') {
            suspensionsQueryCalls.push({ constraints: q.__constraints });
            // Mimic Firestore's actual range-filter behavior for date >= / <=
            // so tests can seed docs across the boundary and assert only the
            // correctly-bounded subset comes back — this exercises the
            // component's wiring; the real Firestore engine's honoring of
            // these same bounds is separately verified against production.
            const gte = q.__constraints.find((c: any) => c.__kind === 'where' && c.op === '>=');
            const lte = q.__constraints.find((c: any) => c.__kind === 'where' && c.op === '<=');
            const filtered = suspensionRows.filter(r =>
                (!gte || r.data.date >= gte.value) && (!lte || r.data.date <= lte.value));
            return Promise.resolve({ docs: filtered.map(r => ({ id: r.id, data: () => r.data })) });
        }
        if (Array.isArray(q.__col) && q.__col[q.__col.length - 1] === 'streetRules') {
            return Promise.resolve({ docs: streetRuleRows.map(r => ({ id: r.id, data: () => r.data })) });
        }
        return Promise.resolve({ docs: [] });
    },
}));

import { StreetIntelligenceCard } from './StreetIntelligenceCard';
import { toNYCDateKey, addNYCDateKeyDays, MAX_FORWARD_SEARCH_DAYS_AHEAD } from '../../utils/streetIntelligence';

const MELVILLE_RULE = {
    type: 'streetCleaning',
    effectiveDate: null,
    supersededAt: null,
    schedules: [{ side: 'West', days: ['Mon', 'Thu'], startTime: '08:30', endTime: '10:00' }],
    source: 'admin',
    lastSourceSync: null,
};

const SUPPORTED_ADMIN_SEGMENT = {
    status: 'active',
    source: 'admin',
    confidenceScore: 1,
    provenance: { provider: 'admin' },
};

function renderedText(renderer: TestRenderer.ReactTestRenderer): string {
    return renderer.root.findAll(node => typeof node.children?.[0] === 'string')
        .flatMap(node => node.children.filter((child): child is string => typeof child === 'string'))
        .join(' ');
}

async function renderCard(overrides: Partial<React.ComponentProps<typeof StreetIntelligenceCard>> = {}) {
    let onResultValue: any = 'not-called';
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
        renderer = TestRenderer.create(
            <StreetIntelligenceCard
                segmentId="seg1"
                parkingSide="West"
                streetName="Melville St"
                sideConfidence="high"
                confirmedParkingSide={null}
                onConfirmSide={vi.fn()}
                onResult={(r) => { onResultValue = r; }}
                {...overrides}
            />
        );
        await Promise.resolve();
        await Promise.resolve();
    });
    return { renderer: renderer!, getResult: () => onResultValue };
}

describe('StreetIntelligenceCard — date-bounded suspension fetch', () => {
    beforeEach(() => {
        suspensionsQueryCalls = [];
        suspensionRows = [];
        segmentExists = true;
        segmentData = SUPPORTED_ADMIN_SEGMENT;
        streetRuleRows = [{ id: 'rule1', data: MELVILLE_RULE }];
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('bounds the suspensions query to [today, today+13] NYC civil dates, ordered date desc', async () => {
        await renderCard();
        expect(suspensionsQueryCalls).toHaveLength(1);
        const constraints = suspensionsQueryCalls[0].constraints;
        const todayKey = toNYCDateKey(new Date());
        const horizonKey = addNYCDateKeyDays(todayKey, MAX_FORWARD_SEARCH_DAYS_AHEAD);

        const gte = constraints.find((c: any) => c.__kind === 'where' && c.op === '>=');
        const lte = constraints.find((c: any) => c.__kind === 'where' && c.op === '<=');
        const order = constraints.find((c: any) => c.__kind === 'orderBy');

        expect(gte).toMatchObject({ field: 'date', value: todayKey });
        expect(lte).toMatchObject({ field: 'date', value: horizonKey });
        expect(order).toMatchObject({ field: 'date', dir: 'desc' });
    });

    it('the query bounds for the same pinned instant are identical under every device/runtime timezone', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-27T20:15:00-04:00')); // evening EDT — UTC date already rolled over

        const boundsByTZ: Record<string, { gte: string; lte: string }> = {};
        for (const tz of ['America/New_York', 'UTC', 'America/Los_Angeles', 'Asia/Tokyo']) {
            const priorTZ = process.env.TZ;
            process.env.TZ = tz;
            suspensionsQueryCalls = [];
            await renderCard();
            const constraints = suspensionsQueryCalls[0].constraints;
            boundsByTZ[tz] = {
                gte: constraints.find((c: any) => c.op === '>=').value,
                lte: constraints.find((c: any) => c.op === '<=').value,
            };
            process.env.TZ = priorTZ;
        }

        const uniqueGte = new Set(Object.values(boundsByTZ).map(b => b.gte));
        const uniqueLte = new Set(Object.values(boundsByTZ).map(b => b.lte));
        expect(uniqueGte.size).toBe(1);
        expect(uniqueLte.size).toBe(1);
    });

    it('the horizon does not shift across the spring-forward DST transition', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-03-01T07:00:00-05:00')); // one week before the 2026-03-08 transition
        await renderCard();
        const constraints = suspensionsQueryCalls[0].constraints;
        const lte = constraints.find((c: any) => c.op === '<=').value;
        // Independently derived via the same canonical helper the component uses —
        // this is the horizon-coherence guarantee: both read MAX_FORWARD_SEARCH_DAYS_AHEAD
        // from the same exported constant computeSafeUntil's own loop bound uses.
        expect(lte).toBe(addNYCDateKeyDays('2026-03-01', MAX_FORWARD_SEARCH_DAYS_AHEAD));
        expect(lte).toBe('2026-03-14');
    });

    it('a suspension dated before today is excluded, today and the horizon day are included, and the day after the horizon is excluded', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-27T07:00:00-04:00'));
        const todayKey = toNYCDateKey(new Date());
        const horizonKey = addNYCDateKeyDays(todayKey, MAX_FORWARD_SEARCH_DAYS_AHEAD);
        const dayAfterHorizon = addNYCDateKeyDays(horizonKey, 1);
        const dayBeforeToday = addNYCDateKeyDays(todayKey, -1);

        suspensionRows = [
            { id: 'before', data: { cityId: 'nyc', date: dayBeforeToday, type: 'holiday', label: 'Before', affectsTypes: ['streetCleaning'], source: 'admin', status: 'active' } },
            { id: 'today', data: { cityId: 'nyc', date: todayKey, type: 'holiday', label: 'Today', affectsTypes: ['streetCleaning'], source: 'admin', status: 'active' } },
            { id: 'horizon', data: { cityId: 'nyc', date: horizonKey, type: 'holiday', label: 'Horizon', affectsTypes: ['streetCleaning'], source: 'admin', status: 'active' } },
            { id: 'after', data: { cityId: 'nyc', date: dayAfterHorizon, type: 'holiday', label: 'After', affectsTypes: ['streetCleaning'], source: 'admin', status: 'active' } },
        ];

        await renderCard();
        const constraints = suspensionsQueryCalls[0].constraints;
        const gte = constraints.find((c: any) => c.op === '>=').value;
        const lte = constraints.find((c: any) => c.op === '<=').value;
        const returned = suspensionRows.filter(r => r.data.date >= gte && r.data.date <= lte).map(r => r.id);

        expect(returned).not.toContain('before');
        expect(returned).toContain('today');
        expect(returned).toContain('horizon');
        expect(returned).not.toContain('after');
    });

    it('an archived suspension inside the fetched range is still ignored (client-side filter preserved), a non-archived one still applies', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-24T09:00:00-04:00')); // Mon 9 AM EDT — inside the West Mon 8:30-10:00 window
        const todayKey = toNYCDateKey(new Date());

        // Archived suspension for today: must NOT suppress the active window.
        suspensionRows = [
            { id: 'archived-today', data: { cityId: 'nyc', date: todayKey, type: 'holiday', label: 'Archived', affectsTypes: ['streetCleaning'], source: 'admin', status: 'archived' } },
        ];
        const { getResult: getResultArchived } = await renderCard();
        expect(getResultArchived().activeNow).toBe(true);

        // Same date, but non-archived: must suppress the active window.
        suspensionRows = [
            { id: 'active-today', data: { cityId: 'nyc', date: todayKey, type: 'holiday', label: 'Active', affectsTypes: ['streetCleaning'], source: 'admin', status: 'active' } },
        ];
        const { getResult: getResultActive } = await renderCard();
        expect(getResultActive().activeNow).toBe(false);
    });

    it('multiple applicable suspensions in range are all available to computeSafeUntil (no artificial limit(1))', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-27T07:00:00-04:00'));
        const todayKey = toNYCDateKey(new Date());
        const nextThu = addNYCDateKeyDays(todayKey, 0); // today is Thursday in this fixture

        suspensionRows = [
            { id: 's1', data: { cityId: 'nyc', date: nextThu, type: 'holiday', label: 'A', affectsTypes: ['streetCleaning'], source: 'admin', status: 'active' } },
            { id: 's2', data: { cityId: 'nyc', date: addNYCDateKeyDays(todayKey, 4), type: 'holiday', label: 'B', affectsTypes: ['streetCleaning'], source: 'admin', status: 'active' } },
        ];
        await renderCard();
        const constraints = suspensionsQueryCalls[0].constraints;
        expect(constraints.some((c: any) => c.__kind === 'limit')).toBe(false);
    });
});

describe('StreetIntelligenceCard — calibrated authority presentation', () => {
    beforeEach(() => {
        suspensionsQueryCalls = [];
        suspensionRows = [];
        segmentExists = true;
        segmentData = SUPPORTED_ADMIN_SEGMENT;
        streetRuleRows = [{ id: 'rule1', data: MELVILLE_RULE }];
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-08-24T07:00:00-04:00'));
    });

    afterEach(() => vi.useRealTimers());

    it('missing segment renders neutral unavailable copy and no precise Safe Until', async () => {
        segmentExists = false;
        const { renderer } = await renderCard();
        const text = renderedText(renderer);
        expect(text).toContain('Parking rule data is unavailable for this location.');
        expect(text).not.toContain('Safe Until');
        expect(text).not.toContain('ParQueen Verified');
    });

    it('missing status fails closed instead of rendering supported or verified', async () => {
        segmentData = { ...SUPPORTED_ADMIN_SEGMENT, status: undefined };
        const { renderer } = await renderCard();
        const text = renderedText(renderer);
        expect(text).toContain('Parking rule data is unavailable for this location.');
        expect(text).not.toContain('Parking info available');
        expect(text).not.toContain('ParQueen Verified');
    });

    it('needs_review places textual caution before the calculated time and removes verified treatment', async () => {
        segmentData = { ...SUPPORTED_ADMIN_SEGMENT, status: 'needs_review' };
        const { renderer } = await renderCard();
        const text = renderedText(renderer);
        expect(text).toContain('Needs review');
        expect(text).toContain('Estimated parking window');
        expect(text.indexOf('Needs review')).toBeLessThan(text.indexOf('Estimated parking window'));
        expect(text).not.toContain('ParQueen Verified');
    });

    it('fallback data receives caution rather than an unsupported verified label', async () => {
        segmentData = {
            status: 'needs_review',
            source: 'nyc_open_data',
            needsReview: true,
            confidenceScore: 0.5,
            provenance: { provider: 'nyc_open_data', geometrySource: 'fallback' },
        };
        streetRuleRows = [{ id: 'rule1', data: { ...MELVILLE_RULE, source: 'nyc_open_data', needsReview: true } }];
        const { renderer } = await renderCard();
        const text = renderedText(renderer);
        expect(text).toContain('Needs review');
        expect(text).toContain('NYC Open Data fallback');
        expect(text).not.toContain('ParQueen Verified');
    });

    it('answers a supported result declaratively, without defensive copy', async () => {
        const { renderer } = await renderCard();
        const text = renderedText(renderer);
        expect(text).toContain('Safe Until');
        expect(text).toContain('Parking info available');
        // A supported answer is declarative. Safety copy belongs only to a
        // concrete caution/unknown reason, not every successful calculation.
        expect(text).not.toContain('Check posted signs and current NYC rules before parking.');
        expect(text).not.toMatch(/review recommended|needs review/i);
        expect(text).not.toMatch(/posted signs are always the final word|verify posted signs|confirm before parking/i);
        expect(text).not.toContain('ParQueen Verified');
        expect(text).not.toMatch(/guarantee(?:d|s)? legal parking/i);
    });

    it('renders source and freshness only when reliable metadata exists', async () => {
        streetRuleRows = [{ id: 'rule1', data: { ...MELVILLE_RULE, lastSourceSync: '2026-08-29' } }];
        const withMetadata = await renderCard();
        expect(renderedText(withMetadata.renderer)).toContain('Source: ParQueen admin data');
        expect(renderedText(withMetadata.renderer)).toContain('Data updated: Aug 29, 2026');

        streetRuleRows = [{ id: 'rule1', data: { ...MELVILLE_RULE, lastSourceSync: null } }];
        const withoutFreshness = await renderCard();
        expect(renderedText(withoutFreshness.renderer)).not.toContain('Data updated:');

        streetRuleRows = [{ id: 'rule1', data: { ...MELVILLE_RULE, lastSourceSync: '2026-13-01' } }];
        const withInvalidFreshness = await renderCard();
        expect(renderedText(withInvalidFreshness.renderer)).not.toContain('Data updated:');
    });

    it('still renders the existing Street Intelligence card for NYC Open Data without infrastructure language', async () => {
        segmentData = {
            status: 'active',
            source: 'nyc_open_data',
            needsReview: false,
            confidenceScore: 1,
            provenance: { provider: 'nyc_open_data' },
            blockFaceEvidence: { blockDecisive: true, sideResolved: true, parseComplete: true },
        };
        streetRuleRows = [{
            id: 'nyc_open_data_v1',
            data: { ...MELVILLE_RULE, source: 'nyc_open_data', lastSourceSync: '2026-08-29' },
        }];
        const { renderer } = await renderCard();
        const text = renderedText(renderer);
        expect(text).toContain('Safe Until');
        expect(text).toContain('Parking info available');
        expect(text).toContain('NYC Open Data fallback');
        expect(text).not.toMatch(/Curb resolver|BFI|blockface|cohort|shadow|CSCL/i);
    });

    it('A. shows cleaning and matched meter independently of SAFE UNTIL', async () => {
        streetRuleRows = [
            { id: 'rule1', data: MELVILLE_RULE },
            {
                id: 'park_nyc_v1',
                data: {
                    type: 'meter',
                    source: 'park_nyc',
                    schedules: [{ side: 'West', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], startTime: '09:00', endTime: '19:00' }],
                    meterTerms: { maxStayMinutes: 120, rateDisplay: '$3.50/hour' },
                },
            },
        ];
        const { renderer, getResult } = await renderCard();
        const text = renderedText(renderer);
        expect(text).toContain('Safe Until');
        expect(text).toContain('Street cleaning');
        expect(text).toContain('Metered parking');
        expect(text).toContain('$3.50/hour');
        expect(text).toContain('2 hr maximum');
        expect(getResult().scheduleDescription).toContain('Mon & Thu');
        expect(getResult().scheduleDescription).not.toContain('9');
    });

    it('C. meter-only does not render the generic unavailable card', async () => {
        streetRuleRows = [{
            id: 'park_nyc_v1',
            data: {
                type: 'meter',
                source: 'park_nyc',
                schedules: [{ side: 'West', days: ['Mon', 'Sat'], startTime: '09:00', endTime: '19:00' }],
            },
        }];
        segmentData = {
            status: 'active',
            source: 'park_nyc',
            confidenceScore: 0.95,
            provenance: { provider: 'park_nyc' },
        };
        const { renderer, getResult } = await renderCard();
        const text = renderedText(renderer);
        expect(text).toContain('Metered parking');
        expect(text).toContain('No street-cleaning schedule found');
        expect(text).not.toContain('Parking rule data is unavailable for this location.');
        expect(text).not.toContain('Safe Until');
        expect(getResult().scheduleDescription).toBeNull();
    });

    it('B. cleaning-only omits the meter section', async () => {
        const { renderer } = await renderCard();
        const text = renderedText(renderer);
        expect(text).toContain('Street cleaning');
        expect(text).not.toContain('Metered parking');
        expect(text).not.toContain('No meter');
    });
});
