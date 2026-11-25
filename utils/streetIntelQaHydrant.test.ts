import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { readQaHydrantFixture, STREET_INTEL_QA_HYDRANT_KEY } from './streetIntelQaHydrant';

function storage(value: string | null) {
  return { getItem: (key: string) => (key === STREET_INTEL_QA_HYDRANT_KEY ? value : null) };
}

describe('readQaHydrantFixture', () => {
  it('ignores a planted fixture outside the QA package build', () => {
    expect(readQaHydrantFixture({
      qaBuild: false,
      storage: storage(JSON.stringify({ status: 'found', meters: 40 })),
    })).toBeNull();
  });

  it('returns a recorded clear distance only for the QA package build', () => {
    expect(readQaHydrantFixture({
      qaBuild: true,
      storage: storage(JSON.stringify({ status: 'found', meters: 40 })),
    })).toEqual({ status: 'found', meters: 40 });
  });

  it('rejects a found result without a finite distance', () => {
    expect(readQaHydrantFixture({
      qaBuild: true,
      storage: storage(JSON.stringify({ status: 'found', meters: null })),
    })).toBeNull();
  });

  it('returns the QA fixture before the hydrant callable', () => {
    const source = readFileSync(new URL('../views/assistant/HydrantDistanceTool.tsx', import.meta.url), 'utf8');
    const fixtureAt = source.indexOf('const fixture = readQaHydrantFixture()');
    const callableAt = source.indexOf("httpsCallable<{ lat: number; lng: number }, HydrantLookup>(");
    expect(fixtureAt).toBeGreaterThan(0);
    expect(callableAt).toBeGreaterThan(fixtureAt);
  });

  it('accepts an explicit empty search without inventing a distance', () => {
    expect(readQaHydrantFixture({
      qaBuild: true,
      storage: storage(JSON.stringify({ status: 'none_nearby', meters: null })),
    })).toEqual({ status: 'none_nearby', meters: null });
  });
});
