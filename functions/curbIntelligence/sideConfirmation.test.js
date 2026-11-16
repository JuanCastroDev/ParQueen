import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveCanonicalCurb, hasPrimaryTopologyAuthority } = require('./canonicalCurbResolver');
const { applyVisualCurbSelection } = require('./visualCurbSelection');
const { runCanonicalCurbOrchestrator } = require('./canonicalCurbOrchestrator');
const { createPrivateBlockfaceResolver } = require('./privateBlockfaceResolver');
const {
  ENRICHMENT_MODE,
  SHADOW_EVALUATION,
  bindServerSourceEvidence,
} = require('./privateSourceContextRetention');
const {
  cardinalForSide,
  isSideConfirmationEnabled,
  orientationForTangent,
  PRESENTATION_AXIS_LIMIT_DEGREES,
  stableSideAuthorityDigest,
} = require('./sideConfirmation');
const {
  TOKEN_LIFETIME_MS,
  inspectSideConfirmationToken,
} = require('./sideConfirmationToken');

const TEST_HMAC_KEY = 'side-confirmation-test-key-0123456789ab';
const TEST_UID = 'driver-1';
const VERSION = Object.freeze({ resourceId: 'inkn-q76z', version: 'selection-v1' });
const METADATA = Object.freeze({ id: 'inkn-q76z', rowsUpdatedAt: 1767225600, viewLastModified: 1767225660 });
const HORIZONTAL = [[[-74.001, 40.7], [-73.999, 40.7]]];
const REVERSED = [[[-73.999, 40.7], [-74.001, 40.7]]];
const VERTICAL = [[[-74, 40.699], [-74, 40.701]]];
const SHALLOW = [[[-74.001, 40.7], [-73.999, 40.700268]]];
const STEEP = [[[-74.001, 40.69924], [-73.999, 40.70076]]];
const PRIVATE = ['1000000001', '1000000002', '2000000001', '2000000002', 'l_blockfaceid', 'r_blockfaceid', 'physicalid', 'b5sc', 'globalid'];

function record(overrides = {}) {
  const id = overrides.globalId || 'maran';
  const name = overrides.streetName || 'MARAN PLACE';
  return {
    globalId: id,
    sourceVersion: overrides.sourceVersion || VERSION,
    geometry: { type: 'MultiLineString', coordinates: overrides.coordinates || HORIZONTAL },
    leftBlockFaceId: overrides.leftBlockFaceId === undefined ? '1000000001' : overrides.leftBlockFaceId,
    rightBlockFaceId: overrides.rightBlockFaceId === undefined ? '1000000002' : overrides.rightBlockFaceId,
    sourceNative: {
      globalid: id,
      physicalid: `${id}-physical`,
      b5sc: overrides.b5sc || `${id}-b5sc`,
      boroughcode: '2',
      rw_type: '1',
      full_street_name: name,
      street_name: name,
      stname_label: name,
      streetwidth: '34',
      from_level_code: overrides.fromLevel || '13',
      to_level_code: overrides.toLevel || '13',
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
const fetchFor = rows => vi.fn(async url => ({
  ok: true,
  json: async () => (String(url).includes('/api/views/') ? METADATA : rows.map(rawRow)),
}));
const emptyPlan = { async queryCurbs() { return { candidates: [], completeness: { state: 'COMPLETE', reason: null } }; } };
const closeLocation = Object.freeze({
  lat: 40.70002, lng: -74, accuracyMeters: 8, sampleCount: 3, consistencyMeters: 2,
});

function options(rows, extra = {}) {
  return {
    fetchFn: fetchFor(rows),
    planimetricStore: emptyPlan,
    requestNonce: 'server-generated-nonce',
    sideConfirmationEnabled: true,
    callerUid: TEST_UID,
    sideConfirmationHmacKey: TEST_HMAC_KEY,
    ...extra,
  };
}

async function resolveAt(rows, location = closeLocation, extra = {}) {
  return resolveCanonicalCurb(location, options(rows, extra));
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
  return createPrivateBlockfaceResolver({
    mode: 'shadow',
    serviceUrl: 'https://parqueen-test-resolver-uc.a.run.app',
    getIdToken: vi.fn(async () => 'synthetic-token'),
    transport,
  });
}

describe('one-roadway side confirmation', () => {
  it('keeps the gate off unless the caller or exact env enables it', () => {
    expect(isSideConfirmationEnabled({})).toBe(false);
    expect(isSideConfirmationEnabled({}, {})).toBe(false);
    expect(isSideConfirmationEnabled({}, { CURB_SIDE_CONFIRMATION: 'yes' })).toBe(false);
    expect(isSideConfirmationEnabled({}, { CURB_SIDE_CONFIRMATION: 'on' })).toBe(true);
    expect(isSideConfirmationEnabled({ sideConfirmationEnabled: false }, { CURB_SIDE_CONFIRMATION: 'on' })).toBe(false);
  });

  it('keeps axis-aligned streets and draws a valid diagonal at its bearing', () => {
    const bearing = degrees => ({
      eastMeters: Math.cos(degrees * Math.PI / 180),
      northMeters: Math.sin(degrees * Math.PI / 180),
    });
    expect(PRESENTATION_AXIS_LIMIT_DEGREES).toBe(20);
    expect(orientationForTangent({ eastMeters: 1, northMeters: 0 })).toMatchObject({
      north: 'up', axis: 'east-west', sides: { LEFT: 'North', RIGHT: 'South' },
    });
    expect(orientationForTangent({ eastMeters: 0, northMeters: 1 })).toMatchObject({
      north: 'up', axis: 'north-south', sides: { LEFT: 'West', RIGHT: 'East' },
    });
    expect(orientationForTangent(bearing(10)).axis).toBe('east-west');
    expect(orientationForTangent(bearing(80)).axis).toBe('north-south');
    expect(orientationForTangent(bearing(180)).sides).toEqual({ LEFT: 'South', RIGHT: 'North' });
    expect(orientationForTangent(bearing(270)).sides).toEqual({ LEFT: 'East', RIGHT: 'West' });
    expect(orientationForTangent(bearing(10)).bearingDegrees).toBeUndefined();
    expect(orientationForTangent(bearing(21))).toMatchObject({
      north: 'up', axis: 'oblique', bearingDegrees: 69, sides: { LEFT: 'North', RIGHT: 'South' },
    });
    expect(orientationForTangent(bearing(45))).toMatchObject({
      north: 'up', axis: 'oblique', bearingDegrees: 45, sides: { LEFT: 'Northwest', RIGHT: 'Southeast' },
    });
    expect(orientationForTangent(bearing(135))).toMatchObject({
      north: 'up', axis: 'oblique', bearingDegrees: 315, sides: { LEFT: 'Southwest', RIGHT: 'Northeast' },
    });
    expect(orientationForTangent({ eastMeters: 0, northMeters: 0 })).toBeNull();
    expect(orientationForTangent({ eastMeters: Number.NaN, northMeters: 1 })).toBeNull();
    expect(cardinalForSide({ eastMeters: 1, northMeters: 0 }, 'CENTERLINE')).toBeNull();
    expect(cardinalForSide({ eastMeters: Math.SQRT1_2, northMeters: Math.SQRT1_2 }, 'LEFT')).toBe('Northwest');
  });

  it('binds the side token to the official roadway and not to the search center', () => {
    const faces = { LEFT: '1000000001', RIGHT: '1000000002' };
    const roadway = record();
    const east = record({ globalId: 'east-piece', coordinates: [[[-74, 40.7], [-73.999, 40.7]]] });
    const west = record({ globalId: 'west-piece', coordinates: [[[-74.001, 40.7], [-74, 40.7]]] });
    const first = stableSideAuthorityDigest({
      sourceVersion: roadway.sourceVersion, records: [roadway], faces,
    });
    const forward = stableSideAuthorityDigest({
      sourceVersion: roadway.sourceVersion, records: [west, east], faces,
    });
    const backward = stableSideAuthorityDigest({
      sourceVersion: roadway.sourceVersion, records: [east, west], faces,
    });
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(forward).toBe(backward);
    expect(forward).not.toBe(first);
    expect(stableSideAuthorityDigest({
      sourceVersion: roadway.sourceVersion,
      records: [roadway],
      faces: { LEFT: '1000000002', RIGHT: '1000000001' },
    })).not.toBe(first);
    expect(stableSideAuthorityDigest({
      sourceVersion: { ...roadway.sourceVersion, version: 'selection-v2' },
      records: [roadway],
      faces,
    })).not.toBe(first);
    const shifted = record({ coordinates: [[[-74.001, 40.70001], [-73.999, 40.70001]]] });
    expect(stableSideAuthorityDigest({
      sourceVersion: roadway.sourceVersion, records: [shifted], faces,
    })).not.toBe(first);
    expect(stableSideAuthorityDigest({
      sourceVersion: { version: ' selection-v1 ', resourceId: 'inkn-q76z' },
      records: [roadway],
      faces: { RIGHT: faces.RIGHT, LEFT: faces.LEFT },
    })).toBe(first);
    expect(JSON.stringify({ digest: first })).not.toContain('1000000001');
  });

  it('offers both official faces only when the gate is on and the side is uncertain', async () => {
    const offered = await resolveAt([record()]);
    expect(offered.state).toBe('SIDE_CONFIRMATION_REQUIRED');
    expect(offered.confirmation.orientation).toEqual({ north: 'up', axis: 'east-west' });
    expect(offered.confirmation.curbs.map(curb => curb.cardinal).sort()).toEqual(['North', 'South']);
    const closed = await resolveAt([record()], closeLocation, { sideConfirmationEnabled: false });
    expect(closed).toMatchObject({ state: 'UNSUPPORTED', reasons: ['ambiguity_unresolved'] });
    const orchestrated = await runCanonicalCurbOrchestrator({
      protocolVersion: 2, location: closeLocation,
    }, {
      fetchFn: fetchFor([record()]),
      planimetricStore: emptyPlan,
      requestNonceFactory: () => 'server-generated-nonce',
      inFlight: new Map(),
      telemetry: { emit: vi.fn() },
    });
    expect(orchestrated).toEqual({
      protocolVersion: 2, status: 'unsupported', reason: 'candidate_incomplete',
    });
    const centered = await resolveAt([record()], {
      lat: 40.7, lng: -74, accuracyMeters: 8, sampleCount: 3, consistencyMeters: 2,
    });
    expect(centered).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_incomplete'] });
  });

  it('maps each diagram choice to the official face for forward, reversed, vertical, and diagonal roads', async () => {
    const cases = [
      [record(), closeLocation],
      [record({ coordinates: REVERSED }), closeLocation],
      [record({ coordinates: VERTICAL }), { lat: 40.7, lng: -73.99998, accuracyMeters: 8, sampleCount: 3, consistencyMeters: 2 }],
      [record({ coordinates: SHALLOW }), { lat: 40.70016, lng: -74, accuracyMeters: 8, sampleCount: 3, consistencyMeters: 2 }],
    ];
    const leftCardinals = [];
    for (const [row, location] of cases) {
      const offered = await resolveAt([row], location);
      expect(offered.state).toBe('SIDE_CONFIRMATION_REQUIRED');
      const selected = {};
      for (const curb of offered.confirmation.curbs) {
        const result = await applyVisualCurbSelection({
          location, candidateToken: curb.token,
        }, options([row]));
        expect(result.state).toBe('SUPPORTED');
        expect(result.identity.side.cardinal).toBe(curb.cardinal);
        expect(result.identity.resolution.method).toBe('visual_selection');
        expect(hasPrimaryTopologyAuthority(result)).toBe(true);
        selected[result.identity.csclSide] = {
          face: result.identity.officialBlockFaceId,
          cardinal: result.identity.side.cardinal,
        };
      }
      expect(selected.LEFT.face).toBe('1000000001');
      expect(selected.RIGHT.face).toBe('1000000002');
      expect(selected.LEFT.cardinal).not.toBe(selected.RIGHT.cardinal);
      leftCardinals.push(selected.LEFT.cardinal);
    }
    expect(leftCardinals[0]).not.toBe(leftCardinals[1]);
  });

  it('does not offer a side when a face is missing, faces disagree, the point is at an endpoint, or another road is present', async () => {
    const missing = await resolveAt([record({ rightBlockFaceId: null })]);
    expect(missing).toMatchObject({ state: 'UNSUPPORTED', reasons: ['ambiguity_unresolved'] });
    const first = record({ globalId: 'maran-a', coordinates: [[[-74.001, 40.7], [-74, 40.7]]], leftBlockFaceId: '1000000001' });
    const second = record({
      globalId: 'maran-b', coordinates: [[[-74, 40.7], [-73.999, 40.7]]],
      leftBlockFaceId: '1000000003', b5sc: 'maran-a-b5sc',
    });
    second.sourceNative.b5sc = 'maran-a-b5sc';
    const inconsistent = await resolveAt([first, second]);
    expect(inconsistent).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_incomplete'] });
    const endpoint = await resolveAt(
      [record({ coordinates: [[[-74.00006, 40.7], [-73.99994, 40.7]]] })],
      { lat: 40.70002, lng: -74, accuracyMeters: 20, sampleCount: 3, consistencyMeters: 2 },
    );
    expect(endpoint).toMatchObject({ state: 'UNSUPPORTED', reasons: ['ambiguity_unresolved'] });
    const steep = await resolveAt(
      [record({ coordinates: STEEP })],
      { lat: 40.70002, lng: -74, accuracyMeters: 8, sampleCount: 3, consistencyMeters: 2 },
    );
    expect(steep.state).toBe('SIDE_CONFIRMATION_REQUIRED');
    expect(steep.confirmation.orientation.axis).toBe('oblique');
    expect(steep.state).not.toBe('SUPPORTED');
    const adjacent = await resolveAt([
      record(),
      record({
        globalId: 'white-plains', streetName: 'WHITE PLAINS ROAD', coordinates: VERTICAL,
        leftBlockFaceId: '2000000001', rightBlockFaceId: '2000000002',
      }),
    ], { lat: 40.70004, lng: -73.99997, accuracyMeters: 3, sampleCount: 3, consistencyMeters: 3 });
    expect(adjacent.state).toBe('AMBIGUOUS');
  });

  it('keeps a multilevel roadway unsupported and a clearly one-sided fix supported', async () => {
    const upper = record({ globalId: 'upper', fromLevel: '13', toLevel: '13' });
    const lower = record({ globalId: 'lower', fromLevel: '1', toLevel: '1' });
    const multilevel = await resolveAt([upper, lower]);
    expect(multilevel).toMatchObject({ state: 'UNSUPPORTED', reasons: ['multilevel_or_roadbed_ambiguity'] });
    const clear = await resolveAt([record()], {
      lat: 40.700063, lng: -74, accuracyMeters: 3, sampleCount: 3, consistencyMeters: 2,
    });
    expect(clear.state).toBe('SUPPORTED');
    expect(clear.identity.resolution.method).toBe('automatic');
  });

  it('rejects a forged token, a moved sample, a changed source, and a stale roadway', async () => {
    const offered = await resolveAt([record()]);
    const token = offered.confirmation.curbs[0].token;
    const forgedToken = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
    expect(forgedToken).not.toBe(token);
    const forged = await applyVisualCurbSelection({
      location: closeLocation, candidateToken: forgedToken,
    }, options([record()]));
    expect(forged).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_token_invalid'] });
    const moved = await applyVisualCurbSelection({
      location: { ...closeLocation, lat: 40.702 }, candidateToken: token,
    }, options([record()]));
    expect(moved.reasons).toContain('candidate_selection_stale');
    const changedFetch = vi.fn(async url => ({
      ok: true,
      json: async () => (String(url).includes('/api/views/')
        ? { ...METADATA, rowsUpdatedAt: METADATA.rowsUpdatedAt + 1 }
        : [record()].map(rawRow)),
    }));
    const changed = await applyVisualCurbSelection({
      location: closeLocation, candidateToken: token,
    }, { ...options([record()]), fetchFn: changedFetch });
    expect(changed.reasons).toContain('candidate_selection_stale');
    const removed = await applyVisualCurbSelection({
      location: closeLocation, candidateToken: token,
    }, options([]));
    expect(removed.reasons).toContain('candidate_selection_stale');
    const north = offered.confirmation.curbs.find(curb => curb.cardinal === 'North');
    const south = offered.confirmation.curbs.find(curb => curb.cardinal === 'South');
    const samePoint = await applyVisualCurbSelection({
      location: closeLocation, candidateToken: north.token,
    }, options([record()]));
    expect(samePoint).toMatchObject({
      state: 'SUPPORTED',
      identity: { officialBlockFaceId: '1000000001', csclSide: 'LEFT', side: { cardinal: 'North' } },
    });
    const subMeter = await applyVisualCurbSelection({
      location: { ...closeLocation, lat: closeLocation.lat + 0.000004 },
      candidateToken: north.token,
    }, options([record()]));
    expect(subMeter).toMatchObject({
      state: 'SUPPORTED',
      identity: { officialBlockFaceId: '1000000001', csclSide: 'LEFT', side: { cardinal: 'North' } },
    });
    const jitter = await applyVisualCurbSelection({
      location: { ...closeLocation, lat: closeLocation.lat + 0.00002, lng: closeLocation.lng + 0.00001 },
      candidateToken: south.token,
    }, options([record()]));
    expect(jitter).toMatchObject({
      state: 'SUPPORTED',
      identity: { officialBlockFaceId: '1000000002', csclSide: 'RIGHT', side: { cardinal: 'South' } },
    });
    const certain = await applyVisualCurbSelection({
      location: { lat: 40.700063, lng: -74, accuracyMeters: 3, sampleCount: 3, consistencyMeters: 2 },
      candidateToken: north.token,
    }, options([record()]));
    expect(certain).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_selection_stale'] });
    const otherBlock = record({ leftBlockFaceId: '1000000008', rightBlockFaceId: '1000000009' });
    const wrongBlock = await applyVisualCurbSelection({
      location: closeLocation, candidateToken: north.token,
    }, options([otherBlock]));
    expect(wrongBlock).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_selection_stale'] });
    const movedGeometry = record({
      coordinates: [[[-74.001, 40.70001], [-73.999, 40.70001]]],
    });
    const geometryChanged = await applyVisualCurbSelection({
      location: closeLocation, candidateToken: north.token,
    }, options([movedGeometry]));
    expect(geometryChanged).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_selection_stale'] });
    const atEndpoint = await applyVisualCurbSelection({
      location: { ...closeLocation, lng: -73.99905 },
      candidateToken: north.token,
    }, options([record()]));
    expect(atEndpoint).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_selection_stale'] });
    const gatedOff = await applyVisualCurbSelection({
      location: closeLocation, candidateToken: north.token,
    }, options([record()], { sideConfirmationEnabled: false }));
    expect(gatedOff).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_selection_stale'] });
  });

  it('resolves again for every confirmation and keeps two-roadway tokens on the search envelope', async () => {
    const transport = {
      fetchFn: vi.fn(async url => ({
        ok: true,
        json: async () => (String(url).includes('/api/views/') ? METADATA : [record()].map(rawRow)),
      })),
    };
    const offered = await resolveCanonicalCurb(closeLocation, {
      ...options([record()]), fetchFn: transport.fetchFn,
    });
    const callsAfterOffer = transport.fetchFn.mock.calls.length;
    expect(callsAfterOffer).toBeGreaterThan(0);
    const selected = await applyVisualCurbSelection({
      location: { ...closeLocation, lat: closeLocation.lat + 0.000004 },
      candidateToken: offered.confirmation.curbs[0].token,
    }, { ...options([record()]), fetchFn: transport.fetchFn });
    expect(selected.state).toBe('SUPPORTED');
    expect(transport.fetchFn.mock.calls.length).toBeGreaterThan(callsAfterOffer);

    const twoRoads = [
      record(),
      record({
        globalId: 'white-plains', streetName: 'WHITE PLAINS ROAD', coordinates: VERTICAL,
        leftBlockFaceId: '2000000001', rightBlockFaceId: '2000000002',
      }),
    ];
    const ambiguousLocation = {
      lat: 40.70004, lng: -73.99997, accuracyMeters: 3, sampleCount: 3, consistencyMeters: 3,
    };
    const ambiguous = await resolveAt(twoRoads, ambiguousLocation);
    expect(ambiguous.state).toBe('AMBIGUOUS');
    const ambiguousToken = ambiguous.candidates[0].token;
    const jitteredAmbiguous = await applyVisualCurbSelection({
      location: { ...ambiguousLocation, lat: ambiguousLocation.lat + 0.000004 },
      candidateToken: ambiguousToken,
    }, options(twoRoads));
    expect(jitteredAmbiguous).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_selection_stale'] });
  });

  it('publishes no internal face or geometry identifier and proves the selected face independently', async () => {
    const persist = vi.fn(async () => ({ success: true }));
    const telemetry = { emit: vi.fn() };
    const shared = {
      planimetricStore: emptyPlan,
      requestNonceFactory: () => 'server-generated-nonce',
      sideConfirmationEnabled: true,
      callerUid: TEST_UID,
      sideConfirmationHmacKey: TEST_HMAC_KEY,
      loadCanonicalRules: vi.fn(),
      readCanonicalCache: vi.fn(),
      persistCanonicalCurb: persist,
      inFlight: new Map(),
      telemetry,
      blockfaceResolver: function3c('1000000001'),
    };
    const offered = await runCanonicalCurbOrchestrator({
      protocolVersion: 2, location: closeLocation,
    }, { ...shared, fetchFn: fetchFor([record()]) });
    const published = JSON.stringify(offered);
    expect(offered.status).toBe('side_confirmation_required');
    expect(offered.status).not.toBe('ambiguous');
    for (const marker of PRIVATE) expect(published).not.toContain(marker);
    expect(offered.confirmation.curbs[0]).toEqual({
      token: expect.stringMatching(/^sidec1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/),
      cardinal: expect.stringMatching(/North|South/),
    });
    expect(telemetry.emit.mock.calls.some(call => call[0] === 'intersection_ambiguity')).toBe(false);
    expect(telemetry.emit.mock.calls.some(call => call[0] === 'curb_side_confirmation_required')).toBe(true);
    expect(persist).not.toHaveBeenCalled();

    const mismatch = await runCanonicalCurbOrchestrator({
      protocolVersion: 2,
      location: closeLocation,
      candidateToken: offered.confirmation.curbs[0].token,
    }, {
      ...shared,
      fetchFn: fetchFor([record()]),
      blockfaceResolver: function3c('1000000099'),
    });
    expect(mismatch).toEqual({ protocolVersion: 2, status: 'unsupported', reason: 'source_unavailable' });
    expect(persist).not.toHaveBeenCalled();
    expect(shared.readCanonicalCache).not.toHaveBeenCalled();
    expect(shared.loadCanonicalRules).not.toHaveBeenCalled();
  });

  it('does not offer a side when shadow enrichment supplied the street context', async () => {
    const segment = fields => Object.freeze({
      nodeLevelFrom: 'M', nodeLevelTo: 'M', lgc1: '01', lgc2: '  ', lgc3: '  ', lgc4: '  ', lgc5: '  ', ...fields,
    });
    const evidence = bindServerSourceEvidence([Object.freeze({
      provenance: { certificationStatus: 'NOT_CERTIFIED', source: 'retained-lion-snd-26b' },
      leftBlockFaceId: '1222600642',
      rightBlockFaceId: '1222604562',
      lionRelease: '26B',
      sndRelease: '26B',
      onStreet: {
        segmentId: '0018126', physicalId: 5, street: 'BATTERY PLACE', streetCode: '112670',
        nodeIdFrom: '0012380', nodeIdTo: '0012383',
      },
      segments: [
        segment({ segmentId: '0018126', physicalId: 5, street: 'BATTERY PLACE', streetCode: '112670', nodeIdFrom: '0012380', nodeIdTo: '0012383' }),
        segment({ segmentId: '0018125', physicalId: 83678, street: '2 PLACE', streetCode: '110115', nodeIdFrom: '0012380', nodeIdTo: '0012378' }),
        segment({ segmentId: '0161439', physicalId: 122850, street: '2 PLACE', streetCode: '110115', nodeIdFrom: '0095551', nodeIdTo: '0012380' }),
        segment({ segmentId: '0018128', physicalId: 97697, street: '3 PLACE', streetCode: '110250', nodeIdFrom: '0012381', nodeIdTo: '0012383' }),
        segment({ segmentId: '0018139', physicalId: 97698, street: '3 PLACE', streetCode: '110250', nodeIdFrom: '0012383', nodeIdTo: '0095476' }),
      ],
      sndRows: [
        Object.freeze({ name: '2 PLACE', primaryFlag: 'P', principalFlag: 'F', b5sc: '110115', b7sc: '11011501', b10sc: '11011501010', localGroup: '01' }),
        Object.freeze({ name: 'SECOND PLACE', primaryFlag: 'V', principalFlag: 'S', b5sc: '110115', b7sc: '11011501', b10sc: '11011501020', localGroup: '01' }),
        Object.freeze({ name: '3 PLACE', primaryFlag: 'P', principalFlag: 'F', b5sc: '110250', b7sc: '11025001', b10sc: '11025001010', localGroup: '01' }),
        Object.freeze({ name: 'THIRD PLACE', primaryFlag: 'V', principalFlag: 'S', b5sc: '110250', b7sc: '11025001', b10sc: '11025001020', localGroup: '01' }),
        Object.freeze({ name: 'BATTERY PLACE', primaryFlag: 'P', principalFlag: 'F', b5sc: '112670', b7sc: '11267001', b10sc: '11267001010', localGroup: '01' }),
      ],
      fromNodeNames: [' BATTERY PL', ' 2 PL'],
      toNodeNames: [' BATTERY PL', ' 3 PL'],
    })]);
    const enriched = record({
      globalId: 'battery',
      streetName: 'BATTERY PLACE',
      leftBlockFaceId: '1222600642',
      rightBlockFaceId: '1222604562',
    });
    enriched.sourceNative.physicalid = '5';
    enriched.sourceNative.b5sc = '112670';
    enriched.sourceNative.boroughcode = '1';
    delete enriched.sourceNative.from_street;
    delete enriched.sourceNative.to_street;
    const result = await resolveAt([enriched], closeLocation, {
      privateSourceContextEnrichment: ENRICHMENT_MODE,
      evaluationScope: SHADOW_EVALUATION,
      privateSourceEvidence: evidence,
    });
    expect(evidence.ok).toBe(true);
    expect(result).toMatchObject({ state: 'UNSUPPORTED', reasons: ['ambiguity_unresolved'] });
  });
});

describe('side-confirmation HMAC authentication', () => {
  const issuedAt = 1_700_000_000_000;

  it('accepts the same roadway inside five minutes, including sub-meter jitter, and then expires', async () => {
    const row = record();
    const offered = await resolveAt([row], closeLocation, { sideConfirmationNow: issuedAt });
    const token = offered.confirmation.curbs.find(curb => curb.cardinal === 'North').token;
    const inside = await applyVisualCurbSelection({
      location: { ...closeLocation, lat: closeLocation.lat + 0.000004 },
      candidateToken: token,
    }, options([row], { sideConfirmationNow: issuedAt + TOKEN_LIFETIME_MS - 1 }));
    expect(inside).toMatchObject({
      state: 'SUPPORTED',
      identity: { officialBlockFaceId: '1000000001', csclSide: 'LEFT' },
    });
    const expired = await applyVisualCurbSelection({
      location: closeLocation,
      candidateToken: token,
    }, options([row], { sideConfirmationNow: issuedAt + TOKEN_LIFETIME_MS }));
    expect(expired).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_token_invalid'] });
    const future = await applyVisualCurbSelection({
      location: closeLocation,
      candidateToken: token,
    }, options([row], { sideConfirmationNow: issuedAt - 1 }));
    expect(future).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_token_invalid'] });
  });

  it('rejects another uid, a changed claim, the opposite face, a missing key, and a legacy candidate2 token', async () => {
    const row = record();
    const offered = await resolveAt([row], closeLocation, { sideConfirmationNow: issuedAt });
    const north = offered.confirmation.curbs.find(curb => curb.cardinal === 'North');
    const south = offered.confirmation.curbs.find(curb => curb.cardinal === 'South');
    const otherUser = await applyVisualCurbSelection({
      location: closeLocation,
      candidateToken: north.token,
    }, options([row], { sideConfirmationNow: issuedAt, callerUid: 'driver-2' }));
    expect(otherUser).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_token_invalid'] });

    const opposite = await applyVisualCurbSelection({
      location: closeLocation,
      candidateToken: north.token,
    }, options([row], { sideConfirmationNow: issuedAt }));
    expect(opposite.identity.csclSide).not.toBe('RIGHT');
    expect(opposite.identity.side.cardinal).toBe('North');
    expect(south.cardinal).toBe('South');

    const flippedMac = `${north.token.slice(0, -1)}${north.token.endsWith('A') ? 'B' : 'A'}`;
    const badMac = inspectSideConfirmationToken(flippedMac, {
      key: TEST_HMAC_KEY, now: issuedAt, uid: TEST_UID, officialBlockFaceId: '1000000001',
    });
    expect(badMac).toEqual({ ok: false, reason: 'invalid_signature' });

    const missingKey = await resolveAt([row], closeLocation, { sideConfirmationHmacKey: undefined });
    expect(missingKey).toMatchObject({ state: 'UNSUPPORTED', reasons: ['ambiguity_unresolved'] });
    expect(missingKey.confirmation).toBeUndefined();
    const shortKey = await resolveAt([row], closeLocation, { sideConfirmationHmacKey: 'too-short' });
    expect(shortKey.confirmation).toBeUndefined();

    const legacy = await applyVisualCurbSelection({
      location: closeLocation,
      candidateToken: 'candidate2_abcdef0123456789_0123456789abcdef0123456789abcdef',
    }, options([row], { sideConfirmationNow: issuedAt }));
    expect(legacy).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_selection_stale'] });
    expect(legacy.identity).toBeUndefined();
  });

  it('keeps the secret, uid, and token out of telemetry and error responses', async () => {
    const telemetry = { emit: vi.fn() };
    const offered = await runCanonicalCurbOrchestrator({
      protocolVersion: 2,
      location: closeLocation,
      callerUid: 'attacker-supplied',
    }, {
      fetchFn: fetchFor([record()]),
      planimetricStore: emptyPlan,
      requestNonceFactory: () => 'server-generated-nonce',
      sideConfirmationEnabled: true,
      callerUid: TEST_UID,
      sideConfirmationHmacKey: TEST_HMAC_KEY,
      sideConfirmationNow: issuedAt,
      inFlight: new Map(),
      telemetry,
    });
    expect(offered.status).toBe('side_confirmation_required');
    const token = offered.confirmation.curbs[0].token;
    const face = offered.confirmation.curbs[0].cardinal === 'North' ? '1000000001' : '1000000002';
    const inspected = inspectSideConfirmationToken(token, {
      key: TEST_HMAC_KEY, now: issuedAt, uid: TEST_UID, officialBlockFaceId: face,
    });
    expect(inspected.ok).toBe(true);
    expect(inspected.visible).not.toHaveProperty('uid');
    expect(inspected.visible).not.toHaveProperty('officialBlockFaceId');
    expect(token).not.toContain(TEST_UID);
    expect(token).not.toContain(face);
    const emitted = JSON.stringify(telemetry.emit.mock.calls);
    expect(emitted).not.toContain(TEST_HMAC_KEY);
    expect(emitted).not.toContain(TEST_UID);
    expect(emitted).not.toContain(token);
    expect(emitted).not.toContain('1000000001');

    const failed = await runCanonicalCurbOrchestrator({
      protocolVersion: 2,
      location: closeLocation,
      candidateToken: `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`,
    }, {
      fetchFn: fetchFor([record()]),
      planimetricStore: emptyPlan,
      sideConfirmationEnabled: true,
      callerUid: TEST_UID,
      sideConfirmationHmacKey: TEST_HMAC_KEY,
      sideConfirmationNow: issuedAt,
      inFlight: new Map(),
      telemetry: { emit: vi.fn() },
      blockfaceResolver: function3c('1000000001'),
    });
    expect(failed).toEqual({ protocolVersion: 2, status: 'unsupported', reason: 'candidate_incomplete' });
    expect(JSON.stringify(failed)).not.toContain(TEST_HMAC_KEY);
    expect(JSON.stringify(failed)).not.toContain(token);
  });
});

describe('oblique side confirmation', () => {
  const issuedAt = 1_700_000_000_000;
  const latScale = 111320;
  const lngScale = 111320 * Math.cos(40.7 * Math.PI / 180);

  function roadwayAt(mathDegrees, reversed = false) {
    const east = 180 * Math.cos(mathDegrees * Math.PI / 180);
    const north = 180 * Math.sin(mathDegrees * Math.PI / 180);
    const start = [-74, 40.7];
    const end = [-74 + east / lngScale, 40.7 + north / latScale];
    const coordinates = [[reversed ? end : start, reversed ? start : end]];
    const unitEast = east / 180;
    const unitNorth = north / 180;
    return {
      row: record({ coordinates }),
      location: {
        lat: 40.7 + north / latScale / 2 + (unitEast * 2) / latScale,
        lng: -74 + east / lngScale / 2 + (-unitNorth * 2) / lngScale,
        accuracyMeters: 8,
        sampleCount: 3,
        consistencyMeters: 2,
      },
    };
  }

  async function chosenFace(mathDegrees, cardinal, reversed = false) {
    const { row, location } = roadwayAt(mathDegrees, reversed);
    const offered = await resolveAt([row], location, { sideConfirmationNow: issuedAt });
    expect(offered.state).toBe('SIDE_CONFIRMATION_REQUIRED');
    expect(offered.confirmation.orientation.axis).toBe('oblique');
    const curb = offered.confirmation.curbs.find(value => value.cardinal === cardinal);
    expect(curb?.token.startsWith('sidec1.')).toBe(true);
    const selected = await applyVisualCurbSelection({
      location, candidateToken: curb.token,
    }, options([row], { sideConfirmationNow: issuedAt }));
    expect(selected.state).toBe('SUPPORTED');
    expect(selected.identity.side.cardinal).toBe(cardinal);
    expect(selected.identity.resolution.method).toBe('visual_selection');
    return selected.identity.officialBlockFaceId;
  }

  it('binds each displayed diagonal curb to its official face', async () => {
    expect(await chosenFace(45, 'Northwest')).toBe('1000000001');
    expect(await chosenFace(45, 'Southeast')).toBe('1000000002');
    expect(await chosenFace(135, 'Southwest')).toBe('1000000001');
    expect(await chosenFace(135, 'Northeast')).toBe('1000000002');
    expect(await chosenFace(21, 'North')).toBe('1000000001');
    expect(await chosenFace(21, 'South', true)).toBe('1000000001');
    expect(await chosenFace(45, 'Northwest', true)).toBe('1000000002');
  });

  it('does not offer a zero-length tangent or two identical faces', async () => {
    const { location } = roadwayAt(45);
    const collapsed = record({ coordinates: [[[-74, 40.7], [-74, 40.7]]] });
    const sameFace = record({ coordinates: roadwayAt(45).row.geometry.coordinates, rightBlockFaceId: '1000000001' });
    expect((await resolveAt([collapsed], location)).state).not.toBe('SIDE_CONFIRMATION_REQUIRED');
    expect((await resolveAt([sameFace], location)).state).not.toBe('SIDE_CONFIRMATION_REQUIRED');
  });

  it('keeps expiration and replay protection on a diagonal token', async () => {
    const { row, location } = roadwayAt(45);
    const offered = await resolveAt([row], location, { sideConfirmationNow: issuedAt });
    const token = offered.confirmation.curbs.find(curb => curb.cardinal === 'Northwest').token;
    const expired = await applyVisualCurbSelection({
      location, candidateToken: token,
    }, options([row], { sideConfirmationNow: issuedAt + TOKEN_LIFETIME_MS }));
    expect(expired).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_token_invalid'] });
    const replayed = await applyVisualCurbSelection({
      location, candidateToken: token,
    }, options([row], { sideConfirmationNow: issuedAt, callerUid: 'driver-2' }));
    expect(replayed).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_token_invalid'] });
    const accepted = await applyVisualCurbSelection({
      location, candidateToken: token,
    }, options([row], { sideConfirmationNow: issuedAt + TOKEN_LIFETIME_MS - 1 }));
    expect(accepted.state).toBe('SUPPORTED');
    expect(accepted.identity.officialBlockFaceId).toBe('1000000001');
    expect(JSON.stringify(offered.confirmation)).not.toContain(TEST_HMAC_KEY);
    expect(JSON.stringify(offered.confirmation)).not.toContain(TEST_UID);
    expect(JSON.stringify(offered.confirmation)).not.toContain('1000000001');
  });
});
