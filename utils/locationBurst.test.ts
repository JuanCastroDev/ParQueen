import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  aggregateLocationSamples,
  collectLocationBurst,
  isCanonicalLocationReady,
  LOCATION_BURST_POLICY,
  locationBurstMaximumDurationMs,
  locationBurstWatchOptions,
  retainedCanonicalLocation,
  STREET_INTEL_QA_BURST_MAXIMUM_DURATION_MS,
  STREET_INTEL_QA_BURST_MINIMUM_UPDATE_INTERVAL_MS,
  STREET_INTEL_QA_BURST_UPDATE_INTERVAL_MS,
  type LocationSample,
} from './locationBurst';
import { resolveCanonicalCurbWithLocation } from './canonicalCurbClient';
import {
  LocationPositionError,
  POSITION_TIMEOUT,
  POSITION_UNAVAILABLE,
  type AppPosition,
  type AppPositionOptions,
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

describe('isCanonicalLocationReady', () => {
  const readyLocation = {
    lat: 40.7,
    lng: -73.9,
    accuracyMeters: 50,
    sampleCount: 3,
    consistencyMeters: 12,
  };

  it('accepts the existing canonical location boundary', () => {
    expect(isCanonicalLocationReady(readyLocation)).toBe(true);
  });

  it.each([
    ['one sample', { sampleCount: 1 }],
    ['two samples', { sampleCount: 2 }],
    ['poor accuracy', { accuracyMeters: 50.001 }],
    ['inconsistent samples', { consistencyMeters: 12.001 }],
  ])('rejects %s', (_label, override) => {
    expect(isCanonicalLocationReady({ ...readyLocation, ...override })).toBe(false);
  });
});

const position = (
  lat: number,
  lng: number,
  accuracy: number,
  timestampMs?: number,
): AppPosition => ({
  coords: { latitude: lat, longitude: lng, accuracy },
  ...(timestampMs === undefined ? {} : { timestampMs }),
});

describe('location burst timing isolation', () => {
  it('keeps the production window and exposes the QA window only by explicit flag', () => {
    expect(LOCATION_BURST_POLICY.maximumDurationMs).toBe(1_800);
    expect(locationBurstMaximumDurationMs(false)).toBe(1_800);
    expect(locationBurstMaximumDurationMs(true)).toBe(STREET_INTEL_QA_BURST_MAXIMUM_DURATION_MS);
    expect(STREET_INTEL_QA_BURST_MAXIMUM_DURATION_MS).toBe(10_000);
    expect(LOCATION_BURST_POLICY.minimumTargetSamples).toBe(3);
    expect(LOCATION_BURST_POLICY.targetSamples).toBe(5);
    expect(LOCATION_BURST_POLICY.maximumCanonicalAccuracyMeters).toBe(50);
    expect(LOCATION_BURST_POLICY.maximumCanonicalConsistencyMeters).toBe(12);
    expect(LOCATION_BURST_POLICY.maximumSeedAgeMs).toBe(5_000);
    expect(LOCATION_BURST_POLICY.maximumSampleAgeMs).toBe(10_000);
    expect(locationBurstWatchOptions(false, 1_800)).toEqual({
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 1_800,
    });
    expect(locationBurstWatchOptions(true, 10_000)).toEqual({
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10_000,
      interval: STREET_INTEL_QA_BURST_UPDATE_INTERVAL_MS,
      minimumUpdateInterval: STREET_INTEL_QA_BURST_MINIMUM_UPDATE_INTERVAL_MS,
    });
    expect(STREET_INTEL_QA_BURST_UPDATE_INTERVAL_MS).toBe(2_000);
    expect(STREET_INTEL_QA_BURST_MINIMUM_UPDATE_INTERVAL_MS).toBe(1_000);
  });
});

describe('collectLocationBurst', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stops as soon as three valid canonical-ready samples are collected', async () => {
    vi.useFakeTimers();
    let onSuccess: ((value: AppPosition) => void) | undefined;
    const clear = vi.fn();
    const startWatch = vi.fn((callback: (value: AppPosition) => void): LocationWatchHandle => {
      onSuccess = callback;
      return { clear };
    });

    const resultPromise = collectLocationBurst({ now: () => NOW, startWatch });
    for (let index = 0; index < 3; index += 1) {
      onSuccess?.(position(40.7 + index * 0.000001, -73.9, 6));
    }

    const result = await resultPromise;
    expect(result.sampleCount).toBe(3);
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
    for (let index = 0; index < 3; index += 1) {
      onSuccess?.(position(40.7 + index * 0.000001, -73.9, 6));
    }

    const result = await resultPromise;
    expect(result.sampleCount).toBe(3);
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

  it('accepts three fresh provider fixes spread over several seconds and stops early', async () => {
    vi.useFakeTimers();
    let clock = NOW;
    let onSuccess: ((value: AppPosition) => void) | undefined;
    const clear = vi.fn();
    const startWatch = vi.fn((
      callback: (value: AppPosition) => void,
      _onError?: (error: LocationPositionError) => void,
      options?: { timeout?: number },
    ): LocationWatchHandle => {
      onSuccess = callback;
      expect(options?.timeout).toBe(10_000);
      return { clear };
    });

    const resultPromise = collectLocationBurst({
      now: () => clock,
      startWatch,
      maximumDurationMs: 10_000,
    });
    onSuccess?.(position(40.7, -73.9, 6, NOW));
    clock = NOW + 3_000;
    onSuccess?.(position(40.700001, -73.9, 6, NOW + 3_000));
    expect(clear).not.toHaveBeenCalled();
    clock = NOW + 6_500;
    onSuccess?.(position(40.700002, -73.9, 7, NOW + 6_500));

    const result = await resultPromise;
    expect(result.sampleCount).toBe(3);
    expect(isCanonicalLocationReady(result)).toBe(true);
    expect(clear).toHaveBeenCalledOnce();
    expect(clock - NOW).toBeLessThan(10_000);
  });

  it('keeps a one-sample and a two-sample burst until the QA window ends', async () => {
    vi.useFakeTimers();
    const run = async (fixes: AppPosition[]) => {
      let onSuccess: ((value: AppPosition) => void) | undefined;
      const clear = vi.fn();
      const startWatch = (callback: (value: AppPosition) => void): LocationWatchHandle => {
        onSuccess = callback;
        return { clear };
      };
      const resultPromise = collectLocationBurst({
        now: () => NOW,
        startWatch,
        maximumDurationMs: 10_000,
      });
      fixes.forEach((fix) => onSuccess?.(fix));
      await vi.advanceTimersByTimeAsync(1_800);
      let settled = false;
      resultPromise.then(() => { settled = true; }, () => { settled = true; });
      await Promise.resolve();
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(8_200);
      const result = await resultPromise;
      expect(clear).toHaveBeenCalledOnce();
      return result;
    };

    await expect(run([position(40.7, -73.9, 6, NOW)])).resolves.toMatchObject({ sampleCount: 1 });
    await expect(run([
      position(40.7, -73.9, 6, NOW),
      position(40.700001, -73.9, 6, NOW + 1_000),
    ])).resolves.toMatchObject({ sampleCount: 2 });
  });

  it('does not count a repeated or stale provider fix as a new sample', async () => {
    vi.useFakeTimers();
    let onSuccess: ((value: AppPosition) => void) | undefined;
    const startWatch = (callback: (value: AppPosition) => void): LocationWatchHandle => {
      onSuccess = callback;
      return { clear: vi.fn() };
    };

    const resultPromise = collectLocationBurst({ now: () => NOW, startWatch });
    const repeated = position(40.7, -73.9, 6, NOW - 400);
    onSuccess?.(repeated);
    onSuccess?.(repeated);
    onSuccess?.(position(40.70002, -73.90002, 6, NOW - 400));
    onSuccess?.(position(40.71, -73.91, 6, NOW - 10_001));
    onSuccess?.(position(40.7, -73.9, 6));
    onSuccess?.(position(40.7, -73.9, 6));
    await vi.advanceTimersByTimeAsync(LOCATION_BURST_POLICY.maximumDurationMs);

    await expect(resultPromise).resolves.toMatchObject({
      lat: 40.7,
      lng: -73.9,
      sampleCount: 1,
    });
  });

  it('returns an aggregate that stays below the canonical accuracy gate', async () => {
    vi.useFakeTimers();
    let onSuccess: ((value: AppPosition) => void) | undefined;
    const startWatch = (callback: (value: AppPosition) => void): LocationWatchHandle => {
      onSuccess = callback;
      return { clear: vi.fn() };
    };
    const resultPromise = collectLocationBurst({ now: () => NOW, startWatch });
    for (let index = 0; index < 3; index += 1) {
      onSuccess?.(position(40.7 + index * 0.000001, -73.9, 60, NOW + index));
    }
    await vi.advanceTimersByTimeAsync(LOCATION_BURST_POLICY.maximumDurationMs);

    const result = await resultPromise;
    expect(result.sampleCount).toBe(3);
    expect(result.accuracyMeters).toBeGreaterThan(50);
    expect(isCanonicalLocationReady(result)).toBe(false);
  });

  it('returns an aggregate that stays above the consistency gate', async () => {
    vi.useFakeTimers();
    let onSuccess: ((value: AppPosition) => void) | undefined;
    const startWatch = (callback: (value: AppPosition) => void): LocationWatchHandle => {
      onSuccess = callback;
      return { clear: vi.fn() };
    };
    const resultPromise = collectLocationBurst({ now: () => NOW, startWatch });
    [0, 0.000126, 0.000252].forEach((offset, index) => {
      onSuccess?.(position(40.7 + offset, -73.9, 8, NOW + index));
    });
    await vi.advanceTimersByTimeAsync(LOCATION_BURST_POLICY.maximumDurationMs);

    const result = await resultPromise;
    expect(result.sampleCount).toBe(3);
    expect(result.consistencyMeters).toBeGreaterThan(12);
    expect(isCanonicalLocationReady(result)).toBe(false);
  });

  it('clears the temporary watch when the platform reports a timeout', async () => {
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
    const timeout = new LocationPositionError(POSITION_TIMEOUT, 'timeout', 'timed out');

    const resultPromise = collectLocationBurst({ now: () => NOW, startWatch });
    onError?.(timeout);

    await expect(resultPromise).rejects.toBe(timeout);
    expect(clear).toHaveBeenCalledOnce();
  });

  it('requests a two-second Android update interval only for the QA burst', async () => {
    vi.useFakeTimers();
    let clock = NOW;
    let onSuccess: ((value: AppPosition) => void) | undefined;
    const clear = vi.fn();
    let seen: AppPositionOptions | undefined;
    const startWatch = (
      callback: (value: AppPosition) => void,
      _onError?: (error: LocationPositionError) => void,
      options?: AppPositionOptions,
    ): LocationWatchHandle => {
      onSuccess = callback;
      seen = options;
      return { clear };
    };

    const resultPromise = collectLocationBurst({ now: () => clock, startWatch, qaBuild: true });
    expect(seen).toEqual({
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 10_000,
      interval: 2_000,
      minimumUpdateInterval: 1_000,
    });
    onSuccess?.(position(40.7, -73.9, 8, NOW));
    clock = NOW + 2_000;
    onSuccess?.(position(40.700001, -73.9, 8, NOW + 2_000));
    clock = NOW + 4_000;
    onSuccess?.(position(40.700002, -73.9, 8, NOW + 4_000));

    const result = await resultPromise;
    expect(result.sampleCount).toBe(3);
    expect(isCanonicalLocationReady(result)).toBe(true);
    expect(clock - NOW).toBeLessThan(10_000);
    expect(clear).toHaveBeenCalledOnce();
  });

  it('does not request a faster Android interval for the production burst', async () => {
    vi.useFakeTimers();
    let seen: AppPositionOptions | undefined;
    const startWatch = (
      callback: (value: AppPosition) => void,
      _onError?: (error: LocationPositionError) => void,
      options?: AppPositionOptions,
    ): LocationWatchHandle => {
      callback(position(40.7, -73.9, 8, NOW));
      seen = options;
      return { clear: vi.fn() };
    };

    const resultPromise = collectLocationBurst({ now: () => NOW, startWatch, qaBuild: false });
    await vi.advanceTimersByTimeAsync(1_800);

    await expect(resultPromise).resolves.toMatchObject({ sampleCount: 1 });
    expect(seen).toEqual({
      enableHighAccuracy: true,
      maximumAge: 0,
      timeout: 1_800,
    });
  });

  it('still rejects two samples collected on the faster QA interval', async () => {
    vi.useFakeTimers();
    let clock = NOW;
    let onSuccess: ((value: AppPosition) => void) | undefined;
    const startWatch = (callback: (value: AppPosition) => void): LocationWatchHandle => {
      onSuccess = callback;
      return { clear: vi.fn() };
    };
    const repeated = position(40.7, -73.9, 8, NOW);
    const resultPromise = collectLocationBurst({
      now: () => clock,
      startWatch,
      qaBuild: true,
    });
    onSuccess?.(repeated);
    onSuccess?.(repeated);
    onSuccess?.(position(40.70002, -73.9, 8, NOW));
    onSuccess?.(position(40.71, -73.91, 8, NOW - 10_001));
    clock = NOW + 2_000;
    onSuccess?.(position(40.700001, -73.9, 8, NOW + 2_000));
    await vi.advanceTimersByTimeAsync(10_000);

    const result = await resultPromise;
    expect(result.sampleCount).toBe(2);
    expect(isCanonicalLocationReady(result)).toBe(false);
    const invoke = vi.fn();
    await expect(resolveCanonicalCurbWithLocation({
      collectLocation: async () => result,
      invoke,
    })).resolves.toEqual({
      protocolVersion: 2,
      status: 'unsupported',
      reason: 'location_quality',
    });
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('fresh confirmation location', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not spend another four seconds when a canonical burst is still fresh', async () => {
    vi.useFakeTimers();
    let watches = 0;
    const startWatch = (callback: (value: AppPosition) => void): LocationWatchHandle => {
      watches += 1;
      setTimeout(() => callback(position(40.7, -73.9, 6)), 0);
      setTimeout(() => callback(position(40.700001, -73.9, 6)), 2_000);
      setTimeout(() => callback(position(40.700002, -73.9, 6)), 4_000);
      return { clear: vi.fn() };
    };
    const options = {
      now: () => NOW,
      startWatch,
      setTimer: setTimeout,
      clearTimer: clearTimeout,
      qaBuild: true as const,
    };
    const firstPromise = collectLocationBurst(options);
    await vi.advanceTimersByTimeAsync(3_999);
    let firstDone = false;
    void firstPromise.then(() => { firstDone = true; });
    await Promise.resolve();
    expect(firstDone).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const first = await firstPromise;
    expect(first.sampleCount).toBeGreaterThanOrEqual(LOCATION_BURST_POLICY.minimumTargetSamples);
    expect(first.accuracyMeters).toBeLessThanOrEqual(LOCATION_BURST_POLICY.maximumCanonicalAccuracyMeters);
    expect(watches).toBe(1);

    const reused = retainedCanonicalLocation(NOW + 1_000);
    expect(reused?.sampleCount).toBeGreaterThanOrEqual(LOCATION_BURST_POLICY.minimumTargetSamples);
    expect(isCanonicalLocationReady(reused)).toBe(true);
    expect(watches).toBe(1);

    expect(retainedCanonicalLocation(NOW + LOCATION_BURST_POLICY.maximumSampleAgeMs + 1)).toBeNull();
    const secondPromise = collectLocationBurst(options);
    await vi.advanceTimersByTimeAsync(4_000);
    const second = await secondPromise;
    expect(second.sampleCount).toBeGreaterThanOrEqual(LOCATION_BURST_POLICY.minimumTargetSamples);
    expect(watches).toBe(2);
  });
});
