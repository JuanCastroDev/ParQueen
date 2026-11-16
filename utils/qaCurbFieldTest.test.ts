import { describe, expect, it, vi } from 'vitest';
import { readSavedSpot, writeSavedSpot, SAVED_SPOT_KEY, type SavedSpot } from './savedSpot';

vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: () => null,
    length: 0,
  };
});
import { sampleSideConfirmationToken } from './sideConfirmationTokenFixture';
import {
  cancelQaCurbFieldTest,
  readQaFieldGps,
  reportQaCurbResponse,
  runQaCurbFieldAttempt,
} from './qaCurbFieldTest';
import type { CanonicalCurbResponse, SideConfirmation } from './canonicalCurbClient';

const token = (label: string) => sampleSideConfirmationToken(label);
const confirmation: SideConfirmation = {
  streetName: 'Synthetic Street',
  orientation: { north: 'up', axis: 'east-west' },
  curbs: [
    { token: token('south'), cardinal: 'South' },
    { token: token('north'), cardinal: 'North' },
  ],
};
const verified: CanonicalCurbResponse = {
  protocolVersion: 2,
  status: 'high_confidence',
  segmentId: `curb2_${'ab'.repeat(16)}`,
  streetName: 'Synthetic Street',
  sideLabel: 'Northeast',
  ruleSummary: { cleaningAvailable: false },
};
const offered: CanonicalCurbResponse = {
  protocolVersion: 2,
  status: 'side_confirmation_required',
  confirmation,
};
const northeast: SavedSpot = {
  lat: 40.71,
  lng: -73.98,
  address: 'Saved curb',
  savedAt: Date.now(),
  sessionId: 'northeast-session',
  linkedPingId: null,
  segmentId: `curb2_${'cd'.repeat(16)}`,
  parkingSide: 'Northeast',
  restrictionVersionId: null,
  segmentStreetName: 'Saved Street',
  streetIntelStatus: 'found',
  streetIntelReason: null,
  streetIntelCheckedAt: '2026-11-04T17:00:00.000Z',
  curbProtocolVersion: 2,
  curbResolutionStatus: 'high_confidence',
  curbSelector: null,
  curbSideConfirmation: null,
  curbRefreshAttempted: true,
  gpsAccuracyMeters: 6,
  sideConfidence: 'high',
  confirmedParkingSide: null,
};

function keepSavedCar() {
  writeSavedSpot(northeast);
  return localStorage.getItem(SAVED_SPOT_KEY);
}

describe('QA curb field test', () => {
  it('reports GPS quality without copying coordinates into the report', () => {
    const gps = readQaFieldGps({
      sampleCount: 3,
      accuracyMeters: 6.4,
      consistencyMeters: 0.4,
      durationMs: 3900,
      lat: 40.7128,
      lng: -74.006,
    });
    const report = reportQaCurbResponse({ response: verified, gps, elapsedMs: 4200 });
    expect(report.gps).toEqual({
      sampleCount: 3,
      accuracyMeters: 6.4,
      consistencyMeters: 0.4,
      durationMs: 3900,
    });
    expect(JSON.stringify(report)).not.toContain('40.7128');
    expect(JSON.stringify(report)).not.toContain('-74.006');
    expect(report.verifiedSide).toBe('Northeast');
    expect(report.rules).toBe('unavailable');
  });

  it('leaves the saved Northeast car unchanged after success, failure, cancellation, and timeout', async () => {
    const before = keepSavedCar();
    const gps = { sampleCount: 3, accuracyMeters: 6, consistencyMeters: 0.4, durationMs: 1000 };

    const success = await runQaCurbFieldAttempt({
      resolve: async () => verified,
      readGps: () => gps,
      now: () => 1_000,
    });
    const failed = await runQaCurbFieldAttempt({
      resolve: async () => ({ protocolVersion: 2, status: 'unsupported', reason: 'source_unavailable' }),
      readGps: () => gps,
    });
    const thrown = await runQaCurbFieldAttempt({
      resolve: async () => { throw new Error('network down'); },
      readGps: () => gps,
    });
    const offeredReport = reportQaCurbResponse({ response: offered, gps, elapsedMs: 1000 });
    const cancelled = cancelQaCurbFieldTest(offeredReport);
    const timedOut = await runQaCurbFieldAttempt({
      resolve: () => new Promise(() => {}),
      readGps: () => gps,
      timeoutMs: 20,
    });

    expect(success.firstAttemptStatus).toBe('high_confidence');
    expect(success.verifiedSide).toBe('Northeast');
    expect(failed.failClosedReason).toBe('source_unavailable');
    expect(failed.verifiedSide).toBeNull();
    expect(thrown.failClosedReason).toBe('source_unavailable');
    expect(cancelled.failClosedReason).toBe('cancelled');
    expect(cancelled.confirmation).toBeNull();
    expect(timedOut.failClosedReason).toBe('timeout');
    expect(localStorage.getItem(SAVED_SPOT_KEY)).toBe(before);
    expect(readSavedSpot()).toMatchObject({
      segmentId: northeast.segmentId,
      parkingSide: 'Northeast',
      curbResolutionStatus: 'high_confidence',
      sideConfidence: 'high',
    });
  });
});
