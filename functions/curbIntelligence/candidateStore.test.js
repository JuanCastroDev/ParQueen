import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createMemoryCandidateStore } = require('./candidateStore');

const record = (id, lng) => ({
  globalId: id,
  geometry: { type: 'MultiLineString', coordinates: [[[lng, 40.71], [lng, 40.711]]] },
});

describe('candidate-store contract', () => {
  it('returns a bounded broad candidate set with explicit complete state', async () => {
    const store = createMemoryCandidateStore([record('a', -74.001), record('b', -73.99)], {
      maxCandidates: 10,
      coverageEnvelope: { minLat: 40.6, maxLat: 40.8, minLng: -74.1, maxLng: -73.9 },
    });
    const result = await store.queryCandidates({
      lat: 40.71, lng: -74.001, searchRadiusMeters: 200,
      envelope: { minLat: 40.708, maxLat: 40.712, minLng: -74.004, maxLng: -73.998 },
    });
    expect(result.completeness).toEqual({ state: 'COMPLETE', reason: null });
    expect(result.candidates.map(item => item.globalId)).toEqual(['a']);
  });

  it('marks truncation and coverage gaps explicitly rather than claiming completeness', async () => {
    const store = createMemoryCandidateStore([record('a', -74.001), record('b', -74.0005)], {
      maxCandidates: 1,
      coverageEnvelope: { minLat: 40.7, maxLat: 40.72, minLng: -74.01, maxLng: -73.99 },
    });
    const truncated = await store.queryCandidates({
      lat: 40.71, lng: -74, searchRadiusMeters: 500,
      envelope: { minLat: 40.705, maxLat: 40.715, minLng: -74.005, maxLng: -73.995 },
    });
    expect(truncated.candidates).toHaveLength(1);
    expect(truncated.completeness).toEqual({ state: 'INCOMPLETE', reason: 'candidate_limit_reached' });

    const outside = await store.queryCandidates({
      lat: 40.71, lng: -74, searchRadiusMeters: 500,
      envelope: { minLat: 40.69, maxLat: 40.73, minLng: -74.02, maxLng: -73.98 },
    });
    expect(outside.completeness).toEqual({ state: 'INCOMPLETE', reason: 'coverage_gap' });
  });

  it('fails closed for invalid or unbounded query input', async () => {
    const store = createMemoryCandidateStore([]);
    await expect(store.queryCandidates({ lat: 40.7, lng: -74 })).resolves.toEqual({
      candidates: [], completeness: { state: 'INCOMPLETE', reason: 'invalid_query' },
    });
    await expect(store.queryCandidates({
      lat: 40.7, lng: -74, searchRadiusMeters: 50,
      envelope: { minLat: 40.8, maxLat: 40.7, minLng: -73.9, maxLng: -74.1 },
    })).resolves.toEqual({
      candidates: [], completeness: { state: 'INCOMPLETE', reason: 'invalid_query' },
    });
  });
});
