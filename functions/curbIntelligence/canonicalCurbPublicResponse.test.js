import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
  buildHighConfidenceResponse,
  selectedHasUnresolvedConflicts,
  requestIncludesExtendedResponse,
  classifyRegulationStatus,
} = require('./canonicalCurbPublicResponse');

const curb = {
  segmentId: 'curb2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  streetName: 'Broadway',
  sideLabel: 'West',
};

const selected = {
  cleaning: { category: 'cleaning', source: 'sweepNyc', schedules: [{ days: ['Monday'], startTime: '09:00', endTime: '10:30' }] },
  conflicts: [],
  rules: [
    { category: 'cleaning', source: 'sweepNyc', schedules: [{ days: ['Monday'], startTime: '09:00', endTime: '10:30', side: 'West' }] },
  ],
};

describe('canonicalCurbPublicResponse', () => {
  it('keeps the legacy high_confidence key set when extended fields are not requested', () => {
    const response = buildHighConfidenceResponse(curb, selected, { includeExtended: false, dotComplete: true });
    expect(Object.keys(response).sort()).toEqual([
      'protocolVersion', 'ruleSummary', 'segmentId', 'sideLabel', 'status', 'streetName',
    ].sort());
    expect(response.status).toBe('high_confidence');
    expect(response.ruleSummary).toEqual({ cleaningAvailable: true });
    const unknown = buildHighConfidenceResponse(curb, selected, { includeExtended: false });
    expect(unknown.ruleSummary).toEqual({ cleaningAvailable: false });
  });

  it('adds versioned public rules and schedules without private identity fields', () => {
    const response = buildHighConfidenceResponse(curb, selected, { includeExtended: true, cacheHit: false, dotComplete: true });
    expect(response.responseVersion).toBe(1);
    expect(response.cacheHit).toBe(false);
    expect(response.publicRules[0].type).toBe('streetCleaning');
    expect(response.publicRules[0].source).toBe('sweepnyc');
    expect(response.publicSchedules.cleaning[0]).toMatchObject({ days: ['Monday'], startTime: '09:00', endTime: '10:30' });
    expect(JSON.stringify(response)).not.toMatch(/identityProof|persistToken|candidateToken|officialBlockFace|"lat"|"lng"/);
  });

  it('fails closed on contradictory selected rules', () => {
    expect(selectedHasUnresolvedConflicts({ conflicts: [{ category: 'cleaning' }] })).toBe(true);
    expect(buildHighConfidenceResponse(curb, { ...selected, conflicts: [{ category: 'cleaning' }] }, { includeExtended: true }))
      .toEqual({ protocolVersion: 2, status: 'unsupported', reason: 'source_unavailable' });
  });

  it('recognizes the additive request contract', () => {
    expect(requestIncludesExtendedResponse({ responseVersion: 1 })).toBe(true);
    expect(requestIncludesExtendedResponse({ protocolVersion: 2 })).toBe(false);
  });

  it('classifies complete, incomplete, conflicting, unavailable, and verified-empty regulations', () => {
    expect(classifyRegulationStatus(selected, { dotComplete: true })).toMatchObject({
      regulationStatus: 'verified', regulationCompleteness: 'complete', regulationAvailability: 'available',
    });
    expect(classifyRegulationStatus({ rules: [], cleaning: null, conflicts: [] }, { dotComplete: false, dotState: 'incomplete' })).toEqual({
      regulationStatus: 'unknown', regulationCompleteness: 'incomplete', regulationAvailability: 'unavailable',
    });
    expect(classifyRegulationStatus({
      rules: [{ category: 'cleaning', source: 'dot', schedules: [] }],
      cleaning: { category: 'cleaning' },
      conflicts: [],
    }, { dotComplete: false, dotState: 'incomplete' })).toMatchObject({
      regulationStatus: 'partial', regulationCompleteness: 'incomplete',
    });
    expect(classifyRegulationStatus({ ...selected, conflicts: [{ category: 'cleaning' }] })).toMatchObject({
      regulationAvailability: 'conflict', regulationStatus: 'unknown',
    });
    expect(classifyRegulationStatus({ rules: [], cleaning: null, conflicts: [] }, { sourceUnavailable: true })).toEqual({
      regulationStatus: 'unknown', regulationCompleteness: 'unknown', regulationAvailability: 'unavailable',
    });
    expect(classifyRegulationStatus({ rules: [], cleaning: null, conflicts: [] }, { dotComplete: true })).toEqual({
      regulationStatus: 'verified_empty', regulationCompleteness: 'complete', regulationAvailability: 'available',
    });
    expect(classifyRegulationStatus({ rules: [], cleaning: null, conflicts: [] }, {
      dotComplete: true, dotReasons: ['official_blockface_mismatch'],
    })).toMatchObject({ regulationStatus: 'unknown' });
  });

  it('does not treat incomplete empty rules as verified cleaning or published schedules', () => {
    const response = buildHighConfidenceResponse(curb, { rules: [], cleaning: null, conflicts: [] }, {
      includeExtended: true,
      dotComplete: false,
      dotState: 'incomplete',
    });
    expect(response.status).toBe('high_confidence');
    expect(response.identityConfidence).toBe('high');
    expect(response.regulationStatus).toBe('unknown');
    expect(response.ruleSummary.cleaningAvailable).toBe(false);
    expect(response.publicRules).toEqual([]);
    expect(response.publicSchedules).toEqual({ cleaning: [], restrictions: [], timeLimited: [], meters: [] });
  });
});
