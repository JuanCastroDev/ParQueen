import { describe, it, expect, beforeEach, vi } from 'vitest';

// The suite runs in a node environment; savedSpot degrades to null without
// storage, so give it a real one to exercise the parse/migrate paths.
vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  };
});
import {
  assessHydrantDistance, isHydrantBlocking, isHydrantUncertain,
  metersToFeet, HYDRANT_THRESHOLD_FT, ASSUMED_ACCURACY_M, MAX_USABLE_ACCURACY_M,
} from './hydrantDistance';
import { evaluateParkingCheck, evaluateStreetRules } from './parkingCheck';
import { readSavedSpot, writeSavedSpot, clearSavedSpot, effectiveParkingSide, SAVED_SPOT_KEY, SAVED_SPOT_TTL_MS } from './savedSpot';
import type { SafeUntilResult } from './streetIntelligence';

/** Feet expressed as metres, so the tests read in the units of the actual rule. */
const ft = (feet: number) => feet / 3.28084;

describe('assessHydrantDistance — the 15 ft line', () => {
  // A good fix, so the threshold arithmetic is what is under test.
  const good = { accuracyMeters: 1 };

  it('reports within at exactly 15 ft', () => {
    const a = assessHydrantDistance({ distanceMeters: ft(15), ...good });
    expect(a.status).toBe('within');
    expect(a.distanceFt).toBe(15);
  });

  it('reports within below 15 ft', () => {
    expect(assessHydrantDistance({ distanceMeters: ft(9), ...good }).status).toBe('within');
    expect(assessHydrantDistance({ distanceMeters: ft(0.5), ...good }).status).toBe('within');
  });

  it('reports beyond when the distance and the accuracy both clear the line', () => {
    const a = assessHydrantDistance({ distanceMeters: ft(28), ...good });
    expect(a.status).toBe('beyond');
    expect(a.distanceFt).toBe(28);
  });

  it('reports within even on a poor fix, because the risk is the point', () => {
    // Conservative: a coarse fix must never upgrade a close reading to "beyond".
    const a = assessHydrantDistance({ distanceMeters: ft(10), accuracyMeters: 25 });
    expect(a.status).toBe('within');
  });
});

describe('assessHydrantDistance — accuracy crossing the threshold', () => {
  it('is too close to call when the accuracy range reaches back over 15 ft', () => {
    // 22 ft away, ±10 ft → the true distance could be 12 ft.
    const a = assessHydrantDistance({ distanceMeters: ft(22), accuracyMeters: ft(10) });
    expect(a.status).toBe('too_close_to_call');
    expect(a.distanceFt).toBe(22);
  });

  it('is beyond when the same distance has a tight fix', () => {
    const a = assessHydrantDistance({ distanceMeters: ft(22), accuracyMeters: ft(3) });
    expect(a.status).toBe('beyond');
  });

  it('is too close to call whenever the fix is worse than the usable ceiling', () => {
    // Far enough away on paper, but the fix cannot resolve a 15 ft question.
    const a = assessHydrantDistance({ distanceMeters: ft(120), accuracyMeters: MAX_USABLE_ACCURACY_M + 1 });
    expect(a.status).toBe('too_close_to_call');
  });

  it('assumes a routine fix when the platform reports no accuracy', () => {
    const a = assessHydrantDistance({ distanceMeters: ft(60), accuracyMeters: null });
    expect(a.accuracyAssumed).toBe(true);
    expect(a.accuracyFt).toBe(Math.round(metersToFeet(ASSUMED_ACCURACY_M)));
    expect(a.status).toBe('beyond');
  });

  it('treats a nonsense accuracy as absent rather than trusting it', () => {
    for (const bad of [NaN, -5, Infinity, undefined]) {
      const a = assessHydrantDistance({ distanceMeters: ft(60), accuracyMeters: bad as any });
      expect(a.accuracyAssumed).toBe(true);
    }
  });

  it('always reports the threshold it judged against', () => {
    expect(assessHydrantDistance({ distanceMeters: ft(20) }).thresholdFt).toBe(HYDRANT_THRESHOLD_FT);
  });
});

describe('assessHydrantDistance — absent data is never a green light', () => {
  it('reports none_nearby when no hydrant was found', () => {
    const a = assessHydrantDistance({ distanceMeters: null });
    expect(a.status).toBe('none_nearby');
    expect(a.distanceFt).toBeNull();
    expect(isHydrantBlocking(a)).toBe(false);
  });

  it('reports unavailable when the lookup failed, and treats it as uncertainty', () => {
    const a = assessHydrantDistance({ distanceMeters: null, failed: true });
    expect(a.status).toBe('unavailable');
    expect(isHydrantUncertain(a)).toBe(true);
  });

  it('treats a non-finite distance as no reading rather than as zero', () => {
    for (const bad of [NaN, Infinity, undefined]) {
      expect(assessHydrantDistance({ distanceMeters: bad as any }).status).toBe('none_nearby');
    }
  });

  it('marks only a within reading as blocking', () => {
    const statuses = [
      assessHydrantDistance({ distanceMeters: ft(10), accuracyMeters: 1 }),
      assessHydrantDistance({ distanceMeters: ft(22), accuracyMeters: ft(10) }),
      assessHydrantDistance({ distanceMeters: ft(40), accuracyMeters: 1 }),
      assessHydrantDistance({ distanceMeters: null }),
      assessHydrantDistance({ distanceMeters: null, failed: true }),
    ];
    expect(statuses.map(isHydrantBlocking)).toEqual([true, false, false, false, false]);
  });
});

// ── Parking check ───────────────────────────────────────────────────────────

const clearRules: SafeUntilResult = {
  activeNow: false, safeUntil: new Date('2026-09-11T12:00:00Z'),
  nextDay: 'Thursday', nextTime: '8:30 AM', scheduleDescription: 'Mon & Thu · 8:30–10 AM',
};
const activeRules: SafeUntilResult = {
  activeNow: true, safeUntil: new Date('2026-09-10T14:00:00Z'),
  nextDay: null, nextTime: null, scheduleDescription: 'Mon & Thu · 8:30–10 AM',
};
const farHydrant = assessHydrantDistance({ distanceMeters: ft(40), accuracyMeters: 1 });
const closeHydrant = assessHydrantDistance({ distanceMeters: ft(9), accuracyMeters: 1 });
const uncertainHydrant = assessHydrantDistance({ distanceMeters: ft(22), accuracyMeters: ft(10) });
const failedHydrant = assessHydrantDistance({ distanceMeters: null, failed: true });

const supported = { presentation: 'supported' as const, effectiveSide: 'North' };

describe('evaluateStreetRules', () => {
  it('classifies each input', () => {
    expect(evaluateStreetRules({ ...supported, safeUntil: activeRules })).toBe('active_restriction');
    expect(evaluateStreetRules({ ...supported, safeUntil: clearRules })).toBe('clear');
    expect(evaluateStreetRules({ ...supported, safeUntil: clearRules, effectiveSide: null })).toBe('side_unknown');
    expect(evaluateStreetRules({ presentation: 'unknown', safeUntil: null, effectiveSide: 'North' })).toBe('unavailable');
    expect(evaluateStreetRules({ ...supported, safeUntil: clearRules, failed: true })).toBe('unavailable');
    expect(evaluateStreetRules({ ...supported, safeUntil: null })).toBe('unavailable');
  });
});

describe('evaluateParkingCheck — move your car', () => {
  it('when a street restriction is active right now', () => {
    const r = evaluateParkingCheck({ street: { ...supported, safeUntil: activeRules }, hydrant: farHydrant });
    expect(r.overall).toBe('move');
    expect(r.reasons).toContain('street_active_restriction');
  });

  it('when the hydrant estimate is at or inside 15 ft', () => {
    const r = evaluateParkingCheck({ street: { ...supported, safeUntil: clearRules }, hydrant: closeHydrant });
    expect(r.overall).toBe('move');
    expect(r.reasons).toContain('hydrant_within_threshold');
  });

  it('and an active problem outranks unrelated uncertainty', () => {
    const r = evaluateParkingCheck({
      street: { presentation: 'caution', safeUntil: activeRules, effectiveSide: 'North' },
      hydrant: failedHydrant,
    });
    expect(r.overall).toBe('move');
  });
});

describe('evaluateParkingCheck — check this spot', () => {
  const cases: Array<[string, Parameters<typeof evaluateParkingCheck>[0]]> = [
    ['street data unavailable', { street: { presentation: 'unknown', safeUntil: null, effectiveSide: 'North' }, hydrant: farHydrant }],
    ['street lookup failed', { street: { ...supported, safeUntil: clearRules, failed: true }, hydrant: farHydrant }],
    ['segment needs review', { street: { presentation: 'caution', safeUntil: clearRules, effectiveSide: 'North' }, hydrant: farHydrant }],
    ['parking side unknown', { street: { ...supported, safeUntil: clearRules, effectiveSide: null }, hydrant: farHydrant }],
    ['hydrant too close to call', { street: { ...supported, safeUntil: clearRules }, hydrant: uncertainHydrant }],
    ['hydrant unavailable', { street: { ...supported, safeUntil: clearRules }, hydrant: failedHydrant }],
    ['hydrant not checked', { street: { ...supported, safeUntil: clearRules }, hydrant: null }],
  ];

  for (const [label, input] of cases) {
    it(label, () => {
      expect(evaluateParkingCheck(input).overall).toBe('check');
    });
  }

  it('reports partial results rather than collapsing to nothing', () => {
    // Hydrant worked, street rules did not: the hydrant reading is still shown.
    const r = evaluateParkingCheck({
      street: { presentation: 'unknown', safeUntil: null, effectiveSide: null },
      hydrant: farHydrant,
    });
    expect(r.overall).toBe('check');
    expect(r.hydrant?.status).toBe('beyond');
    expect(r.street).toBe('unavailable');
  });
});

describe('evaluateParkingCheck — no known issue', () => {
  it('only when every check ParQueen can run came back clean', () => {
    const r = evaluateParkingCheck({ street: { ...supported, safeUntil: clearRules }, hydrant: farHydrant });
    expect(r.overall).toBe('no_known_issue');
    expect(r.confidence).toBe('high');
    expect(r.reasons).toEqual([]);
  });

  it('accepts no hydrant in the searched radius as no known hydrant problem', () => {
    const none = assessHydrantDistance({ distanceMeters: null });
    const r = evaluateParkingCheck({ street: { ...supported, safeUntil: clearRules }, hydrant: none });
    expect(r.overall).toBe('no_known_issue');
  });

  it('never reaches no_known_issue from an unknown input', () => {
    // Exhaustive: every degraded street/hydrant combination must avoid green.
    const streets = [
      { presentation: 'unknown' as const, safeUntil: null, effectiveSide: 'North' },
      { presentation: 'caution' as const, safeUntil: clearRules, effectiveSide: 'North' },
      { ...supported, safeUntil: clearRules, effectiveSide: null },
      { ...supported, safeUntil: clearRules, failed: true },
    ];
    const hydrants = [farHydrant, uncertainHydrant, failedHydrant, null];
    for (const street of streets) {
      for (const hydrant of hydrants) {
        expect(evaluateParkingCheck({ street, hydrant }).overall).not.toBe('no_known_issue');
      }
    }
  });

  it('downgrades confidence whenever anything was uncertain', () => {
    expect(evaluateParkingCheck({ street: { ...supported, safeUntil: clearRules }, hydrant: uncertainHydrant }).confidence).toBe('review');
    expect(evaluateParkingCheck({ street: { presentation: 'caution', safeUntil: clearRules, effectiveSide: 'North' }, hydrant: farHydrant }).confidence).toBe('review');
  });
});

// ── Saved spot ──────────────────────────────────────────────────────────────

const baseSpot = {
  lat: 40.7128, lng: -74.006, address: '123 Main St', savedAt: Date.now(),
  sessionId: 'abc', linkedPingId: null, segmentId: 'seg1', parkingSide: 'North',
  restrictionVersionId: 'v1', segmentStreetName: 'Main St',
  streetIntelStatus: 'found' as const, streetIntelReason: null, streetIntelCheckedAt: null,
  curbProtocolVersion: 2 as const, curbResolutionStatus: 'high_confidence' as const,
  curbSelector: null, curbRefreshAttempted: false,
  gpsAccuracyMeters: 8, sideConfidence: 'high' as const, confirmedParkingSide: null,
};

describe('readSavedSpot', () => {
  beforeEach(() => { clearSavedSpot(); });

  it('round-trips a saved spot', () => {
    writeSavedSpot(baseSpot);
    expect(readSavedSpot()).toEqual(baseSpot);
  });

  it('keeps a pre-V2 saved session readable and marks canonical refresh unattempted', () => {
    const legacy = { ...baseSpot } as Record<string, unknown>;
    delete legacy.curbProtocolVersion;
    delete legacy.curbResolutionStatus;
    delete legacy.curbSelector;
    delete legacy.curbRefreshAttempted;
    localStorage.setItem(SAVED_SPOT_KEY, JSON.stringify(legacy));

    expect(readSavedSpot()).toMatchObject({
      segmentId: 'seg1',
      curbProtocolVersion: null,
      curbResolutionStatus: null,
      curbSelector: null,
      curbRefreshAttempted: false,
    });
  });

  it('returns null when nothing is saved', () => {
    expect(readSavedSpot()).toBeNull();
  });

  it('expires a session older than 24 hours and clears it', () => {
    writeSavedSpot({ ...baseSpot, savedAt: Date.now() - SAVED_SPOT_TTL_MS - 1000 });
    expect(readSavedSpot()).toBeNull();
    expect(localStorage.getItem(SAVED_SPOT_KEY)).toBeNull();
  });

  it('keeps a session just inside the window', () => {
    writeSavedSpot({ ...baseSpot, savedAt: Date.now() - SAVED_SPOT_TTL_MS + 60_000 });
    expect(readSavedSpot()).not.toBeNull();
  });

  it('back-fills fields that predate later versions, and writes them back', () => {
    localStorage.setItem(SAVED_SPOT_KEY, JSON.stringify({
      lat: 40.7, lng: -74, address: 'x', savedAt: Date.now(), parkingSide: 'North',
    }));
    const s = readSavedSpot()!;
    expect(s.sessionId).toBeTruthy();
    expect(s.linkedPingId).toBeNull();
    expect(s.gpsAccuracyMeters).toBeNull();
    expect(s.sideConfidence).toBe('low');      // had a side but no confidence
    expect(s.confirmedParkingSide).toBeNull();
    expect(JSON.parse(localStorage.getItem(SAVED_SPOT_KEY)!).sessionId).toBe(s.sessionId);
  });

  it('back-fills unknown confidence when there was no side either', () => {
    localStorage.setItem(SAVED_SPOT_KEY, JSON.stringify({ lat: 40.7, lng: -74, address: 'x', savedAt: Date.now() }));
    expect(readSavedSpot()!.sideConfidence).toBe('unknown');
  });

  it('rejects untrusted payloads instead of handing out unusable coordinates', () => {
    for (const bad of ['null', '{}', '[]', '"x"', 'not json',
      JSON.stringify({ lat: 'a', lng: -74, savedAt: Date.now() }),
      JSON.stringify({ lat: NaN, lng: -74, savedAt: Date.now() }),
      JSON.stringify({ lat: 40.7, lng: null, savedAt: Date.now() }),
      JSON.stringify({ lat: 40.7, lng: -74 })]) {
      localStorage.setItem(SAVED_SPOT_KEY, bad);
      expect(readSavedSpot()).toBeNull();
    }
  });
});

describe('effectiveParkingSide', () => {
  it('prefers a side the user confirmed', () => {
    expect(effectiveParkingSide({ parkingSide: 'North', sideConfidence: 'high', confirmedParkingSide: 'South' })).toBe('South');
  });

  it('uses the GPS side only at high confidence', () => {
    expect(effectiveParkingSide({ parkingSide: 'North', sideConfidence: 'high', confirmedParkingSide: null })).toBe('North');
    expect(effectiveParkingSide({ parkingSide: 'North', sideConfidence: 'low', confirmedParkingSide: null })).toBeNull();
    expect(effectiveParkingSide({ parkingSide: 'North', sideConfidence: 'unknown', confirmedParkingSide: null })).toBeNull();
  });
});
