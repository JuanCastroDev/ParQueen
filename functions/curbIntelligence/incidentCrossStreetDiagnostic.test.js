import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { diagnoseIncidentCrossStreets } = require('./incidentCrossStreetDiagnostic');

const LGC = Object.freeze({
  lgc1: '01', lgc2: '  ', lgc3: '  ', lgc4: '  ', lgc5: '  ',
});

const ON_STREET = Object.freeze({
  segmentId: '0018126',
  physicalId: 5,
  street: 'BATTERY PLACE',
  streetCode: '112670',
  nodeIdFrom: '0012380',
  nodeIdTo: '0012383',
});

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

function batteryEvidence(overrides = {}) {
  return {
    lionRelease: '26B',
    sndRelease: '26B',
    onStreet: ON_STREET,
    segments: SEGMENTS,
    sndRows: SND_ROWS,
    fromNodeNames: [' BATTERY PL', ' 2 PL'],
    toNodeNames: [' BATTERY PL', ' 3 PL'],
    ...overrides,
  };
}

describe('Battery Place street-code join', () => {
  it('joins each terminal to the SND primary name for its LGC', () => {
    const diagnostic = diagnoseIncidentCrossStreets(batteryEvidence());

    expect(diagnostic).toMatchObject({
      status: 'NON_AUTHORITATIVE',
      reason: null,
      certificationStatus: 'NOT_CERTIFIED',
      productionAuthoritative: false,
      canonicalSupported: false,
      fromStreetCandidate: '2 PLACE',
      toStreetCandidate: '3 PLACE',
      side: null,
      gradeSeparation: [],
      fromNode: {
        nodeId: '0012380',
        streetCode: '110115',
        b7sc: '11011501',
        b10sc: '11011501010',
        localGroup: '01',
        segmentIds: ['0018125', '0161439'],
        secondaryNames: ['SECOND PLACE'],
        nodeNames: [' BATTERY PL', ' 2 PL'],
        lgc: [
          { segmentId: '0018125', lgc1: '01', lgc2: '  ', lgc3: '  ', lgc4: '  ', lgc5: '  ' },
          { segmentId: '0161439', lgc1: '01', lgc2: '  ', lgc3: '  ', lgc4: '  ', lgc5: '  ' },
        ],
      },
      toNode: {
        nodeId: '0012383',
        streetCode: '110250',
        b7sc: '11025001',
        b10sc: '11025001010',
        localGroup: '01',
        segmentIds: ['0018128', '0018139'],
        secondaryNames: ['THIRD PLACE'],
        nodeNames: [' BATTERY PL', ' 3 PL'],
      },
      provenance: { lionRelease: '26B', sndRelease: '26B', certificationStatus: 'NOT_CERTIFIED' },
    });
    expect(diagnostic.from_street).toBeUndefined();
    expect(diagnostic.to_street).toBeUndefined();
    expect(diagnostic.fromNode.secondaryNames).not.toContain(' 2 PL');
    expect(diagnostic.status).not.toBe('SUPPORTED');
  });

  it('rejects a wrong node, a wrong street code, a conflicting LGC, and a secondary name used as primary', () => {
    const wrongNode = diagnoseIncidentCrossStreets(batteryEvidence({
      segments: SEGMENTS.map(row => (
        row.streetCode === '110115' ? { ...row, nodeIdFrom: '0099991', nodeIdTo: '0099992' } : row
      )),
    }));
    const wrongCode = diagnoseIncidentCrossStreets(batteryEvidence({
      segments: SEGMENTS.map(row => (
        row.streetCode === '110115' ? { ...row, streetCode: '119999' } : row
      )),
    }));
    const conflictingLgc = diagnoseIncidentCrossStreets(batteryEvidence({
      segments: SEGMENTS.map(row => (
        row.segmentId === '0161439' ? { ...row, lgc2: '02' } : row
      )),
    }));
    const secondary = diagnoseIncidentCrossStreets(batteryEvidence({
      segments: SEGMENTS.map(row => (
        row.streetCode === '110115' ? { ...row, street: 'SECOND PLACE' } : row
      )),
    }));

    expect(wrongNode).toMatchObject({ reason: 'wrong_incident_node', fromStreetCandidate: null, canonicalSupported: false });
    expect(wrongCode).toMatchObject({ reason: 'street_code_snd_mismatch', fromStreetCandidate: null });
    expect(conflictingLgc).toMatchObject({ reason: 'incompatible_local_group', fromStreetCandidate: null });
    expect(secondary).toMatchObject({ reason: 'secondary_name_not_primary', fromStreetCandidate: null });
  });

  it('rejects a missing SND local group, incomplete LGC evidence, and a release mismatch', () => {
    const missingGroup = diagnoseIncidentCrossStreets(batteryEvidence({
      sndRows: SND_ROWS.map(row => (
        row.b5sc === '110115' && row.primaryFlag === 'P' ? { ...row, localGroup: ' ' } : row
      )),
    }));
    const incomplete = diagnoseIncidentCrossStreets(batteryEvidence({
      segments: SEGMENTS.map(row => (
        row.segmentId === '0018125' ? { ...row, lgc1: undefined } : row
      )),
    }));
    const mismatch = diagnoseIncidentCrossStreets(batteryEvidence({ sndRelease: '26C' }));

    expect(missingGroup.reason).toBe('missing_snd_local_group');
    expect(incomplete.reason).toBe('incomplete_incident_segment');
    expect(mismatch.reason).toBe('source_release_mismatch');
    expect(mismatch.certificationStatus).toBe('NOT_CERTIFIED');
    expect(mismatch.canonicalSupported).toBe(false);
  });

  it('preserves a non-main node level and stays unwired from production identity', () => {
    const diagnostic = diagnoseIncidentCrossStreets(batteryEvidence({
      segments: SEGMENTS.map(row => (
        row.segmentId === '0018125' ? { ...row, nodeLevelFrom: 'A' } : row
      )),
    }));
    const index = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    const resolver = readFileSync(new URL('./canonicalCurbResolver.js', import.meta.url), 'utf8');
    const identity = readFileSync(new URL('./canonicalCurbIdentity.js', import.meta.url), 'utf8');

    expect(diagnostic.fromStreetCandidate).toBe('2 PLACE');
    expect(diagnostic.side).toBeNull();
    expect(diagnostic.gradeSeparation).toEqual([{ segmentId: '0018125', from: 'A', to: 'M' }]);
    expect(diagnostic.canonicalSupported).toBe(false);
    expect(diagnostic.productionAuthoritative).toBe(false);
    expect(index).not.toContain('fromStreetCandidate');
    expect(resolver).not.toContain('incidentCrossStreetDiagnostic');
    expect(identity).not.toContain('fromStreetCandidate');
    expect(index).toContain('enforceAppCheck: true');
  });
});

const GROUP = Object.freeze({ lgc1: '01', lgc2: '  ', lgc3: '  ', lgc4: '  ', lgc5: '  ' });

function joinedSegment(fields) {
  return Object.freeze({ nodeLevelFrom: 'M', nodeLevelTo: 'M', ...GROUP, ...fields });
}

function sndRow(name, b10sc, primary, principal) {
  return Object.freeze({
    name,
    b10sc,
    b5sc: b10sc.slice(0, 6),
    b7sc: b10sc.slice(0, 8),
    localGroup: b10sc.slice(6, 8),
    primaryFlag: primary,
    principalFlag: principal,
  });
}

const VAN_NEST_SND = Object.freeze([
  sndRow('C JENNEWEIN PLACE', '27112002040', 'V', 'S'),
  sndRow('C P JENNEWEIN PLACE', '27112002030', 'V', 'S'),
  sndRow('CARL P JENNEWEIN PLACE', '27112002020', 'V', 'S'),
  sndRow('CARL PAUL JENNEWEIN PLACE', '27112002010', 'V', 'F'),
  sndRow('JENNEWEIN PLACE', '27112002050', 'V', 'S'),
  sndRow('VAN NEST AVENUE', '27112001010', 'P', 'F'),
  sndRow('VANNEST AVENUE', '27112001020', 'V', 'S'),
]);

function vanNestEvidence(overrides = {}) {
  return {
    lionRelease: '26B',
    sndRelease: '26B',
    onStreet: {
      segmentId: '0085847',
      physicalId: '98053',
      street: 'MELVILLE STREET',
      streetCode: '250420',
      nodeIdFrom: '0052416',
      nodeIdTo: '0048539',
    },
    segments: [
      joinedSegment({
        segmentId: '0085847', physicalId: '98053', street: 'MELVILLE STREET', streetCode: '250420',
        nodeIdFrom: '0052416', nodeIdTo: '0048539',
      }),
      joinedSegment({
        segmentId: '0085848', physicalId: '40573', street: 'VAN NEST AVENUE', streetCode: '271120',
        nodeIdFrom: '0052416', nodeIdTo: '0052431',
      }),
      joinedSegment({
        segmentId: '0085843', physicalId: '40574', street: 'VAN NEST AVENUE', streetCode: '271120',
        nodeIdFrom: '0052413', nodeIdTo: '0052416', lgc2: '02',
      }),
      joinedSegment({
        segmentId: '0079542', physicalId: '56255', street: 'MORRIS PARK AVENUE', streetCode: '252220',
        nodeIdFrom: '0048536', nodeIdTo: '0048539',
      }),
      joinedSegment({
        segmentId: '0079547', physicalId: '56254', street: 'MORRIS PARK AVENUE', streetCode: '252220',
        nodeIdFrom: '0048539', nodeIdTo: '0052429',
      }),
    ],
    sndRows: [
      ...VAN_NEST_SND,
      sndRow('MORRIS PARK AVENUE', '25222001010', 'P', 'F'),
      sndRow('MELVILLE STREET', '25042001010', 'P', 'F'),
    ],
    fromNodeNames: [' MELVILLE ST', ' VAN NEST AVE'],
    toNodeNames: [' MORRIS PARK AVE', ' MELVILLE ST'],
    ...overrides,
  };
}

describe('recorded local groups with one primary street identity', () => {
  it('selects the SND primary recorded on the segment and retains the other local group', () => {
    const diagnostic = diagnoseIncidentCrossStreets(vanNestEvidence());

    expect(diagnostic).toMatchObject({
      reason: null,
      certificationStatus: 'NOT_CERTIFIED',
      productionAuthoritative: false,
      canonicalSupported: false,
      fromStreetCandidate: 'VAN NEST AVENUE',
      toStreetCandidate: 'MORRIS PARK AVENUE',
      fromNode: {
        nodeId: '0052416',
        streetCode: '271120',
        b7sc: '27112001',
        b10sc: '27112001010',
        localGroup: '01',
        segmentIds: ['0085848', '0085843'],
        physicalIds: ['40573', '40574'],
      },
      toNode: {
        localGroup: '01',
        b7sc: '25222001',
      },
    });
    expect(diagnostic.fromNode.secondaryNames).toEqual([
      'C JENNEWEIN PLACE',
      'C P JENNEWEIN PLACE',
      'CARL P JENNEWEIN PLACE',
      'CARL PAUL JENNEWEIN PLACE',
      'JENNEWEIN PLACE',
      'VANNEST AVENUE',
    ]);
    expect(diagnostic.fromNode.lgc).toContainEqual({
      segmentId: '0085843', lgc1: '01', lgc2: '02', lgc3: '  ', lgc4: '  ', lgc5: '  ',
    });
    expect(diagnostic.fromNode.nodeNames).toEqual([' MELVILLE ST', ' VAN NEST AVE']);
    expect(diagnostic.fromStreetCandidate).not.toBe(' VAN NEST AVE');
    expect(diagnostic.status).not.toBe('SUPPORTED');
  });

  it('uses the primary local group when a lower group is also recorded', () => {
    const diagnostic = diagnoseIncidentCrossStreets(vanNestEvidence({
      segments: [
        joinedSegment({
          segmentId: '0085847', physicalId: '98053', street: 'MELVILLE STREET', streetCode: '250420',
          nodeIdFrom: '0052416', nodeIdTo: '0048539',
        }),
        joinedSegment({
          segmentId: '0085843', physicalId: '40574', street: 'PRIMARY AVENUE', streetCode: '271120',
          nodeIdFrom: '0052413', nodeIdTo: '0052416', lgc1: '02', lgc2: '07',
        }),
        joinedSegment({
          segmentId: '0079542', physicalId: '56255', street: 'MORRIS PARK AVENUE', streetCode: '252220',
          nodeIdFrom: '0048536', nodeIdTo: '0048539',
        }),
      ],
      sndRows: [
        sndRow('HONORARY PLACE', '27112002010', 'V', 'F'),
        sndRow('PRIMARY AVENUE', '27112007010', 'P', 'F'),
        sndRow('MORRIS PARK AVENUE', '25222001010', 'P', 'F'),
      ],
    }));

    expect(diagnostic.fromStreetCandidate).toBe('PRIMARY AVENUE');
    expect(diagnostic.fromNode.localGroup).toBe('07');
    expect(diagnostic.fromNode.b7sc).toBe('27112007');
    expect(diagnostic.fromNode.secondaryNames).toEqual(['HONORARY PLACE']);
    expect(diagnostic.canonicalSupported).toBe(false);
  });

  it('rejects competing, unsupported, and mismatched local-group evidence', () => {
    const competingCodes = diagnoseIncidentCrossStreets(vanNestEvidence({
      segments: [
        ...vanNestEvidence().segments,
        joinedSegment({
          segmentId: '0099001', physicalId: '1', street: 'OTHER AVENUE', streetCode: '200001',
          nodeIdFrom: '0052416', nodeIdTo: '0099002',
        }),
      ],
    }));
    const primaryMissingFromSegment = diagnoseIncidentCrossStreets(vanNestEvidence({
      segments: vanNestEvidence().segments.map(row => (
        row.segmentId === '0085843' ? { ...row, lgc1: '03', lgc2: '04' } : row
      )),
      sndRows: [
        sndRow('VAN NEST AVENUE', '27112001010', 'P', 'F'),
        sndRow('GROUP THREE', '27112003010', 'V', 'F'),
        sndRow('GROUP FOUR', '27112004010', 'V', 'F'),
        sndRow('MORRIS PARK AVENUE', '25222001010', 'P', 'F'),
      ],
    }));
    const honoraryStreet = diagnoseIncidentCrossStreets(vanNestEvidence({
      segments: vanNestEvidence().segments.map(row => (
        row.streetCode === '271120' ? { ...row, street: 'CARL PAUL JENNEWEIN PLACE' } : row
      )),
    }));
    const twoPrimaries = diagnoseIncidentCrossStreets(vanNestEvidence({
      sndRows: [
        ...VAN_NEST_SND,
        sndRow('SECOND PRIMARY', '27112002060', 'P', 'F'),
        sndRow('MORRIS PARK AVENUE', '25222001010', 'P', 'F'),
      ],
    }));
    const wrongB7sc = diagnoseIncidentCrossStreets(vanNestEvidence({
      sndRows: VAN_NEST_SND.map(row => (
        row.name === 'VAN NEST AVENUE' ? { ...row, b7sc: '27112099' } : row
      )).concat([sndRow('MORRIS PARK AVENUE', '25222001010', 'P', 'F')]),
    }));
    const unsupportedGroup = diagnoseIncidentCrossStreets(vanNestEvidence({
      sndRows: [
        sndRow('VAN NEST AVENUE', '27112001010', 'P', 'F'),
        sndRow('MORRIS PARK AVENUE', '25222001010', 'P', 'F'),
      ],
    }));
    const missingPrimary = diagnoseIncidentCrossStreets(vanNestEvidence({
      sndRows: VAN_NEST_SND.filter(row => row.primaryFlag !== 'P')
        .concat([sndRow('MORRIS PARK AVENUE', '25222001010', 'P', 'F')]),
    }));
    const wrongNode = diagnoseIncidentCrossStreets(vanNestEvidence({
      segments: vanNestEvidence().segments.map(row => (
        row.streetCode === '271120' ? { ...row, nodeIdFrom: '0099991', nodeIdTo: '0099992' } : row
      )),
    }));
    const missingRelease = diagnoseIncidentCrossStreets(vanNestEvidence({ lionRelease: '', sndRelease: '' }));

    expect(competingCodes.reason).toBe('ambiguous_street_code');
    expect(primaryMissingFromSegment.reason).toBe('incompatible_local_group');
    expect(honoraryStreet.reason).toBe('secondary_name_not_primary');
    expect(twoPrimaries.reason).toBe('unresolved_source_identity');
    expect(wrongB7sc.reason).toBe('unresolved_source_identity');
    expect(unsupportedGroup.reason).toBe('incompatible_local_group');
    expect(missingPrimary.reason).toBe('unresolved_source_identity');
    expect(wrongNode.reason).toBe('wrong_incident_node');
    expect(missingRelease.reason).toBe('source_release_mismatch');
    for (const diagnostic of [
      competingCodes, primaryMissingFromSegment, honoraryStreet, twoPrimaries,
      wrongB7sc, unsupportedGroup, missingPrimary, wrongNode, missingRelease,
    ]) {
      expect(diagnostic.fromStreetCandidate).toBeNull();
      expect(diagnostic.canonicalSupported).toBe(false);
      expect(diagnostic.certificationStatus).toBe('NOT_CERTIFIED');
    }
  });
});
