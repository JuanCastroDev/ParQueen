
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { isA1ResponseOnlyEnabled, A1_RESPONSE_ONLY_ENV } = require('./a1ResponseOnlyFlag');

describe('A1 response-only migration flag', () => {
  it('defaults off unless the env value is the exact approved token', () => {
    expect(A1_RESPONSE_ONLY_ENV).toBe('STREET_INTEL_A1_RESPONSE_ONLY');
    expect(isA1ResponseOnlyEnabled({})).toBe(false);
    expect(isA1ResponseOnlyEnabled({ STREET_INTEL_A1_RESPONSE_ONLY: '' })).toBe(false);
    expect(isA1ResponseOnlyEnabled({ STREET_INTEL_A1_RESPONSE_ONLY: 'true' })).toBe(false);
    expect(isA1ResponseOnlyEnabled({ STREET_INTEL_A1_RESPONSE_ONLY: 'ON' })).toBe(false);
    expect(isA1ResponseOnlyEnabled({ STREET_INTEL_A1_RESPONSE_ONLY: 'on' })).toBe(true);
  });
});
