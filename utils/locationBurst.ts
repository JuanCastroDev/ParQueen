import { streetIntelQaBuild } from './demoFirebase';
import {
  watchPosition,
  type AppPosition,
  type AppPositionOptions,
  type LocationPositionError,
  type LocationWatchHandle,
} from './geolocation';

export interface LocationSample {
  lat: number;
  lng: number;
  accuracyMeters: number;
  timestampMs: number;
  /** Platform clock of this fix, when the device reported one. */
  providerTimestampMs?: number;
}

export interface AggregatedLocation {
  lat: number;
  lng: number;
  accuracyMeters: number;
  sampleCount: number;
  consistencyMeters: number;
}

export const LOCATION_BURST_POLICY = {
  targetSamples: 5,
  minimumTargetSamples: 3,
  maximumDurationMs: 1_800,
  maximumSeedAgeMs: 5_000,
  maximumSampleAgeMs: 10_000,
  maximumReportedAccuracyMeters: 100,
  maximumCanonicalAccuracyMeters: 50,
  maximumCanonicalConsistencyMeters: 12,
  accuracyFloorMeters: 3,
  minimumOutlierDistanceMeters: 15,
  oldestSampleFreshnessWeight: 0.5,
} as const;

/** Isolated Street Intelligence QA only. Production keeps maximumDurationMs at 1,800. */
export const STREET_INTEL_QA_BURST_MAXIMUM_DURATION_MS = 10_000;
export const STREET_INTEL_QA_BURST_UPDATE_INTERVAL_MS = 2_000;
export const STREET_INTEL_QA_BURST_MINIMUM_UPDATE_INTERVAL_MS = 1_000;

export const locationBurstMaximumDurationMs = (qaBuild: boolean): number => (
  qaBuild
    ? STREET_INTEL_QA_BURST_MAXIMUM_DURATION_MS
    : LOCATION_BURST_POLICY.maximumDurationMs
);

export const locationBurstWatchOptions = (
  qaBuild: boolean,
  maximumDurationMs: number,
): AppPositionOptions => {
  const options: AppPositionOptions = {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: maximumDurationMs,
  };
  if (!qaBuild) return options;
  return {
    ...options,
    interval: STREET_INTEL_QA_BURST_UPDATE_INTERVAL_MS,
    minimumUpdateInterval: STREET_INTEL_QA_BURST_MINIMUM_UPDATE_INTERVAL_MS,
  };
};

let qaSampleOffsetsMs: number[] | null = null;

/** Relative provider-fix times from the latest QA burst. Production leaves this empty. */
export const readStreetIntelQaBurstTiming = (): readonly number[] | null => qaSampleOffsetsMs;

let retainedCanonicalSamples: LocationSample[] | null = null;

/** A confirmation may reuse a burst only while every sample is still inside the freshness window. */
export const retainedCanonicalLocation = (
  nowMs = Date.now(),
): AggregatedLocation | null => {
  const samples = retainedCanonicalSamples;
  if (!samples || samples.some(sample => !isValidSample(sample, nowMs))) return null;
  const aggregate = aggregateLocationSamples(samples, nowMs);
  return isCanonicalLocationReady(aggregate) ? aggregate : null;
};

const retainCanonicalSamples = (
  samples: readonly LocationSample[],
  aggregate: AggregatedLocation | null,
): void => {
  retainedCanonicalSamples = isCanonicalLocationReady(aggregate)
    ? samples.map(sample => ({ ...sample }))
    : null;
};

export const isCanonicalLocationReady = (
  location: AggregatedLocation | null,
): location is AggregatedLocation =>
  location !== null
  && location.sampleCount >= LOCATION_BURST_POLICY.minimumTargetSamples
  && location.accuracyMeters <= LOCATION_BURST_POLICY.maximumCanonicalAccuracyMeters
  && location.consistencyMeters <= LOCATION_BURST_POLICY.maximumCanonicalConsistencyMeters;

const EARTH_RADIUS_METERS = 6_371_000;

const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

const distanceMeters = (a: LocationSample, b: LocationSample): number => {
  const deltaLat = toRadians(b.lat - a.lat);
  const deltaLng = toRadians(b.lng - a.lng);
  const aLat = toRadians(a.lat);
  const bLat = toRadians(b.lat);
  const haversine =
    Math.sin(deltaLat / 2) ** 2
    + Math.cos(aLat) * Math.cos(bLat) * Math.sin(deltaLng / 2) ** 2;

  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(haversine));
};

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
};

const isValidSample = (
  sample: LocationSample,
  nowMs: number,
  maximumAgeMs: number = LOCATION_BURST_POLICY.maximumSampleAgeMs,
): boolean =>
  Number.isFinite(sample.lat)
  && Number.isFinite(sample.lng)
  && Number.isFinite(sample.accuracyMeters)
  && Number.isFinite(sample.timestampMs)
  && sample.lat >= -90
  && sample.lat <= 90
  && sample.lng >= -180
  && sample.lng <= 180
  && sample.accuracyMeters > 0
  && sample.accuracyMeters <= LOCATION_BURST_POLICY.maximumReportedAccuracyMeters
  && sample.timestampMs <= nowMs
  && nowMs - sample.timestampMs <= maximumAgeMs;

export const aggregateLocationSamples = (
  samples: readonly LocationSample[],
  nowMs = Date.now(),
): AggregatedLocation | null => {
  const validSamples = samples.filter((sample) => isValidSample(sample, nowMs));
  if (validSamples.length === 0) {
    return null;
  }

  const medoid = validSamples.reduce((best, candidate) => {
    const candidateDistance = validSamples.reduce(
      (total, other) => total + distanceMeters(candidate, other),
      0,
    );
    const bestDistance = validSamples.reduce(
      (total, other) => total + distanceMeters(best, other),
      0,
    );
    return candidateDistance < bestDistance ? candidate : best;
  });
  const medianAccuracy = median(validSamples.map(({ accuracyMeters }) => accuracyMeters));
  const consistentSamples = validSamples.filter((sample) => {
    const thresholdMeters = Math.max(
      LOCATION_BURST_POLICY.minimumOutlierDistanceMeters,
      2 * (sample.accuracyMeters + medianAccuracy),
    );
    return distanceMeters(sample, medoid) <= thresholdMeters;
  });

  if (consistentSamples.length === 1) {
    const [onlySample] = consistentSamples;
    return {
      lat: onlySample.lat,
      lng: onlySample.lng,
      accuracyMeters: Math.max(
        onlySample.accuracyMeters,
        LOCATION_BURST_POLICY.accuracyFloorMeters,
      ),
      sampleCount: 1,
      consistencyMeters: 0,
    };
  }

  const weighted = consistentSamples.map((sample) => {
    const ageFraction = (nowMs - sample.timestampMs)
      / LOCATION_BURST_POLICY.maximumSampleAgeMs;
    const freshness = 1 - ageFraction
      * (1 - LOCATION_BURST_POLICY.oldestSampleFreshnessWeight);
    const modeledAccuracy = Math.max(
      sample.accuracyMeters,
      LOCATION_BURST_POLICY.accuracyFloorMeters,
    );
    return {
      sample,
      weight: freshness / modeledAccuracy ** 2,
    };
  });
  const totalWeight = weighted.reduce((total, item) => total + item.weight, 0);
  const lat = weighted.reduce(
    (total, item) => total + item.sample.lat * item.weight,
    0,
  ) / totalWeight;
  const lng = weighted.reduce(
    (total, item) => total + item.sample.lng * item.weight,
    0,
  ) / totalWeight;
  const aggregateSample: LocationSample = {
    lat,
    lng,
    accuracyMeters: LOCATION_BURST_POLICY.accuracyFloorMeters,
    timestampMs: nowMs,
  };
  const consistencyMeters = consistentSamples.reduce(
    (maximum, sample) => Math.max(maximum, distanceMeters(sample, aggregateSample)),
    0,
  );
  const reportedAccuracyMeters = weighted.reduce(
    (total, item) => total + item.sample.accuracyMeters * item.weight,
    0,
  ) / totalWeight;

  return {
    lat,
    lng,
    accuracyMeters: Math.max(
      reportedAccuracyMeters,
      consistencyMeters,
      LOCATION_BURST_POLICY.accuracyFloorMeters,
    ),
    sampleCount: consistentSamples.length,
    consistencyMeters,
  };
};

type StartWatch = (
  onSuccess: (position: AppPosition) => void,
  onError?: (error: LocationPositionError) => void,
  options?: Parameters<typeof watchPosition>[2],
) => LocationWatchHandle;

const sameReading = (left: LocationSample, right: LocationSample): boolean =>
  left.lat === right.lat
  && left.lng === right.lng
  && left.accuracyMeters === right.accuracyMeters;

const acceptDistinctSample = (
  samples: LocationSample[],
  nextSample: LocationSample,
  observedAt: number,
): boolean => {
  const providerTimestampMs = nextSample.providerTimestampMs;
  if (providerTimestampMs != null) {
    const providerAgeMs = observedAt - providerTimestampMs;
    if (providerAgeMs > LOCATION_BURST_POLICY.maximumSampleAgeMs) return false;
    if (samples.some((sample) => sample.providerTimestampMs === providerTimestampMs)) return false;
  } else if (samples.some((sample) => sameReading(sample, nextSample))) {
    return false;
  }
  if (!isValidSample(nextSample, observedAt)) return false;
  samples.push(nextSample);
  return true;
};

export async function collectLocationBurst(input: {
  seed?: LocationSample | null;
  now?: () => number;
  startWatch?: StartWatch;
  setTimer?: typeof setTimeout;
  clearTimer?: typeof clearTimeout;
  maximumDurationMs?: number;
  qaBuild?: boolean;
} = {}): Promise<AggregatedLocation> {
  const now = input.now ?? Date.now;
  const startWatch = input.startWatch ?? watchPosition;
  const setTimer = input.setTimer ?? setTimeout;
  const clearTimer = input.clearTimer ?? clearTimeout;
  const qaBuild = input.qaBuild ?? streetIntelQaBuild();
  const maximumDurationMs = input.maximumDurationMs
    ?? locationBurstMaximumDurationMs(qaBuild);
  const samples: LocationSample[] = [];
  const sampleOffsetsMs: number[] = [];
  let sampleOriginMs: number | null = null;
  qaSampleOffsetsMs = qaBuild ? sampleOffsetsMs : null;
  const noteSample = (sample: LocationSample): void => {
    if (!qaBuild) return;
    const mark = sample.providerTimestampMs ?? sample.timestampMs;
    if (sampleOriginMs == null) sampleOriginMs = mark;
    sampleOffsetsMs.push(mark - sampleOriginMs);
  };
  const startedAt = now();

  if (
    input.seed
    && isValidSample(input.seed, startedAt, LOCATION_BURST_POLICY.maximumSeedAgeMs)
  ) {
    samples.push(input.seed);
    noteSample(input.seed);
  }

  return new Promise<AggregatedLocation>((resolve, reject) => {
    let settled = false;
    let watchHandle: LocationWatchHandle | undefined;
    let clearWatchWhenAvailable = false;

    const clearWatch = (): void => {
      if (watchHandle) watchHandle.clear();
      else clearWatchWhenAvailable = true;
    };
    const timer = setTimer(() => {
      finish();
    }, maximumDurationMs);
    const cleanup = (): void => {
      clearTimer(timer);
      clearWatch();
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const finish = (): void => {
      if (settled) return;
      const aggregate = aggregateLocationSamples(samples, now());
      if (!aggregate) {
        retainCanonicalSamples(samples, null);
        fail(new Error('No valid location samples'));
        return;
      }
      retainCanonicalSamples(samples, aggregate);
      settled = true;
      cleanup();
      resolve(aggregate);
    };

    try {
      watchHandle = startWatch(
        (position) => {
          if (settled) return;
          const observedAt = now();
          const providerTimestampMs = Number.isFinite(position.timestampMs)
            ? position.timestampMs
            : undefined;
          const nextSample: LocationSample = {
            lat: position.coords.latitude,
            lng: position.coords.longitude,
            accuracyMeters: position.coords.accuracy ?? Number.NaN,
            timestampMs: observedAt,
            ...(providerTimestampMs === undefined ? {} : { providerTimestampMs }),
          };
          if (!acceptDistinctSample(samples, nextSample, observedAt)) return;
          noteSample(nextSample);
          const aggregate = aggregateLocationSamples(samples, observedAt);
          if (
            isCanonicalLocationReady(aggregate)
            || samples.length >= LOCATION_BURST_POLICY.targetSamples
          ) {
            finish();
          }
        },
        fail,
        locationBurstWatchOptions(qaBuild, maximumDurationMs),
      );
      if (clearWatchWhenAvailable) watchHandle.clear();
    } catch (error) {
      fail(error);
    }
  });
}
