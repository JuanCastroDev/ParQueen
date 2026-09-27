#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { performance } = require('node:perf_hooks');
const { canonicalJson } = require('./lib/canonicalJson');
const { validateSnapshotManifest } = require('./lib/manifest');
const {
  normalizeCsclCenterline,
  normalizeCsclNode,
  normalizeStreetName,
  normalizePavementEdge,
} = require('./lib/normalizers');
const { buildTopology } = require('./lib/topology');
const { reconcilePavementBfi, assessB5scB7scCoverage } = require('./lib/reconcile');
const {
  buildArtifact,
  compareShardingStrategies,
  createArtifactLookup,
  writeArtifact,
} = require('./lib/artifact');
const { buildQualityReport, qualityReportMarkdown } = require('./lib/report');

const FILES = {
  cscl_centerline: 'cscl-centerline.ndjson',
  cscl_node: 'cscl-node.ndjson',
  cscl_street_name: 'cscl-street-name.ndjson',
  pavement_edge: 'pavement-edge.ndjson',
};

const parseArgs = argv => {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    if (!key.startsWith('--') || argv[index + 1] === undefined) throw new TypeError(`invalid argument: ${key}`);
    values[key.slice(2)] = argv[index + 1];
  }
  return values;
};

async function* ndjson(file) {
  const lines = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) if (line) yield JSON.parse(line);
}

const inventoryFile = async file => {
  const crypto = require('node:crypto');
  const hash = crypto.createHash('sha256');
  let rowCount = 0;
  const fields = new Set();
  const input = fs.createReadStream(file);
  input.on('data', chunk => hash.update(chunk));
  const digest = new Promise((resolve, reject) => {
    input.on('end', () => resolve(hash.digest('hex')));
    input.on('error', reject);
  });
  for await (const row of ndjson(file)) {
    rowCount += 1;
    const source = row.type === 'Feature' ? row.properties : row;
    Object.keys(source || {}).forEach(key => fields.add(key));
  }
  return {
    byteSize: fs.statSync(file).size,
    rowCount,
    sha256: await digest,
    fields: [...fields].sort(),
  };
};

const percentile = (values, fraction) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(4));
};

const distribution = values => ({
  min: values.length ? Math.min(...values) : 0,
  median: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  max: values.length ? Math.max(...values) : 0,
});

const privateArtifactRecord = record => ({
  topologySchemaVersion: record.topologySchemaVersion,
  sourceManifestDigest: record.sourceManifestDigest,
  sourceRelease: record.sourceRelease,
  bfi: record.bfi,
  borough: record.borough,
  boroughCode: record.boroughCode,
  csclSide: record.csclSide,
  onStreet: record.onStreet,
  onStreetB5sc: record.onStreetB5sc,
  onStreetB7sc: record.onStreetB7sc,
  supportingSegments: record.supportingSegments,
  roadwayStatus: record.roadwayStatus,
  roadwayType: record.roadwayType,
  levelEvidence: record.levelEvidence,
  roadbedEvidence: record.roadbedEvidence,
  fromNode: record.fromNode,
  fromStreet: record.fromStreet,
  fromStreetCandidates: record.fromStreetCandidates,
  toNode: record.toNode,
  toStreet: record.toStreet,
  toStreetCandidates: record.toStreetCandidates,
  endpointMethod: record.endpointMethod,
  topologyState: record.topologyState,
  provenance: record.provenance,
});

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = path.resolve(args.manifest || 'data/curb-topology/manifest.json');
  const snapshotDirectory = path.resolve(args.snapshots || 'data/curb-topology/snapshots/normalized');
  const outputDirectory = path.resolve(args.output || 'data/curb-topology/artifacts/current');
  const reportJsonPath = path.resolve(args['report-json'] || path.join(outputDirectory, 'quality.json'));
  const reportMarkdownPath = path.resolve(args['report-markdown'] || path.join(outputDirectory, 'quality.md'));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  const inventory = {};
  for (const [role, filename] of Object.entries(FILES)) {
    inventory[role] = await inventoryFile(path.join(snapshotDirectory, filename));
  }
  const validated = validateSnapshotManifest(manifest, inventory);
  const csclRelease = validated.sourceRelease.cscl;
  const pavementRelease = validated.sourceRelease.pavementEdge;

  const centerlines = [];
  for await (const row of ndjson(path.join(snapshotDirectory, FILES.cscl_centerline))) {
    centerlines.push(normalizeCsclCenterline(row, csclRelease));
  }
  const nodes = [];
  for await (const row of ndjson(path.join(snapshotDirectory, FILES.cscl_node))) {
    nodes.push(normalizeCsclNode(row, csclRelease));
  }
  let streetNameRows = 0;
  let invalidStreetNameB7sc = 0;
  for await (const row of ndjson(path.join(snapshotDirectory, FILES.cscl_street_name))) {
    const streetName = normalizeStreetName(row, csclRelease);
    if (streetName.b7scStatus === 'invalid') invalidStreetNameB7sc += 1;
    streetNameRows += 1;
  }

  const generationStarted = performance.now();
  const topology = buildTopology({
    centerlines,
    nodes,
    sourceManifestDigest: validated.manifestDigest,
    sourceRelease: csclRelease,
  });
  const topologyByBfi = new Map(topology.records.map(record => [record.bfi, record]));
  const pavement = {
    totalRows: 0,
    conflatedRows: 0,
    validConflatedEdges: 0,
    missingBfi: 0,
    invalidBfi: 0,
    reconciled: 0,
    reconciliationFailures: {},
  };
  for await (const row of ndjson(path.join(snapshotDirectory, FILES.pavement_edge))) {
    pavement.totalRows += 1;
    let edge;
    try {
      edge = normalizePavementEdge(row, pavementRelease);
    } catch (error) {
      if (/BFI/.test(error.message)) {
        pavement.invalidBfi += 1;
        continue;
      }
      throw error;
    }
    if (edge.conflated) pavement.conflatedRows += 1;
    if (!edge.blockFaceId) {
      pavement.missingBfi += 1;
      continue;
    }
    if (!edge.conflated) continue;
    pavement.validConflatedEdges += 1;
    const topologyRecord = topologyByBfi.get(edge.blockFaceId);
    const result = reconcilePavementBfi(edge, topologyRecord ? [topologyRecord] : []);
    if (result.ok) pavement.reconciled += 1;
    else pavement.reconciliationFailures[result.reason] = (pavement.reconciliationFailures[result.reason] || 0) + 1;
  }

  const eligible = topology.records.filter(record => record.topologyState === 'complete').map(privateArtifactRecord);
  const artifactOptions = {
    strategy: 'hash-prefix',
    prefixLength: 2,
    maxRecordsPerShard: 1000,
    maxShardBytes: 4 * 1024 * 1024,
    sourceManifestDigest: validated.manifestDigest,
    sourceRelease: csclRelease,
  };
  const artifact = buildArtifact(eligible, artifactOptions);
  const shardingComparison = compareShardingStrategies(eligible, artifactOptions);
  const generationMs = performance.now() - generationStarted;
  writeArtifact(outputDirectory, artifact);

  const lookup = createArtifactLookup(path.join(outputDirectory, 'index.json'));
  const samples = eligible.slice(0, 100).map(record => record.bfi);
  samples.forEach(bfi => lookup.lookupBfi(bfi));
  samples.forEach(bfi => lookup.lookupBfi(bfi));
  const lookupMetrics = lookup.metrics();
  const files = [...artifact.files.values()];
  const shardByteValues = artifact.index.shards.map(shard => shard.byteSize);
  const relationship = {
    explicit: topology.records.filter(record => record.endpointMethod === 'explicit_relation').length,
    geometryFallback: topology.records.filter(record => record.endpointMethod === 'geometry_node_fallback').length,
    unavailable: topology.records.filter(record => !record.endpointMethod).length,
    publishedStreetNameRows: streetNameRows,
    invalidStreetNameB7sc,
  };
  const report = buildQualityReport({
    manifestDigest: validated.manifestDigest,
    sourceRelease: validated.sourceRelease,
    centerlineRowCount: centerlines.length,
    topology,
    pavement,
    relationship,
    bridge: assessB5scB7scCoverage(topology.records),
    artifact: {
      totalBytes: files.reduce((sum, bytes) => sum + bytes.length, 0),
      shardCount: artifact.index.shards.length,
      shardBytes: distribution(shardByteValues),
      shardingComparison,
      estimatedBundledPackageBytes: files.reduce((sum, bytes) => sum + bytes.length, 0),
      deliveryRecommendation: 'bundled-lazy-shards',
    },
    performance: {
      generationMs: Number(generationMs.toFixed(4)),
      peakRssBytes: process.memoryUsage().rss,
      coldLookupMs: distribution(lookupMetrics.coldLatenciesMs),
      warmLookupMs: distribution(lookupMetrics.warmLatenciesMs),
      lazyDiskReads: lookupMetrics.diskReads,
    },
  });
  fs.mkdirSync(path.dirname(reportJsonPath), { recursive: true });
  fs.mkdirSync(path.dirname(reportMarkdownPath), { recursive: true });
  fs.writeFileSync(reportJsonPath, `${canonicalJson(report)}\n`);
  fs.writeFileSync(reportMarkdownPath, qualityReportMarkdown(report));
  process.stdout.write(`${canonicalJson(report)}\n`);
};

main().catch(error => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
