'use strict';

const increment = (target, key) => {
  target[key] = (target[key] || 0) + 1;
};

const nestedBreakdown = (records, keyOf) => {
  const output = {};
  for (const record of records) {
    for (const key of keyOf(record)) {
      if (!output[key]) output[key] = {};
      increment(output[key], record.topologyState);
    }
  }
  return Object.fromEntries(Object.entries(output).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })));
};

const buildQualityReport = input => {
  const { records, counts } = input.topology;
  const classified = counts.complete + counts.incomplete + counts.ambiguous + counts.conflict;
  if (classified !== records.length) throw new TypeError('topology counts do not match records');
  const percent = records.length === 0 ? 0 : Number(((counts.complete / records.length) * 100).toFixed(4));

  return {
    reportSchemaVersion: 1,
    source: {
      manifestDigest: input.manifestDigest,
      release: input.sourceRelease,
      centerlineRows: input.centerlineRowCount,
    },
    pavementEdge: input.pavement,
    topology: {
      totalBfis: records.length,
      mappedToExactlyOneSide: records.filter(record => ['LEFT', 'RIGHT'].includes(record.csclSide)).length,
      conflictingSidesOrEvidence: counts.conflict,
      conflictingSides: records.filter(record => (record.conflictReasons || []).includes('side')).length,
      complete: counts.complete,
      completePercent: percent,
      incomplete: counts.incomplete,
      ambiguous: counts.ambiguous,
      byBorough: nestedBreakdown(records, record => [record.borough || 'unknown']),
      byRoadwayStatus: nestedBreakdown(records, record => record.roadwayStatus.length ? record.roadwayStatus : ['unknown']),
    },
    relationships: input.relationship,
    b5scB7sc: input.bridge,
    artifact: input.artifact,
    performance: input.performance,
  };
};

const qualityReportMarkdown = report => `# Canonical Curb Topology Quality Report

- Manifest digest: \`${report.source.manifestDigest}\`
- CSCL release: \`${report.source.release.cscl}\`
- Pavement Edge release: \`${report.source.release.pavementEdge}\`
- Centerline rows: ${report.source.centerlineRows.toLocaleString('en-US')}
- Pavement Edge rows: ${report.pavementEdge.totalRows.toLocaleString('en-US')}
- Valid conflated edges: ${report.pavementEdge.validConflatedEdges.toLocaleString('en-US')}
- BFIs: ${report.topology.totalBfis.toLocaleString('en-US')}
- Complete topology: ${report.topology.complete.toLocaleString('en-US')} (${report.topology.completePercent}%)
- Ambiguous topology: ${report.topology.ambiguous.toLocaleString('en-US')}
- Incomplete topology: ${report.topology.incomplete.toLocaleString('en-US')}
- Conflicting topology: ${report.topology.conflictingSidesOrEvidence.toLocaleString('en-US')}
- Geometry-to-Node fallback: ${report.relationships.geometryFallback.toLocaleString('en-US')}
- B5SC/B7SC finding: ${report.b5scB7sc.finding} (${report.b5scB7sc.coveragePercent}%)
- Artifact bytes: ${report.artifact.totalBytes.toLocaleString('en-US')}
- Artifact shards: ${report.artifact.shardCount.toLocaleString('en-US')}
- Recommended sharding: ${report.artifact.shardingComparison.recommendation}
`;

module.exports = { buildQualityReport, qualityReportMarkdown };
