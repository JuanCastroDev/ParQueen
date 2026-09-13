import { describe, expect, it } from 'vitest';
import { classifyStreetIntelligence } from './streetIntelligencePresentation';

const schedules = [{ side: 'West', days: ['Mon'], startTime: '08:30', endTime: '10:00' }];

const adminSegment = {
  status: 'active',
  source: 'admin',
  confidenceScore: 1,
  provenance: { provider: 'admin' },
};

const sweepSegment = {
  status: 'active',
  source: 'sweepnyc',
  confidenceScore: 0.95,
  provenance: { provider: 'sweepnyc', geometrySource: 'osm' },
};

const odEvidence = { blockDecisive: true, sideResolved: true, parseComplete: true, selectionReason: 'bounding_pair_and_side' };

const odSegment = {
  status: 'active',
  source: 'nyc_open_data',
  confidenceScore: 0.9,
  provenance: { provider: 'nyc_open_data', geometrySource: 'osm' },
  confidence: { level: 'community' },
  blockFaceEvidence: odEvidence,
};

const adminRule = { source: 'admin', schedules, lastSourceSync: '2026-08-29' };
const sweepRule = { source: 'sweepnyc', schedules, lastSourceSync: '2026-08-29T18:20:00.000Z' };
const odRule = { source: 'nyc_open_data', schedules, lastSourceSync: '2026-08-29T18:20:00.000Z' };

describe('classifyStreetIntelligence', () => {
  it.each([
    ['missing segment', null, [adminRule]],
    ['missing status', { ...adminSegment, status: undefined }, [adminRule]],
    ['missing source', { ...adminSegment, source: undefined }, [adminRule]],
    ['missing confidence', { ...adminSegment, confidenceScore: undefined }, [adminRule]],
    ['lastVerifiedAt without confidence', { ...adminSegment, confidenceScore: undefined, confidence: { lastVerifiedAt: '2026-08-29' } }, [adminRule]],
    ['mismatched provenance provider', { ...adminSegment, provenance: { provider: 'sweepnyc' } }, [adminRule]],
    ['missing rule source', adminSegment, [{ ...adminRule, source: undefined }]],
    ['empty schedules', adminSegment, [{ ...adminRule, schedules: [] }]],
    ['archived segment', { ...adminSegment, status: 'archived' }, [adminRule]],
    ['duplicate segment', { ...adminSegment, status: 'duplicate' }, [adminRule]],
    ['missing rules', adminSegment, []],
  ])('fails closed to unknown for %s', (_name, segment, rules) => {
    expect(classifyStreetIntelligence(segment, rules).state).toBe('unknown');
  });

  it.each([
    ['needs_review status', { ...sweepSegment, status: 'needs_review' }, [sweepRule]],
    ['needsReview flag', { ...sweepSegment, needsReview: true }, [sweepRule]],
    ['rule needsReview flag', sweepSegment, [{ ...sweepRule, needsReview: true }]],
    ['low repository confidence', { ...sweepSegment, confidenceScore: 0.6 }, [sweepRule]],
    ['block face not decisive', { ...odSegment, blockFaceEvidence: { ...odEvidence, blockDecisive: false } }, [odRule]],
    ['side not resolved', { ...odSegment, blockFaceEvidence: { ...odEvidence, sideResolved: false } }, [odRule]],
    ['partially parsed signs', { ...odSegment, blockFaceEvidence: { ...odEvidence, parseComplete: false } }, [odRule]],
  ])('uses caution for %s', (_name, segment, rules) => {
    expect(classifyStreetIntelligence(segment, rules).state).toBe('caution');
  });

  it.each([
    ['admin data', adminSegment, [adminRule], 'admin'],
    ['SweepNYC data', sweepSegment, [sweepRule], 'sweepnyc'],
  ])('keeps supported %s useful without inventing a score', (_name, segment, rules, source) => {
    expect(classifyStreetIntelligence(segment, rules)).toMatchObject({
      state: 'supported',
      source,
      lastSourceSync: expect.any(String),
    });
  });

  it('does not invent freshness when lastSourceSync is absent', () => {
    const result = classifyStreetIntelligence(adminSegment, [{ ...adminRule, lastSourceSync: null }]);
    expect(result.lastSourceSync).toBeNull();
  });

  it('reports the actual rule source when an admin rule supplies the parking decision for a SweepNYC segment', () => {
    const result = classifyStreetIntelligence(sweepSegment, [adminRule]);
    expect(result.source).toBe('admin');
  });

  it('treats agreeing mixed sources as corroboration, not conflict', () => {
    // Two publishers stating the same window for the same side is stronger
    // evidence, not weaker. `source` stays null because no single one owns it.
    const result = classifyStreetIntelligence(sweepSegment, [sweepRule, adminRule]);
    expect(result).toMatchObject({ state: 'supported', source: null, reasons: [] });
  });

  it('flags mixed sources only when they actually disagree for the same side', () => {
    const conflicting = { ...adminRule, schedules: [{ side: 'West', days: ['Tue'], startTime: '11:00', endTime: '12:30' }] };
    const result = classifyStreetIntelligence(sweepSegment, [sweepRule, conflicting]);
    expect(result.state).toBe('caution');
    expect(result.reasons).toContain('conflicting_schedules');
  });

  it.each([
    ['admin source with SweepNYC confidence', { ...adminSegment, confidenceScore: 0.95 }, adminRule],
    ['SweepNYC source with admin confidence', { ...sweepSegment, confidenceScore: 1 }, sweepRule],
  ])('accepts any score above the floor rather than an exact per-source value: %s', (_name, segment, rule) => {
    // Previously an exact-equality allowlist, which no nyc_open_data segment
    // could ever satisfy. Provider/provenance agreement is still enforced above.
    expect(classifyStreetIntelligence(segment, [rule]).state).toBe('supported');
  });

  describe('NYC Open Data is judged on evidence, not on being the fallback route', () => {
    it('is supported when the block face is decisive, the side resolved and the parse complete', () => {
      const result = classifyStreetIntelligence(odSegment, [odRule]);
      expect(result).toMatchObject({ state: 'supported', source: 'nyc_open_data', reasons: [] });
    });

    it('stays supported when only the drawn geometry fell back', () => {
      // A synthetic centreline degrades the map line, not the schedule: the side
      // then comes from the DOT record's own side_of_street field.
      const segment = { ...odSegment, provenance: { provider: 'nyc_open_data', geometrySource: 'fallback' } };
      expect(classifyStreetIntelligence(segment, [odRule]).state).toBe('supported');
    });

    it('stays caution while the producer has not recorded any evidence', () => {
      // Segments written before evidence was persisted keep their conservative stamp.
      const legacy = { ...odSegment, blockFaceEvidence: undefined, status: 'needs_review', needsReview: true, confidenceScore: 0.5, confidence: { level: 'unverified' } };
      const result = classifyStreetIntelligence(legacy, [odRule]);
      expect(result.state).toBe('caution');
      expect(result.reasons).toEqual(expect.arrayContaining(['flagged_for_review', 'low_confidence']));
    });
  });

  it('names every distinct doubt so the UI never has to say "review recommended"', () => {
    const segment = { ...odSegment, confidenceScore: 0.5, blockFaceEvidence: { blockDecisive: false, sideResolved: false, parseComplete: false } };
    const result = classifyStreetIntelligence(segment, [odRule]);
    expect(result.reasons).toEqual(expect.arrayContaining([
      'block_not_decisive', 'side_unresolved', 'incomplete_parse', 'low_confidence',
    ]));
  });

  it('reports supported results with no reasons at all', () => {
    expect(classifyStreetIntelligence(adminSegment, [adminRule]).reasons).toEqual([]);
  });

  it('flags a schedule old enough that the block may have been re-signed', () => {
    const old = { ...adminRule, lastSourceSync: '2024-01-01T00:00:00.000Z' };
    const result = classifyStreetIntelligence(adminSegment, [old], Date.parse('2026-09-13T00:00:00.000Z'));
    expect(result.state).toBe('caution');
    expect(result.reasons).toContain('stale_data');
  });
});
