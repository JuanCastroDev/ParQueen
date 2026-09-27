import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const line = ({
  id,
  name,
  b5sc,
  coordinates,
  leftBfi = null,
  rightBfi = null,
  fromLevel = 13,
  toLevel = 13,
  roadbedEvidence = null,
}) => ({
  physicalId: String(id),
  leftBfi,
  rightBfi,
  boroughCode: '1',
  borough: 'Manhattan',
  displayName: name,
  b5sc,
  b7sc: `${b5sc}01`,
  status: '2',
  roadwayType: 1,
  segmentType: null,
  fromLevel,
  toLevel,
  roadbedEvidence,
  geometry: { type: 'MultiLineString', coordinates: [coordinates] },
  sourceVersion: 'cscl-release',
});

const node = (id, coordinates) => ({
  nodeId: id,
  masterFlag: 'N',
  safType: null,
  groundElevation: null,
  geometry: { type: 'Point', coordinates },
  sourceVersion: 'cscl-release',
});

const base = () => ({
  centerlines: [
    line({ id: 1, name: 'BROADWAY', b5sc: '113260', leftBfi: '0000000001', coordinates: [[0, 0], [1, 0]] }),
    line({ id: 2, name: 'SPRING ST', b5sc: '128890', leftBfi: '0000000011', coordinates: [[0, -1], [0, 0]] }),
    line({ id: 3, name: 'BROOME ST', b5sc: '113900', leftBfi: '0000000012', coordinates: [[1, 0], [1, 1]] }),
  ],
  nodes: [node('A', [0, 0]), node('B', [1, 0]), node('C', [0, -1]), node('D', [1, 1])],
  streetNames: [],
  sourceManifestDigest: 'd'.repeat(64),
  sourceRelease: 'cscl-release',
});

const target = result => result.records.find(record => record.bfi === '0000000001');

describe('BFI-centered topology construction', () => {
  it('derives one complete on/from/to context from official incident streets', () => {
    const { buildTopology } = require('./lib/topology');
    const result = buildTopology(base());

    expect(target(result)).toMatchObject({
      bfi: '0000000001',
      borough: 'Manhattan',
      csclSide: 'LEFT',
      onStreet: 'BROADWAY',
      onStreetB5sc: '113260',
      supportingSegments: ['1'],
      fromNode: 'A',
      fromStreetCandidates: [{ b5sc: '128890', displayName: 'SPRING ST' }],
      toNode: 'B',
      toStreetCandidates: [{ b5sc: '113900', displayName: 'BROOME ST' }],
      topologyState: 'complete',
      endpointMethod: 'geometry_node_fallback',
      provenance: { sourceManifestDigest: 'd'.repeat(64), sourceRelease: 'cscl-release' },
    });
    expect(result.counts.geometryFallback).toBeGreaterThan(0);
  });

  it('prefers explicit segment-node relations over geometry reconstruction', () => {
    const { buildTopology } = require('./lib/topology');
    const input = base();
    input.segmentNodeRelations = [
      { physicalId: '1', fromNodeId: 'A', toNodeId: 'B' },
      { physicalId: '2', fromNodeId: 'C', toNodeId: 'A' },
      { physicalId: '3', fromNodeId: 'B', toNodeId: 'D' },
    ];
    expect(target(buildTopology(input)).endpointMethod).toBe('explicit_relation');
  });

  it('groups adjacent records with one BFI into one directed block chain', () => {
    const { buildTopology } = require('./lib/topology');
    const input = base();
    input.centerlines.splice(0, 1,
      line({ id: 1, name: 'BROADWAY', b5sc: '113260', leftBfi: '0000000001', coordinates: [[0, 0], [0.5, 0]] }),
      line({ id: 4, name: 'BROADWAY', b5sc: '113260', leftBfi: '0000000001', coordinates: [[0.5, 0], [1, 0]] }),
    );
    input.nodes.push(node('MID', [0.5, 0]));

    expect(target(buildTopology(input))).toMatchObject({
      supportingSegments: ['1', '4'],
      fromNode: 'A',
      toNode: 'B',
      topologyState: 'complete',
    });
  });

  it('preserves official side and swaps endpoint direction for consistently reversed geometry', () => {
    const { buildTopology } = require('./lib/topology');
    const input = base();
    input.centerlines[0].geometry.coordinates[0].reverse();

    expect(target(buildTopology(input))).toMatchObject({
      csclSide: 'LEFT',
      fromNode: 'B',
      toNode: 'A',
      fromStreetCandidates: [{ b5sc: '113900', displayName: 'BROOME ST' }],
      toStreetCandidates: [{ b5sc: '128890', displayName: 'SPRING ST' }],
      topologyState: 'complete',
    });
  });

  it('keeps long sparse-vertex centerlines topology-complete', () => {
    const { buildTopology } = require('./lib/topology');
    const input = base();
    input.centerlines[0].geometry.coordinates = [[[0, 0], [100, 0]]];
    input.centerlines[2].geometry.coordinates = [[[100, 0], [100, 1]]];
    input.nodes[1].geometry.coordinates = [100, 0];
    input.nodes[3].geometry.coordinates = [100, 1];
    expect(target(buildTopology(input)).topologyState).toBe('complete');
  });

  it('marks multiple non-equivalent endpoint streets ambiguous without selecting one', () => {
    const { buildTopology } = require('./lib/topology');
    const input = base();
    input.centerlines.push(line({
      id: 9,
      name: 'SIXTH AVE',
      b5sc: '131210',
      leftBfi: '0000000099',
      coordinates: [[0, 0], [-1, 1]],
    }));
    input.nodes.push(node('E', [-1, 1]));
    const record = target(buildTopology(input));
    expect(record.topologyState).toBe('ambiguous');
    expect(record.fromStreet).toBeUndefined();
    expect(record.fromStreetCandidates).toHaveLength(2);
  });

  it('marks a missing endpoint or endpoint street incomplete', () => {
    const { buildTopology } = require('./lib/topology');
    const input = base();
    input.nodes = input.nodes.filter(item => item.nodeId !== 'B');
    expect(target(buildTopology(input)).topologyState).toBe('incomplete');
  });

  it.each([
    ['left/right conflict', input => { input.centerlines[0].rightBfi = '0000000001'; }],
    ['same BFI conflicting sides', input => { input.centerlines.push(line({ id: 8, name: 'BROADWAY', b5sc: '113260', rightBfi: '0000000001', coordinates: [[1, 0], [2, 0]] })); }],
    ['level conflict', input => { input.centerlines[0].toLevel = 14; }],
    ['roadbed conflict', input => {
      input.centerlines.splice(0, 1,
        line({ id: 1, name: 'BROADWAY', b5sc: '113260', leftBfi: '0000000001', roadbedEvidence: 'A', coordinates: [[0, 0], [0.5, 0]] }),
        line({ id: 4, name: 'BROADWAY', b5sc: '113260', leftBfi: '0000000001', roadbedEvidence: 'B', coordinates: [[0.5, 0], [1, 0]] }),
      );
      input.nodes.push(node('MID', [0.5, 0]));
    }],
  ])('fails closed for %s', (_name, mutate) => {
    const { buildTopology } = require('./lib/topology');
    const input = base();
    mutate(input);
    expect(target(buildTopology(input)).topologyState).toBe('conflict');
  });

  it('classifies a conflicting official side separately for citywide quality reporting', () => {
    const { buildTopology } = require('./lib/topology');
    const input = base();
    input.centerlines.push(line({
      id: 8, name: 'BROADWAY', b5sc: '113260', rightBfi: '0000000001', coordinates: [[1, 0], [2, 0]],
    }));

    expect(target(buildTopology(input)).conflictReasons).toContain('side');
  });

  it('marks divided-road contexts ambiguous when endpoint evidence differs materially', () => {
    const { buildTopology } = require('./lib/topology');
    const input = base();
    input.centerlines.push(line({
      id: 10,
      name: 'BROADWAY',
      b5sc: '113260',
      leftBfi: '0000000001',
      coordinates: [[0, 0.1], [1, 0.1]],
    }));
    input.nodes.push(node('A2', [0, 0.1]), node('B2', [1, 0.1]));
    expect(target(buildTopology(input)).topologyState).toBe('conflict');
  });
});
