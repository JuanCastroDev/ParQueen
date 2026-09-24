import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  countUsableSchedules,
  hasUsableSchedules,
  shouldCallEmptyCacheRefresh,
  logStreetIntelEvent,
  STREET_INTEL_REFRESH_DOMAIN,
} from './streetIntelRefresh';

const CLIENT_SRC = readFileSync(resolve(__dirname, '../views/StreetParkingView.tsx'), 'utf8');

describe('client empty-rules cache helper', () => {
  it('A. usable schedules skip refresh', () => {
    expect(hasUsableSchedules([{
      type: 'streetCleaning',
      schedules: [{ days: ['Mon'], startTime: '08:00', endTime: '10:00' }],
    }])).toBe(true);
    expect(shouldCallEmptyCacheRefresh(1, false)).toBe(false);
  });

  it('B. empty schedules refresh once', () => {
    expect(countUsableSchedules([{ type: 'streetCleaning', schedules: [] }])).toBe(0);
    expect(shouldCallEmptyCacheRefresh(0, false)).toBe(true);
    expect(CLIENT_SRC).toContain('from \'../utils/streetIntelRefresh\'');
  });

  it('G. a second empty match does not refresh', () => {
    expect(shouldCallEmptyCacheRefresh(0, true)).toBe(false);
  });

  it('H. logs stay privacy-safe JSON', () => {
    const lines: string[] = [];
    const payload = logStreetIntelEvent('cache_hit_usable', {
      via: 'nearby_80m',
      usableCount: 2,
      uid: 'u',
      streetName: 'x',
      segmentId: 'nyc_1',
    }, line => lines.push(line));
    const parsed = JSON.parse(lines[0]);
    expect(parsed.domain).toBe(STREET_INTEL_REFRESH_DOMAIN);
    expect(parsed.event).toBe('cache_hit_usable');
    expect(parsed.message).toBe('cache_hit_usable');
    expect(payload).not.toHaveProperty('uid');
    expect(payload).not.toHaveProperty('streetName');
    expect(payload).not.toHaveProperty('segmentId');
  });
});
