import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { coarseLocationHash, enforceUpstreamCostGuard } = require('./upstreamCostGuard');

describe('upstreamCostGuard', () => {
  it('hashes location without exposing raw coordinates', () => {
    const hash = coarseLocationHash('uid-1', { lat: 40.7580, lng: -73.9855 });
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain('40.758');
    expect(hash).not.toContain('-73.985');
  });

  it('limits repeated lookups of the same coarse location in memory', () => {
    const store = new Map();
    const location = { lat: 40.75801, lng: -73.98551 };
    let last;
    for (let i = 0; i < 8; i += 1) {
      last = enforceUpstreamCostGuard({ uid: 'uid-1', location, nowMs: 1_000 + i }, store);
      expect(last.ok).toBe(true);
    }
    const blocked = enforceUpstreamCostGuard({ uid: 'uid-1', location, nowMs: 1_050 }, store);
    expect(blocked.ok).toBe(false);
    expect(blocked.limited).toBe(true);
    expect(blocked.reason).toBe('source_unavailable');
    expect(blocked.hashedLocationKey).toMatch(/^[a-f0-9]{16}$/);
  });
});
