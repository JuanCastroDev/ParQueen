import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, String(value)); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => values.clear(),
    },
  });
  return values;
});

import {
  VEHICLE_HINT_KEY,
  __resetVehicleHintSessionForTests,
  hasVehicleDetails,
  markVehicleHintShown,
  readPingsShared,
  shouldOfferVehicleHint,
} from './vehicleHint';

const noCar = { vehicleType: null, vehicleBrand: '', vehicleColor: undefined };
const base = { newPublication: true, user: noCar, pingsSharedBefore: 0 as number | null };

describe('D22 vehicle-details suggestion guards', () => {
  beforeEach(() => { store.clear(); __resetVehicleHintSessionForTests(); });

  it('offers once after the first new Ping for a user without car details', () => {
    expect(shouldOfferVehicleHint(base)).toBe(true);
    markVehicleHintShown();
    expect(store.get(VEHICLE_HINT_KEY)).toBe('1');
    expect(shouldOfferVehicleHint(base)).toBe(false);
  });

  it('never for edits or reposts', () => {
    expect(shouldOfferVehicleHint({ ...base, newPublication: false })).toBe(false);
  });

  it('never when any car detail exists', () => {
    expect(hasVehicleDetails({ vehicleColor: 'Red' })).toBe(true);
    expect(shouldOfferVehicleHint({ ...base, user: { vehicleType: 'sedan' } })).toBe(false);
  });

  it('skips (does not defer) without an authoritative counter, and after any earlier Ping', () => {
    expect(shouldOfferVehicleHint({ ...base, pingsSharedBefore: null })).toBe(false);
    expect(shouldOfferVehicleHint({ ...base, pingsSharedBefore: 1 })).toBe(false);
    expect(shouldOfferVehicleHint(base)).toBe(true);
  });

  it('device guard alone blocks it (e.g. a new session on the same device)', () => {
    store.set(VEHICLE_HINT_KEY, '1');
    expect(shouldOfferVehicleHint(base)).toBe(false);
  });

  it('session flag alone blocks it even if storage is cleared', () => {
    markVehicleHintShown();
    store.clear();
    expect(shouldOfferVehicleHint(base)).toBe(false);
  });

  it('reads the server counter: absent is 0, malformed is not authoritative', () => {
    expect(readPingsShared({})).toBe(0);
    expect(readPingsShared({ impactStats: {} })).toBe(0);
    expect(readPingsShared({ impactStats: { pingsShared: 3 } })).toBe(3);
    expect(readPingsShared({ impactStats: { pingsShared: 'x' } })).toBeNull();
    expect(readPingsShared({ impactStats: { pingsShared: -1 } })).toBeNull();
    expect(readPingsShared(null)).toBeNull();
  });
});
