import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const source = (role, overrides = {}) => ({
  role,
  name: role,
  officialUrl: `https://official.example/${role}`,
  resourceId: `resource-${role}`,
  releaseId: role.startsWith('cscl_') ? 'cscl-2026-09-27' : 'pavement-1714164498',
  schemaVersion: {
    cscl_centerline: 'cscl-pub-centerline-v1',
    cscl_node: 'cscl-pub-node-v1',
    cscl_street_name: 'cscl-pub-street-name-v1',
    pavement_edge: 'pavement-edge-v1',
  }[role],
  byteSize: 10,
  rowCount: 2,
  sha256: 'a'.repeat(64),
  requiredFields: ['id'],
  ...overrides,
});

const manifest = (overrides = {}) => ({
  manifestSchemaVersion: 1,
  normalizationVersion: 'curb-topology-v1',
  acquisition: { timestamp: '2026-09-27T12:00:00.000Z' },
  sources: [
    source('cscl_centerline'),
    source('cscl_node'),
    source('cscl_street_name'),
    source('pavement_edge'),
  ],
  ...overrides,
});

const inventory = value => Object.fromEntries(value.sources.map(item => [item.role, {
  byteSize: item.byteSize,
  rowCount: item.rowCount,
  sha256: item.sha256,
  fields: item.requiredFields,
}]));

describe('snapshot manifest', () => {
  it('serializes nested values with stable key ordering', () => {
    const { canonicalJson, sha256 } = require('./lib/canonicalJson');
    const one = canonicalJson({ z: 1, a: { y: 2, x: 3 } });
    const two = canonicalJson({ a: { x: 3, y: 2 }, z: 1 });

    expect(one).toBe('{"a":{"x":3,"y":2},"z":1}');
    expect(two).toBe(one);
    expect(sha256(one)).toMatch(/^[a-f0-9]{64}$/);
  });

  it('separates acquisition timestamp from deterministic snapshot identity', () => {
    const { manifestIdentity } = require('./lib/manifest');
    const first = manifest();
    const second = manifest({ acquisition: { timestamp: '2026-09-28T01:02:03.000Z' } });

    expect(manifestIdentity(first)).toBe(manifestIdentity(second));
  });

  it('accepts a complete, single-release inventory', () => {
    const { validateSnapshotManifest } = require('./lib/manifest');
    const value = manifest();

    expect(validateSnapshotManifest(value, inventory(value))).toEqual({
      ok: true,
      manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      sourceRelease: {
        cscl: 'cscl-2026-09-27',
        pavementEdge: 'pavement-1714164498',
      },
    });
  });

  it.each([
    ['missing required source', value => ({ ...value, sources: value.sources.slice(1) })],
    ['duplicate role', value => ({ ...value, sources: [...value.sources, value.sources[0]] })],
    ['missing digest', value => ({ ...value, sources: value.sources.map((item, index) => index ? item : { ...item, sha256: '' }) })],
    ['unknown release', value => ({ ...value, sources: value.sources.map((item, index) => index ? item : { ...item, releaseId: '' }) })],
    ['unsupported schema', value => ({ ...value, sources: value.sources.map((item, index) => index ? item : { ...item, schemaVersion: 'future-v9' }) })],
    ['mixed CSCL releases', value => ({ ...value, sources: value.sources.map(item => item.role === 'cscl_node' ? { ...item, releaseId: 'other' } : item) })],
  ])('rejects %s before building', (_name, mutate) => {
    const { validateSnapshotManifest } = require('./lib/manifest');
    const value = mutate(manifest());
    expect(() => validateSnapshotManifest(value, inventory(value))).toThrow();
  });

  it.each([
    ['digest mismatch', inv => ({ ...inv, cscl_centerline: { ...inv.cscl_centerline, sha256: 'b'.repeat(64) } })],
    ['missing field', inv => ({ ...inv, cscl_centerline: { ...inv.cscl_centerline, fields: [] } })],
    ['short row count', inv => ({ ...inv, cscl_centerline: { ...inv.cscl_centerline, rowCount: 1 } })],
    ['byte mismatch', inv => ({ ...inv, cscl_centerline: { ...inv.cscl_centerline, byteSize: 9 } })],
  ])('rejects inventory %s', (_name, mutate) => {
    const { validateSnapshotManifest } = require('./lib/manifest');
    const value = manifest();
    expect(() => validateSnapshotManifest(value, mutate(inventory(value)))).toThrow();
  });
});
