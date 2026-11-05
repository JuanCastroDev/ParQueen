import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  encodeRelationshipIndex,
  loadPinnedRelationshipIndex,
  openRelationshipIndex,
  relationshipIndexPath,
} = require('./lionRelationshipIndex');
const { APPROVED_LION } = require('./successorReleasePolicy');
const { PINNED_ARTIFACT_SHA256 } = require('./runtimeSourceArtifact');
const { createCatalog, evaluateOfficialLionRelationship } = require('./officialLionPrimaryTopology');

const GEOMETRY = Object.freeze({
  type: 'MultiLineString',
  coordinates: [[[-73.869399076566, 40.841629393257], [-73.870996446086, 40.84311966193]]],
});

function pins(overrides = {}) {
  return {
    lionSha256: APPROVED_LION.sha256,
    lionByteLength: APPROVED_LION.byteLength,
    artifactSha256: PINNED_ARTIFACT_SHA256,
    ...overrides,
  };
}

function segment(physicalId, segmentId, street, streetCode, nodeIdFrom, nodeIdTo, left, right) {
  return {
    physicalId, segmentId, street, streetCode, nodeIdFrom, nodeIdTo,
    leftBlockFaceId: left, rightBlockFaceId: right, geometry: GEOMETRY,
  };
}

function source() {
  return {
    segments: [
      segment('98053', '0085847', 'MELVILLE STREET', '250420', '0052416', '0048539', '1522611401', '1522607000'),
      segment('40573', '0085848', 'VAN NEST AVENUE', '271120', '0052416', '0052431', '1522611960', '1522602777'),
      segment('40574', '0085843', 'VAN NEST AVENUE', '271120', '0052413', '0052416', '1522604786', '1522602779'),
      segment('56255', '0079542', 'MORRIS PARK AVENUE', '252220', '0048536', '0048539', '1522605705', '1522604784'),
      segment('56254', '0079547', 'MORRIS PARK AVENUE', '252220', '0048539', '0052429', '1522605705', '1522607001'),
    ],
    names: [
      { nodeId: '0052416', name: ' VAN NEST AVE' },
      { nodeId: '0052416', name: ' MELVILLE ST' },
      { nodeId: '0048539', name: ' MORRIS PARK AVE' },
      { nodeId: '0048539', name: ' MELVILLE ST' },
    ],
  };
}

const configuredArchive = process.env.CURB_LION_PRIMARY_ARCHIVE || '';
const configuredIndex = configuredArchive ? relationshipIndexPath(configuredArchive) : '';
const privatePinnedIndex = configuredArchive
  && configuredIndex
  && existsSync(configuredArchive)
  && existsSync(configuredIndex)
  ? configuredIndex
  : '';

function record() {
  return {
    sourceVersion: { resourceId: 'inkn-q76z', version: '1793494484:1744725948' },
    geometry: GEOMETRY,
    leftBlockFaceId: '1522611401',
    rightBlockFaceId: '1522607000',
    sourceNative: { physicalid: '98053', b5sc: '250420' },
  };
}

describe('LION relationship index', () => {
  it('preserves a unique relationship and keeps duplicate physical ids closed', () => {
    const bytes = encodeRelationshipIndex({ ...source(), ...pins() });
    const index = openRelationshipIndex(bytes);
    expect(index).not.toBeNull();
    expect(index.ambiguousPhysicalCount).toBe(0);
    expect(index.packetFor('not-an-id')).toBeNull();
    expect(index.packetFor('999999')).toBeNull();
    const packet = index.packetFor('0098053');
    expect(packet.segments.map(item => item.physicalId)).toEqual(['98053', '40573', '40574', '56255', '56254']);
    expect(evaluateOfficialLionRelationship(record(), packet)).toMatchObject({
      ok: true,
      onStreet: 'MELVILLE STREET',
      fromStreet: 'VAN NEST AVENUE',
      toStreet: 'MORRIS PARK AVENUE',
      segmentId: '0085847',
    });

    const duplicated = encodeRelationshipIndex({
      ...pins(),
      names: [],
      segments: [
        segment('1', '10', 'A STREET', '100', '10', '11', '1000000001', '1000000002'),
        segment('1', '11', 'A STREET', '100', '10', '12', '1000000003', '1000000004'),
        segment('2', '20', 'B STREET', '200', '10', '30', '1000000005', '1000000006'),
      ],
    });
    const duplicates = openRelationshipIndex(duplicated);
    expect(duplicates.packetFor('0000001')).toBeNull();
    expect(duplicates.packetFor('2').segments.map(item => item.segmentId)).toEqual(['10', '11', '20']);
  });

  it('rejects a changed digest, a corrupt byte, and the wrong schema', () => {
    const bytes = encodeRelationshipIndex({ ...source(), ...pins() });
    const wrongLion = Buffer.from(bytes);
    wrongLion[16] ^= 0xff;
    expect(openRelationshipIndex(wrongLion)).toBeNull();
    const corrupt = Buffer.from(bytes);
    corrupt[corrupt.length - 1] ^= 0xff;
    expect(openRelationshipIndex(corrupt)).toBeNull();
    const wrongSchema = Buffer.from(bytes);
    wrongSchema[8] = 2;
    expect(openRelationshipIndex(wrongSchema)).toBeNull();
    const mismatched = encodeRelationshipIndex({
      ...source(),
      ...pins({ lionSha256: 'ab'.repeat(32) }),
    });
    expect(openRelationshipIndex(mismatched)).toBeNull();
    expect(openRelationshipIndex(mismatched, pins({ lionSha256: 'ab'.repeat(32) }))).not.toBeNull();
  });

  it('does not scan FileGDB when the validated index can answer', async () => {
    const index = openRelationshipIndex(encodeRelationshipIndex({ ...source(), ...pins() }));
    let calls = 0;
    const wrapped = {
      packetFor(physicalId) {
        calls += 1;
        return index.packetFor(physicalId);
      },
    };
    const session = { async query() { throw new Error('filegdb scan'); } };
    const catalog = createCatalog('unused', session, wrapped);
    expect(await catalog.packetFor('40573')).toBeTruthy();
    expect(await catalog.packetFor('0040573')).toBeTruthy();
    expect(await catalog.packetFor('999999')).toBeNull();
    expect(calls).toBe(2);
  });

  it('refuses an index file whose digest is not the pinned offline index', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lion-index-'));
    const file = join(directory, 'index.bin');
    writeFileSync(file, encodeRelationshipIndex({ ...source(), ...pins() }));
    expect(loadPinnedRelationshipIndex(file)).toBeNull();
    expect(loadPinnedRelationshipIndex('')).toBeNull();
  });

  it.skipIf(!privatePinnedIndex)('loads the configured pinned 26B index once and resolves an unseen physical id', () => {
    const file = privatePinnedIndex;
    const started = performance.now();
    const index = loadPinnedRelationshipIndex(file);
    const loadMs = performance.now() - started;
    expect(index?.lionSha256).toBe(APPROVED_LION.sha256);
    expect(index?.artifactSha256).toBe(PINNED_ARTIFACT_SHA256);
    expect(loadMs).toBeLessThan(3000);
    const packet = index.packetFor('98053');
    expect(evaluateOfficialLionRelationship(record(), packet)).toMatchObject({
      ok: true,
      onStreet: 'MELVILLE STREET',
      fromStreet: 'VAN NEST AVENUE',
      toStreet: 'MORRIS PARK AVENUE',
      segmentId: '0085847',
    });
    const lookupStarted = performance.now();
    expect(index.packetFor('999999999')).toBeNull();
    expect(index.packetFor('98053')?.segments.length).toBe(packet.segments.length);
    expect(performance.now() - lookupStarted).toBeLessThan(20);
  });
});
