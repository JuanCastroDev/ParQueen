import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  aggregateLocationSamples,
  collectLocationBurst,
  LOCATION_BURST_POLICY,
  type LocationSample,
} from './locationBurst';
import {
  LocationPositionError,
  POSITION_UNAVAILABLE,
  type AppPosition,
  type LocationWatchHandle,
} from './geolocation';

const NOW = 1_000_000;

const sample = (
  lat: number,
  lng: number,
  accuracyMeters: number,
  ageMs = 0,
): LocationSample => ({
  lat,
  lng,
  accuracyMeters,
  timestampMs: NOW - ageMs,
});

describe('aggregateLocationSamples', () => {
  it('returns a one-sample aggregate without inventing more samples', () => {
    expect(aggregateLocationSamples([sample(40.7, -73.9, 1)], NOW)).toEqual({
      lat: 40.7,
      lng: -73.9,
      accuracyMeters: 3,
      sampleCount: 1,
      consistencyMeters: 0,
    });
  });

  it('rejects stale invalid and worse-than-100m samples', () => {
    const result = aggregateLocationSamples(
      [
        sample(40.7, -73.9, 8),
        sample(40.71, -73.91, 8, 10_001),
        sample(Number.NaN, -73.9, 8),
        sample(40.7, -73.9, 101),
      ],
      NOW,
    );

    expect(result).toMatchObject({ lat: 40.7, lng: -73.9, sampleCount: 1 });
  });

  it('rejects a distant outlier', () => {
    const result = aggregateLocationSamples(
      [
        sample(40.700000, -73.900000, 5),
        sample(40.700020, -73.900020, 5),
        sample(40.710000, -73.910000, 5),
      ],
      NOW,
    );

    expect(result.sampleCount).toBe(2);
    expect(result.lat).toBeGreaterThan(40.7);
    expect(result.lat).toBeLessThan(40.70003);
    expect(result.lng).toBeLessThan(-73.9);
    expect(result.lng).toBeGreaterThan(-73.90003);
    expect(result.consistencyMeters).toBeLessThan(5);
  });

  it('weights accurate fresh samples more heavily', () => {
    const result = aggregateLocationSamples(
      [
        sample(40.700000, -73.900000, 4, 100),
        sample(40.700060, -73.900060, 12, 2_000),
      ],
      NOW,
    );

    expect(result?.lat).toBeCloseTo(40.70000548, 8);
    expect(result?.lng).toBeCloseTo(-73.90000548, 8);
    expect(result.accuracyMeters).toBeGreaterThanOrEqual(4);
    expect(result.sampleCount).toBe(2);
  });

  it('uses the policy floor for aggregate accuracy', () => {
    expect(LOCATION_BURST_POLICY.accuracyFloorMeters).toBe(3);
    expect(
      aggregateLocationSamples(
        [sample(40.7, -73.9, 101), sample(40.7, -73.9, 5, 10_001)],
        NOW,
      ),
    ).toBeNull();
  });
});

const position = (lat: number, lng: number, accuracy: number): AppPosition => ({
  coords: { latitude: lat, longitude: lng, accuracy },
});

describe('collectLocationBurst', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops on five valid samples and returns no raw samples', async () => {
    vi.useFakeTimers();
    let onSuccess: ((value: AppPosition) => void) | undefined;
    const clear = vi.fn();
    const startWatch = vi.fn((callback: (value: AppPosition) => void): LocationWatchHandle => {
      onSuccess = callback;
      return { clear };
    });

    const resultPromise = collectLocationBurst({ now: () => NOW, startWatch });
    for (let index = 0; index < 5; index += 1) {
      onSuccess?.(position(40.7 + index * 0.000001, -73.9, 6));
    }

    const result = await resultPromise;
    expect(result.sampleCount).toBe(5);
    expect(Object.keys(result).sort()).toEqual([
      'accuracyMeters',
      'consistencyMeters',
      'lat',
      'lng',
      'sampleCount',
    ]);
    expect(clear).toHaveBeenCalledOnce();
  });

  it('stops by 1.8 seconds and clears its temporary watch', async () => {
    vi.useFakeTimers();
    let onSuccess: ((value: AppPosition) => void) | undefined;
    const clear = vi.fn();
    const startWatch = (callback: (value: AppPosition) => void): LocationWatchHandle => {
      onSuccess = callback;
      return { clear };
    };

    const resultPromise = collectLocationBurst({ now: () => NOW, startWatch });
    onSuccess?.(position(40.7, -73.9, 8));
    await vi.advanceTimersByTimeAsync(LOCATION_BURST_POLICY.maximumDurationMs);

    await expect(resultPromise).resolves.toMatchObject({ sampleCount: 1 });
    expect(clear).toHaveBeenCalledOnce();
  });

  it('seeds only from a foreground sample no older than five seconds', async () => {
    vi.useFakeTimers();
    let onSuccess: ((value: AppPosition) => void) | undefined;
    const startWatch = (callback: (value: AppPosition) => void): LocationWatchHandle => {
      onSuccess = callback;
      return { clear: vi.fn() };
    };
    const oldSeed = sample(40.8, -74, 4, 5_001);

    const resultPromise = collectLocationBurst({ seed: oldSeed, now: () => NOW, startWatch });
    for (let index = 0; index < 5; index += 1) {
      onSuccess?.(position(40.7 + index * 0.000001, -73.9, 6));
    }

    const result = await resultPromise;
    expect(result.sampleCount).toBe(5);
    expect(result.lat).toBeLessThan(40.71);
  });

  it('clears the temporary watch when collection fails', async () => {
    vi.useFakeTimers();
    let onError: ((error: LocationPositionError) => void) | undefined;
    const clear = vi.fn();
    const startWatch = (
      _onSuccess: (value: AppPosition) => void,
      errorCallback?: (error: LocationPositionError) => void,
    ): LocationWatchHandle => {
      onError = errorCallback;
      return { clear };
    };
    const failure = new LocationPositionError(
      POSITION_UNAVAILABLE,
      'unavailable',
      'location failed',
    );

    const resultPromise = collectLocationBurst({ now: () => NOW, startWatch });
    onError?.(failure);

    await expect(resultPromise).rejects.toBe(failure);
    expect(clear).toHaveBeenCalledOnce();
  });
});
