'use strict';

const { createParkNycCandidateStore } = require('./parkNycSocrataAdapter');

const metadata = Object.freeze({
  id: 'e7yp-wx55',
  rowsUpdatedAt: '2026-09-01T10:21:51Z',
  viewLastModified: '2026-09-01T10:20:59Z',
});

const row = Object.freeze({
  the_geom: { type: 'MultiLineString', coordinates: [[[-74.00515, 40.70949], [-74.00494, 40.70968]]] },
  pay_by_cel: '100124',
  vehicle_ty: 'All Vehicles',
  all_vehicl: '2 Hours',
  all_vehi_1: 'Monday-Saturday 9 AM-7 PM',
  all_vehi_2: '$1.50 per Hour',
  all_vehi_3: '$3.00',
  on_street: 'Gold Street',
  side_of_st: 'W',
  from_stree: 'Beekman Street',
  to_street: 'Ann Street',
  borough: 'Manhattan',
  meter_rate: 'Zone M1',
});

const query = Object.freeze({
  lat: 40.70958,
  lng: -74.00504,
  searchRadiusMeters: 75,
});

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('ParkNYC Socrata candidate adapter', () => {
  it('issues one bounded spatial query with limit+1 and does not retry', async () => {
    const calls = [];
    const fetchFn = async (url, options) => {
      calls.push({ url: String(url), options });
      if (String(url).includes('/api/views/')) return response(metadata);
      return response([row]);
    };
    const store = createParkNycCandidateStore({ fetchFn, getSocrataToken: () => 'private-token', candidateLimit: 2 });
    const result = await store.query({ ...query, signal: new AbortController().signal });
    expect(result.candidateSnapshot.completeness.state).toBe('COMPLETE');
    expect(result.candidateSnapshot.candidates).toHaveLength(1);
    const dataCalls = calls.filter(call => call.url.includes('/resource/'));
    expect(dataCalls).toHaveLength(1);
    const url = new URL(dataCalls[0].url);
    expect(url.searchParams.get('$where')).toBe('within_circle(the_geom, 40.70958, -74.00504, 75)');
    expect(url.searchParams.get('$limit')).toBe('3');
    expect(dataCalls[0].options.headers['X-App-Token']).toBe('private-token');
  });

  it('does not invent fields that ParkNYC does not publish, such as live meter status', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, 'parkNycSocrataAdapter.js'), 'utf8');
    expect(source).toContain('does not include a live operational meter-status field');
    expect(source).not.toMatch(/status_operational|meter_status/);
  });
});
