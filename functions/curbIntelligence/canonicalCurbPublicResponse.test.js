import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const {
  buildHighConfidenceResponse,
  selectedHasUnresolvedConflicts,
  requestIncludesExtendedResponse,
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
    const response = buildHighConfidenceResponse(curb, selected, { includeExtended: false });
    expect(Object.keys(response).sort()).toEqual([
      'protocolVersion', 'ruleSummary', 'segmentId', 'sideLabel', 'status', 'streetName',
    ].sort());
    expect(response.status).toBe('high_confidence');
    expect(response.ruleSummary).toEqual({ cleaningAvailable: true });
  });

  it('adds versioned public rules and schedules without private identity fields', () => {
    const response = buildHighConfidenceResponse(curb, selected, { includeExtended: true, cacheHit: false });
    expect(response.responseVersion).toBe(1);
    expect(response.cacheHit).toBe(false);
    expect(response.publicRules[0].type).toBe('streetCleaning');
    expect(response.publicRules[0].source).toBe('sweepnyc');
    expect(response.publicSchedules.cleaning[0]).toMatchObject({ days: ['Monday'], startTime: '09:00', endTime: '10:30' });
    expect(JSON.stringify(response)).not.toMatch(/identity|persistToken|candidateToken|lat|lng/);
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
});
