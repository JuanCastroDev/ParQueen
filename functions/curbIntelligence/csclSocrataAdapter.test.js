'use strict';

const { createCsclCandidateStore } = require('./csclSocrataAdapter');

const metadata = Object.freeze({
  id: 'inkn-q76z',
  rowsUpdatedAt: 1767225600,
  viewLastModified: 1767225660,
});

const row = Object.freeze({
  globalid: 'cscl-1',
  physicalid: '101',
  l_blockfaceid: '0212261301',
  r_blockfaceid: '0212261302',
  rw_type: '1',
  from_level_code: 'M',
  to_level_code: 'M',
  status: '2',
  nonped: '',
  accessible: 'Y',
  streetwidth: '30',
  the_geom: {
    type: 'MultiLineString',
    coordinates: [[[-74.0061, 40.7119], [-74.0058, 40.7122]]],
  },
});

const query = Object.freeze({
  lat: 40.712,
  lng: -74.006,
  searchRadiusMeters: 75,
  envelope: {
    minLat: 40.711,
    maxLat: 40.713,
    minLng: -74.007,
    maxLng: -74.005,
  },
});

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function createFetch(rows = [row], metadataResponses = [metadata, metadata]) {
  const calls = [];
  let metadataIndex = 0;
  const fetchFn = vi.fn(async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/api/views/')) {
      return response(metadataResponses[Math.min(metadataIndex++, metadataResponses.length - 1)]);
    }
    return response(rows);
  });
  return { fetchFn, calls };
}

describe('CSCL Socrata candidate adapter', () => {
  it('issues one bounded spatial data query with limit+1, stable order, token header, and caller signal', async () => {
    const { fetchFn, calls } = createFetch();
    const signal = new AbortController().signal;
    const store = createCsclCandidateStore({ fetchFn, getSocrataToken: () => 'private-token', candidateLimit: 2 });

    const result = await store.queryCandidates({ ...query, signal });

    expect(result.completeness).toEqual({ state: 'COMPLETE', reason: null });
    expect(result.candidates).toHaveLength(1);
    const dataCall = calls.filter(call => call.url.includes('/resource/'));
    expect(dataCall).toHaveLength(1);
    const url = new URL(dataCall[0].url);
    expect(url.searchParams.get('$where')).toBe('within_circle(the_geom, 40.712, -74.006, 75)');
    expect(url.searchParams.get('$limit')).toBe('3');
    expect(url.searchParams.get('$order')).toBe(':id');
    expect(url.searchParams.has('$offset')).toBe(false);
    expect(dataCall[0].options.signal).toBe(signal);
    expect(dataCall[0].options.headers).toEqual({ Accept: 'application/json', 'X-App-Token': 'private-token' });
  });

  it('normalizes every row only into reviewed CSCL records and source metadata', async () => {
    const { fetchFn } = createFetch();
    const result = await createCsclCandidateStore({ fetchFn, candidateLimit: 5 })
      .queryCandidates(query);

    expect(result.sourceVersion).toEqual({ resourceId: 'inkn-q76z', version: '1767225600:1767225660' });
    expect(result.candidates[0]).toMatchObject({
      globalId: 'cscl-1',
      leftBlockFaceId: '0212261301',
      rightBlockFaceId: '0212261302',
      sourceVersion: result.sourceVersion,
    });
    expect(result.candidates[0]).not.toHaveProperty('the_geom');
  });

  it('marks limit+1 results incomplete and returns no candidates', async () => {
    const { fetchFn } = createFetch([row, { ...row, globalid: 'cscl-2' }, { ...row, globalid: 'cscl-3' }]);
    const result = await createCsclCandidateStore({ fetchFn, candidateLimit: 2 })
      .queryCandidates(query);

    expect(result).toEqual(expect.objectContaining({
      candidates: [],
      completeness: { state: 'INCOMPLETE', reason: 'source_query_truncated' },
    }));
  });

  it('fails closed for malformed rows, malformed metadata, and source-version changes', async () => {
    const malformedRow = createFetch([{ ...row, globalid: '' }]);
    const malformedMetadata = createFetch([row], [{ ...metadata, rowsUpdatedAt: 'bad' }]);
    const changedMetadata = createFetch([row], [metadata, { ...metadata, viewLastModified: 1767225999 }]);

    const malformed = await createCsclCandidateStore({ fetchFn: malformedRow.fetchFn }).queryCandidates(query);
    const invalidVersion = await createCsclCandidateStore({ fetchFn: malformedMetadata.fetchFn }).queryCandidates(query);
    const changed = await createCsclCandidateStore({ fetchFn: changedMetadata.fetchFn }).queryCandidates(query);

    expect(malformed).toEqual(expect.objectContaining({ candidates: [], completeness: { state: 'INCOMPLETE', reason: 'source_response_malformed' } }));
    expect(invalidVersion).toEqual(expect.objectContaining({ candidates: [], completeness: { state: 'INCOMPLETE', reason: 'invalid_source_version' } }));
    expect(changed).toEqual(expect.objectContaining({ candidates: [], completeness: { state: 'INCOMPLETE', reason: 'source_changed_during_read' } }));
  });

  it('rejects invalid or unbounded queries before network access', async () => {
    const { fetchFn } = createFetch();
    const store = createCsclCandidateStore({ fetchFn });

    const results = await Promise.all([
      store.queryCandidates({ ...query, searchRadiusMeters: 0 }),
      store.queryCandidates({ ...query, searchRadiusMeters: 501 }),
      store.queryCandidates({ ...query, envelope: null }),
      store.queryCandidates({ ...query, lat: 0 }),
    ]);

    expect(results.every(result => result.completeness.reason === 'invalid_query')).toBe(true);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('does not retry network failures and produces no logs containing source rows or coordinates', async () => {
    const fetchFn = vi.fn(async () => { throw new Error('network unavailable'); });
    const logger = { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const store = createCsclCandidateStore({ fetchFn, logger });

    const result = await store.queryCandidates(query);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ candidates: [], completeness: { state: 'INCOMPLETE', reason: 'source_unavailable' } }));
    expect(logger.log).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('honors an already-aborted signal without issuing a request', async () => {
    const { fetchFn } = createFetch();
    const controller = new AbortController();
    controller.abort();

    const result = await createCsclCandidateStore({ fetchFn }).queryCandidates({ ...query, signal: controller.signal });

    expect(result.completeness.reason).toBe('request_aborted');
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
