import { describe, expect, it } from 'vitest';
import { getMapContextChip } from './mapContextChip';

const labels = { parkedCar: 'My Parked Car', arrived: "You've arrived", myPing: 'My Ping' };
const base = { signedIn: true, hasSavedSpot: false, distanceLabel: null, hasActivePing: false, labels };

describe('getMapContextChip', () => {
  it('shows nothing when there is no car session and no active Ping (create stays on the nav Ping)', () => {
    expect(getMapContextChip(base)).toBeNull();
  });
  it('shows nothing when signed out', () => {
    expect(getMapContextChip({ ...base, signedIn: false, hasSavedSpot: true, hasActivePing: true })).toBeNull();
  });
  it('shows the active Ping', () => {
    expect(getMapContextChip({ ...base, hasActivePing: true })).toEqual({ kind: 'ping', text: 'My Ping', arrived: false });
  });
  it('shows the parked car with its distance, and wins over an active Ping like the old CTA', () => {
    expect(getMapContextChip({ ...base, hasSavedSpot: true, hasActivePing: true, distanceLabel: '0.3 mi away' }))
      .toEqual({ kind: 'car', text: 'My Parked Car · 0.3 mi away', arrived: false });
    expect(getMapContextChip({ ...base, hasSavedSpot: true, distanceLabel: '420 ft away' })!.text).toBe('My Parked Car · 420 ft away');
  });
  it('shows the parked car without a distance when location is unknown', () => {
    expect(getMapContextChip({ ...base, hasSavedSpot: true })).toEqual({ kind: 'car', text: 'My Parked Car', arrived: false });
  });
  it('shows arrival when the car is within the "You\'re here" radius', () => {
    expect(getMapContextChip({ ...base, hasSavedSpot: true, distanceLabel: "You're here" })).toEqual({ kind: 'car', text: "You've arrived", arrived: true });
  });
});
