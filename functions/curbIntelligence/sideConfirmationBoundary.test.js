import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveCanonicalCurb } = require('./canonicalCurbResolver');
const { applyVisualCurbSelection } = require('./visualCurbSelection');
const { runCanonicalCurbOrchestrator } = require('./canonicalCurbOrchestrator');
const { createPrivateBlockfaceResolver } = require('./privateBlockfaceResolver');
const {
  createCandidateToken,
  candidateTokenNonceDigest,
  publicCurbKey,
} = require('./canonicalCurbIdentity');
const { stableSideAuthorityDigest } = require('./sideConfirmation');

const METADATA = Object.freeze({ id: 'inkn-q76z', rowsUpdatedAt: 1767225600, viewLastModified: 1767225660 });
const SERVER_VERSION = Object.freeze({
  resourceId: 'inkn-q76z',
  version: `${METADATA.rowsUpdatedAt}:${METADATA.viewLastModified}`,
});
const closeLocation = Object.freeze({
  lat: 40.70002, lng: -74, accuracyMeters: 8, sampleCount: 3, consistencyMeters: 2,
});
const shiftedLocation = Object.freeze({
  ...closeLocation, lng: closeLocation.lng - 0.00015,
});
const otherLocation = Object.freeze({
  lat: 40.71002, lng: -74, accuracyMeters: 8, sampleCount: 3, consistencyMeters: 2,
});
const emptyPlan = { async queryCurbs() { return { candidates: [], completeness: { state: 'COMPLETE', reason: null } }; } };

function record(overrides = {}) {
  const id = overrides.globalId || 'maran';
  const name = overrides.streetName || 'MARAN PLACE';
  return {
    globalId: id,
    geometry: { type: 'MultiLineString', coordinates: overrides.coordinates || [[[-74.001, 40.7], [-73.999, 40.7]]] },
    leftBlockFaceId: overrides.leftBlockFaceId === undefined ? '1000000001' : overrides.leftBlockFaceId,
    rightBlockFaceId: overrides.rightBlockFaceId === undefined ? '1000000002' : overrides.rightBlockFaceId,
    sourceNative: {
      globalid: id,
      physicalid: overrides.physicalId || `${id}-physical`,
      b5sc: overrides.b5sc || `${id}-b5sc`,
      boroughcode: '2',
      rw_type: '1',
      full_street_name: name,
      street_name: name,
      stname_label: name,
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

const rawRow = value => ({
  ...value.sourceNative,
  globalid: value.globalId,
  l_blockfaceid: value.leftBlockFaceId,
  r_blockfaceid: value.rightBlockFaceId,
  the_geom: value.geometry,
});

function scriptedFetch(populations, metadata = METADATA) {
  const envelopes = [];
  let dataCall = 0;
  const currentMetadata = () => (typeof metadata === 'function' ? metadata() : metadata);
  const fetchFn = vi.fn(async url => {
    const text = String(url);
    if (text.includes('/api/views/')) {
      return { ok: true, json: async () => currentMetadata() };
    }
    envelopes.push(new URL(text).searchParams.get('$where'));
    const rows = populations[Math.min(dataCall, populations.length - 1)];
    dataCall += 1;
    return { ok: true, json: async () => rows.map(rawRow) };
  });
  return { fetchFn, envelopes };
}

function options(fetchFn, extra = {}) {
  return {
    fetchFn,
    planimetricStore: emptyPlan,
    requestNonce: 'boundary-nonce',
    sideConfirmationEnabled: true,
    ...extra,
  };
}

function northToken(result) {
  return result.confirmation.curbs.find(curb => curb.cardinal === 'North').token;
}

function function3c(officialBlockFaceId) {
  const transport = vi.fn(async () => ({
    status: 200,
    text: async () => JSON.stringify({
      ok: true,
      officialBlockFaceId,
      normalizedStreetNames: {
        onStreet: 'MARAN PLACE',
        crossStreetOne: 'WHITE PLAINS ROAD',
        crossStreetTwo: 'LURTING AVENUE',
      },
      returnCode: '00',
      reasonCode: ' ',
      sourceVersion: { geosupportRelease: '26C', geosupportVersion: '26.3' },
    }),
  }));
  return {
    transport,
    resolver: createPrivateBlockfaceResolver({
      mode: 'shadow',
      serviceUrl: 'https://parqueen-test-resolver-uc.a.run.app',
      getIdToken: vi.fn(async () => 'synthetic-token'),
      transport,
    }),
  };
}

async function orchestrate(location, token, fetchFn, proof, enabled = true) {
  const persist = vi.fn(async () => ({ success: true }));
  const readCanonicalCache = vi.fn(async () => ({ hit: false }));
  const loadCanonicalRules = vi.fn(async () => ({ state: 'complete', sources: {}, selected: {
    cleaning: null, restrictions: [], timeLimits: [], meter: null, admin: [], conflicts: [], rules: [],
  } }));
  const outcome = await runCanonicalCurbOrchestrator({
    protocolVersion: 2,
    location,
    ...(token ? { candidateToken: token } : {}),
  }, {
    fetchFn,
    planimetricStore: emptyPlan,
    requestNonceFactory: () => 'boundary-nonce',
    sideConfirmationEnabled: enabled,
    blockfaceResolver: proof.resolver,
    persistCanonicalCurb: persist,
    readCanonicalCache,
    loadCanonicalRules,
    inFlight: new Map(),
    telemetry: { emit: vi.fn() },
  });
  return { outcome, persist, readCanonicalCache, loadCanonicalRules, transport: proof.transport };
}

describe('side-confirmation authority boundaries', () => {
  it('accepts a new center when the envelope changes and the selected roadway does not', async () => {
    const roadway = record();
    const script = scriptedFetch([[roadway], [roadway]]);
    const offered = await resolveCanonicalCurb(closeLocation, options(script.fetchFn));
    const selected = await applyVisualCurbSelection({
      location: shiftedLocation,
      candidateToken: northToken(offered),
    }, options(script.fetchFn));
    expect(script.envelopes).toHaveLength(2);
    expect(script.envelopes[0]).not.toBe(script.envelopes[1]);
    expect(selected).toMatchObject({
      state: 'SUPPORTED',
      identity: { officialBlockFaceId: '1000000001', csclSide: 'LEFT' },
    });
  });

  it('accepts confirmation when an ungrouped row joins the search population', async () => {
    const roadway = record();
    const distant = record({
      globalId: 'unrelated',
      streetName: 'UNRELATED AVENUE',
      coordinates: [[[-74.001, 40.705], [-73.999, 40.705]]],
      leftBlockFaceId: '3000000001',
      rightBlockFaceId: '3000000002',
      b5sc: 'unrelated-b5sc',
    });
    const script = scriptedFetch([[roadway], [roadway, distant]]);
    const offered = await resolveCanonicalCurb(closeLocation, options(script.fetchFn));
    const selected = await applyVisualCurbSelection({
      location: closeLocation,
      candidateToken: northToken(offered),
    }, options(script.fetchFn));
    expect(selected).toMatchObject({
      state: 'SUPPORTED',
      identity: { officialBlockFaceId: '1000000001', csclSide: 'LEFT' },
    });
    expect(JSON.stringify(selected.publicCurb)).not.toContain('3000000001');
  });

  it('fails closed when a connected continuation enters or leaves the selected group', async () => {
    const west = record({
      globalId: 'maran-west',
      coordinates: [[[-74.001, 40.7], [-74, 40.7]]],
      b5sc: 'shared-b5sc',
    });
    const east = record({
      globalId: 'maran-east',
      coordinates: [[[-74, 40.7], [-73.999, 40.7]]],
      b5sc: 'shared-b5sc',
    });
    const besideWest = { ...closeLocation, lng: -74.0005 };
    const entered = scriptedFetch([[west], [west, east]]);
    const offered = await resolveCanonicalCurb(besideWest, options(entered.fetchFn));
    expect(offered.state).toBe('SIDE_CONFIRMATION_REQUIRED');
    const withContinuation = await resolveCanonicalCurb(besideWest, options(scriptedFetch([[west, east]]).fetchFn));
    expect(withContinuation.state).toBe('SIDE_CONFIRMATION_REQUIRED');
    expect(withContinuation.confirmation.curbs.map(curb => curb.token))
      .not.toEqual(offered.confirmation.curbs.map(curb => curb.token));
    const afterEntry = await applyVisualCurbSelection({
      location: besideWest,
      candidateToken: northToken(offered),
    }, options(entered.fetchFn));
    expect(afterEntry).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_selection_stale'] });

    const leftBehind = scriptedFetch([[west, east], [west]]);
    const both = await resolveCanonicalCurb(besideWest, options(leftBehind.fetchFn));
    const afterDeparture = await applyVisualCurbSelection({
      location: besideWest,
      candidateToken: northToken(both),
    }, options(leftBehind.fetchFn));
    expect(afterDeparture).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_selection_stale'] });
  });

  it('rejects a duplicate globalId before an offer and keeps the helper order-dependent', () => {
    const west = record({
      globalId: 'dup-road',
      coordinates: [[[-74.001, 40.7], [-74, 40.7]]],
    });
    const east = record({
      globalId: 'dup-road',
      coordinates: [[[-74, 40.7], [-73.999, 40.7]]],
      physicalId: 'dup-road-other',
    });
    const faces = { LEFT: '1000000001', RIGHT: '1000000002' };
    const forward = stableSideAuthorityDigest({ sourceVersion: SERVER_VERSION, records: [west, east], faces });
    const reverse = stableSideAuthorityDigest({ sourceVersion: SERVER_VERSION, records: [east, west], faces });
    expect(forward).toMatch(/^[0-9a-f]{64}$/);
    expect(forward).toBe(stableSideAuthorityDigest({
      sourceVersion: SERVER_VERSION, records: [west, east], faces,
    }));
    expect(reverse).not.toBe(forward);
  });

  it('does not issue an identity when retrieved rows repeat a globalId', async () => {
    const west = record({
      globalId: 'dup-road',
      coordinates: [[[-74.001, 40.7], [-74, 40.7]]],
    });
    const east = record({
      globalId: 'dup-road',
      coordinates: [[[-74, 40.7], [-73.999, 40.7]]],
      physicalId: 'dup-road-other',
    });
    const script = scriptedFetch([[west, east]]);
    const offered = await resolveCanonicalCurb(closeLocation, options(script.fetchFn));
    expect(offered).toMatchObject({ state: 'UNSUPPORTED', reasons: ['duplicate_candidate_identity'] });
    expect(offered.identity).toBeUndefined();
    const selected = await applyVisualCurbSelection({
      location: closeLocation,
      candidateToken: 'candidate2_abcdef0123456789_0123456789abcdef0123456789abcdef',
    }, options(script.fetchFn));
    expect(selected.state).not.toBe('SUPPORTED');
  });

  it('stops invalid and changed confirmation before Function 3C and persistence', async () => {
    const roadway = record();
    const offerScript = scriptedFetch([[roadway]]);
    const offered = await resolveCanonicalCurb(closeLocation, options(offerScript.fetchFn));
    const token = northToken(offered);
    const quality = [
      [{ ...closeLocation, sampleCount: 2 }, 'insufficient_samples'],
      [{ ...closeLocation, accuracyMeters: 51 }, 'reported_accuracy_exceeds_limit'],
      [{ ...closeLocation, consistencyMeters: 13 }, 'inconsistent_samples'],
    ];
    for (const [location, reason] of quality) {
      const resolved = await resolveCanonicalCurb(location, options(scriptedFetch([[roadway]]).fetchFn));
      expect(resolved).toMatchObject({ state: 'UNSUPPORTED', reasons: [reason] });
      const proof = function3c('1000000001');
      const result = await orchestrate(location, token, scriptedFetch([[roadway]]).fetchFn, proof);
      // Selection collapses every non-matching fresh result to stale, so the
      // public confirmation reason is candidate_incomplete. The resolver
      // reason above is the quality gate that actually ran.
      expect(result.outcome).toEqual({
        protocolVersion: 2, status: 'unsupported', reason: 'candidate_incomplete',
      });
      expect(proof.transport).not.toHaveBeenCalled();
      expect(result.persist).not.toHaveBeenCalled();
      expect(result.readCanonicalCache).not.toHaveBeenCalled();
      expect(result.loadCanonicalRules).not.toHaveBeenCalled();
    }
    const movedGeometry = record({ coordinates: [[[-74.001, 40.70001], [-73.999, 40.70001]]] });
    const otherFaces = record({ leftBlockFaceId: '1000000008', rightBlockFaceId: '1000000009' });
    const changes = [
      [{ lat: 40.700063, lng: -74, accuracyMeters: 3, sampleCount: 3, consistencyMeters: 2 }, [roadway]],
      [closeLocation, [movedGeometry]],
      [closeLocation, [otherFaces]],
    ];
    for (const [location, rows] of changes) {
      const proof = function3c('1000000001');
      const result = await orchestrate(location, token, scriptedFetch([rows]).fetchFn, proof);
      expect(result.outcome).toEqual({
        protocolVersion: 2, status: 'unsupported', reason: 'candidate_incomplete',
      });
      expect(proof.transport).not.toHaveBeenCalled();
      expect(result.persist).not.toHaveBeenCalled();
      expect(result.readCanonicalCache).not.toHaveBeenCalled();
      expect(result.loadCanonicalRules).not.toHaveBeenCalled();
    }
    let metadata = { ...METADATA, rowsUpdatedAt: METADATA.rowsUpdatedAt + 1 };
    const changed = scriptedFetch([[roadway]], () => metadata);
    const changedProof = function3c('1000000001');
    const changedResult = await orchestrate(closeLocation, token, changed.fetchFn, changedProof);
    expect(changedResult.outcome).toEqual({
      protocolVersion: 2, status: 'unsupported', reason: 'candidate_incomplete',
    });
    expect(changedProof.transport).not.toHaveBeenCalled();
    expect(changedResult.persist).not.toHaveBeenCalled();

    const validProof = function3c('1000000001');
    const valid = await orchestrate(
      closeLocation,
      token,
      scriptedFetch([[roadway]]).fetchFn,
      validProof,
    );
    expect(valid.outcome.status).toBe('high_confidence');
    expect(valid.outcome.sideLabel).toBe('North');
    expect(validProof.transport).toHaveBeenCalledTimes(1);
    expect(valid.persist).toHaveBeenCalledTimes(1);
  });

  it('keeps the gate off and rejects an altered token before Function 3C', async () => {
    const roadway = record();
    const closedProof = function3c('1000000001');
    const closed = await orchestrate(
      closeLocation,
      undefined,
      scriptedFetch([[roadway]]).fetchFn,
      closedProof,
      false,
    );
    expect(closed.outcome).toEqual({
      protocolVersion: 2, status: 'unsupported', reason: 'candidate_incomplete',
    });
    expect(closedProof.transport).not.toHaveBeenCalled();
    expect(closed.persist).not.toHaveBeenCalled();

    const offered = await resolveCanonicalCurb(
      closeLocation,
      options(scriptedFetch([[roadway]]).fetchFn),
    );
    const token = northToken(offered);
    const forged = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
    expect(forged).not.toBe(token);
    const forgedProof = function3c('1000000001');
    const rejected = await orchestrate(
      closeLocation,
      forged,
      scriptedFetch([[roadway]]).fetchFn,
      forgedProof,
    );
    expect(rejected.outcome).toEqual({
      protocolVersion: 2, status: 'unsupported', reason: 'candidate_incomplete',
    });
    expect(forgedProof.transport).not.toHaveBeenCalled();
    expect(rejected.persist).not.toHaveBeenCalled();
  });

  it('shows a captured nonce can select another roadway only when fresh resolution independently matches it', async () => {
    const roadway = record();
    const other = record({
      globalId: 'other-road',
      streetName: 'OTHER PLACE',
      coordinates: [[[-74.001, 40.71], [-73.999, 40.71]]],
      leftBlockFaceId: '2000000001',
      rightBlockFaceId: '2000000002',
    });
    const offered = await resolveCanonicalCurb(
      closeLocation,
      options(scriptedFetch([[roadway]]).fetchFn),
    );
    const nonce = candidateTokenNonceDigest(northToken(offered));
    const synthesized = createCandidateToken({
      publicCurbKey: publicCurbKey({
        schemaVersion: 2,
        jurisdiction: 'NYC',
        officialBlockFaceId: '2000000001',
        sourceVersion: SERVER_VERSION,
      }),
      requestNonceDigest: nonce,
      rank: 0,
      authorityContextDigest: stableSideAuthorityDigest({
        sourceVersion: SERVER_VERSION,
        records: [other],
        faces: { LEFT: '2000000001', RIGHT: '2000000002' },
      }),
    });
    expect(synthesized).toBeTruthy();
    expect(offered.confirmation.curbs.map(curb => curb.token)).not.toContain(synthesized);

    const onOtherRoad = await applyVisualCurbSelection({
      location: otherLocation,
      candidateToken: synthesized,
    }, options(scriptedFetch([[other]]).fetchFn));
    expect(onOtherRoad).toMatchObject({
      state: 'SUPPORTED',
      identity: { officialBlockFaceId: '2000000001', csclSide: 'LEFT', side: { cardinal: 'North' } },
    });

    const onOriginalRoad = await applyVisualCurbSelection({
      location: closeLocation,
      candidateToken: synthesized,
    }, options(scriptedFetch([[roadway]]).fetchFn));
    expect(onOriginalRoad).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_selection_stale'] });
    expect(onOriginalRoad.identity).toBeUndefined();

    const proof = function3c('2000000001');
    const proven = await orchestrate(
      otherLocation,
      synthesized,
      scriptedFetch([[other]]).fetchFn,
      proof,
    );
    expect(proof.transport).toHaveBeenCalledTimes(1);
    expect(proven.outcome.status).toBe('high_confidence');
    expect(proven.outcome.streetName).toBe('OTHER PLACE');

    const wrongPlace = function3c('2000000001');
    const notProven = await orchestrate(
      closeLocation,
      synthesized,
      scriptedFetch([[roadway]]).fetchFn,
      wrongPlace,
    );
    expect(notProven.outcome).toEqual({
      protocolVersion: 2, status: 'unsupported', reason: 'candidate_incomplete',
    });
    expect(wrongPlace.transport).not.toHaveBeenCalled();
    expect(notProven.persist).not.toHaveBeenCalled();
  });
});
