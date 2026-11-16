import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  buildDemoResolutionRecord,
  demoCurbDiagnosticsEnabled,
  RECORD_NAME,
} = require('./demoResolutionDiagnostic');
const { firstSideConfirmationEligibilityFailure } = require('./sideConfirmation');
const { resolveCanonicalCurb } = require('./canonicalCurbResolver');
const { runCanonicalCurbOrchestrator } = require('./canonicalCurbOrchestrator');

const DEMO = Object.freeze({
  FUNCTIONS_EMULATOR: 'true',
  GCLOUD_PROJECT: 'demo-parkqueen-functions-test',
});
const PRODUCTION = Object.freeze({
  FUNCTIONS_EMULATOR: 'true',
  GCLOUD_PROJECT: 'parkqueen-46475363-ccf36',
});
const VERSION = Object.freeze({ resourceId: 'inkn-q76z', version: 'fixture-v2' });
const METADATA = Object.freeze({ id: 'inkn-q76z', rowsUpdatedAt: 1767225600, viewLastModified: 1767225660 });
const SECRET_UID = 'diagnostic-uid-should-not-log';
const SECRET_KEY = 'diagnostic-hmac-key-should-not-log-0123456789';

function roadway() {
  return {
    globalId: 'main-global',
    sourceVersion: VERSION,
    geometry: { type: 'MultiLineString', coordinates: [[[-74.001, 40.7], [-73.999, 40.7]]] },
    leftBlockFaceId: '1000000001',
    rightBlockFaceId: '1000000002',
    sourceNative: {
      globalid: 'main-global',
      physicalid: 'main-global-physical',
      b5sc: 'main-global-b5sc',
      boroughcode: '2',
      rw_type: '1',
      full_street_name: 'MARAN PLACE',
      street_name: 'MARAN PLACE',
      stname_label: 'Maran Place',
      streetwidth: '34',
      from_level_code: '13',
      to_level_code: '13',
      accessible: null,
      nonped: null,
      status: '2',
      from_street: 'WHITE PLAINS ROAD',
      to_street: 'LURTING AVENUE',
    },
  };
}

function fetchFor(rows) {
  return vi.fn(async url => ({
    ok: true,
    json: async () => (String(url).includes('/api/views/') ? METADATA : rows.map(row => ({
      ...row.sourceNative,
      globalid: row.globalId,
      l_blockfaceid: row.leftBlockFaceId,
      r_blockfaceid: row.rightBlockFaceId,
      the_geom: row.geometry,
    }))),
  }));
}

function resolverOptions(extra = {}) {
  return {
    fetchFn: fetchFor([roadway()]),
    getSocrataToken: () => '',
    planimetricStore: {
      async queryCurbs() {
        return { candidates: [], completeness: { state: 'COMPLETE', reason: null } };
      },
    },
    requestNonce: 'request-nonce',
    callerUid: SECRET_UID,
    sideConfirmationHmacKey: SECRET_KEY,
    ...extra,
  };
}

function diagnosticsFrom(spy) {
  return spy.mock.calls.flatMap(([line]) => {
    if (typeof line !== 'string' || !line.includes(RECORD_NAME)) return [];
    return [JSON.parse(line)];
  });
}

const eligible = Object.freeze({
  enabled: true,
  consideredCount: 1,
  sideCrossesCenterline: true,
  endpointAmbiguous: false,
  levelOrRoadbedAmbiguous: false,
  topologySelectable: true,
  sourceEnrichment: false,
  decisionState: 'UNSUPPORTED',
  decisionReasons: ['ambiguity_unresolved'],
  faces: { LEFT: '1000000001', RIGHT: '1000000002' },
  orientation: { north: 'up', axis: 'east-west' },
});

describe('demo curb resolution diagnostic', () => {
  let spy;
  afterEach(() => spy?.mockRestore());

  it('stays off outside the local demo functions emulator', () => {
    expect(demoCurbDiagnosticsEnabled(DEMO)).toBe(true);
    expect(demoCurbDiagnosticsEnabled(PRODUCTION)).toBe(false);
    expect(demoCurbDiagnosticsEnabled({ GCLOUD_PROJECT: DEMO.GCLOUD_PROJECT })).toBe(false);
    expect(demoCurbDiagnosticsEnabled({ FUNCTIONS_EMULATOR: 'true' })).toBe(false);
    expect(demoCurbDiagnosticsEnabled({})).toBe(false);
  });

  it('keeps only the privacy-safe diagnostic fields', () => {
    const record = buildDemoResolutionRecord({
      internalReason: '40.7128,-74.0060',
      stage: 'candidate_construction',
      rawCsclCandidateCount: 4,
      materialRoadwayCandidateCount: 1,
      constructedCanonicalCandidateCount: 0,
      classifierState: 'UNSUPPORTED',
      classifierReason: 'sidec1.secret.token',
      sideConfirmationEligibility: 'centerline_uncertainty',
      elapsedMs: 120,
      stageElapsedMs: 15,
      lat: 40.7128,
      uid: SECRET_UID,
      hmacKey: SECRET_KEY,
      address: 'MARAN PLACE',
    });
    expect(record).toEqual({
      record: RECORD_NAME,
      projectId: 'demo-parkqueen-functions-test',
      internalReason: null,
      stage: 'candidate_construction',
      rawCsclCandidateCount: 4,
      materialRoadwayCandidateCount: 1,
      constructedCanonicalCandidateCount: 0,
      classifierState: 'UNSUPPORTED',
      classifierReason: null,
      sideConfirmationEligibility: 'centerline_uncertainty',
      elapsedMs: 120,
      stageElapsedMs: 15,
    });
    expect(JSON.stringify(record)).not.toContain(SECRET_UID);
    expect(JSON.stringify(record)).not.toContain('40.7128');
    expect(JSON.stringify(record)).not.toContain('MARAN');
  });

  it('names the first failed side-confirmation condition in gate order', () => {
    expect(firstSideConfirmationEligibilityFailure(eligible)).toBeNull();
    expect(firstSideConfirmationEligibilityFailure({ ...eligible, enabled: false })).toBe('confirmation_disabled');
    expect(firstSideConfirmationEligibilityFailure({ ...eligible, consideredCount: 2 })).toBe('considered_count');
    expect(firstSideConfirmationEligibilityFailure({ ...eligible, sideCrossesCenterline: false })).toBe('centerline_uncertainty');
    expect(firstSideConfirmationEligibilityFailure({ ...eligible, endpointAmbiguous: true })).toBe('endpoint_ambiguity');
    expect(firstSideConfirmationEligibilityFailure({ ...eligible, topologySelectable: false })).toBe('roadway_topology');
    expect(firstSideConfirmationEligibilityFailure({ ...eligible, sourceEnrichment: true })).toBe('source_enrichment');
    expect(firstSideConfirmationEligibilityFailure({ ...eligible, decisionState: 'SUPPORTED' })).toBe('classifier_state');
    expect(firstSideConfirmationEligibilityFailure({ ...eligible, decisionReasons: ['official_face_missing'] })).toBe('classifier_reason');
    expect(firstSideConfirmationEligibilityFailure({ ...eligible, faces: null })).toBe('official_faces');
    expect(firstSideConfirmationEligibilityFailure({ ...eligible, orientation: null })).toBe('street_orientation');
  });

  it('reports a classifier failure without changing the unsupported result', async () => {
    spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const point = {
      lat: 40.70005, lng: -74, accuracyMeters: 80, sampleCount: 3, consistencyMeters: 2,
    };
    const silent = await resolveCanonicalCurb(point, resolverOptions());
    const logged = await resolveCanonicalCurb(point, resolverOptions({ env: DEMO }));
    expect(silent).toEqual(logged);
    expect(logged).toEqual({
      state: 'UNSUPPORTED',
      reasons: ['reported_accuracy_exceeds_limit'],
    });
    expect(diagnosticsFrom(spy)).toEqual([expect.objectContaining({
      internalReason: 'reported_accuracy_exceeds_limit',
      stage: 'classification',
      classifierState: 'UNSUPPORTED',
      classifierReason: 'reported_accuracy_exceeds_limit',
      rawCsclCandidateCount: null,
      sideConfirmationEligibility: null,
    })]);
  });

  it('reports candidate construction separately from the collapsed public reason', async () => {
    spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const point = {
      lat: 40.7, lng: -74, accuracyMeters: 8, sampleCount: 3, consistencyMeters: 2,
    };
    const silent = await resolveCanonicalCurb(point, resolverOptions());
    const logged = await resolveCanonicalCurb(point, resolverOptions({ env: DEMO }));
    expect(logged).toEqual(silent);
    expect(logged).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_incomplete'] });
    const [record] = diagnosticsFrom(spy);
    expect(record).toMatchObject({
      internalReason: 'invalid_cscl_side',
      stage: 'candidate_construction',
      rawCsclCandidateCount: 1,
      materialRoadwayCandidateCount: 1,
      constructedCanonicalCandidateCount: 0,
      sideConfirmationEligibility: null,
      classifierState: null,
    });
    expect(record.stageElapsedMs).toEqual(expect.any(Number));
    expect(JSON.stringify(record)).not.toContain('40.7');
    expect(JSON.stringify(record)).not.toContain(SECRET_UID);
    expect(JSON.stringify(record)).not.toContain(SECRET_KEY);
  });

  it('reports side-confirmation ineligibility and keeps the orchestrated response', async () => {
    spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const point = {
      lat: 40.70002, lng: -74, accuracyMeters: 8, sampleCount: 3, consistencyMeters: 2,
    };
    const silent = await resolveCanonicalCurb(point, resolverOptions({ sideConfirmationEnabled: false }));
    const logged = await resolveCanonicalCurb(point, resolverOptions({
      sideConfirmationEnabled: false,
      env: DEMO,
    }));
    expect(logged).toEqual(silent);
    expect(logged).toMatchObject({ state: 'UNSUPPORTED', reasons: ['ambiguity_unresolved'] });
    expect(diagnosticsFrom(spy)[0]).toMatchObject({
      internalReason: 'confirmation_disabled',
      stage: 'side_confirmation_eligibility',
      sideConfirmationEligibility: 'confirmation_disabled',
      classifierState: 'UNSUPPORTED',
      classifierReason: 'ambiguity_unresolved',
      rawCsclCandidateCount: 1,
      materialRoadwayCandidateCount: 1,
      constructedCanonicalCandidateCount: 1,
    });

    const orchestrated = await runCanonicalCurbOrchestrator({
      protocolVersion: 2,
      location: point,
    }, {
      ...resolverOptions({ sideConfirmationEnabled: false, env: PRODUCTION }),
      requestNonceFactory: () => 'server-generated-nonce',
      inFlight: new Map(),
      telemetry: { emit: vi.fn() },
    });
    expect(orchestrated).toEqual({
      protocolVersion: 2,
      status: 'unsupported',
      reason: 'candidate_incomplete',
    });
    expect(diagnosticsFrom(spy)).toHaveLength(1);
  });

  it('reports signing failure after eligibility without a selector or secret', async () => {
    spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const point = {
      lat: 40.70002, lng: -74, accuracyMeters: 8, sampleCount: 3, consistencyMeters: 2,
    };
    const result = await resolveCanonicalCurb(point, resolverOptions({
      sideConfirmationEnabled: true,
      sideConfirmationHmacKey: undefined,
      env: DEMO,
    }));
    expect(result).toMatchObject({ state: 'UNSUPPORTED', reasons: ['ambiguity_unresolved'] });
    expect(result.confirmation).toBeUndefined();
    const [record] = diagnosticsFrom(spy);
    expect(record).toMatchObject({
      internalReason: 'signing_authority',
      stage: 'side_confirmation_signing',
      sideConfirmationEligibility: null,
      classifierState: 'UNSUPPORTED',
      classifierReason: 'ambiguity_unresolved',
      constructedCanonicalCandidateCount: 1,
    });
    expect(JSON.stringify(record)).not.toContain(SECRET_UID);
    expect(JSON.stringify(record)).not.toContain('sidec1');
  });

  it('does not record a successful resolution', async () => {
    spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const result = await resolveCanonicalCurb({
      lat: 40.70005, lng: -74, accuracyMeters: 1, sampleCount: 3, consistencyMeters: 2,
    }, resolverOptions({ env: DEMO }));
    expect(result.state).toBe('SUPPORTED');
    expect(diagnosticsFrom(spy)).toEqual([]);
  });
});
