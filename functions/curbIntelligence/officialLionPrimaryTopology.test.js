import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const {
  createCatalog,
  evaluateOfficialLionRelationship,
  extractVerifiedBytes,
  loadOfficialLionPrimary,
  openApprovedLionArchive,
  readOfficialLionPrimary,
  verifiedExtraction,
} = require('./officialLionPrimaryTopology');
const { nyLongIslandUsFtToWgs84 } = require('./lionStatePlane');
const { resolveCanonicalCurb, hasPrimaryTopologyAuthority } = require('./canonicalCurbResolver');
const { proveCanonicalCurbIdentity } = require('./canonicalCurbIdentityProof');
const { createPrivateBlockfaceResolver } = require('./privateBlockfaceResolver');

const ARCHIVE = process.env.CURB_LION_PRIMARY_ARCHIVE ?? '';
const GDAL = process.env.CURB_LION_GDAL_MODULE ?? '';
const liveLion = ARCHIVE !== '' && GDAL !== '' && existsSync(ARCHIVE) && existsSync(GDAL);
const SERVICE_URL = 'https://local-demo-disabled.run.app';
const GEOMETRY = Object.freeze({
  type: 'MultiLineString',
  coordinates: [[[-73.869399076566, 40.841629393257], [-73.870996446086, 40.84311966193]]],
});

function record(overrides = {}) {
  return {
    sourceVersion: { resourceId: 'inkn-q76z', version: '1793494484:1744725948' },
    geometry: GEOMETRY,
    leftBlockFaceId: '1522611401',
    rightBlockFaceId: '1522607000',
    sourceNative: {
      physicalid: '98053', b5sc: '250420', boroughcode: '2', streetwidth: '24',
    },
    ...overrides,
  };
}

function packet() {
  return {
    segments: [
      segment('98053', '0085847', 'MELVILLE STREET', '250420', '0052416', '0048539', '1522611401', '1522607000'),
      segment('40573', '0085848', 'VAN NEST AVENUE', '271120', '0052416', '0052431', '1522611960', '1522602777'),
      segment('40574', '0085843', 'VAN NEST AVENUE', '271120', '0052413', '0052416', '1522604786', '1522602779'),
      segment('56255', '0079542', 'MORRIS PARK AVENUE', '252220', '0048536', '0048539', '1522605705', '1522604784'),
      segment('56254', '0079547', 'MORRIS PARK AVENUE', '252220', '0048539', '0052429', '1522605705', '1522607001'),
    ],
    nodeNames: [
      { nodeId: '0052416', name: ' VAN NEST AVE' },
      { nodeId: '0052416', name: ' MELVILLE ST' },
      { nodeId: '0048539', name: ' MORRIS PARK AVE' },
      { nodeId: '0048539', name: ' MELVILLE ST' },
    ],
  };
}

function segment(physicalId, segmentId, street, streetCode, nodeIdFrom, nodeIdTo, left, right) {
  return {
    physicalId, segmentId, street, streetCode, nodeIdFrom, nodeIdTo,
    leftBlockFaceId: left, rightBlockFaceId: right, geometry: GEOMETRY,
  };
}

function offset(meters) {
  const line = GEOMETRY.coordinates[0];
  const mid = [(line[0][0] + line[1][0]) / 2, (line[0][1] + line[1][1]) / 2];
  const dx = line[1][0] - line[0][0];
  const dy = line[1][1] - line[0][1];
  const length = Math.hypot(dx, dy);
  const ux = -dy / length;
  const uy = dx / length;
  const dLat = meters / 111320;
  const dLng = meters / (111320 * Math.cos(mid[1] * Math.PI / 180));
  return {
    left: { lat: mid[1] + uy * dLat, lng: mid[0] + ux * dLng },
    right: { lat: mid[1] - uy * dLat, lng: mid[0] - ux * dLng },
  };
}

describe('official LION primary topology', () => {
  it('projects the official state-plane vertex onto the live CSCL endpoint', () => {
    const projected = nyLongIslandUsFtToWgs84(1020386.5408263057, 245929.5857990086);
    const target = [-73.869399076566, 40.841629393257];
    const dLat = (projected[1] - target[1]) * 111320;
    const dLng = (projected[0] - target[0]) * 111320 * Math.cos(target[1] * Math.PI / 180);
    expect(Math.hypot(dLat, dLng)).toBeLessThan(1.2);
  });

  it('admits one unambiguous relationship and rejects caller-built authority', () => {
    expect(evaluateOfficialLionRelationship(record(), packet())).toMatchObject({
      ok: true,
      onStreet: 'MELVILLE STREET',
      fromStreet: 'VAN NEST AVENUE',
      toStreet: 'MORRIS PARK AVENUE',
      segmentId: '0085847',
      certificationStatus: 'NOT_CERTIFIED',
      productionAuthoritative: false,
    });
    expect(readOfficialLionPrimary({
      ok: true,
      relationshipsFor: async () => new Map(),
    })).toBeNull();
  });

  it('rejects an archive whose bytes are not the approved LION 26B package', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'lion-mismatch-'));
    const file = join(directory, 'not-lion.zip');
    writeFileSync(file, 'not the official archive');
    expect(await openApprovedLionArchive(file)).toBeNull();
  });

  it('rejects node ambiguity, reversed geometry, missing or conflicting faces, and a foreign CSCL resource', () => {
    const ambiguous = packet();
    ambiguous.segments.push(segment(
      '1', '1', 'BRONXDALE AVENUE', '999999', '0052416', '0000001', '1111111111', '2222222222',
    ));
    ambiguous.nodeNames.push({ nodeId: '0052416', name: ' BRONXDALE AVE' });
    expect(evaluateOfficialLionRelationship(record(), ambiguous).reason).toBe('lion_node_ambiguous');

    const reversed = record({
      geometry: {
        type: 'MultiLineString',
        coordinates: [[GEOMETRY.coordinates[0][1], GEOMETRY.coordinates[0][0]]],
      },
    });
    expect(evaluateOfficialLionRelationship(reversed, packet()).reason).toBe('lion_direction_mismatch');

    expect(evaluateOfficialLionRelationship(record({
      leftBlockFaceId: null,
    }), packet()).reason).toBe('lion_bfi_missing');
    expect(evaluateOfficialLionRelationship(record({
      leftBlockFaceId: '1522611402',
    }), packet()).reason).toBe('lion_bfi_conflict');
    expect(evaluateOfficialLionRelationship(record({
      sourceVersion: { resourceId: 'other', version: '1' },
    }), packet()).reason).toBe('lion_cscl_incompatible');
  });

  it('keeps the local loader disabled unless the emulator and local switch are both set', async () => {
    expect(await loadOfficialLionPrimary({
      FUNCTIONS_EMULATOR: 'true',
      CURB_OFFICIAL_LION_PRIMARY: 'off',
      CURB_LION_PRIMARY_ARCHIVE: 'unused.zip',
    })).toBeNull();
    expect(await loadOfficialLionPrimary({
      CURB_OFFICIAL_LION_PRIMARY: 'local',
      CURB_LION_PRIMARY_ARCHIVE: 'unused.zip',
    })).toBeNull();
    expect(await loadOfficialLionPrimary({
      FUNCTIONS_EMULATOR: 'true',
      CURB_OFFICIAL_LION_PRIMARY: 'local',
      GCLOUD_PROJECT: 'parkqueen-46475363-ccf36',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
      FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
      K_REVISION: '1',
      CURB_LION_PRIMARY_ARCHIVE: 'unused.zip',
    })).toBeNull();
  });

  it('requires one official segment before querying incidents', async () => {
    const queries = [];
    const feature = (segmentId, nodeIdFrom, nodeIdTo) => ({
      attributes: {
        SegmentID: segmentId,
        PhysicalID: '98053',
        Street: 'MELVILLE STREET',
        StreetCode: '250420',
        NodeIDFrom: nodeIdFrom,
        NodeIDTo: nodeIdTo,
        LBlockFaceID: '1522611401',
        RBlockFaceID: '1522607000',
      },
      geometry: null,
    });
    const session = {
      async query(_directory, name, sql) {
        queries.push({ name, sql });
        if (name.startsWith('subject-')) return [feature('0085847', '0052416', '0048539')];
        if (name.startsWith('incident-')) return [feature('0085847', '0052416', '0048539')];
        return [{ attributes: { NODEID: '0052416', STNAME: 'VAN NEST AVENUE' } }];
      },
    };
    const packet = await createCatalog('lion', session).packetFor('98053');
    expect(packet.segments).toHaveLength(1);
    expect(packet.segments[0]).toMatchObject({ physicalId: '98053', segmentId: '0085847' });
    expect(queries.map(query => query.name)).toEqual(['subject-98053', 'incident-98053', 'names-98053']);

    const duplicateQueries = [];
    const duplicates = {
      async query(_directory, name, sql) {
        duplicateQueries.push({ name, sql });
        return [
          feature('0085847', '0052416', '0048539'),
          feature('0099999', '0000002', '0000003'),
        ];
      },
    };
    const rejected = await createCatalog('lion', duplicates).packetFor('0098053');
    expect(rejected).toBeNull();
    expect(duplicateQueries).toHaveLength(1);
    expect(duplicateQueries[0].name).toBe('subject-98053');
    expect(duplicateQueries[0].sql).not.toContain('0000002');
  });

  it('binds GDAL input to the verified archive and rejects stale extraction', () => {
    const root = mkdtempSync(join(tmpdir(), 'lion-verified-'));
    const source = join(root, 'lion', 'lion.gdb');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'a00000001.gdbtable'), 'verified-gdb');
    const archive = join(root, 'archive.zip');
    const packed = spawnSync('tar', ['-a', '-cf', archive, '-C', root, 'lion'], { windowsHide: true });
    expect(packed.status).toBe(0);
    const bytes = readFileSync(archive);
    const digest = createHash('sha256').update(bytes).digest('hex');
    const stale = join(tmpdir(), `parqueen-lion-${digest.slice(0, 16)}`, 'lion', 'lion.gdb');
    mkdirSync(stale, { recursive: true });
    writeFileSync(join(stale, 'a00000001.gdbtable'), 'stale-gdb');

    const extracted = extractVerifiedBytes(bytes, digest);
    expect(extracted?.directory.startsWith(stale)).toBe(false);
    expect(readFileSync(join(extracted.directory, 'lion.gdb', 'a00000001.gdbtable'), 'utf8')).toBe('verified-gdb');
    writeFileSync(join(extracted.directory, 'lion.gdb', 'a00000001.gdbtable'), 'altered-gdb');
    expect(verifiedExtraction(extracted.directory, extracted.treeSha256)).toBe(false);

    const incompleteRoot = mkdtempSync(join(tmpdir(), 'lion-incomplete-'));
    mkdirSync(join(incompleteRoot, 'lion'), { recursive: true });
    writeFileSync(join(incompleteRoot, 'lion', 'readme.txt'), 'missing gdb');
    const incompleteArchive = join(incompleteRoot, 'archive.zip');
    const incompletePacked = spawnSync('tar', ['-a', '-cf', incompleteArchive, '-C', incompleteRoot, 'lion'], {
      windowsHide: true,
    });
    expect(incompletePacked.status).toBe(0);
    const incomplete = readFileSync(incompleteArchive);
    expect(extractVerifiedBytes(incomplete, createHash('sha256').update(incomplete).digest('hex'))).toBeNull();
    expect(extractVerifiedBytes(bytes, '0'.repeat(64))).toBeNull();
    rmSync(root, { recursive: true, force: true });
    rmSync(incompleteRoot, { recursive: true, force: true });
    rmSync(join(tmpdir(), `parqueen-lion-${digest.slice(0, 16)}`), { recursive: true, force: true });
  });

  it.skipIf(!liveLion)('resolves both Melville curbs from the approved archive and live CSCL, then fails closed without Function 3C', async () => {
    process.env.CURB_LION_GDAL_MODULE = GDAL;
    const admitted = await openApprovedLionArchive(ARCHIVE);
    expect(readOfficialLionPrimary(admitted)?.ok).toBe(true);
    const sides = offset(5);
    const location = point => ({
      ...point, accuracyMeters: 1, sampleCount: 3, consistencyMeters: 1,
    });
    const left = await resolveCanonicalCurb(location(sides.left), {
      fetchFn: globalThis.fetch,
      getSocrataToken: () => '',
      officialLionPrimary: admitted,
    });
    const right = await resolveCanonicalCurb(location(sides.right), {
      fetchFn: globalThis.fetch,
      getSocrataToken: () => '',
      officialLionPrimary: admitted,
    });
    expect(left).toMatchObject({
      state: 'SUPPORTED',
      identity: {
        names: {
          onStreet: 'MELVILLE STREET',
          fromStreet: 'VAN NEST AVENUE',
          toStreet: 'MORRIS PARK AVENUE',
        },
      },
    });
    expect(right.state).toBe('SUPPORTED');
    expect(hasPrimaryTopologyAuthority(left)).toBe(true);
    expect(hasPrimaryTopologyAuthority(right)).toBe(true);
    expect(new Set([
      left.identity.officialBlockFaceId,
      right.identity.officialBlockFaceId,
    ])).toEqual(new Set(['1522611401', '1522607000']));

    const unavailable = createPrivateBlockfaceResolver({ mode: 'shadow', serviceUrl: '' });
    const unproven = await proveCanonicalCurbIdentity(left, { blockfaceResolver: unavailable });
    expect(unproven).toEqual({ state: 'IDENTITY_NOT_PROVEN', reason: 'function3c_unavailable' });

    const mismatched = createPrivateBlockfaceResolver({
      mode: 'shadow',
      serviceUrl: SERVICE_URL,
      getIdToken: async () => 'token',
      transport: vi.fn(async () => ({
        status: 200,
        text: async () => JSON.stringify({
          ok: true,
          officialBlockFaceId: left.identity.officialBlockFaceId === '1522611401'
            ? '1522607000' : '1522611401',
          normalizedStreetNames: {
            onStreet: 'MELVILLE STREET',
            crossStreetOne: 'VAN NEST AVENUE',
            crossStreetTwo: 'MORRIS PARK AVENUE',
          },
          returnCode: '00',
          reasonCode: ' ',
          sourceVersion: { geosupportRelease: '26C', geosupportVersion: '26.3' },
        }),
      })),
    });
    const mismatch = await proveCanonicalCurbIdentity(left, { blockfaceResolver: mismatched });
    expect(mismatch).toEqual({ state: 'IDENTITY_NOT_PROVEN', reason: 'function3c_bfi_mismatch' });
  }, 90000);
});
