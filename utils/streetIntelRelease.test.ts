import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { computeSafeUntil } from './streetIntelligence';
import { countUsableStreetIntelligence, shouldCallEmptyCacheRefresh, shouldCallRestrictionMigrationRefresh } from './streetIntelRefresh';

const INDEX_SRC = readFileSync(resolve(__dirname, '../functions/index.js'), 'utf8');
const CLIENT_SRC = readFileSync(resolve(__dirname, '../views/StreetParkingView.tsx'), 'utf8');
const LOG_SRC = readFileSync(resolve(__dirname, '../functions/streetIntelStructuredLog.js'), 'utf8');

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
