import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createCanonicalCurbIdentity } = require('./canonicalCurbIdentity');
const { proveCanonicalCurbIdentity } = require('./canonicalCurbIdentityProof');
const { diagnoseIncidentCrossStreets } = require('./incidentCrossStreetDiagnostic');
const { resolveCanonicalCurb, hasPrimaryTopologyAuthority } = require('./canonicalCurbResolver');

const RETAINED_DIAGNOSTIC = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'si-block-association-02-physicalid-5.json');
const RETAINED_DIAGNOSTIC_SHA256 = 'bdaf877e58b78a8fc9bf9a7f8c2ff58d15fc8b3c487d0c7b88868ee64609dd21';
const STRUCTURAL_SOURCE_VERSION = Object.freeze({
  resourceId: 'inkn-q76z',
  version: 'structural-grammar-only',
});
const SYNTHETIC_GLOBAL_ID = 'synthetic-grammar-global-id';
const SYNTHETIC_CARDINALS = Object.freeze(['North', 'South', 'East', 'West']);

const LGC = Object.freeze({
  lgc1: '01', lgc2: '  ', lgc3: '  ', lgc4: '  ', lgc5: '  ',
});
const RETAINED_CENTERLINE = Object.freeze([[
  [-74.017575674546, 40.706848105307],
  [-74.017121822757, 40.707470769174],
]]);

function segment(fields) {
  return Object.freeze({ nodeLevelFrom: 'M', nodeLevelTo: 'M', ...LGC, ...fields });
}

const SEGMENTS = Object.freeze([
  segment({ segmentId: '0018126', physicalId: 5, street: 'BATTERY PLACE', streetCode: '112670', nodeIdFrom: '0012380', nodeIdTo: '0012383' }),
  segment({ segmentId: '0018123', physicalId: 3, street: 'BATTERY PLACE', streetCode: '112670', nodeIdFrom: '0012377', nodeIdTo: '0012380' }),
  segment({ segmentId: '0018125', physicalId: 83678, street: '2 PLACE', streetCode: '110115', nodeIdFrom: '0012380', nodeIdTo: '0012378', featureType: '0', segmentType: 'U', rwType: ' 1' }),
  segment({ segmentId: '0161439', physicalId: 122850, street: '2 PLACE', streetCode: '110115', nodeIdFrom: '0095551', nodeIdTo: '0012380', featureType: '0', segmentType: 'U', rwType: ' 1' }),
  segment({ segmentId: '0018129', physicalId: 6, street: 'BATTERY PLACE', streetCode: '112670', nodeIdFrom: '0012383', nodeIdTo: '0012399' }),
  segment({ segmentId: '0018128', physicalId: 97697, street: '3 PLACE', streetCode: '110250', nodeIdFrom: '0012381', nodeIdTo: '0012383', featureType: '0', segmentType: 'U', rwType: ' 1' }),
  segment({ segmentId: '0018139', physicalId: 97698, street: '3 PLACE', streetCode: '110250', nodeIdFrom: '0012383', nodeIdTo: '0095476', featureType: '0', segmentType: 'U', rwType: ' 1' }),
]);

const SND_ROWS = Object.freeze([
  Object.freeze({ name: '2 PLACE', primaryFlag: 'P', principalFlag: 'F', b5sc: '110115', b7sc: '11011501', b10sc: '11011501010', localGroup: '01' }),
  Object.freeze({ name: 'SECOND PLACE', primaryFlag: 'V', principalFlag: 'S', b5sc: '110115', b7sc: '11011501', b10sc: '11011501020', localGroup: '01' }),
  Object.freeze({ name: '3 PLACE', primaryFlag: 'P', principalFlag: 'F', b5sc: '110250', b7sc: '11025001', b10sc: '11025001010', localGroup: '01' }),
  Object.freeze({ name: 'THIRD PLACE', primaryFlag: 'V', principalFlag: 'S', b5sc: '110250', b7sc: '11025001', b10sc: '11025001020', localGroup: '01' }),
  Object.freeze({ name: 'BATTERY PLACE', primaryFlag: 'P', principalFlag: 'F', b5sc: '112670', b7sc: '11267001', b10sc: '11267001010', localGroup: '01' }),
]);

function evidence(overrides = {}) {
  return {
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

function acceptedPair(diagnostic) {
  if (diagnostic?.status !== 'NON_AUTHORITATIVE' || diagnostic.canonicalSupported !== false) return null;
  if (diagnostic.certificationStatus !== 'NOT_CERTIFIED' || diagnostic.side !== null) return null;
  if (diagnostic.fromNode?.nodeId !== '0012380' || diagnostic.fromNode.b5sc !== '110115') return null;
  if (diagnostic.fromNode.localGroup !== '01' || diagnostic.fromNode.b7sc !== '11011501') return null;
  if (diagnostic.toNode?.nodeId !== '0012383' || diagnostic.toNode.b5sc !== '110250') return null;
  if (diagnostic.toNode.localGroup !== '01' || diagnostic.toNode.b7sc !== '11025001') return null;
  if (diagnostic.fromStreetCandidate !== '2 PLACE' || diagnostic.toStreetCandidate !== '3 PLACE') return null;
  return Object.freeze({
    fromStreet: diagnostic.fromStreetCandidate,
    toStreet: diagnostic.toStreetCandidate,
  });
}

function retainedIdentityInput(pair) {
  return {
    csclRows: [{
      physicalid: '5',
      b5sc: '112670',
      full_street_name: 'BATTERY PLACE',
      l_blockfaceid: '1222600642',
      r_blockfaceid: '1222604562',
    }],
    geometry: { type: 'MultiLineString', coordinates: RETAINED_CENTERLINE },
    streetWidthFeet: 42,
    borough: 'Manhattan',
    onStreet: 'BATTERY PLACE',
    fromStreet: pair.fromStreet,
    toStreet: pair.toStreet,
    resolutionMethod: 'automatic',
  };
}

function retainedProjectionSide(diagnostic) {
  const recorded = [
    diagnostic?.projection?.csclSide,
    diagnostic?.sources?.cscl?.csclSide,
    diagnostic?.csclSide,
  ];
  return recorded.find(value => value === 'LEFT' || value === 'RIGHT') || null;
}

function grammarInput(pair, csclSide, cardinalSide, overrides = {}) {
  return {
    csclRows: [{
      globalid: SYNTHETIC_GLOBAL_ID,
      physicalid: '5',
      b5sc: '112670',
      full_street_name: 'BATTERY PLACE',
      l_blockfaceid: '1222600642',
      r_blockfaceid: '1222604562',
    }],
    csclSide,
    sourceVersion: STRUCTURAL_SOURCE_VERSION,
    geometry: { type: 'MultiLineString', coordinates: RETAINED_CENTERLINE },
    streetWidthFeet: 42,
    cardinalSide,
    resolutionMethod: 'automatic',
    borough: 'Manhattan',
    onStreet: 'BATTERY PLACE',
    fromStreet: pair.fromStreet,
    toStreet: pair.toStreet,
    ...overrides,
  };
}

describe('source-backed street-context dry run', () => {
  it('records the identity validator order through the street-context rule', () => {
    const rows = [{
      physicalid: '5',
      b5sc: '112670',
      full_street_name: 'BATTERY PLACE',
      l_blockfaceid: '1222600642',
      r_blockfaceid: '1222604562',
    }];
    const sourceVersion = STRUCTURAL_SOURCE_VERSION;
    const geometry = { type: 'MultiLineString', coordinates: RETAINED_CENTERLINE };
    const throughWidth = {
      csclRows: rows,
      csclSide: 'LEFT',
      sourceVersion,
      geometry,
      streetWidthFeet: 42,
    };

    expect(createCanonicalCurbIdentity()).toEqual({ ok: false, reason: 'invalid_cscl_rows' });
    expect(createCanonicalCurbIdentity({ csclRows: rows })).toEqual({ ok: false, reason: 'invalid_cscl_side' });
    expect(createCanonicalCurbIdentity({ csclRows: rows, csclSide: 'LEFT' })).toEqual({
      ok: false, reason: 'invalid_source_version',
    });
    expect(createCanonicalCurbIdentity({
      csclRows: [{ ...rows[0], sourceVersion: { resourceId: 'inkn-q76z', version: 'other-grammar-token' } }],
      csclSide: 'LEFT',
      sourceVersion,
    })).toEqual({ ok: false, reason: 'source_version_mismatch' });
    expect(createCanonicalCurbIdentity({
      csclRows: [{ ...rows[0], l_blockfaceid: '' }],
      csclSide: 'LEFT',
      sourceVersion,
    })).toEqual({ ok: false, reason: 'invalid_block_face_id' });
    expect(createCanonicalCurbIdentity({
      csclRows: [rows[0], { ...rows[0], l_blockfaceid: '1222600999' }],
      csclSide: 'LEFT',
      sourceVersion,
    })).toEqual({ ok: false, reason: 'conflicting_block_face_ids' });
    expect(createCanonicalCurbIdentity({ csclRows: rows, csclSide: 'LEFT', sourceVersion })).toEqual({
      ok: false, reason: 'invalid_geometry',
    });
    expect(createCanonicalCurbIdentity({ ...throughWidth, streetWidthFeet: 0 })).toEqual({
      ok: false, reason: 'invalid_street_width',
    });
    expect(createCanonicalCurbIdentity(throughWidth)).toEqual({ ok: false, reason: 'invalid_cardinal_side' });
    expect(createCanonicalCurbIdentity({ ...throughWidth, cardinalSide: 'North' })).toEqual({
      ok: false, reason: 'invalid_resolution_method',
    });
    expect(createCanonicalCurbIdentity({
      ...throughWidth, cardinalSide: 'North', resolutionMethod: 'automatic',
    })).toEqual({ ok: false, reason: 'invalid_selected_global_id' });
    expect(createCanonicalCurbIdentity({
      ...throughWidth,
      csclRows: [{ ...rows[0], globalid: SYNTHETIC_GLOBAL_ID }],
      cardinalSide: 'North',
      resolutionMethod: 'automatic',
      borough: 'Manhattan',
      onStreet: 'BATTERY PLACE',
      fromStreet: '',
      toStreet: '',
    })).toEqual({ ok: false, reason: 'invalid_street_context' });
  });

  it('accepts the source-backed names once synthetic side grammar is supplied', async () => {
    const retainedBytes = readFileSync(RETAINED_DIAGNOSTIC);
    expect(createHash('sha256').update(retainedBytes).digest('hex')).toBe(RETAINED_DIAGNOSTIC_SHA256);
    const retained = JSON.parse(retainedBytes.toString('utf8'));
    const diagnostic = diagnoseIncidentCrossStreets(evidence());
    const pair = acceptedPair(diagnostic);
    const recordedSide = retainedProjectionSide(retained);

    expect(recordedSide).toBeNull();
    expect(retained.authoritativeSideMatch).toBe(false);
    expect(retained.authoritativeDirectionProven).toBe(false);
    expect(retained.approvedTopologyArtifact).toBe(false);
    expect(retained.releaseCertification).toBe('BLOCKED');
    expect(retained.productionAuthoritative).toBe(false);
    expect(retained.sources.cscl.leftBfi).toBe('1222600642');
    expect(retained.sources.cscl.rightBfi).toBe('1222604562');
    expect(retained.comparison.closerPairing).toBe('FORWARD');
    expect(pair).toEqual({ fromStreet: '2 PLACE', toStreet: '3 PLACE' });

    for (const csclSide of ['LEFT', 'RIGHT']) {
      for (const cardinalSide of SYNTHETIC_CARDINALS) {
        const identity = createCanonicalCurbIdentity(grammarInput(pair, csclSide, cardinalSide));
        const shapedLikeSupported = { state: 'SUPPORTED', identity: identity.identity };
        const proof = await proveCanonicalCurbIdentity(shapedLikeSupported);

        expect(identity.ok).toBe(true);
        expect(identity.identity.names).toEqual({
          borough: 'Manhattan',
          onStreet: 'BATTERY PLACE',
          fromStreet: '2 PLACE',
          toStreet: '3 PLACE',
          aliases: [],
        });
        expect(identity.identity.csclSide).toBe(csclSide);
        expect(identity.identity.side).toEqual({ cardinal: cardinalSide });
        expect(identity.identity.officialBlockFaceId).toBe(csclSide === 'LEFT' ? '1222600642' : '1222604562');
        expect(identity.identity.sourceVersion).toEqual(STRUCTURAL_SOURCE_VERSION);
        expect(identity.identity.certificationStatus).toBeUndefined();
        expect(identity.state).toBeUndefined();
        expect(hasPrimaryTopologyAuthority(identity)).toBe(false);
        expect(hasPrimaryTopologyAuthority(shapedLikeSupported)).toBe(false);
        expect(proof).toEqual({ state: 'IDENTITY_NOT_PROVEN', reason: 'topology_primary_required' });
      }
    }

    expect(diagnostic.certificationStatus).toBe('NOT_CERTIFIED');
    expect(diagnostic.canonicalSupported).toBe(false);
    expect(diagnostic.side).toBeNull();
  });

  it('stops before street context when the test omits a side', () => {
    const diagnostic = diagnoseIncidentCrossStreets(evidence());
    const pair = acceptedPair(diagnostic);
    const identity = createCanonicalCurbIdentity(retainedIdentityInput(pair));

    expect(pair).toEqual({ fromStreet: '2 PLACE', toStreet: '3 PLACE' });
    expect(diagnostic.fromNode.secondaryNames).toEqual(['SECOND PLACE']);
    expect(diagnostic.toNode.secondaryNames).toEqual(['THIRD PLACE']);
    expect(diagnostic.fromNode.nodeNames).toEqual([' BATTERY PL', ' 2 PL']);
    expect(diagnostic.toNode.nodeNames).toEqual([' BATTERY PL', ' 3 PL']);
    expect(identity).toEqual({ ok: false, reason: 'invalid_cscl_side' });
    expect(identity.reason).not.toBe('invalid_street_context');
    expect(hasPrimaryTopologyAuthority(identity)).toBe(false);
    expect(identity.ok).not.toBe(true);
  });

  it('keeps the default resolver closed when cross streets are absent', async () => {
    const row = {
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
    const resolution = await resolveCanonicalCurb({
      lat: 40.70005, lng: -74, accuracyMeters: 1, sampleCount: 3, consistencyMeters: 2,
    }, {
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
    });

    expect(resolution).toMatchObject({ state: 'UNSUPPORTED', reasons: ['candidate_incomplete'] });
    expect(resolution.state).not.toBe('SUPPORTED');
    expect(hasPrimaryTopologyAuthority(resolution)).toBe(false);
  });

  it('rejects reversed, wrong, conflicting, and unverified source relationships', () => {
    const reversed = diagnoseIncidentCrossStreets(evidence({
      onStreet: {
        segmentId: '0018126', physicalId: 5, street: 'BATTERY PLACE', streetCode: '112670',
        nodeIdFrom: '0012383', nodeIdTo: '0012380',
      },
    }));
    const wrongNode = diagnoseIncidentCrossStreets(evidence({
      segments: SEGMENTS.map(row => (
        row.streetCode === '110115' ? { ...row, nodeIdFrom: '0099991', nodeIdTo: '0099992' } : row
      )),
    }));
    const wrongCode = diagnoseIncidentCrossStreets(evidence({
      segments: SEGMENTS.map(row => (
        row.streetCode === '110115' ? { ...row, streetCode: '119999' } : row
      )),
    }));
    const wrongLgc = diagnoseIncidentCrossStreets(evidence({
      segments: SEGMENTS.map(row => (
        row.segmentId === '0018125' ? { ...row, lgc1: '02' } : row
      )),
    }));
    const missingPrimary = diagnoseIncidentCrossStreets(evidence({
      sndRows: SND_ROWS.filter(row => !(row.b5sc === '110115' && row.primaryFlag === 'P')),
    }));
    const conflicting = diagnoseIncidentCrossStreets(evidence({
      segments: [...SEGMENTS, segment({
        segmentId: '0099999', physicalId: 1, street: 'WASHINGTON STREET', streetCode: '199999',
        nodeIdFrom: '0012380', nodeIdTo: '0000001',
      })],
    }));
    const unverified = diagnoseIncidentCrossStreets(evidence({ sndRelease: '26C' }));

    expect(acceptedPair(reversed)).toBeNull();
    expect(reversed.fromStreetCandidate).toBe('3 PLACE');
    expect(reversed.toStreetCandidate).toBe('2 PLACE');
    expect(wrongNode.reason).toBe('wrong_incident_node');
    expect(wrongCode.reason).toBe('street_code_snd_mismatch');
    expect(wrongLgc.reason).toBe('incompatible_local_group');
    expect(missingPrimary.reason).toBe('unresolved_source_identity');
    expect(conflicting.reason).toBe('ambiguous_street_code');
    expect(unverified.reason).toBe('source_release_mismatch');
    for (const diagnostic of [wrongNode, wrongCode, wrongLgc, missingPrimary, conflicting, unverified]) {
      expect(diagnostic.fromStreetCandidate).toBeNull();
      expect(diagnostic.canonicalSupported).toBe(false);
      expect(diagnostic.certificationStatus).toBe('NOT_CERTIFIED');
    }
  });
});
