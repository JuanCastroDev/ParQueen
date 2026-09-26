import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { computeSafeUntil } from './streetIntelligence';
import { countUsableStreetIntelligence, shouldCallEmptyCacheRefresh, shouldCallRestrictionMigrationRefresh } from './streetIntelRefresh';

const INDEX_SRC = readFileSync(resolve(__dirname, '../functions/index.js'), 'utf8');
const CLIENT_SRC = readFileSync(resolve(__dirname, '../views/StreetParkingView.tsx'), 'utf8');
const LOG_SRC = readFileSync(resolve(__dirname, '../functions/streetIntelStructuredLog.js'), 'utf8');
const ORCHESTRATOR_SRC = readFileSync(
  resolve(__dirname, '../functions/curbIntelligence/canonicalCurbOrchestrator.js'),
  'utf8',
);
const RULE_SOURCES_SRC = readFileSync(
  resolve(__dirname, '../functions/curbIntelligence/canonicalRuleSources.js'),
  'utf8',
);
const IDENTITY_SRC = readFileSync(
  resolve(__dirname, '../functions/curbIntelligence/canonicalCurbIdentity.js'),
  'utf8',
);
const POLICY_SRC = readFileSync(
  resolve(__dirname, '../functions/curbIntelligence/curbResolutionPolicy.js'),
  'utf8',
);
const CLIENT_CONTRACT_SRC = readFileSync(resolve(__dirname, './canonicalCurbClient.ts'), 'utf8');
const LOCATION_BURST_SRC = readFileSync(resolve(__dirname, './locationBurst.ts'), 'utf8');
const SELECTOR_SRC = readFileSync(
  resolve(__dirname, '../views/street-parking/VisualCurbSelector.tsx'),
  'utf8',
);
const CONFIG_SRC = readFileSync(
  resolve(__dirname, '../functions/.env.parkqueen-46475363-ccf36'),
  'utf8',
);
const CONFIG_MODULE_SRC = readFileSync(
  resolve(__dirname, '../functions/curbIntelligence/privateBlockfaceResolverConfig.js'),
  'utf8',
);

const between = (source: string, start: string, end: string): string => {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return source.slice(startIndex, endIndex);
};

describe('Street Intelligence 2A.27–2A.30 release gates', () => {
  it('documents the command that validates this stack', () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, '../package.json'), 'utf8'));
    expect(pkg.scripts['test:street-intel']).toContain('utils/streetIntelRelease.test.ts');
  });

  it('keeps empty-cache and restriction migration one-shot, with in-flight save dedup', () => {
    expect(shouldCallEmptyCacheRefresh(0, false)).toBe(true);
    expect(shouldCallEmptyCacheRefresh(0, true)).toBe(false);
    expect(shouldCallRestrictionMigrationRefresh(1, false, false)).toBe(true);
    expect(shouldCallRestrictionMigrationRefresh(1, true, false)).toBe(false);
    expect(CLIENT_SRC).toContain('runMatchNearestSegment');
    expect(CLIENT_SRC).toContain('saveInFlightRef');
  });

  it('writes structured Cloud Logging objects instead of JSON strings', () => {
    expect(LOG_SRC).toContain('sink.info(payload)');
    expect(LOG_SRC).toContain('jsonPayload');
    expect(INDEX_SRC).toContain('logMeterEvent');
    expect(INDEX_SRC).toContain('logRestrictionEvent');
  });

  it('does not let meters or time limits beat a prohibition SAFE UNTIL', () => {
    const now = new Date('2026-08-24T10:00:00-04:00');
    const cleaning = [{ side: 'West', days: ['Tue'], startTime: '08:30', endTime: '09:00' }];
    const standing = [{
      side: 'West', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], startTime: '16:00', endTime: '19:00', type: 'noStanding' as const,
    }];
    const timeLimit = [{
      side: 'West', days: ['Mon'], startTime: '09:00', endTime: '19:00', type: 'timeLimited' as const,
    }];
    const mixed = computeSafeUntil([...cleaning, ...standing, ...timeLimit], 'West', [], now);
    expect(mixed.nextTime).toBe('4 PM');
    expect(mixed.restrictionKind).toBe('noStanding');
  });

  it('counts cleaning, meter, and prohibition caches as usable', () => {
    expect(countUsableStreetIntelligence([{
      type: 'curbRestrictionSet',
      schedules: [{ days: ['Mon'], startTime: '16:00', endTime: '19:00' }],
    }])).toBe(1);
  });

  it('keeps Curb product/sample/mode contracts unchanged', () => {
    expect(INDEX_SRC).not.toMatch(/CURB_SHADOW_SAMPLE_PERMILLE\s*=/);
    expect(INDEX_SRC).not.toMatch(/maxScale\s*:/);
  });
});

describe('Street Intelligence 2A.32 release gates', () => {
  it('keeps the normal V2 save path to one location burst and one canonical request', () => {
    const saveFlow = between(CLIENT_SRC, 'const saveMySpot = async () => {', '// Used after handoff');
    const requestFlow = between(
      CLIENT_SRC,
      'const requestCanonicalCurb = useCallback(async (',
      '// Pre-V2 sessions remain readable',
    );
    expect(requestFlow.match(/collectLocationBurst\(/g) ?? []).toHaveLength(1);
    expect(requestFlow.match(/httpsCallable\(/g) ?? []).toHaveLength(1);
    expect(saveFlow.match(/requestCanonicalCurb\(/g) ?? []).toHaveLength(1);
    expect(saveFlow).not.toContain('runMatchNearestSegment');
    expect(saveFlow).not.toContain('geohashQueryBounds');
    expect(saveFlow).not.toContain('nearby_80m');
  });

  it('resolves one canonical identity before every rule source lookup', () => {
    expect(ORCHESTRATOR_SRC.indexOf('const identity = resolution.identity;'))
      .toBeLessThan(ORCHESTRATOR_SRC.indexOf('await loadRules(identity, dependencies)'));
    expect(RULE_SOURCES_SRC).toContain('const sourceInput = { identity, signal: options.signal };');
    expect(RULE_SOURCES_SRC.match(/boundedLookup\([^,]+, sourceInput, options\)/g)).toHaveLength(4);
    expect(RULE_SOURCES_SRC).not.toMatch(/boundedLookup\([^,]+,\s*\{[^}]*lat/i);
  });

  it('does not expose private canonical identifiers through public or client contracts', () => {
    const publicSerializer = between(IDENTITY_SRC, 'function toPublicCurb(identity)', 'module.exports');
    const forbidden = [
      'officialBlockFaceId', 'csclSide', 'sourceVersion', 'selectedGlobalId',
      'supportingGlobalIds', 'physicalId', 'b5sc',
    ];
    for (const privateField of forbidden) {
      expect(publicSerializer).not.toContain(privateField);
      expect(CLIENT_CONTRACT_SRC).not.toContain(privateField);
      expect(SELECTOR_SRC).not.toContain(privateField);
    }
  });

  it('keeps the canonical orchestration single-shot and within its latency budget', () => {
    expect(ORCHESTRATOR_SRC).toContain('const OVERALL_DEADLINE_MS = 8000;');
    expect(POLICY_SRC).toContain('planimetricDeadlineMs: 900');
    expect(POLICY_SRC).toContain('sourceDeadlineMs: 2500');
    expect(LOCATION_BURST_SRC).toContain('maximumDurationMs: 1_800');
    expect(ORCHESTRATOR_SRC).not.toMatch(/\bretry\b/i);
    expect(ORCHESTRATOR_SRC).not.toContain('setInterval');
    expect(RULE_SOURCES_SRC).not.toMatch(/\bretry\b/i);
    expect(RULE_SOURCES_SRC).not.toContain('setInterval');
  });

  it('preserves the approved deployment switches and callable runtime contract', () => {
    expect(CONFIG_SRC).toMatch(/^CURB_RESOLVER_MODE=shadow$/m);
    expect(CONFIG_SRC).toMatch(/^CURB_SHADOW_SAMPLE_PERMILLE=100$/m);
    expect(CONFIG_SRC).toMatch(/^CURB_PRODUCT_PATH=on$/m);
    expect(CONFIG_MODULE_SRC).toContain("defineString('CURB_RESOLVER_MODE', { default: 'off' })");
    expect(CONFIG_MODULE_SRC).toContain("defineString('CURB_SHADOW_SAMPLE_PERMILLE', { default: '0' })");
    expect(CONFIG_MODULE_SRC).toContain("defineString('CURB_PRODUCT_PATH', { default: 'off' })");

    const callable = between(
      INDEX_SRC,
      'exports.createSegmentFromSweepNYC = onCall(',
      'function _existingNYCOpenDataResult',
    );
    expect(callable).toContain("serviceAccount: 'parqueen-curb-caller@parkqueen-46475363-ccf36.iam.gserviceaccount.com'");
    expect(callable).not.toMatch(/maxScale\s*:/);
    expect(callable).not.toMatch(/concurrency\s*:/);
    expect(callable).not.toMatch(/retry\s*:/);
  });

  it('uses the visual two-curb selector instead of a compass chooser for V2 ambiguity', () => {
    const v2CardFlow = between(
      CLIENT_SRC,
      "savedSpot.curbResolutionStatus === 'ambiguous'",
      'savedSpot.segmentId && savedSpot.segmentStreetName',
    );
    expect(v2CardFlow).toContain('<VisualCurbSelector');
    expect(v2CardFlow).not.toContain('onConfirmSide');
    expect(SELECTOR_SRC).not.toMatch(/['\"](?:North|South|East|West)['\"]/);
    expect(SELECTOR_SRC).toContain('selector.candidates.map');
  });
});
