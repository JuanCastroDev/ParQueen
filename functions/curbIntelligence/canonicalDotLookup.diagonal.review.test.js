import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { runCanonicalDotLookup } = require('./canonicalDotLookup');
const { CURB_RESOLUTION_POLICY } = require('./curbResolutionPolicy');

const NORTHEAST_FACE = '1000000001';
const SOUTHWEST_FACE = '1000000002';
const northeastCleaning = 'NO PARKING (SANITATION BROOM SYMBOL) TUESDAY FRIDAY 8:30AM-10AM <->';
const northeastMorning = 'NO PARKING (SANITATION BROOM SYMBOL) MONDAY 8AM-9AM <->';
const southwestStanding = 'NO STANDING MON-FRI 4PM-7PM <->';

function identity(cardinal, officialBlockFaceId) {
  return {
    schemaVersion: 2,
    jurisdiction: 'NYC',
    officialBlockFaceId,
    csclSide: cardinal === 'Northeast' ? 'RIGHT' : 'LEFT',
    names: {
      borough: 'Bronx',
      onStreet: 'MELVILLE STREET',
      fromStreet: 'VAN NEST AVENUE',
      toStreet: 'MORRIS PARK AVENUE',
    },
    side: { cardinal },
  };
}

function row(side, description) {
  return {
    record_type: 'Current',
    sign_design_voided_on_date: null,
    borough: 'Bronx',
    on_street: 'MELVILLE STREET',
    from_street: 'VAN NEST AVENUE',
    to_street: 'MORRIS PARK AVENUE',
    side_of_street: side,
    order_number: `P-${side}`,
    sign_code: 'PS-1',
    sign_description: description,
  };
}

const rows = [
  row('N', northeastCleaning),
  row('E', northeastMorning),
  row('S', southwestStanding),
];

function source() {
  return {
    query: vi.fn(async () => ({
      rows,
      completeness: { state: 'COMPLETE', reason: null },
      sourceVersion: { resourceId: 'nfid-uabd', version: 'dot-v1' },
    })),
  };
}

function facesFor(direction) {
  if (direction === 'N' || direction === 'E') return NORTHEAST_FACE;
  if (direction === 'S' || direction === 'W') return SOUTHWEST_FACE;
  return '9999999999';
}

function resolver(overrides) {
  const resolve = vi.fn(async query => ({
    ok: true,
    returnCode: '00',
    officialBlockFaceId: facesFor(query.compassDirection),
    ...(overrides ? overrides(query) : {}),
  }));
  return { resolve };
}

describe('diagonal DOT rules and Function 3C side mapping', () => {
  afterEach(() => vi.useRealTimers());

  it('gives the Northeast face only its official cleaning rules', async () => {
    const result = await runCanonicalDotLookup({
      identity: identity('Northeast', NORTHEAST_FACE),
    }, { dotSource: source(), blockfaceResolver: resolver() });

    expect(result.state).toBe('complete');
    expect(result.rules.map(rule => rule.category)).toEqual(['cleaning', 'cleaning']);
    expect(result.rules.every(rule => rule.source === 'dot')).toBe(true);
    const schedules = result.rules.flatMap(rule => rule.schedules);
    expect(schedules.every(schedule => schedule.side === 'Northeast')).toBe(true);
    expect(schedules.some(schedule => schedule.days.includes('Tue') && schedule.days.includes('Fri'))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('4PM-7PM');
    expect(result.rules.some(rule => rule.category === 'restriction')).toBe(false);
  });

  it('does not copy Northeast regulations onto the opposite curb', async () => {
    const result = await runCanonicalDotLookup({
      identity: identity('Southwest', SOUTHWEST_FACE),
    }, { dotSource: source(), blockfaceResolver: resolver() });

    expect(result.state).toBe('complete');
    expect(result.rules).toHaveLength(1);
    expect(result.rules[0]).toMatchObject({ category: 'restriction', source: 'dot' });
    expect(result.rules[0].schedules.every(schedule => schedule.side === 'Southwest')).toBe(true);
    expect(result.rules.some(rule => rule.category === 'cleaning')).toBe(false);
  });

  it('keeps every official compass direction that names the same diagonal face', async () => {
    const blockfaceResolver = resolver();
    const result = await runCanonicalDotLookup({
      identity: identity('Northeast', NORTHEAST_FACE),
    }, { dotSource: source(), blockfaceResolver });

    const directions = blockfaceResolver.resolve.mock.calls
      .map(call => call[0].compassDirection)
      .filter(direction => facesFor(direction) === NORTHEAST_FACE);
    expect(new Set(directions)).toEqual(new Set(['N', 'E']));
    expect(result.rules).toHaveLength(2);
  });

  it('does not authorize a regulation whose official blockface does not match', async () => {
    let calls = 0;
    const blockfaceResolver = {
      resolve: vi.fn(async query => {
        calls += 1;
        const duringSideDiscovery = calls <= 4;
        const officialBlockFaceId = !duringSideDiscovery && query.compassDirection === 'E'
          ? '9999999999'
          : facesFor(query.compassDirection);
        return { ok: true, returnCode: '00', officialBlockFaceId };
      }),
    };
    const result = await runCanonicalDotLookup({
      identity: identity('Northeast', NORTHEAST_FACE),
    }, { dotSource: source(), blockfaceResolver });

    expect(result.rules).toHaveLength(1);
    expect(result.rules[0].schedules[0].days).toEqual(expect.arrayContaining(['Tue', 'Fri']));
    expect(result.reasons).toContain('official_blockface_mismatch');
  });

  it('fails closed when Function 3C is unavailable or rejects the face', async () => {
    const unavailable = await runCanonicalDotLookup({
      identity: identity('Northeast', NORTHEAST_FACE),
    }, {
      dotSource: source(),
      blockfaceResolver: { resolve: vi.fn(async () => { throw new Error('unavailable'); }) },
    });
    const rejected = await runCanonicalDotLookup({
      identity: identity('Northeast', NORTHEAST_FACE),
    }, {
      dotSource: source(),
      blockfaceResolver: {
        resolve: vi.fn(async () => ({ ok: false, failureClass: 'REJECTED', returnCode: 'EE' })),
      },
    });

    expect(unavailable).toEqual({ state: 'unavailable', reason: 'source_unavailable', rules: [] });
    expect(rejected).toEqual({ state: 'unavailable', reason: 'official_blockface_mismatch', rules: [] });
  });

  it('does not turn a malformed or inconsistent resolver response into authoritative rules', async () => {
    const malformed = await runCanonicalDotLookup({
      identity: identity('Northeast', NORTHEAST_FACE),
    }, {
      dotSource: source(),
      blockfaceResolver: { resolve: vi.fn(async () => ({ ok: true, officialBlockFaceId: { unexpected: true } })) },
    });
    const inconsistent = await runCanonicalDotLookup({
      identity: identity('Northeast', NORTHEAST_FACE),
    }, {
      dotSource: source(),
      blockfaceResolver: {
        resolve: vi.fn(async () => ({ ok: true, officialBlockFaceId: NORTHEAST_FACE, rules: [{ category: 'cleaning' }] })),
      },
    });

    expect(malformed.rules).toEqual([]);
    expect(malformed.state).not.toBe('complete');
    expect(inconsistent.rules.every(rule => rule.source === 'dot')).toBe(true);
    expect(JSON.stringify(inconsistent.rules)).not.toContain('unexpected');
  });

  it('aborts a stalled official-side lookup at the configured source deadline', async () => {
    vi.useFakeTimers();
    const started = Date.now();
    let calls = 0;
    const pending = runCanonicalDotLookup({
      identity: identity('Northeast', NORTHEAST_FACE),
    }, {
      dotSource: source(),
      blockfaceResolver: {
        resolve: vi.fn(query => new Promise((_resolve, reject) => {
          calls += 1;
          query.signal?.addEventListener('abort', () => reject(new Error('request_aborted')), { once: true });
        })),
      },
    });

    await vi.advanceTimersByTimeAsync(CURB_RESOLUTION_POLICY.sourceDeadlineMs - 1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await pending;

    expect(Date.now() - started).toBe(CURB_RESOLUTION_POLICY.sourceDeadlineMs);
    expect(result).toEqual({ state: 'unavailable', reason: 'execution_timeout', rules: [] });
    expect(calls).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
