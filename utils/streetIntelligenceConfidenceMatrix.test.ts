import { describe, expect, it } from 'vitest';
import {
  classifyStreetIntelligence,
  StreetIntelligenceCautionReason,
  StreetIntelligencePresentationState,
} from './streetIntelligencePresentation';

/**
 * Confidence matrix, shaped like the rows the two producers actually write.
 *
 * The behaviour under audit: results were reading as uncertain even when the
 * block face, side and schedule were all resolved. Every row below states the
 * evidence, the classification it used to get, and the one it gets now.
 *
 * The rule: caution must correspond to a real, nameable doubt. Being routed
 * through the NYC Open Data fallback is not one -- NYC's own dataset is
 * authoritative, and the fallback is a later route to it, not a worse one.
 */

const W = [{ side: 'West', days: ['Mon', 'Thu'], startTime: '08:30', endTime: '10:00' }];
const NOW = Date.parse('2026-09-13T12:00:00.000Z');
const SYNCED = '2026-09-01T00:00:00.000Z';

const decisiveEvidence = {
  selectionReason: 'bounding_pair_and_side',
  blockDecisive: true,
  sideResolved: true,
  parseComplete: true,
};

interface Row {
  fixture: string;
  source: 'admin' | 'sweepnyc' | 'nyc_open_data';
  blockFace: string;
  side: string;
  parse: string;
  was: StreetIntelligencePresentationState;
  now: StreetIntelligencePresentationState;
  reasons: StreetIntelligenceCautionReason[];
  why: string;
  segment: Record<string, any>;
  rules: Record<string, any>[];
}

const seg = (over: Record<string, any>) => ({
  status: 'active',
  confidenceScore: 0.9,
  confidence: { level: 'community' },
  blockFaceEvidence: decisiveEvidence,
  ...over,
});
const odSeg = (over: Record<string, any> = {}) => seg({
  source: 'nyc_open_data',
  provenance: { provider: 'nyc_open_data', geometrySource: 'osm' },
  ...over,
});
const odRule = (over: Record<string, any> = {}) => ({ source: 'nyc_open_data', schedules: W, lastSourceSync: SYNCED, ...over });

const MATRIX: Row[] = [
  {
    fixture: 'admin-reviewed block',
    source: 'admin', blockFace: 'exact', side: 'confirmed', parse: 'complete',
    was: 'supported', now: 'supported', reasons: [],
    why: 'unchanged — already the strongest case',
    segment: seg({ source: 'admin', confidenceScore: 1, provenance: { provider: 'admin' } }),
    rules: [{ source: 'admin', schedules: W, lastSourceSync: SYNCED }],
  },
  {
    fixture: 'SweepNYC + OSM geometry',
    source: 'sweepnyc', blockFace: 'exact', side: 'from geometry', parse: 'complete',
    was: 'supported', now: 'supported', reasons: [],
    why: 'unchanged',
    segment: seg({ source: 'sweepnyc', confidenceScore: 0.95, provenance: { provider: 'sweepnyc', geometrySource: 'osm' } }),
    rules: [{ source: 'sweepnyc', schedules: W, lastSourceSync: SYNCED }],
  },
  {
    fixture: 'NYC Open Data, bounding pair + side',
    source: 'nyc_open_data', blockFace: 'decisive (both bounds)', side: 'resolved', parse: 'complete',
    was: 'caution', now: 'supported', reasons: [],
    why: 'THE FIX — was caution purely for being the fallback source',
    segment: odSeg(),
    rules: [odRule()],
  },
  {
    fixture: 'NYC Open Data, decisive block, synthetic centreline',
    source: 'nyc_open_data', blockFace: 'decisive (both bounds)', side: 'from DOT record', parse: 'complete',
    was: 'caution', now: 'supported', reasons: [],
    why: 'THE FIX — fallback geometry degrades the drawn line, not the schedule',
    segment: odSeg({
      provenance: { provider: 'nyc_open_data', geometrySource: 'fallback' },
      blockFaceEvidence: { ...decisiveEvidence, sideSource: 'dot_record' },
    }),
    rules: [odRule()],
  },
  {
    fixture: 'SweepNYC + agreeing admin rule',
    source: 'sweepnyc', blockFace: 'exact', side: 'confirmed', parse: 'complete',
    was: 'caution', now: 'supported', reasons: [],
    why: 'THE FIX — two publishers stating the same window is corroboration',
    segment: seg({ source: 'sweepnyc', confidenceScore: 0.95, provenance: { provider: 'sweepnyc', geometrySource: 'osm' } }),
    rules: [
      { source: 'sweepnyc', schedules: W, lastSourceSync: SYNCED },
      { source: 'admin', schedules: W, lastSourceSync: SYNCED },
    ],
  },
  {
    fixture: 'two sources disagreeing on the West side',
    source: 'sweepnyc', blockFace: 'exact', side: 'confirmed', parse: 'complete',
    was: 'caution', now: 'caution', reasons: ['conflicting_schedules'],
    why: 'legitimate caution, now says what conflicts',
    segment: seg({ source: 'sweepnyc', confidenceScore: 0.95, provenance: { provider: 'sweepnyc', geometrySource: 'osm' } }),
    rules: [
      { source: 'sweepnyc', schedules: W, lastSourceSync: SYNCED },
      { source: 'admin', schedules: [{ side: 'West', days: ['Tue'], startTime: '13:00', endTime: '14:30' }], lastSourceSync: SYNCED },
    ],
  },
  {
    fixture: 'NYC Open Data, one bound matched only',
    source: 'nyc_open_data', blockFace: 'not decisive', side: 'resolved', parse: 'complete',
    was: 'caution', now: 'caution', reasons: ['block_not_decisive'],
    why: 'legitimate — could be the neighbouring block',
    segment: odSeg({ blockFaceEvidence: { ...decisiveEvidence, blockDecisive: false, selectionReason: 'single_candidate' } }),
    rules: [odRule()],
  },
  {
    fixture: 'NYC Open Data, side could not be established',
    source: 'nyc_open_data', blockFace: 'decisive', side: 'unresolved', parse: 'complete',
    was: 'caution', now: 'caution', reasons: ['side_unresolved'],
    why: 'legitimate — the schedule is side-specific',
    segment: odSeg({ blockFaceEvidence: { ...decisiveEvidence, sideResolved: false } }),
    rules: [odRule()],
  },
  {
    fixture: 'NYC Open Data, 2 of 5 signs unreadable',
    source: 'nyc_open_data', blockFace: 'decisive', side: 'resolved', parse: 'partial',
    was: 'caution', now: 'caution', reasons: ['incomplete_parse'],
    why: 'legitimate — an unread sign may carry another restriction',
    segment: odSeg({ blockFaceEvidence: { ...decisiveEvidence, parseComplete: false, unparsedCount: 2 } }),
    rules: [odRule()],
  },
  {
    fixture: 'legacy NYC Open Data row written before evidence was persisted',
    source: 'nyc_open_data', blockFace: 'unrecorded', side: 'unrecorded', parse: 'unrecorded',
    was: 'caution', now: 'caution', reasons: ['flagged_for_review', 'low_confidence'],
    why: 'stays conservative — the evidence to justify promotion was never stored',
    segment: {
      status: 'needs_review', source: 'nyc_open_data', needsReview: true, confidenceScore: 0.5,
      confidence: { level: 'unverified' }, provenance: { provider: 'nyc_open_data', geometrySource: 'osm' },
    },
    rules: [odRule({ needsReview: true })],
  },
];

describe('street intelligence confidence matrix', () => {
  it.each(MATRIX.map(r => [r.fixture, r] as const))('%s', (_name, row) => {
    const result = classifyStreetIntelligence(row.segment, row.rules, NOW);
    expect(result.state).toBe(row.now);
    expect([...result.reasons].sort()).toEqual([...row.reasons].sort());
  });

  it('never reports a caution state without naming at least one reason', () => {
    for (const row of MATRIX) {
      const result = classifyStreetIntelligence(row.segment, row.rules, NOW);
      if (result.state === 'caution') expect(result.reasons.length).toBeGreaterThan(0);
      if (result.state === 'supported') expect(result.reasons).toEqual([]);
    }
  });

  it('does not promote anything that lost evidence', () => {
    // Guard against the fix over-reaching: strip each piece of evidence in turn
    // from the strongest fallback row and confirm it drops out of supported.
    for (const missing of ['blockDecisive', 'sideResolved', 'parseComplete'] as const) {
      const segment = odSeg({ blockFaceEvidence: { ...decisiveEvidence, [missing]: false } });
      expect(classifyStreetIntelligence(segment, [odRule()], NOW).state).toBe('caution');
    }
  });
});
