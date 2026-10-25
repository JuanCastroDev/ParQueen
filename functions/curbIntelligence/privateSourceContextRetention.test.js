import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveCanonicalCurb, hasPrimaryTopologyAuthority } = require('./canonicalCurbResolver');
const { createCanonicalCurbIdentity } = require('./canonicalCurbIdentity');
const { RETENTION_MODE } = require('./privateSourceContextRetention');

const VERSION = Object.freeze({ resourceId: 'inkn-q76z', version: 'fixture-v2' });
const METADATA = Object.freeze({ id: 'inkn-q76z', rowsUpdatedAt: 1767225600, viewLastModified: 1767225660 });
const HORIZONTAL = [[[-74.001, 40.7], [-73.999, 40.7]]];
const BATTERY = Object.freeze({
  physicalId: '5',
  segmentId: '0018126',
  nodeIdFrom: '0012380',
  nodeIdTo: '0012383',
  leftBlockFaceId: '1222600642',
  rightBlockFaceId: '1222604562',
  fromNodeNames: Object.freeze([' BATTERY PL', ' 2 PL']),
  toNodeNames: Object.freeze([' BATTERY PL', ' 3 PL']),
});

function batteryRow() {
  return {
    globalid: 'retained-battery-place-row',
    physicalid: BATTERY.physicalId,
    b5sc: '112670',
    boroughcode: '1',
    rw_type: '1',
    full_street_name: 'BATTERY PL',
    street_name: 'BATTERY PLACE',
    stname_label: 'BATTERY PL',
    streetwidth: '42',
    from_level_code: 'M',
    to_level_code: 'M',
    accessible: null,
    nonped: null,
    status: '2',
    l_blockfaceid: BATTERY.leftBlockFaceId,
    r_blockfaceid: BATTERY.rightBlockFaceId,
    the_geom: { type: 'MultiLineString', coordinates: HORIZONTAL },
  };
}

function sourceContext(overrides = {}) {
  return {
    provenance: {
      certificationStatus: 'NOT_CERTIFIED',
      source: 'retained-lion-node-stname',
    },
    segment: {
      physicalId: BATTERY.physicalId,
      segmentId: BATTERY.segmentId,
      nodeIdFrom: BATTERY.nodeIdFrom,
      nodeIdTo: BATTERY.nodeIdTo,
      leftBlockFaceId: BATTERY.leftBlockFaceId,
      rightBlockFaceId: BATTERY.rightBlockFaceId,
    },
    fromNodeNames: BATTERY.fromNodeNames,
    toNodeNames: BATTERY.toNodeNames,
    ...overrides,
  };
}

const location = () => ({
  lat: 40.70005,
  lng: -74,
  accuracyMeters: 1,
  sampleCount: 3,
  consistencyMeters: 2,
});

function options(extra = {}) {
  const fetchFn = vi.fn(async url => ({
    ok: true,
    json: async () => (String(url).includes('/api/views/') ? METADATA : [batteryRow()]),
  }));
  return {
    fetchFn,
    getSocrataToken: () => '',
    planimetricStore: {
      queryCurbs: vi.fn(async () => ({
        candidates: [],
        completeness: { state: 'COMPLETE', reason: null },
        sourceVersion: { resourceId: '5xvt-8cbk', version: 'fixture-plan-v1' },
      })),
    },
    requestNonce: 'request-nonce',
    ...extra,
  };
}

describe('Battery Place candidate recovery', () => {
  it('reproduces candidate_incomplete at the missing cross-street check', async () => {
    const row = batteryRow();
    const identity = createCanonicalCurbIdentity({
      csclRows: [{ ...row, sourceVersion: VERSION }],
      csclSide: 'LEFT',
      sourceVersion: VERSION,
      selectedGlobalId: row.globalid,
      geometry: row.the_geom,
      streetWidthFeet: 42,
      borough: 'Manhattan',
      onStreet: row.full_street_name,
      fromStreet: row.from_street,
      toStreet: row.to_street,
      aliases: [row.street_name, row.stname_label],
      cardinalSide: 'North',
      resolutionMethod: 'automatic',
    });
    const resolution = await resolveCanonicalCurb(location(), options());

    expect(row.from_street).toBeUndefined();
    expect(row.to_street).toBeUndefined();
    expect(identity).toEqual({ ok: false, reason: 'invalid_street_context' });
    expect(resolution).toMatchObject({
      state: 'UNSUPPORTED',
      reasons: ['candidate_incomplete'],
    });
    expect(resolution.state).not.toBe('SUPPORTED');
    expect(hasPrimaryTopologyAuthority(resolution)).toBe(false);
  });

  it('retains the official Battery Place populations without selecting a cross street', async () => {
    const seen = [];
    const resolution = await resolveCanonicalCurb(location(), options({
      privateSourceContextRetention: RETENTION_MODE,
      privateSourceContext: sourceContext(),
      privateSourceContextObserver: report => seen.push(report),
    }));

    expect(resolution).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_incomplete'] });
    expect(hasPrimaryTopologyAuthority(resolution)).toBe(false);
    expect(seen).toEqual([expect.objectContaining({
      retained: true,
      selectedCrossStreet: null,
      certificationStatus: 'NOT_CERTIFIED',
      identityReason: 'invalid_street_context',
      csclFromStreet: null,
      csclToStreet: null,
      reason: 'ambiguous_source_names',
      fromNodeNames: [' BATTERY PL', ' 2 PL'],
      toNodeNames: [' BATTERY PL', ' 3 PL'],
      identities: {
        physicalId: '5',
        segmentId: '0018126',
        nodeIdFrom: '0012380',
        nodeIdTo: '0012383',
        leftBlockFaceId: '1222600642',
        rightBlockFaceId: '1222604562',
        provenance: {
          certificationStatus: 'NOT_CERTIFIED',
          source: 'retained-lion-node-stname',
        },
      },
    })]);
  });

  it('fails closed when cross-street populations, segment evidence, or certification do not qualify', async () => {
    const cases = [
      [sourceContext({ fromNodeNames: [] }), 'missing_cross_street_evidence'],
      [sourceContext({
        segments: [
          { physicalId: '5', segmentId: '0018126' },
          { physicalId: '5', segmentId: '0099999' },
        ],
      }), 'conflicting_segment_evidence'],
      [sourceContext({ from_street: ' 2 PL', to_street: ' 3 PL' }), 'cross_street_selection_refused'],
      [sourceContext({
        provenance: { certificationStatus: 'CERTIFIED', source: 'retained-lion-node-stname' },
      }), 'source_certification_refused'],
    ];

    for (const [packet, reason] of cases) {
      const seen = [];
      const resolution = await resolveCanonicalCurb(location(), options({
        privateSourceContextRetention: RETENTION_MODE,
        privateSourceContext: packet,
        privateSourceContextObserver: report => seen.push(report),
      }));
      expect(resolution).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_incomplete'] });
      expect(resolution.state).not.toBe('SUPPORTED');
      expect(seen[0]).toMatchObject({ retained: false, selectedCrossStreet: null, reason });
    }
  });

  it('leaves the production callable unable to enable retention and keeps App Check enforcement', () => {
    const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const callable = index.slice(index.indexOf('exports.createSegmentFromSweepNYC'));
    const retention = readFileSync(new URL('./privateSourceContextRetention.js', import.meta.url), 'utf8');

    expect(callable.startsWith('exports.createSegmentFromSweepNYC')).toBe(true);
    expect(callable).toContain('enforceAppCheck: true');
    expect(callable).toContain('streetIntelligenceAppCheckRejection(request)');
    expect(callable).toContain("request.data?.protocolVersion !== 2");
    expect(index).not.toContain('privateSourceContextRetention');
    expect(index).not.toContain(RETENTION_MODE);
    expect(retention).not.toContain('process.env');
  });
});
