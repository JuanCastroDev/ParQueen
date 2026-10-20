import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { runCanonicalCurbOrchestrator, OVERALL_DEADLINE_MS, mapCanonicalAuthorityFailure } = require('./canonicalCurbOrchestrator');
const { publicCurbKey, toPublicCurb } = require('./canonicalCurbIdentity');
const { resolveCanonicalCurb } = require('./canonicalCurbResolver');
const { createPrivateBlockfaceResolver } = require('./privateBlockfaceResolver');

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
const metadata = { id: 'inkn-q76z', rowsUpdatedAt: 1767225600, viewLastModified: 1767225660 };
const raw = (id, name, geometry, left = '1000000001', right = '1000000002') => ({
  globalid: id, physicalid: `${id}-physical`, b5sc: `${id}-b5sc`,
  l_blockfaceid: left, r_blockfaceid: right, boroughcode: '2', rw_type: '1',
  full_street_name: name, street_name: name, stname_label: name, streetwidth: '34',
  from_level_code: '13', to_level_code: '13', status: '2', nonped: '', accessible: '',
  from_street: 'WHITE PLAINS ROAD', to_street: 'LURTING AVENUE', the_geom: geometry,
});
const fetchFor = rows => vi.fn(async url => ({ ok: true, json: async () => (
  String(url).includes('/api/views/') ? metadata : rows
) }));
const function3cSuccess = officialBlockFaceId => ({
  ok: true,
  officialBlockFaceId,
  normalizedStreetNames: {
    onStreet: 'MARAN PLACE',
    crossStreetOne: 'WHITE PLAINS ROAD',
    crossStreetTwo: 'LURTING AVENUE',
  },
  returnCode: '00', reasonCode: ' ',
  sourceVersion: { geosupportRelease: '26C', geosupportVersion: '26.3' },
});
function function3c(officialBlockFaceId = '1000000001') {
  const transport = vi.fn(async () => ({
    status: 200, text: async () => JSON.stringify(function3cSuccess(officialBlockFaceId)),
  }));
  return {
    blockfaceResolver: createPrivateBlockfaceResolver({
      mode: 'shadow', serviceUrl: 'https://parqueen-test-resolver-uc.a.run.app',
      getIdToken: vi.fn(async () => 'synthetic-token'), transport,
    }),
    transport,
  };
}
let authenticPrimary;
let authenticAmbiguous;
beforeAll(async () => {
  authenticPrimary = await resolveCanonicalCurb(location, {
    fetchFn: fetchFor([raw('private-global', 'MARAN PLACE', {
      type: 'MultiLineString', coordinates: [[[-74.001, 40.69992], [-73.999, 40.69992]]],
    })]), requestNonce: 'server-nonce',
  });
  authenticAmbiguous = await resolveCanonicalCurb({
    ...location, lat: 40.700035, lng: -73.999965, accuracyMeters: 3, consistencyMeters: 3,
  }, {
    fetchFn: fetchFor([
      raw('horizontal', 'MARAN PLACE', { type: 'MultiLineString', coordinates: [[[-74, 40.7], [-73.999, 40.7]]] }),
      raw('vertical', 'WHITE PLAINS ROAD', { type: 'MultiLineString', coordinates: [[[-74, 40.7], [-74, 40.701]]] }, '2000000001', '2000000002'),
    ]), requestNonce: 'server-nonce',
  });
});

function dependencies(overrides = {}) {
  const proof = function3c();
  return {
    resolveCanonicalCurb: vi.fn(async () => supported()),
    applyVisualCurbSelection: vi.fn(async () => supported()),
    loadCanonicalRules: vi.fn(async () => ({ state: 'complete', selected: selectedRules, sources: {} })),
    readCanonicalCache: vi.fn(async () => ({ hit: false, reason: 'exact_identity_missing' })),
    persistCanonicalCurb: vi.fn(async () => ({ success: true, publicCurbKey: publicCurbKey(identity), ruleCount: 1 })),
    requestNonceFactory: () => 'server-nonce',
    inFlight: new Map(),
    telemetry: { emit: vi.fn() },
    blockfaceResolver: proof.blockfaceResolver,
    ...overrides,
  };
}

describe('runCanonicalCurbOrchestrator', () => {
  it('maps every closed authority reason without exposing private evidence', () => {
    const cases = [
      [['invalid_reported_accuracy', 'unsupported_off_network_location'], 'location_quality'],
      [['intersection_complex', 'candidates_not_distinguishable'], 'intersection_complex'],
      [['candidate_coverage_incomplete', 'candidate_incomplete', 'candidate_selection_stale',
        'candidate_token_invalid', 'candidate_token_unavailable', 'canonical_candidate_missing',
        'official_face_missing', 'ambiguity_unresolved', 'duplicate_candidate_identity',
        'source_query_truncated', 'invalid_candidate_row', 'authority_population_mismatch',
        'authority_envelope_mismatch', 'authority_attestation_invalid'], 'candidate_incomplete'],
      [['request_aborted', 'source_unavailable', 'invalid_source_version',
        'source_changed_during_read', 'source_response_malformed', 'source_version_problem',
        'unsupported_roadway_status', 'implausible_geometry', 'invalid_query', 'invalid_envelope',
        'topology_primary_required', 'function3c_unavailable', 'function3c_contract_invalid',
        'function3c_bfi_blank', 'function3c_bfi_malformed', 'function3c_source_version_invalid',
        'function3c_bfi_mismatch', 'function3c_context_invalid',
        'unexpected_identity_proof_failure'], 'source_unavailable'],
    ];
    for (const [reasons, expected] of cases) {
      for (const reason of reasons) expect(mapCanonicalAuthorityFailure({ reasons: [reason] })).toBe(expected);
    }
    expect(mapCanonicalAuthorityFailure({ reasons: ['unknown-private-state'], coordinates: [1, 2] }))
      .toBe('source_unavailable');
  });
  it('rejects a perfectly shaped caller-created primary before any side effect', async () => {
    const deps = dependencies();
    const result = await runCanonicalCurbOrchestrator(request(), deps);
    expect(result).toEqual({ protocolVersion: 2, status: 'unsupported', reason: 'source_unavailable' });
    expect(deps.readCanonicalCache).not.toHaveBeenCalled();
    expect(deps.loadCanonicalRules).not.toHaveBeenCalled();
    expect(deps.persistCanonicalCurb).not.toHaveBeenCalled();
  });
  it('resolves, loads one source fan-out, persists, and returns a public high-confidence response', async () => {
    const deps = dependencies({ resolveCanonicalCurb: vi.fn(async () => authenticPrimary) });
    const result = await runCanonicalCurbOrchestrator(request(), deps);

    expect(result).toEqual({
      protocolVersion: 2,
      status: 'high_confidence',
      segmentId: publicCurbKey(authenticPrimary.identity),
      streetName: 'MARAN PLACE',
      sideLabel: 'North',
      ruleSummary: { cleaningAvailable: true },
    });
    expect(deps.resolveCanonicalCurb).toHaveBeenCalledOnce();
    expect(deps.loadCanonicalRules).toHaveBeenCalledOnce();
    expect(deps.persistCanonicalCurb).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toMatch(/1000000001|global|physical|b5sc/);
  });

  it('requires canonical Function 3C identity proof before an authentic primary can reach cache', async () => {
    const deps = dependencies({
      resolveCanonicalCurb: vi.fn(async () => authenticPrimary),
      blockfaceResolver: undefined,
    });

    await expect(runCanonicalCurbOrchestrator(request(), deps)).resolves.toEqual({
      protocolVersion: 2,
      status: 'unsupported',
      reason: 'source_unavailable',
    });
    expect(deps.readCanonicalCache).not.toHaveBeenCalled();
    expect(deps.loadCanonicalRules).not.toHaveBeenCalled();
    expect(deps.persistCanonicalCurb).not.toHaveBeenCalled();
  });

  it('fails closed on valid opposite-side Function 3C BFI before every downstream side effect', async () => {
    const proof = function3c('1000000002');
    const deps = dependencies({
      resolveCanonicalCurb: vi.fn(async () => authenticPrimary),
      blockfaceResolver: proof.blockfaceResolver,
    });

    await expect(runCanonicalCurbOrchestrator(request(), deps)).resolves.toEqual({
      protocolVersion: 2, status: 'unsupported', reason: 'source_unavailable',
    });
    expect(proof.transport).toHaveBeenCalledOnce();
    expect(deps.readCanonicalCache).not.toHaveBeenCalled();
    expect(deps.loadCanonicalRules).not.toHaveBeenCalled();
    expect(deps.persistCanonicalCurb).not.toHaveBeenCalled();
    expect(deps.telemetry.emit).not.toHaveBeenCalledWith('curb_resolution_high', expect.anything());
  });

  it('maps malformed Function 3C evidence to the coarse public contract without leaking it', async () => {
    const privateBody = {
      ...function3cSuccess('1000000001'),
      providerMessage: 'private native error for 1000000001',
    };
    const blockfaceResolver = createPrivateBlockfaceResolver({
      mode: 'shadow', serviceUrl: 'https://parqueen-test-resolver-uc.a.run.app',
      getIdToken: vi.fn(async () => 'synthetic-token'),
      transport: vi.fn(async () => ({ status: 200, text: async () => JSON.stringify(privateBody) })),
    });
    const deps = dependencies({
      resolveCanonicalCurb: vi.fn(async () => authenticPrimary), blockfaceResolver,
    });

    const result = await runCanonicalCurbOrchestrator(request(), deps);

    expect(result).toEqual({ protocolVersion: 2, status: 'unsupported', reason: 'source_unavailable' });
    const emitted = JSON.stringify(deps.telemetry.emit.mock.calls);
    expect(emitted).not.toMatch(/1000000001|private native error|officialBlockFaceId|geosupport/i);
    expect(deps.readCanonicalCache).not.toHaveBeenCalled();
    expect(deps.persistCanonicalCurb).not.toHaveBeenCalled();
  });

  it('returns exactly two public candidates without starting rules or persistence', async () => {
    const candidates = authenticAmbiguous.candidates;
    const deps = dependencies({
      resolveCanonicalCurb: vi.fn(async () => authenticAmbiguous),
    });

    const result = await runCanonicalCurbOrchestrator(request(), deps);

    expect(result).toEqual({
      protocolVersion: 2,
      status: 'ambiguous',
      selector: { center: authenticAmbiguous.center, candidates },
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
        state: 'UNSUPPORTED', reasons: ['candidate_coverage_incomplete'], candidateCount: 2,
      })),
    });

    await expect(runCanonicalCurbOrchestrator(request(), deps)).resolves.toEqual({
      protocolVersion: 2, status: 'unsupported', reason: 'candidate_incomplete',
    });
    expect(deps.loadCanonicalRules).not.toHaveBeenCalled();
    expect(deps.persistCanonicalCurb).not.toHaveBeenCalled();
    expect(deps.telemetry.emit).toHaveBeenCalledWith('curb_resolution_attempted', expect.objectContaining({
      accuracyMeters: 5,
    }));
    expect(deps.telemetry.emit).toHaveBeenCalledWith('curb_resolution_unsupported', expect.objectContaining({
      reason: 'candidate_incomplete',
      candidateCount: 2,
      sourceCategory: 'cscl',
    }));
  });

  it('routes candidate tokens through fresh visual selection and rejects invalid selection before sources', async () => {
    const valid = dependencies({ applyVisualCurbSelection: vi.fn(async () => authenticPrimary) });
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
    expect(invalid.telemetry.emit).toHaveBeenCalledWith('curb_resolution_unsupported', expect.not.objectContaining({
      sourceCategory: 'cscl',
    }));
  });

  it('does not let visual selection override Function 3C disagreement', async () => {
    const proof = function3c('1000000002');
    const deps = dependencies({
      applyVisualCurbSelection: vi.fn(async () => authenticPrimary),
      blockfaceResolver: proof.blockfaceResolver,
    });
    const candidateToken = `candidate2_${'a'.repeat(16)}_${'b'.repeat(32)}`;

    await expect(runCanonicalCurbOrchestrator(request({ candidateToken }), deps)).resolves.toEqual({
      protocolVersion: 2, status: 'unsupported', reason: 'source_unavailable',
    });
    expect(proof.transport).toHaveBeenCalledOnce();
    expect(deps.readCanonicalCache).not.toHaveBeenCalled();
    expect(deps.loadCanonicalRules).not.toHaveBeenCalled();
    expect(deps.persistCanonicalCurb).not.toHaveBeenCalled();
  });

  it('reuses an exact canonical cache hit and never queries a radius cache or sources', async () => {
    const key = publicCurbKey(authenticPrimary.identity);
    const proof = function3c();
    const deps = dependencies({
      resolveCanonicalCurb: vi.fn(async () => authenticPrimary),
      blockfaceResolver: proof.blockfaceResolver,
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
    expect(proof.transport).toHaveBeenCalledOnce();
    expect(deps.readCanonicalCache).toHaveBeenCalledWith({
      db: undefined,
      topologyResult: authenticPrimary,
      identityProof: expect.objectContaining({ state: 'IDENTITY_PROVEN' }),
    });
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
    release(authenticPrimary);

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
