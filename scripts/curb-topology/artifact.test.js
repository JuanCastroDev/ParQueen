import { afterEach, describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const tempDirectories = [];
const temp = () => {
  const result = fs.mkdtempSync(path.join(os.tmpdir(), 'curb-topology-artifact-'));
  tempDirectories.push(result);
  return result;
};

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const record = bfi => ({
  topologySchemaVersion: 1,
  sourceManifestDigest: 'd'.repeat(64),
  sourceRelease: 'cscl-release',
  bfi,
  borough: 'Manhattan',
  csclSide: 'LEFT',
  onStreet: `STREET ${bfi}`,
  onStreetB5sc: '113260',
  supportingSegments: [bfi],
  fromNode: `A${bfi}`,
  fromStreetCandidates: [{ b5sc: '100010', displayName: 'FIRST ST' }],
  toNode: `B${bfi}`,
  toStreetCandidates: [{ b5sc: '100020', displayName: 'SECOND ST' }],
  topologyState: 'complete',
  provenance: { sourceManifestDigest: 'd'.repeat(64), sourceRelease: 'cscl-release' },
});

const records = count => Array.from({ length: count }, (_, index) => record(String(index + 1).padStart(10, '0')));

describe('deterministic topology artifact', () => {
  it('emits a versioned index and bounded, digested shards with stable names', () => {
    const { buildArtifact } = require('./lib/artifact');
    const artifact = buildArtifact(records(12), {
      strategy: 'hash-prefix',
      prefixLength: 1,
      maxRecordsPerShard: 3,
      sourceManifestDigest: 'd'.repeat(64),
      sourceRelease: 'cscl-release',
    });

    expect(artifact.index).toMatchObject({
      topologySchemaVersion: 1,
      sourceManifestDigest: 'd'.repeat(64),
      sourceRelease: 'cscl-release',
      recordCount: 12,
      sharding: { strategy: 'hash-prefix', prefixLength: 1, maxRecordsPerShard: 3 },
    });
    expect(artifact.index.shards.every(shard => shard.recordCount <= 3)).toBe(true);
    expect(artifact.index.shards.every(shard => /^shard-[a-f0-9]+-\d{3}\.json$/.test(shard.file))).toBe(true);
    expect(artifact.index.shards.every(shard => /^[a-f0-9]{64}$/.test(shard.sha256))).toBe(true);
  });

  it('produces byte-identical index and shard files from identical inputs in any record order', () => {
    const { buildArtifact } = require('./lib/artifact');
    const input = records(25);
    const options = {
      strategy: 'hash-prefix', prefixLength: 1, maxRecordsPerShard: 4,
      sourceManifestDigest: 'd'.repeat(64), sourceRelease: 'cscl-release',
    };
    const first = buildArtifact(input, options);
    const second = buildArtifact([...input].reverse(), options);

    expect([...first.files.keys()]).toEqual([...second.files.keys()]);
    for (const [name, bytes] of first.files) expect(second.files.get(name).equals(bytes)).toBe(true);
  });

  it('compares prefix and hash-prefix distribution without changing records', () => {
    const { compareShardingStrategies } = require('./lib/artifact');
    const comparison = compareShardingStrategies(records(100), { prefixLength: 2, maxRecordsPerShard: 100 });

    expect(comparison.prefix.recordCount).toBe(100);
    expect(comparison.hashPrefix.recordCount).toBe(100);
    expect(comparison.hashPrefix.shardCount).toBeGreaterThan(comparison.prefix.shardCount);
    expect(comparison.recommendation).toBe('hash-prefix');
  });

  it('writes deterministic files and performs digest-verified cold and warm exact lookup', () => {
    const { buildArtifact, createArtifactLookup, writeArtifact } = require('./lib/artifact');
    const directory = temp();
    const artifact = buildArtifact(records(20), {
      strategy: 'hash-prefix', prefixLength: 1, maxRecordsPerShard: 2,
      sourceManifestDigest: 'd'.repeat(64), sourceRelease: 'cscl-release',
    });
    writeArtifact(directory, artifact);
    const lookup = createArtifactLookup(path.join(directory, 'index.json'));

    expect(lookup.lookupBfi('0000000010')).toMatchObject({ bfi: '0000000010', topologyState: 'complete' });
    const readsAfterCold = lookup.metrics().diskReads;
    expect(lookup.lookupBfi('0000000010')).toMatchObject({ bfi: '0000000010' });
    expect(lookup.metrics()).toMatchObject({ diskReads: readsAfterCold, coldLookups: 1, warmLookups: 1 });
    expect(lookup.lookupBfi('9999999999')).toBeNull();
  });

  it('rejects a missing or digest-corrupted shard instead of returning evidence', () => {
    const { buildArtifact, createArtifactLookup, writeArtifact } = require('./lib/artifact');
    const directory = temp();
    const artifact = buildArtifact(records(1), {
      strategy: 'hash-prefix', prefixLength: 1, maxRecordsPerShard: 2,
      sourceManifestDigest: 'd'.repeat(64), sourceRelease: 'cscl-release',
    });
    writeArtifact(directory, artifact);
    const shardPath = path.join(directory, artifact.index.shards[0].file);
    fs.writeFileSync(shardPath, '{}');
    const lookup = createArtifactLookup(path.join(directory, 'index.json'));
    expect(() => lookup.lookupBfi('0000000001')).toThrow(/digest/);

    fs.rmSync(shardPath);
    const missing = createArtifactLookup(path.join(directory, 'index.json'));
    expect(() => missing.lookupBfi('0000000001')).toThrow(/missing shard/);
  });

  it('rejects unsupported topology schema before lookup', () => {
    const { createArtifactLookup } = require('./lib/artifact');
    const directory = temp();
    fs.writeFileSync(path.join(directory, 'index.json'), '{"topologySchemaVersion":9}');
    expect(() => createArtifactLookup(path.join(directory, 'index.json'))).toThrow(/schema/);
  });
});
