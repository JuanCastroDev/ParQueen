'use strict';

const { createCsclCandidateStore } = require('./csclSocrataAdapter');
const { buildCanonicalSearchEnvelope } = require('./canonicalSearchEnvelope');

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
  from_street: 'ALPHA STREET',
  to_street: 'BETA STREET',
  the_geom: {
    type: 'MultiLineString',
    coordinates: [[[-74.0061, 40.7119], [-74.0058, 40.7122]]],
  },
});

const query = Object.freeze({
  lat: 40.712,
  lng: -74.006,
  searchRadiusMeters: 75,
  canonicalEnvelope: buildCanonicalSearchEnvelope({ lat: 40.712, lng: -74.006 }, 75),
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
    expect(calls.map(call => call.url.includes('/api/views/') ? 'metadata' : 'data'))
      .toEqual(['metadata', 'data', 'metadata']);
    const dataCall = calls.filter(call => call.url.includes('/resource/'));
    expect(dataCall).toHaveLength(1);
    const url = new URL(dataCall[0].url);
    expect(url.searchParams.get('$where')).toBe(`intersects(the_geom,'${query.canonicalEnvelope.wkt}')`);
    expect(url.searchParams.get('$limit')).toBe('3');
    expect(url.searchParams.get('$order')).toBe('globalid');
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
      sourceNative: expect.objectContaining({ from_street: 'ALPHA STREET', to_street: 'BETA STREET' }),
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

  it.each([0, 1, 2, 99, 100])('proves exactly %i rows complete under the 100-row contract', async count => {
    const rows = Array.from({ length: count }, (_, index) => ({ ...row, globalid: `cscl-${index}` }));
    const { fetchFn } = createFetch(rows);
    const result = await createCsclCandidateStore({ fetchFn }).queryCandidates(query);
    expect(result.completeness).toEqual({ state: 'COMPLETE', reason: null });
    expect(result.candidates).toHaveLength(count);
  });

  it('uses the 101st row only as a truncation sentinel', async () => {
    const rows = Array.from({ length: 101 }, (_, index) => ({ ...row, globalid: `cscl-${index}` }));
    const { fetchFn } = createFetch(rows);
    const result = await createCsclCandidateStore({ fetchFn }).queryCandidates(query);
    expect(result).toMatchObject({ candidates: [], completeness: {
      state: 'INCOMPLETE', reason: 'source_query_truncated',
    } });
  });

  it('fails closed for malformed rows, malformed metadata, and source-version changes', async () => {
    const malformedRow = createFetch([{ ...row, globalid: '' }]);
    const malformedCoordinate = createFetch([{
      ...row,
      the_geom: {
        type: 'MultiLineString',
        coordinates: [[[-74.0061, 40.7119, null], [-74.0058, 40.7122]]],
      },
    }]);
    const malformedMetadata = createFetch([row], [{ ...metadata, rowsUpdatedAt: 'bad' }]);
    const changedMetadata = createFetch([row], [metadata, { ...metadata, viewLastModified: 1767225999 }]);

    const malformed = await createCsclCandidateStore({ fetchFn: malformedRow.fetchFn }).queryCandidates(query);
    const invalidCoordinate = await createCsclCandidateStore({ fetchFn: malformedCoordinate.fetchFn })
      .queryCandidates(query);
    const invalidVersion = await createCsclCandidateStore({ fetchFn: malformedMetadata.fetchFn }).queryCandidates(query);
    const changed = await createCsclCandidateStore({ fetchFn: changedMetadata.fetchFn }).queryCandidates(query);

    expect(malformed).toEqual(expect.objectContaining({ candidates: [], completeness: { state: 'INCOMPLETE', reason: 'invalid_candidate_row' } }));
    expect(invalidCoordinate).toEqual(expect.objectContaining({ candidates: [], completeness: { state: 'INCOMPLETE', reason: 'invalid_candidate_row' } }));
    expect(invalidVersion).toEqual(expect.objectContaining({ candidates: [], completeness: { state: 'INCOMPLETE', reason: 'invalid_source_version' } }));
    expect(changed).toEqual(expect.objectContaining({ candidates: [], completeness: { state: 'INCOMPLETE', reason: 'source_changed_during_read' } }));
  });

  it('preserves deterministic abort and data-malformation precedence through metadata-after', async () => {
    const changed = { ...metadata, viewLastModified: 1767225999 };
    const malformedAndChanged = createFetch({ malformed: true }, [metadata, changed]);
    const malformedJson = createFetch();
    malformedJson.fetchFn.mockImplementationOnce(async () => response(metadata));
    malformedJson.fetchFn.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => { throw new SyntaxError('invalid json'); },
    }));
    malformedJson.fetchFn.mockImplementationOnce(async () => response(metadata));
    const controller = new AbortController();
    const abortAfter = createFetch();
    abortAfter.fetchFn.mockImplementationOnce(async () => response(metadata));
    abortAfter.fetchFn.mockImplementationOnce(async () => response([row]));
    abortAfter.fetchFn.mockImplementationOnce(async () => ({
      ok: true,
      json: async () => {
        controller.abort();
        return metadata;
      },
    }));

    await expect(createCsclCandidateStore({ fetchFn: malformedAndChanged.fetchFn }).queryCandidates(query))
      .resolves.toMatchObject({ completeness: { reason: 'source_response_malformed' } });
    await expect(createCsclCandidateStore({ fetchFn: malformedJson.fetchFn }).queryCandidates(query))
      .resolves.toMatchObject({ completeness: { reason: 'source_response_malformed' } });
    await expect(createCsclCandidateStore({ fetchFn: abortAfter.fetchFn })
      .queryCandidates({ ...query, signal: controller.signal }))
      .resolves.toMatchObject({ completeness: { reason: 'request_aborted' } });
  });

  it('rejects invalid or unbounded queries before network access', async () => {
    const { fetchFn } = createFetch();
    const store = createCsclCandidateStore({ fetchFn });

    const results = await Promise.all([
      store.queryCandidates({ ...query, searchRadiusMeters: 0 }),
      store.queryCandidates({ ...query, searchRadiusMeters: 501 }),
      store.queryCandidates({ ...query, canonicalEnvelope: null }),
      store.queryCandidates({ ...query, lat: 0 }),
    ]);

    expect(results.map(result => result.completeness.reason))
      .toEqual(['invalid_query', 'invalid_query', 'invalid_envelope', 'invalid_query']);
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
