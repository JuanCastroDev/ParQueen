import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  runCanonicalCurbOrchestrator,
  OVERALL_DEADLINE_MS,
  CSCL_SOURCE_BUDGET_MS,
} = require('./canonicalCurbOrchestrator');
const { createPrivateBlockfaceResolver } = require('./privateBlockfaceResolver');

const location = Object.freeze({
  lat: 40.7,
  lng: -73.9999,
  accuracyMeters: 5,
  sampleCount: 4,
  consistencyMeters: 4,
});
const request = () => ({ protocolVersion: 2, location });
const metadata = { id: 'inkn-q76z', rowsUpdatedAt: 1767225600, viewLastModified: 1767225660 };
const segment = {
  globalid: 'private-global',
  physicalid: 'private-global-physical',
  b5sc: 'private-b5sc',
  l_blockfaceid: '1000000001',
  r_blockfaceid: '1000000002',
  boroughcode: '2',
  rw_type: '1',
  full_street_name: 'MARAN PLACE',
  street_name: 'MARAN PLACE',
  stname_label: 'MARAN PLACE',
  streetwidth: '34',
  from_level_code: '13',
  to_level_code: '13',
  status: '2',
  nonped: '',
  accessible: '',
  from_street: 'WHITE PLAINS ROAD',
  to_street: 'LURTING AVENUE',
  the_geom: { type: 'MultiLineString', coordinates: [[[-74.001, 40.69992], [-73.999, 40.69992]]] },
};
const proofBody = {
  ok: true,
  officialBlockFaceId: '1000000001',
  normalizedStreetNames: {
    onStreet: 'MARAN PLACE',
    crossStreetOne: 'WHITE PLAINS ROAD',
    crossStreetTwo: 'LURTING AVENUE',
  },
  returnCode: '00',
  reasonCode: ' ',
  sourceVersion: { geosupportRelease: '26C', geosupportVersion: '26.3' },
};

function payloadFor(url) {
  return String(url).includes('/api/views/') ? metadata : [segment];
}

function hangingFetch() {
  return vi.fn((_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  }));
}

function sourceFetch(firstDelayMs) {
  let delayed = false;
  return vi.fn((url, init) => new Promise((resolve, reject) => {
    const delay = delayed ? 0 : firstDelayMs;
    delayed = true;
    const timer = setTimeout(() => resolve({
      ok: true,
      json: async () => payloadFor(url),
    }), delay);
    init?.signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    }, { once: true });
  }));
}

function track(pending) {
  let settled = false;
  const result = pending.then(value => {
    settled = true;
    return value;
  });
  return { result, settled: () => settled };
}

describe('canonical source and orchestration deadlines', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('aborts a source that never responds at the source deadline and does not persist', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const fetchFn = hangingFetch();
    const persistCanonicalCurb = vi.fn(async () => ({ success: true }));
    const loadCanonicalRules = vi.fn(async () => ({ state: 'complete', selected: {} }));
    const tracked = track(runCanonicalCurbOrchestrator(request(), {
      fetchFn,
      persistCanonicalCurb,
      loadCanonicalRules,
      inFlight: new Map(),
      telemetry: { emit: vi.fn() },
    }));

    await vi.advanceTimersByTimeAsync(CSCL_SOURCE_BUDGET_MS - 1);
    expect(tracked.settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const result = await tracked.result;

    expect(Date.now() - started).toBe(CSCL_SOURCE_BUDGET_MS);
    expect(result).toEqual({ protocolVersion: 2, status: 'unsupported', reason: 'source_unavailable' });
    expect(fetchFn).toHaveBeenCalledOnce();
    expect(loadCanonicalRules).not.toHaveBeenCalled();
    expect(persistCanonicalCurb).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds stalled canonical work after a source that finishes just inside its own deadline', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const sourceDelay = CSCL_SOURCE_BUDGET_MS - 100;
    const fetchFn = sourceFetch(sourceDelay);
    const transport = vi.fn(request => new Promise(resolve => {
      request.signal?.addEventListener('abort', () => {
        resolve({
          status: 200,
          text: async () => JSON.stringify(proofBody),
        });
      }, { once: true });
    }));
    const blockfaceResolver = createPrivateBlockfaceResolver({
      mode: 'shadow',
      serviceUrl: 'https://parqueen-test-resolver-uc.a.run.app',
      getIdToken: async () => 'synthetic-token',
      transport,
    });
    const persistCanonicalCurb = vi.fn(async () => ({ success: true }));
    const loadCanonicalRules = vi.fn(async () => ({ state: 'complete', selected: { cleaning: null, rules: [] } }));
    const tracked = track(runCanonicalCurbOrchestrator(request(), {
      fetchFn,
      blockfaceResolver,
      persistCanonicalCurb,
      loadCanonicalRules,
      readCanonicalCache: vi.fn(async () => ({ hit: false, reason: 'exact_identity_missing' })),
      inFlight: new Map(),
      telemetry: { emit: vi.fn() },
    }));

    await vi.advanceTimersByTimeAsync(sourceDelay);
    expect(tracked.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(OVERALL_DEADLINE_MS - 1);
    expect(tracked.settled()).toBe(false);

    await vi.advanceTimersToNextTimerAsync();
    const result = await tracked.result;
    const elapsedAtDeadline = Date.now() - started;

    expect(elapsedAtDeadline).toBeGreaterThanOrEqual(sourceDelay + OVERALL_DEADLINE_MS);
    expect(elapsedAtDeadline).toBeLessThanOrEqual(sourceDelay + OVERALL_DEADLINE_MS + 5);
    expect(result).toEqual({ protocolVersion: 2, status: 'unsupported', reason: 'source_unavailable' });
    expect(transport).toHaveBeenCalledOnce();
    expect(loadCanonicalRules).not.toHaveBeenCalled();
    expect(persistCanonicalCurb).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns a fast proven result without waiting for either deadline', async () => {
    const started = Date.now();
    const transport = vi.fn(async () => ({
      status: 200,
      text: async () => JSON.stringify(proofBody),
    }));
    const blockfaceResolver = createPrivateBlockfaceResolver({
      mode: 'shadow',
      serviceUrl: 'https://parqueen-test-resolver-uc.a.run.app',
      getIdToken: async () => 'synthetic-token',
      transport,
    });
    const persistCanonicalCurb = vi.fn(async () => ({ success: true }));
    const result = await runCanonicalCurbOrchestrator(request(), {
      fetchFn: vi.fn(async url => ({ ok: true, json: async () => payloadFor(url) })),
      blockfaceResolver,
      persistCanonicalCurb,
      loadCanonicalRules: vi.fn(async () => ({
        state: 'complete',
        selected: { cleaning: { category: 'cleaning' }, rules: [] },
      })),
      readCanonicalCache: vi.fn(async () => ({ hit: false, reason: 'exact_identity_missing' })),
      inFlight: new Map(),
      telemetry: { emit: vi.fn() },
    });

    expect(Date.now() - started).toBeLessThan(OVERALL_DEADLINE_MS);
    expect(result).toMatchObject({ protocolVersion: 2, status: 'high_confidence' });
    expect(transport).toHaveBeenCalledOnce();
    expect(persistCanonicalCurb).toHaveBeenCalledOnce();
  });
});
