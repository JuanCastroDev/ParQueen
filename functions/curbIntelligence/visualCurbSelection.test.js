import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveCanonicalCurb } = require('./canonicalCurbResolver');
const { hasPrimaryTopologyAuthority } = require('./canonicalCurbResolver');
const { applyVisualCurbSelection } = require('./visualCurbSelection');

const VERSION = Object.freeze({ resourceId: 'inkn-q76z', version: 'selection-v1' });
const METADATA = Object.freeze({ id: 'inkn-q76z', rowsUpdatedAt: 1767225600, viewLastModified: 1767225660 });
const HORIZONTAL = [[[-74.001, 40.7], [-73.999, 40.7]]];
const VERTICAL = [[[-74, 40.699], [-74, 40.701]]];

function record({
  globalId,
  streetName,
  coordinates,
  leftBlockFaceId,
  rightBlockFaceId,
} = {}) {
  const id = globalId || 'maran';
  const name = streetName || 'MARAN PLACE';
  return {
    globalId: id,
    sourceVersion: VERSION,
    geometry: { type: 'MultiLineString', coordinates: coordinates || HORIZONTAL },
    leftBlockFaceId: leftBlockFaceId || '1000000001',
    rightBlockFaceId: rightBlockFaceId || '1000000002',
    sourceNative: {
      globalid: id,
      physicalid: `${id}-physical`,
      b5sc: `${id}-b5sc`,
      boroughcode: '2',
      rw_type: '1',
      full_street_name: name,
      street_name: name,
      stname_label: name,
      streetwidth: '34',
      from_level_code: '13',
      to_level_code: '13',
      accessible: null,
      nonped: null,
      status: '2',
      from_street: 'WHITE PLAINS ROAD',
      to_street: 'LURTING AVENUE',
    },
  };
}

const whitePlains = () => record({
  globalId: 'white-plains',
  streetName: 'WHITE PLAINS ROAD',
  coordinates: VERTICAL,
  leftBlockFaceId: '2000000001',
  rightBlockFaceId: '2000000002',
});
const location = Object.freeze({
  lat: 40.70004,
  lng: -73.99997,
  accuracyMeters: 3,
  sampleCount: 3,
  consistencyMeters: 3,
});
const emptyPlan = {
  async queryCurbs() {
    return { candidates: [], completeness: { state: 'COMPLETE', reason: null } };
  },
};

const rawRow = value => ({ ...value.sourceNative, globalid: value.globalId,
  l_blockfaceid: value.leftBlockFaceId, r_blockfaceid: value.rightBlockFaceId, the_geom: value.geometry });

function mutableTransport(initial) {
  let candidates = initial;
  return {
    set(next) { candidates = next; },
    fetchFn: vi.fn(async url => ({ ok: true, json: async () => (
      String(url).includes('/api/views/') ? METADATA : candidates.map(rawRow)
    ) })),
  };
}

async function initialSelection(transport) {
  return resolveCanonicalCurb(location, {
    fetchFn: transport.fetchFn,
    planimetricStore: emptyPlan,
    requestNonce: 'server-generated-nonce',
  });
}

describe('applyVisualCurbSelection', () => {
  it('re-resolves and selects the current private identity for a valid token', async () => {
    const transport = mutableTransport([record(), whitePlains()]);
    const initial = await initialSelection(transport);
    const selectedPublic = initial.candidates.find(value => value.streetName === 'MARAN PLACE');

    const result = await applyVisualCurbSelection({
      location,
      candidateToken: selectedPublic.token,
    }, { fetchFn: transport.fetchFn, planimetricStore: emptyPlan });

    expect(result).toMatchObject({
      state: 'SUPPORTED',
      identity: {
        officialBlockFaceId: '1000000001',
        resolution: { method: 'visual_selection', evidenceVersion: 'curb-v2' },
      },
      publicCurb: { streetName: 'MARAN PLACE' },
    });
    expect(hasPrimaryTopologyAuthority(result)).toBe(true);
  });

  it.each([
    ['malformed', 'not-a-token'],
    ['wrong digest', `candidate2_${'a'.repeat(16)}_${'b'.repeat(32)}`],
  ])('rejects a %s token without invoking persistence or rule sources', async (_name, candidateToken) => {
    const persist = vi.fn();
    const loadSources = vi.fn();
    const result = await applyVisualCurbSelection({ location, candidateToken }, {
      fetchFn: mutableTransport([record(), whitePlains()]).fetchFn,
      planimetricStore: emptyPlan,
      persist,
      loadSources,
    });

    expect(result).toMatchObject({ state: 'UNSUPPORTED' });
    expect(persist).not.toHaveBeenCalled();
    expect(loadSources).not.toHaveBeenCalled();
  });

  it('rejects a token when candidate rank changes on fresh resolution', async () => {
    const transport = mutableTransport([record(), whitePlains()]);
    const initial = await initialSelection(transport);
    const token = initial.candidates.find(value => value.streetName === 'MARAN PLACE').token;
    transport.set([
      record({ coordinates: [[[-74.001, 40.7002], [-73.999, 40.7002]]] }),
      whitePlains(),
    ]);

    const result = await applyVisualCurbSelection({ location, candidateToken: token }, {
      fetchFn: transport.fetchFn,
      planimetricStore: emptyPlan,
    });

    expect(result).toEqual({ state: 'UNSUPPORTED', reasons: ['candidate_selection_stale'] });
  });

  it('rejects a stale token after the candidate set changes', async () => {
    const transport = mutableTransport([record(), whitePlains()]);
    const initial = await initialSelection(transport);
    transport.set([record()]);

    const result = await applyVisualCurbSelection({
      location,
      candidateToken: initial.candidates[0].token,
    }, { fetchFn: transport.fetchFn, planimetricStore: emptyPlan });

    expect(result).toEqual({ state: 'UNSUPPORTED', reasons: ['candidate_selection_stale'] });
  });

  it('rejects an old selection when the same selected row gains a new competitor', async () => {
    const transport = mutableTransport([record(), whitePlains()]);
    const initial = await initialSelection(transport);
    const token = initial.candidates.find(value => value.streetName === 'MARAN PLACE').token;
    transport.set([
      record(),
      whitePlains(),
      record({
        globalId: 'diagonal', streetName: 'DIAGONAL STREET',
        coordinates: [[[-74.0004, 40.6996], [-73.9996, 40.7004]]],
        leftBlockFaceId: '3000000001', rightBlockFaceId: '3000000002',
      }),
    ]);

    const result = await applyVisualCurbSelection({ location, candidateToken: token }, {
      fetchFn: transport.fetchFn, planimetricStore: emptyPlan,
    });

    expect(result).toEqual({ state: 'UNSUPPORTED', reasons: ['candidate_selection_stale'] });
  });
});
