import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { normalizeCsclRow } = require('./csclNormalizer');
const { createMemoryCandidateStore } = require('./candidateStore');
const { normalizeDotSignRow } = require('./dotSignNormalizer');
const { normalizeParkNycRow } = require('./parkNycNormalizer');
const { createMemoryAggregateShadowSink } = require('./shadowTelemetry');
const { runCurbIntelligenceShadow } = require('./shadowExecution');

const CSCL_VERSION = { resourceId: 'inkn-q76z', version: 'fixture-v1' };
const DOT_VERSION = { resourceId: 'nfid-uabd', rowsUpdatedAt: '2026-09-15T10:04:47Z', viewLastModified: '2026-09-15T10:00:16Z' };
const PARK_VERSION = { resourceId: 'e7yp-wx55', rowsUpdatedAt: '2026-09-01T10:21:51Z', viewLastModified: '2026-09-01T10:20:59Z' };
const coverageEnvelope = { minLat: 40.69, maxLat: 40.71, minLng: -74.01, maxLng: -73.99 };

function csclCandidate() {
  const normalized = normalizeCsclRow({
    the_geom: { type: 'MultiLineString', coordinates: [[[-74.001, 40.7], [-73.999, 40.7]]] },
    globalid: 'selected-global', physicalid: '123', l_blockfaceid: '1000000001', r_blockfaceid: '1000000002',
    boroughcode: '1', b5sc: '123456', rw_type: '1', full_street_name: 'TEST STREET',
    street_name: 'TEST', stname_label: 'TEST ST', trafdir: 'FT', nominaldir: null,
    streetwidth: '40', from_level_code: '13', to_level_code: '13', accessible: null,
    nonped: null, status: '2', modified_date: '2026-09-15', created_date: '2020-01-01',
  }, CSCL_VERSION);
  return normalized.record;
}

function dotCandidate() {
  return normalizeDotSignRow({
    order_number: 'P-1', record_type: 'Current', order_type: 'P', borough: 'MANHATTAN',
    on_street: 'TEST STREET', from_street: 'FIRST STREET', to_street: 'SECOND STREET',
    side_of_street: 'W', sign_code: 'PS-20B',
    sign_description: 'NO PARKING (SANITATION BROOM SYMBOL) MONDAY 8AM-9AM <->',
  }, DOT_VERSION).record;
}

function parkCandidate() {
  return normalizeParkNycRow({
    the_geom: { type: 'MultiLineString', coordinates: [[[-74.0008, 40.70004], [-73.9992, 40.70004]]] },
    pay_by_cel: '100124', vehicle_ty: 'All Vehicles',
    all_vehicl: '2 Hours', all_vehi_1: 'Monday-Saturday 8 AM-7 PM',
    all_vehi_2: '$2.00 per Hour', all_vehi_3: '$4.00',
    commercial: 'N/A', commerci_1: 'N/A', commerci_2: 'N/A', commerci_3: 'N/A',
    on_street: 'Test Street', side_of_st: 'W', from_stree: 'First Street',
    to_street: 'Second Street', borough: 'Manhattan', meter_rate: 'Zone 1', shape_leng: null,
  }, PARK_VERSION).record;
}

const legacyEvidence = {
  segment: {
    status: 'active', source: 'nyc_open_data', confidenceScore: 0.9,
    provenance: { provider: 'nyc_open_data' }, confidence: { level: 'community' },
    blockFaceEvidence: { blockDecisive: true, sideResolved: true, parseComplete: true },
  },
  activeRules: [{
    type: 'streetCleaning', source: 'nyc_open_data', supersededAt: null,
    schedules: [{ side: 'West', days: ['Mon'], startTime: '08:00', endTime: '09:00' }],
  }],
};

function snapshot(candidates, sourceVersion) {
  return { candidates, completeness: { state: 'COMPLETE', reason: null }, sourceVersion };
}

function dependencies(overrides = {}) {
  return {
    curbCandidateStore: createMemoryCandidateStore([csclCandidate()], { coverageEnvelope }),
    dotSource: { async query() { return snapshot([dotCandidate()], DOT_VERSION); } },
    parkNycSource: {
      async query() {
        return {
          candidateSnapshot: snapshot([parkCandidate()], PARK_VERSION),
          associationContext: {
            officialNames: ['TEST STREET'], officialBounds: ['FIRST STREET', 'SECOND STREET'],
            borough: 'MANHATTAN', side: 'W', officialRoadwayGeometryComplete: true,
          },
        };
      },
    },
    officialRelationshipProvider: {
      fixtureOnly: true,
      async resolve() {
        return {
          ok: true,
          faceContext: {
            curbIdentityState: 'SUPPORTED', borough: 'MANHATTAN', streetNames: ['TEST STREET'],
            fromNames: ['FIRST STREET'], toNames: ['SECOND STREET'], side: 'W',
            officialRelationship: {
              providerId: 'fixture-reviewed-relationship', version: 'fixture-v1',
              orderApplicability: { 'P-1': 'WHOLE_FACE' },
            },
          },
        };
      },
    },
    ...overrides,
  };
}

const policy = {
  overallDeadlineMs: 500,
  sourceDeadlineMs: { curb: 100, dot: 100, parkNyc: 100, relationship: 100, sink: 100 },
  maxCandidates: { curb: 10, dot: 10, parkNyc: 10 },
  maxRetries: 0,
};

async function run(extra = {}) {
  return runCurbIntelligenceShadow({
    location: { lat: 40.70005, lng: -74, accuracyMeters: 1 },
    legacyEvidence,
    dependencies: dependencies(extra.dependencies),
    executionPolicy: { ...policy, ...extra.executionPolicy },
  });
}

describe('standalone Curb Intelligence shadow execution', () => {
  it('returns separate rich runtime and aggregate-safe outputs', async () => {
    const sink = createMemoryAggregateShadowSink();
    const result = await run({ dependencies: { sink } });

    expect(result.completed).toBe(true);
    expect(result.runtimeResult.states).toEqual({ curb: 'SUPPORTED', cleaning: 'SUPPORTED', meter: 'SUPPORTED' });
    expect(result.runtimeResult.runtimeEvidence.selectedGeometry).toBeDefined();
    expect(result.persistableComparison).toMatchObject({
      curbState: 'SUPPORTED', cleaningState: 'SUPPORTED', meterState: 'SUPPORTED',
      cleaningComparisonCategory: 'exact_agreement',
    });
    expect(JSON.stringify(result.persistableComparison)).not.toMatch(/latitude|longitude|coordinates|zoneId|orderNumber/i);
    expect(sink.snapshot()).toHaveLength(1);
  });

  it.each([
    ['absent', undefined],
    ['unavailable', { async resolve() { throw new Error('provider included private context'); } }],
    ['malformed', { async resolve() { return { ok: true, faceContext: {} }; } }],
    ['unmapped', { async resolve() { return { ok: true, faceContext: {
      curbIdentityState: 'SUPPORTED', borough: 'MANHATTAN', streetNames: ['TEST STREET'],
      fromNames: ['FIRST STREET'], toNames: ['SECOND STREET'], side: 'W',
      officialRelationship: { providerId: 'fixture', version: 'v1', orderApplicability: {} },
    } }; } }],
  ])('fails cleaning closed when the relationship provider is %s while meter remains independent', async (_label, provider) => {
    const result = await run({ dependencies: { officialRelationshipProvider: provider } });
    expect(result.runtimeResult.states).toEqual({ curb: 'SUPPORTED', cleaning: 'UNKNOWN', meter: 'SUPPORTED' });
    expect(result.runtimeResult.cleaning.reasons).toContain('official_order_relationship_missing');
    expect(result.persistableComparison.reasonBuckets).toContain('official_order_relationship_missing');
  });

  it('starts independent DOT and ParkNYC retrieval concurrently after curb resolution', async () => {
    let dotStarted = false;
    let parkStarted = false;
    const waitForPeer = async peer => {
      const started = Date.now();
      while (!peer() && Date.now() - started < 80) await new Promise(resolve => setTimeout(resolve, 1));
      return peer();
    };
    const result = await run({ dependencies: {
      dotSource: { async query() { dotStarted = true; expect(await waitForPeer(() => parkStarted)).toBe(true); return snapshot([dotCandidate()], DOT_VERSION); } },
      parkNycSource: { async query() { parkStarted = true; expect(await waitForPeer(() => dotStarted)).toBe(true); return dependencies().parkNycSource.query(); } },
    } });
    expect(result.completed).toBe(true);
  });

  it('isolates source failure and never retries deterministic failures', async () => {
    let dotCalls = 0;
    const result = await run({ dependencies: {
      dotSource: { async query() { dotCalls += 1; throw new Error('raw upstream response with coordinates'); } },
    } });
    expect(dotCalls).toBe(1);
    expect(result.runtimeResult.states.cleaning).toBe('UNKNOWN');
    expect(result.runtimeResult.states.meter).toBe('SUPPORTED');
    expect(result.diagnostics).toContain('dot_unavailable');
    expect(JSON.stringify(result.persistableComparison)).not.toContain('raw upstream');
  });

  it('fails malformed source responses closed with reviewed diagnostics', async () => {
    const result = await run({ dependencies: {
      dotSource: { async query() { return {}; } },
      parkNycSource: { async query() { return { candidateSnapshot: { candidates: 'not-an-array' } }; } },
    } });
    expect(result.runtimeResult.states).toEqual({ curb: 'SUPPORTED', cleaning: 'UNKNOWN', meter: 'UNKNOWN' });
    expect(result.diagnostics).toContain('source_response_malformed');
    expect(result.persistableComparison.reasonBuckets).toContain('source_response_malformed');
  });

  it('aborts a timed-out source and emits only reviewed diagnostics', async () => {
    let observedAbort = false;
    const result = await run({
      dependencies: {
        parkNycSource: { query({ signal }) { return new Promise(resolve => {
          signal.addEventListener('abort', () => { observedAbort = true; resolve(null); });
        }); } },
      },
      executionPolicy: { ...policy, sourceDeadlineMs: { ...policy.sourceDeadlineMs, parkNyc: 10 } },
    });
    expect(observedAbort).toBe(true);
    expect(result.runtimeResult.states.meter).toBe('UNKNOWN');
    expect(result.diagnostics).toEqual(expect.arrayContaining(['execution_timeout', 'park_nyc_unavailable']));
  });

  it('does not throw when the aggregate sink fails', async () => {
    const result = await run({ dependencies: {
      sink: { async record() { throw new Error('database path and user id'); } },
    } });
    expect(result.completed).toBe(true);
    expect(result.diagnostics).toContain('internal_shadow_error');
    expect(JSON.stringify(result.persistableComparison)).not.toContain('database path');
  });
});
