import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { runCanonicalCurbOrchestrator, OVERALL_DEADLINE_MS } = require('./canonicalCurbOrchestrator');
const { publicCurbKey, toPublicCurb } = require('./canonicalCurbIdentity');

const identity = Object.freeze({
  schemaVersion: 2,
  jurisdiction: 'NYC',
  officialBlockFaceId: '1000000001',
  csclSide: 'LEFT',
  sourceVersion: { resourceId: 'inkn-q76z', version: 'orchestrator-v1' },
  roadway: {
    selectedGlobalId: 'private-global',
    supportingGlobalIds: ['private-global'],
    physicalId: 'private-physical',
    b5sc: 'private-b5sc',
    geometry: { type: 'MultiLineString', coordinates: [[[-74, 40.7], [-73.999, 40.7]]] },
    streetWidthFeet: 34,
  },
  names: {
    borough: 'Bronx', onStreet: 'MARAN PLACE',
    fromStreet: 'WHITE PLAINS ROAD', toStreet: 'LURTING AVENUE', aliases: [],
  },
  side: { cardinal: 'North' },
  resolution: { method: 'automatic', evidenceVersion: 'curb-v2' },
});
const location = Object.freeze({
  lat: 40.7,
  lng: -73.9999,
  accuracyMeters: 5,
  sampleCount: 4,
  consistencyMeters: 4,
});
const request = overrides => ({ protocolVersion: 2, location, ...overrides });
const supported = () => ({ state: 'SUPPORTED', identity, publicCurb: toPublicCurb(identity), reasons: [] });
const selectedRules = Object.freeze({
  rules: [{ category: 'cleaning', source: 'dot', schedules: [] }],
  cleaning: { category: 'cleaning', source: 'dot', schedules: [] },
  restrictions: [], timeLimits: [], meter: null, admin: [], conflicts: [],
});

function dependencies(overrides = {}) {
  return {
    resolveCanonicalCurb: vi.fn(async () => supported()),
    applyVisualCurbSelection: vi.fn(async () => supported()),
    loadCanonicalRules: vi.fn(async () => ({ state: 'complete', selected: selectedRules, sources: {} })),
    readCanonicalCache: vi.fn(async () => ({ hit: false, reason: 'exact_identity_missing' })),
    persistCanonicalCurb: vi.fn(async () => ({ success: true, publicCurbKey: publicCurbKey(identity), ruleCount: 1 })),
    requestNonceFactory: () => 'server-nonce',
    inFlight: new Map(),
    telemetry: { emit: vi.fn() },
    ...overrides,
  };
}

describe('runCanonicalCurbOrchestrator', () => {
  it('resolves, loads one source fan-out, persists, and returns a public high-confidence response', async () => {
    const deps = dependencies();
    const result = await runCanonicalCurbOrchestrator(request(), deps);

    expect(result).toEqual({
      protocolVersion: 2,
      status: 'high_confidence',
      segmentId: publicCurbKey(identity),
      streetName: 'MARAN PLACE',
      sideLabel: 'North',
      ruleSummary: { cleaningAvailable: true },
    });
    expect(deps.resolveCanonicalCurb).toHaveBeenCalledOnce();
    expect(deps.loadCanonicalRules).toHaveBeenCalledOnce();
    expect(deps.persistCanonicalCurb).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toMatch(/1000000001|global|physical|b5sc/);
  });

  it('returns exactly two public candidates without starting rules or persistence', async () => {
    const candidates = [0, 1].map(rank => ({
      token: `candidate2_${'a'.repeat(16)}_${String(rank).repeat(32)}`,
      streetName: rank ? 'WHITE PLAINS ROAD' : 'MARAN PLACE',
      stroke: { type: 'MultiLineString', coordinates: [[[-74, 40.7], [-73.999 + rank * 0.0001, 40.7]]] },
    }));
    const deps = dependencies({
      resolveCanonicalCurb: vi.fn(async () => ({
        state: 'AMBIGUOUS', reasons: ['competing_roadways_overlap'],
        center: { lat: location.lat, lng: location.lng }, candidates,
      })),
    });

    const result = await runCanonicalCurbOrchestrator(request(), deps);

    expect(result).toEqual({
      protocolVersion: 2,
      status: 'ambiguous',
      selector: { center: { lat: location.lat, lng: location.lng }, candidates },
    });
    expect(deps.loadCanonicalRules).not.toHaveBeenCalled();
    expect(deps.persistCanonicalCurb).not.toHaveBeenCalled();
    expect(deps.telemetry.emit).toHaveBeenCalledWith('curb_candidate_count', expect.objectContaining({
      candidateCount: 2,
    }));
    expect(deps.telemetry.emit).toHaveBeenCalledWith('visual_curb_selector_shown', expect.any(Object));
  });

  it('returns unsupported and starts no sources when identity resolution fails', async () => {
    const deps = dependencies({
      resolveCanonicalCurb: vi.fn(async () => ({
        state: 'UNSUPPORTED', reasons: ['candidate_coverage_incomplete'],
      })),
    });

    await expect(runCanonicalCurbOrchestrator(request(), deps)).resolves.toEqual({
      protocolVersion: 2, status: 'unsupported', reason: 'candidate_incomplete',
    });
    expect(deps.loadCanonicalRules).not.toHaveBeenCalled();
    expect(deps.persistCanonicalCurb).not.toHaveBeenCalled();
  });

  it('routes candidate tokens through fresh visual selection and rejects invalid selection before sources', async () => {
    const valid = dependencies();
    const invalid = dependencies({
      applyVisualCurbSelection: vi.fn(async () => ({
        state: 'UNSUPPORTED', reasons: ['candidate_selection_stale'],
      })),
    });
    const candidateToken = `candidate2_${'a'.repeat(16)}_${'b'.repeat(32)}`;

    const selected = await runCanonicalCurbOrchestrator(request({ candidateToken }), valid);
    const rejected = await runCanonicalCurbOrchestrator(request({ candidateToken }), invalid);

    expect(selected.status).toBe('high_confidence');
    expect(valid.telemetry.emit).toHaveBeenCalledWith('visual_curb_selected', { protocolVersion: 2 });
    expect(valid.applyVisualCurbSelection).toHaveBeenCalledOnce();
    expect(valid.resolveCanonicalCurb).not.toHaveBeenCalled();
    expect(rejected).toEqual({ protocolVersion: 2, status: 'unsupported', reason: 'candidate_incomplete' });
    expect(invalid.loadCanonicalRules).not.toHaveBeenCalled();
  });

  it('reuses an exact canonical cache hit and never queries a radius cache or sources', async () => {
    const key = publicCurbKey(identity);
    const deps = dependencies({
      readCanonicalCache: vi.fn(async () => ({
        hit: true,
        identity,
        publicSegment: {
          segmentId: key, streetName: 'MARAN PLACE', sideLabel: 'North',
          ruleSummary: { cleaningAvailable: false },
        },
      })),
    });

    const result = await runCanonicalCurbOrchestrator(request(), deps);

    expect(result).toMatchObject({ status: 'high_confidence', segmentId: key, ruleSummary: { cleaningAvailable: false } });
    expect(deps.readCanonicalCache).toHaveBeenCalledWith(expect.objectContaining({ publicCurbKey: key }));
    expect(deps.loadCanonicalRules).not.toHaveBeenCalled();
    expect(deps.persistCanonicalCurb).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent identical requests and performs no retry', async () => {
    let release;
    const resolution = new Promise(resolve => { release = resolve; });
    const deps = dependencies({ resolveCanonicalCurb: vi.fn(() => resolution) });

    const first = runCanonicalCurbOrchestrator(request(), deps);
    const second = runCanonicalCurbOrchestrator(request(), deps);
    expect(deps.resolveCanonicalCurb).toHaveBeenCalledOnce();
    release(supported());

    await expect(Promise.all([first, second])).resolves.toEqual([
      expect.objectContaining({ status: 'high_confidence' }),
      expect.objectContaining({ status: 'high_confidence' }),
    ]);
    expect(deps.loadCanonicalRules).toHaveBeenCalledOnce();
  });

  it('ends the entire orchestration by eight seconds without retrying or starting sources', async () => {
    vi.useFakeTimers();
    try {
      const deps = dependencies({ resolveCanonicalCurb: vi.fn(() => new Promise(() => {})) });
      const result = runCanonicalCurbOrchestrator(request(), deps);

      await vi.advanceTimersByTimeAsync(OVERALL_DEADLINE_MS);

      await expect(result).resolves.toEqual({
        protocolVersion: 2, status: 'unsupported', reason: 'source_unavailable',
      });
      expect(deps.resolveCanonicalCurb).toHaveBeenCalledOnce();
      expect(deps.loadCanonicalRules).not.toHaveBeenCalled();
      expect(deps.persistCanonicalCurb).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns null for non-V2 requests so the legacy callable path remains authoritative', async () => {
    const deps = dependencies();
    await expect(runCanonicalCurbOrchestrator({ lat: 40.7, lng: -74 }, deps)).resolves.toBeNull();
    expect(deps.resolveCanonicalCurb).not.toHaveBeenCalled();
  });
});
