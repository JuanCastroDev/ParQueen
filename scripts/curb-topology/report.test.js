import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const records = [
  { bfi: '0000000001', borough: 'Manhattan', csclSide: 'LEFT', roadwayStatus: ['2'], topologyState: 'complete' },
  { bfi: '0000000002', borough: 'Manhattan', csclSide: 'RIGHT', roadwayStatus: ['2'], topologyState: 'ambiguous' },
  { bfi: '0000000003', borough: 'Queens', csclSide: 'LEFT', roadwayStatus: ['1'], topologyState: 'incomplete' },
  { bfi: '0000000004', borough: 'Queens', csclSide: null, roadwayStatus: ['1'], topologyState: 'conflict', conflictReasons: ['side'] },
];

describe('citywide topology quality report', () => {
  it('reports every required quality, provenance, artifact, and performance measure', () => {
    const { buildQualityReport } = require('./lib/report');
    const report = buildQualityReport({
      manifestDigest: 'a'.repeat(64),
      sourceRelease: { cscl: 'cscl-1', pavementEdge: 'edge-1' },
      centerlineRowCount: 8,
      topology: {
        records,
        counts: { complete: 1, ambiguous: 1, incomplete: 1, conflict: 1, geometryFallback: 3 },
      },
      pavement: {
        totalRows: 10,
        validConflatedEdges: 7,
        missingBfi: 1,
        invalidBfi: 2,
        reconciled: 5,
        reconciliationFailures: { bfi_not_found: 2 },
      },
      relationship: { explicit: 1, geometryFallback: 3, unavailable: 0 },
      bridge: { finding: 'PARTIAL', eligible: 4, withDirectB7sc: 3, coveragePercent: 75 },
      artifact: {
        totalBytes: 1234,
        shardCount: 2,
        shardBytes: { min: 500, median: 600, p95: 700, max: 700 },
        shardingComparison: { recommendation: 'hash-prefix' },
      },
      performance: {
        generationMs: 42,
        peakRssBytes: 999,
        coldLookupMs: { median: 2 },
        warmLookupMs: { median: 0.1 },
      },
    });

    expect(report.topology).toMatchObject({
      totalBfis: 4,
      complete: 1,
      completePercent: 25,
      ambiguous: 1,
      incomplete: 1,
      conflictingSidesOrEvidence: 1,
      conflictingSides: 1,
      mappedToExactlyOneSide: 3,
    });
    expect(report.topology.byBorough.Manhattan).toEqual({ ambiguous: 1, complete: 1 });
    expect(report.topology.byRoadwayStatus['1']).toEqual({ conflict: 1, incomplete: 1 });
    expect(report.pavementEdge.totalRows).toBe(10);
    expect(report.relationships.geometryFallback).toBe(3);
    expect(report.b5scB7sc.finding).toBe('PARTIAL');
    expect(report.artifact.shardingComparison.recommendation).toBe('hash-prefix');
    expect(report.performance.coldLookupMs.median).toBe(2);
  });

  it('rejects inconsistent topology counts instead of writing a misleading report', () => {
    const { buildQualityReport } = require('./lib/report');
    expect(() => buildQualityReport({
      manifestDigest: 'a'.repeat(64),
      sourceRelease: { cscl: 'c', pavementEdge: 'p' },
      centerlineRowCount: 1,
      topology: { records, counts: { complete: 4, ambiguous: 1, incomplete: 0, conflict: 0, geometryFallback: 0 } },
      pavement: {}, relationship: {}, bridge: {}, artifact: {}, performance: {},
    })).toThrow(/topology counts/);
  });
});
