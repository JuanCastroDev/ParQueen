import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
import { QaCurbFieldTest } from './QaCurbFieldTest';
import { readSavedSpot, writeSavedSpot, SAVED_SPOT_KEY, type SavedSpot } from '../../utils/savedSpot';
import { sampleSideConfirmationToken } from '../../utils/sideConfirmationTokenFixture';
import type { CanonicalCurbResponse, SideConfirmation } from '../../utils/canonicalCurbClient';

vi.mock('./VisualCurbSelector', () => ({
  VisualCurbSelector: ({ onSelect, selector }: { onSelect: (token: string) => void; selector: { candidates: { token: string }[] } }) => (
    <button type="button" onClick={() => onSelect(selector.candidates[0].token)}>Choose offered curb</button>
  ),
}));

const token = (label: string) => sampleSideConfirmationToken(label);
const confirmation: SideConfirmation = {
  streetName: 'Synthetic Street',
  orientation: { north: 'up', axis: 'oblique', bearingDegrees: 321 },
  curbs: [
    { token: token('southwest'), cardinal: 'Southwest' },
    { token: token('northeast'), cardinal: 'Northeast' },
  ],
};
const saved: SavedSpot = {
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
const gps = {
  sampleCount: 3,
  accuracyMeters: 6.2,
  consistencyMeters: 0.3,
  durationMs: 4100,
  lat: 40.7128,
  lng: -74.006,
};

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root.findAllByType('p').map(node => node.children.join('')).join('\n');
}

function buttonLabeled(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAllByType('button').find(button =>
    button.props['data-cardinal'] === label || button.children.includes(label));
}

describe('QA curb field test panel', () => {
  afterEach(() => {
    localStorage.removeItem(SAVED_SPOT_KEY);
  });

  it('selects an offered curb without replacing the saved car', async () => {
    writeSavedSpot(saved);
    const before = localStorage.getItem(SAVED_SPOT_KEY);
    const calls: Array<string | undefined> = [];
    const verified: CanonicalCurbResponse = {
      protocolVersion: 2,
      status: 'high_confidence',
      segmentId: `curb2_${'ef'.repeat(16)}`,
      streetName: 'Synthetic Street',
      sideLabel: 'Northeast',
      ruleSummary: { cleaningAvailable: false },
    };
    const resolve = vi.fn(async (candidateToken?: string) => {
      calls.push(candidateToken);
      if (!candidateToken) {
        return { protocolVersion: 2, status: 'side_confirmation_required', confirmation } as CanonicalCurbResponse;
      }
      return verified;
    });
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <QaCurbFieldTest enabled onResolve={resolve} readGps={() => gps} />,
      );
    });
    await act(async () => { buttonLabeled(renderer!, 'Test curb here')!.props.onClick(); });
    await act(async () => { buttonLabeled(renderer!, 'Northeast')!.props.onClick(); });

    const text = textOf(renderer!);
    expect(calls).toEqual([undefined, confirmation.curbs[1].token]);
    expect(text).toContain('First attempt: side_confirmation_required');
    expect(text).toContain('Verified side: Northeast');
    expect(text).toContain('Parking information unavailable');
    expect(text).not.toContain('40.7128');
    expect(text).not.toContain('-74.006');
    expect(localStorage.getItem(SAVED_SPOT_KEY)).toBe(before);
    expect(readSavedSpot()).toMatchObject({
      segmentId: saved.segmentId,
      parkingSide: 'Northeast',
      curbResolutionStatus: 'high_confidence',
    });
  });

  it('keeps the saved car after cancellation, a failed response, and a timeout', async () => {
    writeSavedSpot(saved);
    const before = localStorage.getItem(SAVED_SPOT_KEY);
    const resolve = vi.fn(async () => ({
      protocolVersion: 2,
      status: 'side_confirmation_required',
      confirmation,
    } as CanonicalCurbResponse));
    let renderer: TestRenderer.ReactTestRenderer;
    await act(async () => {
      renderer = TestRenderer.create(
        <QaCurbFieldTest enabled onResolve={resolve} readGps={() => gps} />,
      );
    });
    await act(async () => { buttonLabeled(renderer!, 'Test curb here')!.props.onClick(); });
    await act(async () => { buttonLabeled(renderer!, 'Cancel')!.props.onClick(); });
    expect(textOf(renderer!)).toContain('Fail-closed: cancelled');
    expect(resolve).toHaveBeenCalledTimes(1);

    const failed = vi.fn(async () => ({
      protocolVersion: 2,
      status: 'unsupported',
      reason: 'location_quality',
    } as CanonicalCurbResponse));
    await act(async () => {
      renderer = TestRenderer.create(
        <QaCurbFieldTest enabled onResolve={failed} readGps={() => gps} />,
      );
    });
    await act(async () => { buttonLabeled(renderer!, 'Test curb here')!.props.onClick(); });
    expect(textOf(renderer!)).toContain('Fail-closed: location_quality');

    const stalled = vi.fn(() => new Promise<CanonicalCurbResponse>(() => {}));
    vi.useFakeTimers();
    await act(async () => {
      renderer = TestRenderer.create(
        <QaCurbFieldTest enabled onResolve={stalled} readGps={() => gps} />,
      );
    });
    await act(async () => { buttonLabeled(renderer!, 'Test curb here')!.props.onClick(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(45_000); });
    vi.useRealTimers();
    expect(textOf(renderer!)).toContain('Fail-closed: timeout');
    expect(stalled).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(SAVED_SPOT_KEY)).toBe(before);
    expect(readSavedSpot()?.curbResolutionStatus).toBe('high_confidence');
  });

  it('renders nothing outside the QA build', () => {
    const renderer = TestRenderer.create(
      <QaCurbFieldTest enabled={false} onResolve={async () => { throw new Error('should not run'); }} readGps={() => null} />,
    );
    expect(renderer.toJSON()).toBeNull();
  });
});
