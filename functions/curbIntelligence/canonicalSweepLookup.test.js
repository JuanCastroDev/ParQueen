import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { runCanonicalSweepLookup } = require('./canonicalSweepLookup');

const identity = Object.freeze({
  schemaVersion: 2,
  jurisdiction: 'NYC',
  officialBlockFaceId: '1000000001',
  names: {
    borough: 'Bronx',
    onStreet: 'MARAN PLACE',
    fromStreet: 'WHITE PLAINS ROAD',
    toStreet: 'LURTING AVENUE',
    aliases: ['MARAN PL'],
  },
  side: { cardinal: 'North' },
});
const sweepRow = Object.freeze({
  borough: 'Bronx',
  onStreet: 'MARAN PL',
  fromStreet: 'LURTING AVENUE',
  toStreet: 'WHITE PLAINS ROAD',
  side: 'N',
  schedules: [{ side: 'North', days: ['Mon'], startTime: '08:00', endTime: '09:30' }],
});
const sweepSource = rows => ({
  query: vi.fn(async () => ({ rows, complete: true, sourceVersion: 'sweep-v1' })),
});
const resolver = officialBlockFaceId => ({
  resolve: vi.fn(async () => ({ ok: true, returnCode: '00', officialBlockFaceId })),
});

describe('runCanonicalSweepLookup', () => {
  it('returns exact-curb cleaning evidence after one relationship match', async () => {
    const blockfaceResolver = resolver('1000000001');
    const result = await runCanonicalSweepLookup({ identity }, {
      sweepSource: sweepSource([sweepRow]),
      blockfaceResolver,
    });

    expect(result).toEqual({
      state: 'exact',
      reason: 'official_blockface_match',
      rules: [{
        category: 'cleaning',
        source: 'sweepNyc',
        schedules: sweepRow.schedules,
      }],
    });
    expect(blockfaceResolver.resolve).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toMatch(/1000000001|officialBlockFaceId|identity/);
  });

  it('omits unverifiable and conflicting SweepNYC evidence', async () => {
    const mismatch = await runCanonicalSweepLookup({ identity }, {
      sweepSource: sweepSource([sweepRow]),
      blockfaceResolver: resolver('9999999999'),
    });
    const malformed = await runCanonicalSweepLookup({ identity }, {
      sweepSource: sweepSource([{ ...sweepRow, schedules: [] }]),
      blockfaceResolver: resolver('1000000001'),
    });

    expect(mismatch).toEqual({ state: 'unverifiable', reason: 'official_blockface_mismatch', rules: [] });
    expect(malformed).toEqual({ state: 'unverifiable', reason: 'invalid_schedule', rules: [] });
  });

  it('returns unavailable for technical source failure without retry', async () => {
    const source = { query: vi.fn(async () => { throw new Error('down'); }) };
    const result = await runCanonicalSweepLookup({ identity }, {
      sweepSource: source,
      blockfaceResolver: resolver('1000000001'),
    });

    expect(result).toEqual({ state: 'unavailable', reason: 'source_unavailable', rules: [] });
    expect(source.query).toHaveBeenCalledOnce();
  });
});
