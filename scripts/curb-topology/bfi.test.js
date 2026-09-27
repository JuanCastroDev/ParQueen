import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

describe('offline BFI normalization', () => {
  it('normalizes official numeric exports to one non-zero ten-digit identifier', () => {
    const { normalizeBfi } = require('./lib/bfi');

    expect(normalizeBfi(12345)).toBe('0000012345');
    expect(normalizeBfi('12345')).toBe('0000012345');
    expect(normalizeBfi('1234567890')).toBe('1234567890');
  });

  it.each([
    null,
    undefined,
    '',
    '0',
    0,
    -1,
    1.5,
    '1.5',
    '1e4',
    ' 12345',
    '12345 ',
    '+12345',
    '00000000000',
    '12345678901',
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
  ])('rejects malformed, ambiguous, or out-of-width BFI value %j', value => {
    const { normalizeBfi } = require('./lib/bfi');
    expect(() => normalizeBfi(value)).toThrow(/BFI/);
  });
});
