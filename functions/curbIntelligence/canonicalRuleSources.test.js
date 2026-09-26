import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { loadCanonicalRules } = require('./canonicalRuleSources');

const identity = Object.freeze({
  schemaVersion: 2,
  jurisdiction: 'NYC',
  officialBlockFaceId: '1000000001',
  names: { borough: 'Bronx', onStreet: 'MARAN PLACE', fromStreet: 'A', toStreet: 'B', aliases: [] },
  side: { cardinal: 'North' },
  roadway: { geometry: { type: 'MultiLineString', coordinates: [[[-74, 40.7], [-73.999, 40.7]]] } },
});

describe('loadCanonicalRules', () => {
  it('does not start any source before a valid canonical identity exists', async () => {
    const lookup = vi.fn();
    const result = await loadCanonicalRules(null, {
      dotLookup: lookup,
      parkNycLookup: lookup,
      sweepLookup: lookup,
      adminLookup: lookup,
    });

    expect(result).toEqual({ state: 'unsupported', reason: 'canonical_identity_required' });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('starts independent sources in parallel with the exact same private identity', async () => {
    const started = new Set();
    const makeLookup = (name, value) => vi.fn(async ({ identity: received }) => {
      expect(received).toBe(identity);
      started.add(name);
      await Promise.resolve();
      expect(started.size).toBe(4);
      return value;
    });
    const result = await loadCanonicalRules(identity, {
      dotLookup: makeLookup('dot', { state: 'complete', rules: [] }),
      parkNycLookup: makeLookup('park', { state: 'omitted', product: null }),
      sweepLookup: makeLookup('sweep', { state: 'unverifiable', rules: [] }),
      adminLookup: makeLookup('admin', { state: 'complete', rules: [] }),
    });

    expect(result.state).toBe('complete');
    expect(result.selected.rules).toEqual([]);
  });

  it('keeps known-good source results when another source fails', async () => {
    const result = await loadCanonicalRules(identity, {
      dotLookup: async () => ({ state: 'complete', rules: [{
        category: 'restriction', source: 'dot', type: 'noParking', schedules: [],
      }] }),
      parkNycLookup: async () => { throw new Error('park down'); },
      sweepLookup: async () => ({ state: 'unverifiable', rules: [] }),
      adminLookup: async () => ({ state: 'complete', rules: [] }),
    });

    expect(result.state).toBe('complete');
    expect(result.sources.parkNyc).toMatchObject({ state: 'unavailable' });
    expect(result.selected.restrictions).toHaveLength(1);
  });
});
