'use strict';

const { readFileSync } = require('fs');
const { join } = require('path');
const {
  STREET_INTEL_REFRESH_DOMAIN,
  STREET_INTEL_EVENTS,
  ALLOWED_EXTRA_KEYS,
  isUsableSchedule,
  countUsableSchedules,
  countUsableStreetIntelligence,
  hasUsableSchedules,
  hasUsableStreetIntelligence,
  decideDedupPath,
  shouldCallEmptyCacheRefresh,
  logStreetIntelEvent,
} = require('./streetIntelRefresh');

const INDEX_SRC = readFileSync(join(__dirname, 'index.js'), 'utf8');
const CLIENT_SRC = readFileSync(join(__dirname, '..', 'views', 'StreetParkingView.tsx'), 'utf8');
const CONFIG_SRC = readFileSync(join(__dirname, 'curbIntelligence', 'privateBlockfaceResolverConfig.test.js'), 'utf8');

const usableRule = {
  type: 'streetCleaning',
  schedules: [{ days: ['Tue'], startTime: '08:30', endTime: '10:00' }],
};

describe('usable streetRules schedules', () => {
  it('requires days, startTime, and endTime', () => {
    expect(isUsableSchedule({ days: ['Tue'], startTime: '08:30', endTime: '10:00' })).toBe(true);
    expect(isUsableSchedule({ days: [], startTime: '08:30', endTime: '10:00' })).toBe(false);
    expect(isUsableSchedule({ days: ['Tue'], startTime: '', endTime: '10:00' })).toBe(false);
    expect(isUsableSchedule({ days: ['Tue'], startTime: '08:30', endTime: '  ' })).toBe(false);
    expect(isUsableSchedule(null)).toBe(false);
  });

  it('counts only streetCleaning schedules', () => {
    expect(countUsableSchedules([usableRule])).toBe(1);
    expect(hasUsableSchedules([usableRule])).toBe(true);
    expect(countUsableSchedules([{ type: 'streetCleaning', schedules: [] }])).toBe(0);
    expect(countUsableSchedules([{ type: 'meter', schedules: [usableRule.schedules[0]] }])).toBe(0);
    expect(countUsableSchedules([])).toBe(0);
  });

  it('K. meter-only rules count as usable Street Intelligence', () => {
    const meterOnly = [{ type: 'meter', schedules: [usableRule.schedules[0]] }];
    expect(hasUsableStreetIntelligence(meterOnly)).toBe(true);
    expect(hasUsableSchedules(meterOnly)).toBe(false);
    expect(decideDedupPath(countUsableStreetIntelligence(meterOnly))).toBe('fast');
    expect(shouldCallEmptyCacheRefresh(countUsableStreetIntelligence(meterOnly), false)).toBe(false);
  });

  it('L. truly empty cache still refreshes', () => {
    expect(hasUsableStreetIntelligence([])).toBe(false);
    expect(shouldCallEmptyCacheRefresh(countUsableStreetIntelligence([]), false)).toBe(true);
  });
});

describe('A-B client 80m cache refresh gate', () => {
  it('A. usable nearby schedules do not request a callable refresh', () => {
    expect(CLIENT_SRC).toContain('countUsableStreetIntelligence(nearbyRules)');
    expect(CLIENT_SRC).toContain("logStreetIntelEvent('cache_hit_usable'");
    const refreshIf = CLIENT_SRC.slice(
      CLIENT_SRC.indexOf('if (shouldCallEmptyCacheRefresh(usableCount'),
      CLIENT_SRC.indexOf('} else if (usableCount > 0)'),
    );
    expect(refreshIf).toContain("'createSegmentFromSweepNYC'");
    expect(refreshIf).toContain("logStreetIntelEvent('cache_hit_empty_refresh'");
    expect(refreshIf).not.toContain("logStreetIntelEvent('cache_hit_usable'");
  });

  it('B. zero nearby schedules request one callable refresh', () => {
    expect(shouldCallEmptyCacheRefresh(0, false)).toBe(true);
    expect(CLIENT_SRC).toContain('emptyRulesRefreshAttemptedRef');
    expect(CLIENT_SRC).toMatch(/emptyRulesRefreshAttemptedRef\.current\.add\(nearest\.id\)/);
    expect(CLIENT_SRC).toContain("logStreetIntelEvent('cache_hit_empty_refresh'");
  });
});

describe('C-D SweepNYC dedup refresh gate', () => {
  it('C. usable stored schedules stay on the fast path', () => {
    expect(INDEX_SRC).toContain('countUsableStreetIntelligence(rules)');
    expect(INDEX_SRC).toContain("logStreetIntelEvent('dedup_hit_usable'");
    expect(INDEX_SRC).toMatch(/if \(decideDedupPath\(usableCount\) === 'fast'\)/);
  });

  it('D. zero stored schedules continue into parse instead of returning success', () => {
    expect(decideDedupPath(0)).toBe('refresh');
    expect(INDEX_SRC).toContain("logStreetIntelEvent('dedup_hit_empty_refresh'");
    expect(INDEX_SRC).toContain("return { action: 'refresh', segmentId, segment };");
    const tryStart = INDEX_SRC.indexOf('async function _tryCreateFromSweepNYC');
    const parseStart = INDEX_SRC.indexOf('const parsed = [];', tryStart);
    const emptyRefreshWrite = INDEX_SRC.indexOf("stage: 'empty_rules_refresh'", tryStart);
    expect(parseStart).toBeGreaterThan(tryStart);
    expect(emptyRefreshWrite).toBeGreaterThan(parseStart);
  });
});

describe('E-F refresh continues into fallback and Curb observation', () => {
  it('E. parse_failed after empty-rules refresh still reaches NYC Open Data fallback', () => {
    const callable = INDEX_SRC.slice(
      INDEX_SRC.indexOf('exports.createSegmentFromSweepNYC = onCall('),
      INDEX_SRC.indexOf('function _existingNYCOpenDataResult'),
    );
    expect(callable).toContain("logStreetIntelEvent('fallback_attempted'");
    expect(callable).toMatch(/_fallbackToNYCOpenData\(\s*lat,\s*lng/);
    expect(INDEX_SRC).toContain("logStreetIntelEvent('parser_attempted'");
    expect(INDEX_SRC).toMatch(/_SWEEPNYC_FALLBACK_REASONS = new Set\(\[[\s\S]*'parse_failed'/);
  });

  it('F. refresh success still reaches Curb product observation when eligible', () => {
    const callable = INDEX_SRC.slice(
      INDEX_SRC.indexOf('exports.createSegmentFromSweepNYC = onCall('),
      INDEX_SRC.indexOf('function _existingNYCOpenDataResult'),
    );
    expect(callable).toContain('_observeCurbIntelligenceShadow(productionResult, lat, lng, accuracyMeters, shadowEvidence)');
    expect(INDEX_SRC).toContain('_attachSweepnycProductEvidence(refreshExistingId, d, captureProductEvidence, ruleWrite)');
  });
});

describe('G no request loop / duplicate storm', () => {
  it('client records the attempted segment so a second match does not recall', () => {
    expect(shouldCallEmptyCacheRefresh(0, true)).toBe(false);
    expect(CLIENT_SRC).toContain("logStreetIntelEvent('cache_hit_empty_no_retry'");
    expect(CLIENT_SRC).toMatch(/emptyRulesRefreshAttemptedRef\.current\.has\(nearest\.id\)/);
  });

  it('empty refresh rewrites sweepnyc_v1 in place and does not create a second nyc_ doc', () => {
    const refreshBlock = INDEX_SRC.slice(
      INDEX_SRC.indexOf('if (refreshExistingId) {'),
      INDEX_SRC.indexOf('// ── Street geometry'),
    );
    expect(refreshBlock).toContain('streetRules/sweepnyc_v1');
    expect(refreshBlock).toContain('.set(ruleWrite)');
    expect(refreshBlock).toContain(".set({ updatedAt: now }, { merge: true })");
    expect(refreshBlock).not.toContain('segRef.set(segmentWrite)');
  });
});

describe('H privacy-safe structured logs', () => {
  it('emits JSON with queryable event/domain/message and no forbidden fields', () => {
    const lines = [];
    const payload = logStreetIntelEvent('dedup_hit_empty_refresh', {
      via: 'dedup_index',
      usableCount: 0,
      uid: 'user-123',
      lat: 40.7,
      lng: -73.9,
      streetName: 'MELVILLE STREET',
      segmentId: 'nyc_99',
      officialBlockFaceId: 'BFI-1',
      signs: [{ SignText: 'raw' }],
      token: 'secret',
    }, line => lines.push(line));
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed).toEqual({
      message: 'dedup_hit_empty_refresh',
      event: 'dedup_hit_empty_refresh',
      domain: STREET_INTEL_REFRESH_DOMAIN,
      via: 'dedup_index',
      usableCount: 0,
    });
    expect(payload.uid).toBeUndefined();
    expect(payload.lat).toBeUndefined();
    expect(payload.streetName).toBeUndefined();
    expect(payload.segmentId).toBeUndefined();
    expect(payload.officialBlockFaceId).toBeUndefined();
    expect(payload.token).toBeUndefined();
    expect(ALLOWED_EXTRA_KEYS.has('uid')).toBe(false);
    for (const event of Object.values(STREET_INTEL_EVENTS)) {
      expect(typeof event).toBe('string');
    }
  });

  it('client cache logs use the same JSON helper and never stringify match identity', () => {
    expect(CLIENT_SRC).toContain('logStreetIntelEvent(');
    expect(CLIENT_SRC).not.toMatch(/logStreetIntelEvent\([^)]*nearest\.id/);
    expect(CLIENT_SRC).not.toMatch(/logStreetIntelEvent\([^)]*streetName/);
    expect(CLIENT_SRC).not.toMatch(/logStreetIntelEvent\([^)]*userLat/);
  });
});

describe('I current manual side fallback remains intact', () => {
  it('keeps the SweepNYC multi-side callable overlay and catch that retains detectCardinalSide', () => {
    expect(CLIENT_SRC).toContain("nearest.source === 'sweepnyc' && scheduleSides.length > 1");
    expect(CLIENT_SRC).toContain("keeping manual side confirmation:");
    expect(CLIENT_SRC).toContain('detectParkingSide(');
    expect(CLIENT_SRC).toContain('detectCardinalSide(');
  });
});

describe('J existing 100‰ shadow behavior unchanged', () => {
  it('does not alter product path, sample, or resolver mode', () => {
    expect(CONFIG_SRC).toContain('CURB_SHADOW_SAMPLE_PERMILLE=100');
    expect(CONFIG_SRC).toContain('CURB_PRODUCT_PATH=on');
    expect(CONFIG_SRC).toContain('CURB_RESOLVER_MODE=shadow');
    const callable = INDEX_SRC.slice(
      INDEX_SRC.indexOf('exports.createSegmentFromSweepNYC = onCall('),
      INDEX_SRC.indexOf('function _existingNYCOpenDataResult'),
    );
    expect(INDEX_SRC).toContain('_observeCurbIntelligenceShadow(productionResult, lat, lng, accuracyMeters, shadowEvidence)');
    expect(INDEX_SRC).toContain('productMeterLookup');
    expect(INDEX_SRC).toContain('productRestrictionLookup');
    expect(INDEX_SRC).not.toMatch(/CURB_SHADOW_SAMPLE_PERMILLE\s*=/);
    expect(INDEX_SRC).not.toMatch(/maxScale\s*:/);
  });
});

describe('W-Y restriction cache usable + one-shot migration', () => {
  const { countUsableProhibitionSchedules, hasRestrictionEvaluation, shouldCallRestrictionMigrationRefresh } = require('./streetIntelRefresh');

  it('W. a cached prohibition is usable Street Intelligence', () => {
    const prohibition = [{
      type: 'curbRestrictionSet',
      restrictionSchemaVersion: 1,
      schedules: [{ days: ['Mon'], startTime: '16:00', endTime: '19:00', anytime: false }],
    }];
    expect(countUsableProhibitionSchedules(prohibition)).toBe(1);
    expect(countUsableStreetIntelligence(prohibition)).toBe(1);
    expect(shouldCallEmptyCacheRefresh(countUsableStreetIntelligence(prohibition), false)).toBe(false);
  });

  it('X. legacy cache without a restriction evaluation refreshes once', () => {
    expect(hasRestrictionEvaluation([{ type: 'streetCleaning', schedules: [usableRule.schedules[0]] }])).toBe(false);
    expect(shouldCallRestrictionMigrationRefresh(1, false, false)).toBe(true);
    expect(CLIENT_SRC).toContain('shouldCallRestrictionMigrationRefresh');
    expect(CLIENT_SRC).toContain("logStreetIntelEvent('cache_hit_restriction_refresh'");
  });

  it('Y. evaluated restriction cache does not refresh again', () => {
    expect(shouldCallRestrictionMigrationRefresh(1, true, false)).toBe(false);
    expect(shouldCallRestrictionMigrationRefresh(1, false, true)).toBe(false);
    expect(CLIENT_SRC).toContain('restrictionRefreshAttemptedRef');
  });
});
