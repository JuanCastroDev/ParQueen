import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { timestampToMillis } from '../../utils/pingLifecycle';

// Minimal localStorage polyfill — this vitest environment is plain Node,
// with no DOM globals at all (not even jsdom), and useSpotData.ts reads/
// writes a couple of small localStorage keys.
if (typeof (globalThis as any).localStorage === 'undefined') {
    const store = new Map<string, string>();
    (globalThis as any).localStorage = {
        getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
        setItem: (k: string, v: string) => { store.set(k, String(v)); },
        removeItem: (k: string) => { store.delete(k); },
        clear: () => { store.clear(); },
    };
}

// Mock the firebase app module (avoids real Firebase/Analytics init).
vi.mock('../../firebase', () => ({ db: {} }));

// Controllable Firestore mock. Each onSnapshot() call is keyed by the
// geohash range it queries (extracted from the where() calls recorded on
// the query object), so the test can decide exactly when each range
// "delivers" its snapshot/error, independent of the others.
type Listener = { onNext: (snap: any) => void; onError: (err: any) => void };
const listenersByRangeKey = new Map<string, Listener[]>();

function rangeKeyFromQuery(q: any): string {
    const start = q.wheres.find((w: any) => w.field === 'geohash' && w.op === '>=')?.value;
    const end = q.wheres.find((w: any) => w.field === 'geohash' && w.op === '<=')?.value;
    return `${start}:${end}`;
}

vi.mock('firebase/firestore', () => {
    return {
        collection: (_db: any, name: string) => ({ __collection: name, wheres: [] as any[] }),
        query: (base: any, ...clauses: any[]) => {
            const q = { ...base, wheres: [...base.wheres] };
            clauses.forEach(c => c(q));
            return q;
        },
        where: (field: string, op: string, value: any) => (q: any) => q.wheres.push({ field, op, value }),
        orderBy: (_field: string) => (_q: any) => { /* no-op for this mock */ },
        onSnapshot: (q: any, onNext: any, onError: any) => {
            const key = rangeKeyFromQuery(q);
            const list = listenersByRangeKey.get(key) ?? [];
            list.push({ onNext, onError });
            listenersByRangeKey.set(key, list);
            return () => {
                const idx = list.indexOf(list[list.length - 1]);
                // Simplification: tests only ever have one live subscriber
                // per key at a time in practice; remove all for that key.
                listenersByRangeKey.set(key, list.filter(l => l !== list[idx]));
            };
        },
        Timestamp: {
            now: () => ({ toMillis: () => Date.now(), __fakeNow: true }),
            fromMillis: (ms: number) => ({ toMillis: () => ms }),
        },
    };
});

function emit(rangeKeyStr: string, docs: Array<{ id: string; data: any }>) {
    const list = listenersByRangeKey.get(rangeKeyStr) ?? [];
    const snap = { docs: docs.map(d => ({ id: d.id, data: () => d.data })) };
    list.forEach(l => l.onNext(snap));
}

function emitError(rangeKeyStr: string, err: any) {
    const list = listenersByRangeKey.get(rangeKeyStr) ?? [];
    list.forEach(l => l.onError(err));
}

// Import AFTER the mocks are set up.
const { useSpotData } = await import('./useSpotData');
const { buildGeoQueryRanges } = await import('./geoQuery');

function fakeSpot(id: string, lat: number, lng: number, geohash: string) {
    return {
        id,
        data: {
            lat, lng, geohash,
            status: 'available',
            finderId: 'someone-else',
            reportedAt: { toMillis: () => Date.now() },
            expiresAt: { toMillis: () => Date.now() + 3_600_000 },
            address: 'Test Address',
        },
    };
}

describe('useSpotData transition semantics (real hook, mocked Firestore, DOM-free renderer)', () => {
    beforeEach(() => {
        listenersByRangeKey.clear();
        localStorage.clear();
    });

    // Centers far enough apart that buildGeoQueryRanges produces disjoint
    // range sets, matching the PR review's "Region A" / "Region B" scenario.
    // searchCenter is [lng, lat] (matching useSpotData's own convention —
    // see radiusFilteredItems: centerLat = searchCenter[1]).
    const CENTER_A: [number, number] = [-73.9840, 40.7549]; // Midtown Manhattan
    const CENTER_B: [number, number] = [-74.0785, 40.6437]; // Staten Island (St. George)

    function Harness({ center, radius, onResult }: { center: [number, number]; radius: number; onResult: (r: any) => void }) {
        const result = useSpotData({
            userId: 'me',
            blockedUsers: [],
            searchCenter: center,
            showFree: true,
            showPaid: false,
            filterRadiusMiles: radius,
        });
        onResult(result);
        return null;
    }

    it('TRACE: renders visible markers = [] then [A] once region A promotes, and does not empty before B fully promotes', async () => {
        let latest: any = null;
        const onResult = (r: any) => { latest = r; };

        let renderer: TestRenderer.ReactTestRenderer;
        await act(async () => {
            renderer = TestRenderer.create(React.createElement(Harness, { center: CENTER_A, radius: 2, onResult }));
        });

        const rangesA = buildGeoQueryRanges(CENTER_A[1], CENTER_A[0], 2);
        expect(rangesA.length).toBeGreaterThan(0);

        // T0: Region A active — deliver all of A's ranges with spot "A" in the first one.
        await act(async () => {
            rangesA.forEach((r, i) => {
                const key = `${r.start}:${r.end}`;
                if (i === 0) emit(key, [fakeSpot('spotA', CENTER_A[1], CENTER_A[0], 'dr5regy1')]);
                else emit(key, []);
            });
        });
        expect(latest.radiusFilteredItems.map((it: any) => it.id)).toEqual(['spotA']);

        // T1-T3: user pans, searchCenter becomes B (re-render with new props).
        await act(async () => {
            renderer!.update(React.createElement(Harness, { center: CENTER_B, radius: 2, onResult }));
        });

        // T4-T5: Region B's listeners now exist, but have NOT all delivered yet.
        const rangesB = buildGeoQueryRanges(CENTER_B[1], CENTER_B[0], 2);
        expect(rangesB.length).toBeGreaterThan(0);
        // Confirm B is actually a different range set than A (disjoint scenario).
        const keysA = new Set(rangesA.map(r => `${r.start}:${r.end}`));
        const keysB = new Set(rangesB.map(r => `${r.start}:${r.end}`));
        expect([...keysB].some(k => !keysA.has(k))).toBe(true);

        // *** THE QUESTION UNDER TEST ***
        // radiusFilteredItems is recomputed on every render because its
        // useMemo depends on searchCenter directly. Capture its value here,
        // BEFORE any of B's ranges have delivered a single snapshot.
        const duringTransition = latest.radiusFilteredItems.map((it: any) => it.id);

        // T6: all of B's ranges deliver (promotes B).
        await act(async () => {
            rangesB.forEach((r, i) => {
                const key = `${r.start}:${r.end}`;
                if (i === 0) emit(key, [fakeSpot('spotB', CENTER_B[1], CENTER_B[0], 'dr1regy1')]);
                else emit(key, []);
            });
        });
        const afterPromotion = latest.radiusFilteredItems.map((it: any) => it.id);

        // Report both, and assert the currently-observed (possibly buggy) behavior.
        console.log('duringTransition (B pending):', duringTransition);
        console.log('afterPromotion (B active):', afterPromotion);

        expect(afterPromotion).toEqual(['spotB']);
        // Region A must remain visible (filtered against A's own center) until
        // B's dataset is fully promoted — no empty-map flash mid-transition.
        expect(duringTransition).toEqual(['spotA']);
    });

    it('maps claimStartedAt from the Firestore document so the cancel fingerprint is non-null', async () => {
        let latest: any = null;
        const onResult = (r: any) => { latest = r; };

        await act(async () => {
            TestRenderer.create(React.createElement(Harness, { center: CENTER_A, radius: 2, onResult }));
        });

        const ranges = buildGeoQueryRanges(CENTER_A[1], CENTER_A[0], 2);
        const started = { toMillis: () => 1_700_000_123_000 };
        await act(async () => {
            ranges.forEach((r, i) => {
                const key = `${r.start}:${r.end}`;
                if (i === 0) {
                    emit(key, [{
                        id: 'claimed',
                        data: {
                            lat: CENTER_A[1],
                            lng: CENTER_A[0],
                            geohash: 'dr5regy1',
                            status: 'interested',
                            finderId: 'owner',
                            interestedUserId: 'me',
                            reportedAt: { toMillis: () => Date.now() },
                            expiresAt: { toMillis: () => Date.now() + 3_600_000 },
                            address: 'Claimed curb',
                            claimStartedAt: started,
                        },
                    }]);
                } else {
                    emit(key, []);
                }
            });
        });

        const mapped = latest.freeSpots.find((spot: any) => spot.id === 'claimed');
        const visible = latest.radiusFilteredItems.find((spot: any) => spot.id === 'claimed');
        expect(mapped.claimStartedAt).toBe(started);
        expect(visible.claimStartedAt).toBe(started);
        expect(timestampToMillis(visible.claimStartedAt)).toBe(1_700_000_123_000);

        await act(async () => {
            ranges.forEach((r, i) => {
                const key = `${r.start}:${r.end}`;
                if (i === 0) emit(key, [fakeSpot('plain', CENTER_A[1], CENTER_A[0], 'dr5regy1')]);
                else emit(key, []);
            });
        });
        const plain = latest.freeSpots.find((spot: any) => spot.id === 'plain');
        expect(plain.claimStartedAt).toBeNull();
        expect(timestampToMillis(plain.claimStartedAt)).toBe(0);
    });
});
