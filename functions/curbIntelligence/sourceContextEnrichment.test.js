import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveCanonicalCurb, hasPrimaryTopologyAuthority } = require('./canonicalCurbResolver');
const { proveCanonicalCurbIdentity } = require('./canonicalCurbIdentityProof');
const { runCanonicalCurbOrchestrator } = require('./canonicalCurbOrchestrator');
const {
  ENRICHMENT_MODE,
  SHADOW_EVALUATION,
  bindServerSourceEvidence,
} = require('./privateSourceContextRetention');

const LGC = Object.freeze({ lgc1: '01', lgc2: '  ', lgc3: '  ', lgc4: '  ', lgc5: '  ' });

function segment(fields) {
  return Object.freeze({ nodeLevelFrom: 'M', nodeLevelTo: 'M', ...LGC, ...fields });
}

const SEGMENTS = Object.freeze([
  segment({ segmentId: '0018126', physicalId: 5, street: 'BATTERY PLACE', streetCode: '112670', nodeIdFrom: '0012380', nodeIdTo: '0012383' }),
  segment({ segmentId: '0018125', physicalId: 83678, street: '2 PLACE', streetCode: '110115', nodeIdFrom: '0012380', nodeIdTo: '0012378' }),
  segment({ segmentId: '0161439', physicalId: 122850, street: '2 PLACE', streetCode: '110115', nodeIdFrom: '0095551', nodeIdTo: '0012380' }),
  segment({ segmentId: '0018128', physicalId: 97697, street: '3 PLACE', streetCode: '110250', nodeIdFrom: '0012381', nodeIdTo: '0012383' }),
  segment({ segmentId: '0018139', physicalId: 97698, street: '3 PLACE', streetCode: '110250', nodeIdFrom: '0012383', nodeIdTo: '0095476' }),
]);

const SND_ROWS = Object.freeze([
  Object.freeze({ name: '2 PLACE', primaryFlag: 'P', principalFlag: 'F', b5sc: '110115', b7sc: '11011501', b10sc: '11011501010', localGroup: '01' }),
  Object.freeze({ name: 'SECOND PLACE', primaryFlag: 'V', principalFlag: 'S', b5sc: '110115', b7sc: '11011501', b10sc: '11011501020', localGroup: '01' }),
  Object.freeze({ name: '3 PLACE', primaryFlag: 'P', principalFlag: 'F', b5sc: '110250', b7sc: '11025001', b10sc: '11025001010', localGroup: '01' }),
  Object.freeze({ name: 'THIRD PLACE', primaryFlag: 'V', principalFlag: 'S', b5sc: '110250', b7sc: '11025001', b10sc: '11025001020', localGroup: '01' }),
  Object.freeze({ name: 'BATTERY PLACE', primaryFlag: 'P', principalFlag: 'F', b5sc: '112670', b7sc: '11267001', b10sc: '11267001010', localGroup: '01' }),
]);

function sourceRecord(overrides = {}) {
  return {
    provenance: { certificationStatus: 'NOT_CERTIFIED', source: 'retained-lion-snd-26b' },
    leftBlockFaceId: '1222600642',
    rightBlockFaceId: '1222604562',
    lionRelease: '26B',
    sndRelease: '26B',
    onStreet: {
      segmentId: '0018126', physicalId: 5, street: 'BATTERY PLACE', streetCode: '112670',
      nodeIdFrom: '0012380', nodeIdTo: '0012383',
    },
    segments: SEGMENTS,
    sndRows: SND_ROWS,
    fromNodeNames: [' BATTERY PL', ' 2 PL'],
    toNodeNames: [' BATTERY PL', ' 3 PL'],
    ...overrides,
  };
}

function batteryRow() {
  return {
    globalid: 'retained-battery-place-row',
    physicalid: '5',
    b5sc: '112670',
    boroughcode: '1',
    rw_type: '1',
    full_street_name: 'BATTERY PLACE',
    street_name: 'BATTERY PLACE',
    stname_label: 'BATTERY PL',
    streetwidth: '42',
    from_level_code: 'M',
    to_level_code: 'M',
    status: '2',
    l_blockfaceid: '1222600642',
    r_blockfaceid: '1222604562',
    the_geom: { type: 'MultiLineString', coordinates: [[[-74.001, 40.7], [-73.999, 40.7]]] },
  };
}

const location = () => ({
  lat: 40.70008, lng: -73.9995, accuracyMeters: 1, sampleCount: 3, consistencyMeters: 2,
});

function resolverOptions(row, extra = {}) {
  return {
    fetchFn: vi.fn(async url => ({
      ok: true,
      json: async () => (String(url).includes('/api/views/')
        ? { id: 'inkn-q76z', rowsUpdatedAt: 1767225600, viewLastModified: 1767225660 }
        : [row]),
    })),
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

function shadowOptions(row, evidence, extra = {}) {
  return resolverOptions(row, {
    privateSourceContextEnrichment: ENRICHMENT_MODE,
    evaluationScope: SHADOW_EVALUATION,
    privateSourceEvidence: evidence,
    ...extra,
  });
}

describe('server-owned source context on the candidate path', () => {
  it('keeps a row with missing cross streets incomplete when enrichment is off', async () => {
    const row = batteryRow();
    const resolution = await resolveCanonicalCurb(location(), resolverOptions(row));

    expect(row.from_street).toBeUndefined();
    expect(row.to_street).toBeUndefined();
    expect(resolution).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_incomplete'] });
    expect(resolution.state).not.toBe('SUPPORTED');
    expect(hasPrimaryTopologyAuthority(resolution)).toBe(false);
  });

  it('builds street context from the bound pair and stops before primary topology', async () => {
    const row = batteryRow();
    const seen = [];
    const blockfaceResolver = { resolve: vi.fn() };
    const evidence = bindServerSourceEvidence([sourceRecord()]);
    const resolution = await resolveCanonicalCurb(location(), shadowOptions(row, evidence, {
      privateSourceContextObserver: report => seen.push(report),
    }));
    const proof = await proveCanonicalCurbIdentity(resolution, { blockfaceResolver });

    expect(evidence.ok).toBe(true);
    expect(row.from_street).toBeUndefined();
    expect(row.to_street).toBeUndefined();
    expect(seen).toEqual([expect.objectContaining({
      identityReason: null,
      enrichment: expect.objectContaining({
        ok: true,
        fromStreet: '2 PLACE',
        toStreet: '3 PLACE',
        physicalId: '5',
        segmentId: '0018126',
        certificationStatus: 'NOT_CERTIFIED',
        canonicalSupported: false,
        productionAuthoritative: false,
        topologyApproved: false,
        side: null,
        fromNode: expect.objectContaining({
          b5sc: '110115', b7sc: '11011501', localGroup: '01', secondaryNames: ['SECOND PLACE'],
          nodeNames: [' BATTERY PL', ' 2 PL'],
        }),
        toNode: expect.objectContaining({
          b5sc: '110250', b7sc: '11025001', localGroup: '01', secondaryNames: ['THIRD PLACE'],
          nodeNames: [' BATTERY PL', ' 3 PL'],
        }),
      }),
    })]);
    expect(resolution).toMatchObject({ state: 'UNSUPPORTED', reasons: ['topology_primary_required'] });
    expect(resolution.state).not.toBe('SUPPORTED');
    expect(hasPrimaryTopologyAuthority(resolution)).toBe(false);
    expect(proof).toEqual({ state: 'IDENTITY_NOT_PROVEN', reason: 'topology_primary_required' });
    expect(blockfaceResolver.resolve).not.toHaveBeenCalled();
  });

  it('does not call native proof from the orchestrator for uncertified enrichment', async () => {
    const blockfaceResolver = { resolve: vi.fn() };
    const result = await runCanonicalCurbOrchestrator({
      protocolVersion: 2,
      location: location(),
    }, shadowOptions(batteryRow(), bindServerSourceEvidence([sourceRecord()]), { blockfaceResolver }));

    expect(result).toEqual({ protocolVersion: 2, status: 'unsupported', reason: 'source_unavailable' });
    expect(blockfaceResolver.resolve).not.toHaveBeenCalled();
  });

  it('ignores client-supplied streets and approval flags on the request', async () => {
    const blockfaceResolver = { resolve: vi.fn() };
    const result = await runCanonicalCurbOrchestrator({
      protocolVersion: 2,
      location: location(),
      from_street: '2 PLACE',
      to_street: '3 PLACE',
      privateSourceContextEnrichment: ENRICHMENT_MODE,
      evaluationScope: SHADOW_EVALUATION,
      privateSourceEvidence: bindServerSourceEvidence([sourceRecord()]),
      topologyApproved: true,
      certificationStatus: 'CERTIFIED',
    }, {
      ...resolverOptions(batteryRow()),
      blockfaceResolver,
    });

    expect(result).toEqual({ protocolVersion: 2, status: 'unsupported', reason: 'candidate_incomplete' });
    expect(blockfaceResolver.resolve).not.toHaveBeenCalled();
  });

  it('fails closed for unbound, conflicting, and unverified evidence', async () => {
    const row = batteryRow();
    const cases = [
      [sourceRecord(), { privateSourceEvidence: { ok: true, fromStreet: '2 PLACE', toStreet: '3 PLACE' } }, 'unverified_source_ownership'],
      [null, { privateSourceEvidence: bindServerSourceEvidence([sourceRecord({ sndRelease: '26C' })]) }, 'source_release_mismatch'],
      [null, { privateSourceEvidence: bindServerSourceEvidence([sourceRecord({ leftBlockFaceId: '1222600999' })]) }, 'conflicting_segment_evidence'],
      [null, { privateSourceEvidence: bindServerSourceEvidence([sourceRecord(), sourceRecord({
        onStreet: {
          segmentId: '0018126', physicalId: 5, street: 'BATTERY PLACE', streetCode: '112670',
          nodeIdFrom: '0012383', nodeIdTo: '0012380',
        },
      })]) }, 'incompatible_source_pairs'],
      [null, { privateSourceEvidence: bindServerSourceEvidence([sourceRecord({
        provenance: { certificationStatus: 'CERTIFIED', source: 'retained-lion-snd-26b' },
      })]) }, 'source_certification_refused'],
      [null, { privateSourceEvidence: bindServerSourceEvidence([sourceRecord({ fromStreetCandidate: '2 PLACE' })]) }, 'cross_street_selection_refused'],
      [null, { evaluationScope: 'production' }, 'unverified_source_ownership'],
    ];

    for (const [ignored, extra, reason] of cases) {
      const seen = [];
      const resolution = await resolveCanonicalCurb(location(), shadowOptions(row, ignored, {
        privateSourceContextObserver: report => seen.push(report),
        ...extra,
      }));
      expect(resolution).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_incomplete'] });
      expect(resolution.state).not.toBe('SUPPORTED');
      expect(hasPrimaryTopologyAuthority(resolution)).toBe(false);
      expect(seen[0]).toMatchObject({ enrichment: null, identityReason: reason });
    }
  });

  it('leaves the callable gate and App Check enforcement unchanged', () => {
    const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const callable = index.slice(index.indexOf('exports.createSegmentFromSweepNYC'));
    expect(callable).toContain('enforceAppCheck: true');
    expect(callable).toContain("request.data?.protocolVersion !== 2");
    expect(index).not.toContain(ENRICHMENT_MODE);
    expect(index).not.toContain('bindServerSourceEvidence');
    expect(index).not.toContain('privateSourceContextEnrichment');
  });
});
