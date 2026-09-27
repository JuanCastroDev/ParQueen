'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { canonicalJson, sha256 } = require('./canonicalJson');
const { normalizeBfi } = require('./bfi');

const partitionFor = (bfi, strategy, prefixLength) => {
  if (strategy === 'prefix') return bfi.slice(0, prefixLength);
  if (strategy === 'hash-prefix') return sha256(bfi).slice(0, prefixLength);
  throw new TypeError(`unsupported sharding strategy: ${strategy}`);
};

const shardBytes = (records, options) => Buffer.from(`${canonicalJson({
  topologySchemaVersion: 1,
  sourceManifestDigest: options.sourceManifestDigest,
  sourceRelease: options.sourceRelease,
  records,
})}\n`);

const chunkPartition = (records, options) => {
  const chunks = [];
  let current = [];
  const emptyShardBytes = shardBytes([], options).length;
  let currentBytes = emptyShardBytes;
  for (const record of records) {
    const recordBytes = Buffer.byteLength(canonicalJson(record));
    const separatorBytes = current.length === 0 ? 0 : 1;
    const candidateBytes = currentBytes + separatorBytes + recordBytes;
    const exceedsCount = current.length + 1 > options.maxRecordsPerShard;
    const exceedsBytes = options.maxShardBytes && candidateBytes > options.maxShardBytes;
    if ((exceedsCount || exceedsBytes) && current.length > 0) {
      chunks.push(current);
      current = [record];
      currentBytes = emptyShardBytes + recordBytes;
    } else {
      current.push(record);
      currentBytes = candidateBytes;
    }
    if (options.maxShardBytes && currentBytes > options.maxShardBytes) {
      throw new TypeError(`single topology record exceeds maxShardBytes: ${record.bfi}`);
    }
  }
  if (current.length) chunks.push(current);
  return chunks;
};

const buildArtifact = (records, inputOptions = {}) => {
  const options = {
    strategy: inputOptions.strategy || 'hash-prefix',
    prefixLength: inputOptions.prefixLength || 2,
    maxRecordsPerShard: inputOptions.maxRecordsPerShard || 1000,
    maxShardBytes: inputOptions.maxShardBytes || null,
    sourceManifestDigest: inputOptions.sourceManifestDigest,
    sourceRelease: inputOptions.sourceRelease,
  };
  if (!/^[a-f0-9]{64}$/.test(options.sourceManifestDigest || '')) throw new TypeError('source manifest digest required');
  if (typeof options.sourceRelease !== 'string' || !options.sourceRelease) throw new TypeError('source release required');
  if (!Number.isInteger(options.prefixLength) || options.prefixLength < 1 || options.prefixLength > 8) {
    throw new TypeError('prefixLength out of range');
  }
  if (!Number.isInteger(options.maxRecordsPerShard) || options.maxRecordsPerShard < 1) {
    throw new TypeError('maxRecordsPerShard out of range');
  }

  const sorted = [...records].sort((a, b) => a.bfi.localeCompare(b.bfi));
  if (new Set(sorted.map(record => record.bfi)).size !== sorted.length) throw new TypeError('duplicate BFI record');
  if (sorted.some(record => record.topologySchemaVersion !== 1)) throw new TypeError('unsupported topology record schema');
  const partitions = new Map();
  for (const record of sorted) {
    const partition = partitionFor(record.bfi, options.strategy, options.prefixLength);
    if (!partitions.has(partition)) partitions.set(partition, []);
    partitions.get(partition).push(record);
  }

  const files = new Map();
  const shards = [];
  for (const partition of [...partitions.keys()].sort()) {
    const chunks = chunkPartition(partitions.get(partition), options);
    chunks.forEach((chunk, index) => {
      const file = `shard-${partition}-${String(index).padStart(3, '0')}.json`;
      const bytes = shardBytes(chunk, options);
      files.set(file, bytes);
      shards.push({
        file,
        partition,
        recordCount: chunk.length,
        byteSize: bytes.length,
        sha256: sha256(bytes),
        minBfi: chunk[0].bfi,
        maxBfi: chunk[chunk.length - 1].bfi,
      });
    });
  }

  const index = {
    topologySchemaVersion: 1,
    sourceManifestDigest: options.sourceManifestDigest,
    sourceRelease: options.sourceRelease,
    recordCount: sorted.length,
    sharding: {
      strategy: options.strategy,
      prefixLength: options.prefixLength,
      maxRecordsPerShard: options.maxRecordsPerShard,
      ...(options.maxShardBytes ? { maxShardBytes: options.maxShardBytes } : {}),
    },
    shards,
  };
  files.set('index.json', Buffer.from(`${canonicalJson(index)}\n`));
  return { index, files };
};

const distribution = artifact => {
  const counts = artifact.index.shards.map(shard => shard.recordCount).sort((a, b) => a - b);
  const percentile = fraction => counts.length ? counts[Math.ceil(fraction * counts.length) - 1] : 0;
  return {
    recordCount: artifact.index.recordCount,
    shardCount: counts.length,
    minShardRecords: counts[0] || 0,
    medianShardRecords: percentile(0.5),
    p95ShardRecords: percentile(0.95),
    maxShardRecords: counts[counts.length - 1] || 0,
  };
};

const compareShardingStrategies = (records, options = {}) => {
  const common = {
    prefixLength: options.prefixLength || 2,
    maxRecordsPerShard: options.maxRecordsPerShard || 1000,
    sourceManifestDigest: options.sourceManifestDigest || '0'.repeat(64),
    sourceRelease: options.sourceRelease || 'comparison',
  };
  const prefix = distribution(buildArtifact(records, { ...common, strategy: 'prefix' }));
  const hashPrefix = distribution(buildArtifact(records, { ...common, strategy: 'hash-prefix' }));
  return {
    prefix,
    hashPrefix,
    recommendation: hashPrefix.maxShardRecords < prefix.maxShardRecords ? 'hash-prefix' : 'prefix',
  };
};

const writeArtifact = (directory, artifact) => {
  fs.mkdirSync(directory, { recursive: true });
  for (const [name, bytes] of [...artifact.files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    fs.writeFileSync(path.join(directory, name), bytes);
  }
};

const createArtifactLookup = indexPath => {
  const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  if (index.topologySchemaVersion !== 1 || !index.sharding || !Array.isArray(index.shards)) {
    throw new TypeError('unsupported topology index schema');
  }
  const directory = path.dirname(indexPath);
  const cache = new Map();
  let diskReads = 0;
  let coldLookups = 0;
  let warmLookups = 0;
  const coldLatenciesMs = [];
  const warmLatenciesMs = [];

  const lookupBfi = rawBfi => {
    const started = performance.now();
    const bfi = normalizeBfi(rawBfi);
    const partition = partitionFor(bfi, index.sharding.strategy, index.sharding.prefixLength);
    const candidates = index.shards.filter(shard => shard.partition === partition
      && bfi >= shard.minBfi && bfi <= shard.maxBfi);
    const wasWarm = candidates.length > 0 && candidates.every(shard => cache.has(shard.file));
    let result = null;
    for (const shard of candidates) {
      if (!cache.has(shard.file)) {
        const shardPath = path.join(directory, shard.file);
        if (!fs.existsSync(shardPath)) throw new Error(`missing shard: ${shard.file}`);
        const bytes = fs.readFileSync(shardPath);
        if (sha256(bytes) !== shard.sha256) throw new Error(`shard digest mismatch: ${shard.file}`);
        const parsed = JSON.parse(bytes.toString('utf8'));
        if (parsed.topologySchemaVersion !== 1 || !Array.isArray(parsed.records)) {
          throw new Error(`unsupported shard schema: ${shard.file}`);
        }
        cache.set(shard.file, parsed.records);
        diskReads += 1;
      }
      result = cache.get(shard.file).find(record => record.bfi === bfi) || result;
    }
    const elapsed = performance.now() - started;
    if (wasWarm) {
      warmLookups += 1;
      warmLatenciesMs.push(elapsed);
    } else if (candidates.length > 0) {
      coldLookups += 1;
      coldLatenciesMs.push(elapsed);
    }
    return result;
  };

  const metrics = () => ({
    diskReads,
    coldLookups,
    warmLookups,
    coldLatenciesMs: [...coldLatenciesMs],
    warmLatenciesMs: [...warmLatenciesMs],
  });
  return { index, lookupBfi, metrics };
};

module.exports = {
  buildArtifact,
  compareShardingStrategies,
  createArtifactLookup,
  writeArtifact,
};
