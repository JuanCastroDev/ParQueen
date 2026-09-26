import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  createPlanimetricCurbStore,
  normalizePlanimetricCurbRow,
} = require('./planimetricCurbAdapter');

const metadata = () => ({
  id: '5xvt-8cbk',
  rowsUpdatedAt: 1_720_000_000,
  viewLastModified: 1_720_000_100,
});
const row = (id = 'curb-1', geometry = {
  type: 'LineString',
  coordinates: [[-73.9, 40.7], [-73.899, 40.701]],
}) => ({ objectid: id, the_geom: geometry });
const response = payload => ({ ok: true, json: async () => payload });

describe('normalizePlanimetricCurbRow', () => {
  it('normalizes LineString and MultiLineString rows to MultiLineString evidence', () => {
    expect(normalizePlanimetricCurbRow(row())).toEqual({
      ok: true,
      record: {
        curbId: 'curb-1',
        geometry: {
          type: 'MultiLineString',
          coordinates: [[[-73.9, 40.7], [-73.899, 40.701]]],
        },
      },
    });
    expect(normalizePlanimetricCurbRow(row('curb-2', {
      type: 'MultiLineString',
      coordinates: [[[-73.91, 40.71], [-73.909, 40.711]]],
    }))).toMatchObject({ ok: true, record: { curbId: 'curb-2' } });
  });

  it('rejects malformed geometry without throwing', () => {
    expect(normalizePlanimetricCurbRow(row('bad', {
      type: 'LineString',
      coordinates: [[-73.9, 40.7], ['bad', 40.701]],
    }))).toEqual({ ok: false, reason: 'invalid_geometry' });
  });
});

describe('createPlanimetricCurbStore', () => {
  afterEach(() => vi.useRealTimers());

  it('uses one bounded within_circle query and a 40-row completeness cap', async () => {
    const urls = [];
    const fetchFn = vi.fn(async url => {
      urls.push(String(url));
      return response(String(url).includes('/api/views/') ? metadata() : [row()]);
    });
    const store = createPlanimetricCurbStore({ fetchFn });

    const result = await store.queryCurbs({ lat: 40.7, lng: -73.9, radiusMeters: 30 });

    expect(result).toMatchObject({
      completeness: { state: 'COMPLETE', reason: null },
      sourceVersion: { resourceId: '5xvt-8cbk', version: '1720000000:1720000100' },
      candidates: [{ curbId: 'curb-1' }],
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
    const dataUrl = urls.find(url => url.includes('/resource/'));
    expect(dataUrl).toContain('within_circle%28the_geom%2C+40.7%2C+-73.9%2C+30%29');
    expect(dataUrl).toContain('%24limit=41');
  });

  it('marks malformed rows incomplete instead of returning partial evidence', async () => {
    const fetchFn = async url => response(String(url).includes('/api/views/')
      ? metadata()
      : [row(), row('bad', { type: 'Point', coordinates: [-73.9, 40.7] })]);
    const result = await createPlanimetricCurbStore({ fetchFn })
      .queryCurbs({ lat: 40.7, lng: -73.9, radiusMeters: 30 });

    expect(result).toEqual({
      candidates: [],
      completeness: { state: 'INCOMPLETE', reason: 'source_response_malformed' },
      sourceVersion: { resourceId: '5xvt-8cbk', version: '1720000000:1720000100' },
    });
  });

  it('fails completeness when the source exceeds 40 rows', async () => {
    const fetchFn = async url => response(String(url).includes('/api/views/')
      ? metadata()
      : Array.from({ length: 41 }, (_, index) => row(`curb-${index}`)));
    const result = await createPlanimetricCurbStore({ fetchFn })
      .queryCurbs({ lat: 40.7, lng: -73.9, radiusMeters: 30 });

    expect(result).toMatchObject({
      candidates: [],
      completeness: { state: 'INCOMPLETE', reason: 'source_query_truncated' },
    });
  });

  it('aborts at 900ms and does not retry either source request', async () => {
    vi.useFakeTimers();
    const fetchFn = vi.fn((_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    }));
    const pending = createPlanimetricCurbStore({ fetchFn })
      .queryCurbs({ lat: 40.7, lng: -73.9, radiusMeters: 30 });

    await vi.advanceTimersByTimeAsync(900);

    await expect(pending).resolves.toEqual({
      candidates: [],
      completeness: { state: 'INCOMPLETE', reason: 'deadline_exceeded' },
      sourceVersion: null,
    });
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
