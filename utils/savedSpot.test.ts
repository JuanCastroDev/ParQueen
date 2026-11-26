import { describe, it, expect, beforeEach, vi } from 'vitest';

// The suite runs in a node environment; savedSpot degrades to null without
// storage, so give it a real one to exercise the parse/migrate paths.
vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  };
});

import { readSavedSpot, writeSavedSpot, clearSavedSpot, SAVED_SPOT_KEY, SAVED_SPOT_TTL_MS } from './savedSpot';

// Moved verbatim from the retired utils/assistantTools.test.ts when the Parking Tools hub was removed;
// savedSpot is still used by the map (StreetParkingView) and keeps its coverage.

// ── Saved spot ──────────────────────────────────────────────────────────────

const baseSpot = {
  lat: 40.7128, lng: -74.006, address: '123 Main St', savedAt: Date.now(),
  sessionId: 'abc', linkedPingId: null, segmentId: 'seg1', parkingSide: 'North',
  restrictionVersionId: 'v1', segmentStreetName: 'Main St',
  streetIntelStatus: 'found' as const, streetIntelReason: null, streetIntelCheckedAt: null,
  curbProtocolVersion: 2 as const, curbResolutionStatus: 'high_confidence' as const,
  curbSelector: null, curbSideConfirmation: null, curbRefreshAttempted: false,
  gpsAccuracyMeters: 8, sideConfidence: 'high' as const, confirmedParkingSide: null,
};

describe('readSavedSpot', () => {
  beforeEach(() => { clearSavedSpot(); });

  it('round-trips a saved spot', () => {
    writeSavedSpot(baseSpot);
    expect(readSavedSpot()).toEqual(baseSpot);
  });

  it('keeps a pre-V2 saved session readable and marks canonical refresh unattempted', () => {
    const legacy = { ...baseSpot } as Record<string, unknown>;
    delete legacy.curbProtocolVersion;
    delete legacy.curbResolutionStatus;
    delete legacy.curbSelector;
    delete legacy.curbRefreshAttempted;
    localStorage.setItem(SAVED_SPOT_KEY, JSON.stringify(legacy));

    expect(readSavedSpot()).toMatchObject({
      segmentId: 'seg1',
      curbProtocolVersion: null,
      curbResolutionStatus: null,
      curbSelector: null,
      curbRefreshAttempted: false,
    });
  });

  it('returns null when nothing is saved', () => {
    expect(readSavedSpot()).toBeNull();
  });

  it('expires a session older than 24 hours and clears it', () => {
    writeSavedSpot({ ...baseSpot, savedAt: Date.now() - SAVED_SPOT_TTL_MS - 1000 });
    expect(readSavedSpot()).toBeNull();
    expect(localStorage.getItem(SAVED_SPOT_KEY)).toBeNull();
  });

  it('keeps a session just inside the window', () => {
    writeSavedSpot({ ...baseSpot, savedAt: Date.now() - SAVED_SPOT_TTL_MS + 60_000 });
    expect(readSavedSpot()).not.toBeNull();
  });

  it('back-fills fields that predate later versions, and writes them back', () => {
    localStorage.setItem(SAVED_SPOT_KEY, JSON.stringify({
      lat: 40.7, lng: -74, address: 'x', savedAt: Date.now(), parkingSide: 'North',
    }));
    const s = readSavedSpot()!;
    expect(s.sessionId).toBeTruthy();
    expect(s.linkedPingId).toBeNull();
    expect(s.gpsAccuracyMeters).toBeNull();
    expect(s.sideConfidence).toBe('low');      // had a side but no confidence
    expect(s.confirmedParkingSide).toBeNull();
    expect(JSON.parse(localStorage.getItem(SAVED_SPOT_KEY)!).sessionId).toBe(s.sessionId);
  });

  it('back-fills unknown confidence when there was no side either', () => {
    localStorage.setItem(SAVED_SPOT_KEY, JSON.stringify({ lat: 40.7, lng: -74, address: 'x', savedAt: Date.now() }));
    expect(readSavedSpot()!.sideConfidence).toBe('unknown');
  });

  it('rejects untrusted payloads instead of handing out unusable coordinates', () => {
    for (const bad of ['null', '{}', '[]', '"x"', 'not json',
      JSON.stringify({ lat: 'a', lng: -74, savedAt: Date.now() }),
      JSON.stringify({ lat: NaN, lng: -74, savedAt: Date.now() }),
      JSON.stringify({ lat: 40.7, lng: null, savedAt: Date.now() }),
      JSON.stringify({ lat: 40.7, lng: -74 })]) {
      localStorage.setItem(SAVED_SPOT_KEY, bad);
      expect(readSavedSpot()).toBeNull();
    }
  });
});

