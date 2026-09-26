import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { runCanonicalDotLookup } = require('./canonicalDotLookup');

const identity = Object.freeze({
  schemaVersion: 2,
  jurisdiction: 'NYC',
  officialBlockFaceId: '1000000001',
  csclSide: 'LEFT',
  names: {
    borough: 'Bronx',
    onStreet: 'MARAN PLACE',
    fromStreet: 'WHITE PLAINS ROAD',
    toStreet: 'LURTING AVENUE',
    aliases: ['MARAN PL'],
  },
  side: { cardinal: 'North' },
});
const baseRow = Object.freeze({
  record_type: 'Current',
  sign_design_voided_on_date: null,
  borough: 'Bronx',
  on_street: 'MARAN PLACE',
  from_street: 'WHITE PLAINS ROAD',
  to_street: 'LURTING AVENUE',
  side_of_street: 'N',
  order_number: 'P-100',
  sign_code: 'PS-1',
  sign_description: 'NO STANDING MON-FRI 4PM-7PM <->',
});
const source = rows => ({
  query: vi.fn(async () => ({
    rows,
    completeness: { state: 'COMPLETE', reason: null },
    sourceVersion: { resourceId: 'nfid-uabd', version: 'dot-v1' },
  })),
});
const resolver = (officialBlockFaceId = '1000000001') => ({
  resolve: vi.fn(async () => ({
    ok: true,
    returnCode: '00',
    officialBlockFaceId,
    sourceVersion: 'geosupport-v1',
  })),
});

describe('runCanonicalDotLookup', () => {
  afterEach(() => vi.useRealTimers());

  it('resolves one unique Function 3C tuple and parses whole-face rule dimensions', async () => {
    const dotSource = source([
      { ...baseRow, sign_description: 'NO PARKING (SANITATION BROOM SYMBOL) MON 8AM-9:30AM <->' },
      baseRow,
      { ...baseRow, sign_code: 'R7-1', sign_description: '2 HOUR PARKING MON-SAT 9AM-7PM <->' },
    ]);
    const blockfaceResolver = resolver();

    const result = await runCanonicalDotLookup({ identity }, { dotSource, blockfaceResolver });

    expect(result.state).toBe('complete');
    expect(result.rules.map(rule => rule.category).sort())
      .toEqual(['cleaning', 'restriction', 'timeLimit']);
    expect(blockfaceResolver.resolve).toHaveBeenCalledOnce();
    expect(blockfaceResolver.resolve).toHaveBeenCalledWith(expect.objectContaining({
      borough: 'BRONX',
      onStreet: 'MARAN PLACE',
      crossStreetOne: 'WHITE PLAINS ROAD',
      crossStreetTwo: 'LURTING AVENUE',
      compassDirection: 'N',
    }));
  });

  it('accepts aliases and reversed bounds but omits wrong-side rows', async () => {
    const result = await runCanonicalDotLookup({ identity }, {
      dotSource: source([
        {
          ...baseRow,
          on_street: 'MARAN PL',
          from_street: 'LURTING AVENUE',
          to_street: 'WHITE PLAINS ROAD',
        },
        { ...baseRow, order_number: 'P-200', side_of_street: 'S' },
      ]),
      blockfaceResolver: resolver(),
    });

    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].category).toBe('restriction');
  });

  it('filters historical, voided, partial-face, and mismatched Block Face rows', async () => {
    const ignored = [
      { ...baseRow, record_type: 'Historical' },
      { ...baseRow, sign_design_voided_on_date: '2020-01-01' },
      { ...baseRow, sign_description: 'NO STANDING MON-FRI 4PM-7PM -->' },
    ];
    const filtered = await runCanonicalDotLookup({ identity }, {
      dotSource: source(ignored),
      blockfaceResolver: resolver(),
    });
    const mismatch = await runCanonicalDotLookup({ identity }, {
      dotSource: source([baseRow]),
      blockfaceResolver: resolver('9999999999'),
    });

    expect(filtered).toMatchObject({ state: 'complete', rules: [] });
    expect(mismatch).toMatchObject({ state: 'complete', rules: [] });
    expect(mismatch.reasons).toContain('official_blockface_mismatch');
  });

  it('returns unavailable on the shared 2.5 second source deadline without retry', async () => {
    vi.useFakeTimers();
    const dotSource = {
      query: vi.fn(({ signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
      })),
    };
    const pending = runCanonicalDotLookup({ identity }, { dotSource, blockfaceResolver: resolver() });

    await vi.advanceTimersByTimeAsync(2500);

    await expect(pending).resolves.toEqual({
      state: 'unavailable',
      reason: 'execution_timeout',
      rules: [],
    });
    expect(dotSource.query).toHaveBeenCalledOnce();
  });
});
