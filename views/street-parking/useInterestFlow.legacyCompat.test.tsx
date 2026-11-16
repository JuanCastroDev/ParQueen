// S7 PR-B (t721u): hook wiring for the server legacy contract merged in #333.
// A claimant or finder holding a generationless legacy claim uses the
// server-supported legacy request; generation-bearing claims are unchanged.
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
});

vi.mock('../../firebase', () => ({ db: { __db: true } }));

const G1 = 'a'.repeat(64);
const G2 = 'b'.repeat(64);
const stored = (seconds: number, nanoseconds: number) => ({ seconds, nanoseconds, toMillis: () => seconds * 1000 + Math.floor(nanoseconds / 1e6) });
const STARTED = stored(1_700_000_000, 987_654_000);
const FINGERPRINT = { seconds: 1_700_000_000, nanoseconds: 987_654_000 };

type Snap = { exists: () => boolean; data: () => Record<string, unknown> };
const { getDoc, getDocs, updateDoc, addDoc, setDoc, deleteDoc } = vi.hoisted(() => ({
  getDoc: vi.fn(async (): Promise<Snap> => ({ exists: () => false, data: () => ({}) })),
  getDocs: vi.fn(async () => ({ empty: true, docs: [] as Array<{ id: string }> })),
  updateDoc: vi.fn(async () => {}),
  addDoc: vi.fn(async () => ({ id: 'notif' })),
  setDoc: vi.fn(async () => {}),
  deleteDoc: vi.fn(async () => {}),
}));

vi.mock('firebase/firestore', () => ({
  doc: vi.fn((_db: unknown, ...parts: string[]) => ({ path: parts.join('/') })),
  updateDoc,
  deleteDoc,
  setDoc,
  Timestamp: { now: () => ({ toMillis: () => Date.now() }), fromMillis: (ms: number) => ({ toMillis: () => ms }) },
  collection: vi.fn(),
  query: vi.fn(),
  where: vi.fn(),
  getDocs,
  getDoc,
  addDoc,
  onSnapshot: vi.fn(() => () => {}),
  orderBy: vi.fn(),
  limit: vi.fn(),
}));

const { cancelClaimCallable, cancelLegacyClaimCallable } = vi.hoisted(() => ({
  cancelClaimCallable: vi.fn(),
  cancelLegacyClaimCallable: vi.fn(),
}));
vi.mock('./cancelClaimCallable', () => ({ cancelClaimCallable, cancelLegacyClaimCallable }));

const { claimSpotCallable, prepareClaimIntentCallable, revokeClaimIntentCallable } = vi.hoisted(() => ({
  claimSpotCallable: vi.fn(),
  prepareClaimIntentCallable: vi.fn(async (input: { attemptId: string; spotId: string; mode: string }) => ({
    state: 'prepared',
    attemptId: input.attemptId,
    spotId: input.spotId,
    mode: input.mode,
    expiresAt: 1_700_000_060_000,
  })),
  revokeClaimIntentCallable: vi.fn(),
}));
vi.mock('./claimSpotCallable', () => ({ claimSpotCallable, prepareClaimIntentCallable, revokeClaimIntentCallable }));

const { finderCancelSpot } = vi.hoisted(() => ({ finderCancelSpot: vi.fn() }));
vi.mock('./finderCancelSpot', () => ({ finderCancelSpot }));

vi.mock('../../utils/errorReporting', () => ({
  reportCriticalActionFailure: vi.fn(),
  captureClientException: vi.fn(),
}));
vi.mock('../../utils/parkingAnalytics', () => ({
  recordParkingAnalyticsEvent: vi.fn(),
  isConfirmedServerHandoffSuccess: () => false,
}));

import { t } from '../../i18n';
import { useInterestFlow } from './useInterestFlow';

function mount(selectedItem: Record<string, unknown>, user: { id: string }) {
  const setSelectedItem = vi.fn();
  let flow!: ReturnType<typeof useInterestFlow>;
  act(() => {
    TestRenderer.create(React.createElement(() => {
      flow = useInterestFlow({
        selectedItem,
        setSelectedItem,
        user: { username: 'driver', crowns: 0, ...user },
        freeSpots: [selectedItem as never],
        userLocation: null,
        mapRef: { current: null },
        activeRouteDestinationRef: { current: null },
      });
      return null;
    }));
  });
  return { getFlow: () => flow, setSelectedItem };
}

const snap = (data: Record<string, unknown>): Snap => ({ exists: () => true, data: () => data });

beforeEach(() => {
  vi.clearAllMocks();
  getDocs.mockResolvedValue({ empty: true, docs: [] });
});

describe('claimant cancellation of a legacy claim (T2-G1)', () => {
  const claimantSpot = { id: 'spot-1', lat: 40.7, lng: -73.9, finderId: 'finder-1' };
  const legacyClaim = (extra: Record<string, unknown> = {}) => ({
    status: 'interested',
    interestedUserId: 'u1',
    claimState: 'heading',
    claimGenerationId: null,
    claimStartedAt: STARTED,
    ...extra,
  });

  it('sends the legacy request instead of showing cancel_error, then closes the sheet', async () => {
    getDoc.mockResolvedValue(snap(legacyClaim()));
    cancelLegacyClaimCallable.mockResolvedValue('cancelled');
    const { getFlow, setSelectedItem } = mount(claimantSpot, { id: 'u1' });
    await act(async () => { await getFlow().handleCancelByClaimer('Found parking elsewhere'); });
    expect(cancelLegacyClaimCallable).toHaveBeenCalledWith({
      spotId: 'spot-1',
      legacyClaimStartedAt: FINGERPRINT,
      reason: 'Found parking elsewhere',
    });
    expect(cancelClaimCallable).not.toHaveBeenCalled();
    expect(updateDoc).not.toHaveBeenCalled();
    expect(addDoc).not.toHaveBeenCalled();
    expect(setSelectedItem).toHaveBeenCalledWith(null);
    expect(getFlow().interestError).toBeNull();
  });

  it('treats an absent generation field the same as null', async () => {
    const { claimGenerationId: _omit, ...absent } = legacyClaim({ claimState: null });
    getDoc.mockResolvedValue(snap(absent));
    cancelLegacyClaimCallable.mockResolvedValue('already_resolved');
    const { getFlow, setSelectedItem } = mount(claimantSpot, { id: 'u1' });
    await act(async () => { await getFlow().handleCancelByClaimer('Changed my mind'); });
    expect(cancelLegacyClaimCallable).toHaveBeenCalledTimes(1);
    expect(setSelectedItem).toHaveBeenCalledWith(null);
  });

  it('keeps the sheet open on stale_claim and retries the same captured legacy value', async () => {
    getDoc.mockResolvedValue(snap(legacyClaim()));
    cancelLegacyClaimCallable.mockResolvedValueOnce('stale_claim').mockResolvedValueOnce('cancelled');
    const { getFlow, setSelectedItem } = mount(claimantSpot, { id: 'u1' });
    await act(async () => { await getFlow().handleCancelByClaimer('Changed my mind'); });
    expect(getFlow().interestError).toBe(t('claim_flow.cancel_error'));
    expect(setSelectedItem).not.toHaveBeenCalled();
    getDoc.mockResolvedValue(snap(legacyClaim({ claimStartedAt: stored(1_700_000_999, 0) })));
    await act(async () => { await getFlow().handleCancelByClaimer('Changed my mind'); });
    expect(cancelLegacyClaimCallable.mock.calls[1][0].legacyClaimStartedAt).toEqual(FINGERPRINT);
    expect(setSelectedItem).toHaveBeenCalledWith(null);
  });

  it.each([
    ['held by another user', { interestedUserId: 'someone-else' }],
    ['with no claimStartedAt', { claimStartedAt: null }],
    ['with a millis-only claimStartedAt', { claimStartedAt: { toMillis: () => 1 } }],
    ['with a malformed stored generation', { claimGenerationId: 'not-a-generation' }],
  ])('still refuses locally when the generationless claim is %s', async (_label, extra) => {
    getDoc.mockResolvedValue(snap(legacyClaim(extra)));
    const { getFlow, setSelectedItem } = mount(claimantSpot, { id: 'u1' });
    await act(async () => { await getFlow().handleCancelByClaimer('Changed my mind'); });
    expect(cancelLegacyClaimCallable).not.toHaveBeenCalled();
    expect(cancelClaimCallable).not.toHaveBeenCalled();
    expect(setSelectedItem).not.toHaveBeenCalled();
    expect(getFlow().interestError).toBe(t('claim_flow.cancel_error'));
  });

  it('keeps generation-bearing claims on the generation request even when claimStartedAt is present', async () => {
    getDoc.mockResolvedValue(snap(legacyClaim({ claimGenerationId: G1 })));
    cancelClaimCallable.mockResolvedValue('cancelled');
    const { getFlow } = mount(claimantSpot, { id: 'u1' });
    await act(async () => { await getFlow().handleCancelByClaimer('Traffic is too heavy'); });
    expect(cancelClaimCallable).toHaveBeenCalledWith({ spotId: 'spot-1', claimGenerationId: G1, reason: 'Traffic is too heavy' });
    expect(Object.keys(cancelClaimCallable.mock.calls[0][0])).toEqual(['spotId', 'claimGenerationId', 'reason']);
    expect(cancelLegacyClaimCallable).not.toHaveBeenCalled();
  });
});

describe('finder cancellation of a legacy claim (T2-G2)', () => {
  it('confirms the stored claimStartedAt so the client can build the legacy request', async () => {
    finderCancelSpot.mockResolvedValue('deleted');
    const item = {
      id: 'spot-1', lat: 40.7, lng: -73.9, finderId: 'finder-1', status: 'interested',
      interestedUserId: 'claimer-1', claimState: 'heading', claimGenerationId: null, claimStartedAt: STARTED,
    };
    const { getFlow, setSelectedItem } = mount(item, { id: 'finder-1' });
    await act(async () => { await getFlow().handleCancelByFinder('Spot no longer available'); });
    expect(finderCancelSpot.mock.calls[0][0].confirmedSpot).toEqual({
      finderId: 'finder-1',
      status: 'interested',
      interestedUserId: 'claimer-1',
      claimState: 'heading',
      claimGenerationId: null,
      claimStartedAt: STARTED,
    });
    expect(setSelectedItem).toHaveBeenCalledWith(null);
  });

  it('falls back to rawSpot.claimStartedAt like the generation field does', async () => {
    finderCancelSpot.mockResolvedValue('deleted');
    const item = {
      id: 'spot-1', lat: 40.7, lng: -73.9, finderId: 'finder-1', status: 'interested',
      interestedUserId: 'claimer-1', claimState: 'heading',
      rawSpot: { claimGenerationId: G2, claimStartedAt: STARTED },
    };
    const { getFlow } = mount(item, { id: 'finder-1' });
    await act(async () => { await getFlow().handleCancelByFinder('Spot no longer available'); });
    expect(finderCancelSpot.mock.calls[0][0].confirmedSpot).toMatchObject({ claimGenerationId: G2, claimStartedAt: STARTED });
  });
});

describe('claim leftover-generation recovery opt-in (T2-G3)', () => {
  const available = (extra: Record<string, unknown> = {}) => ({
    id: 'spot-1', lat: 40.7, lng: -73.9, finderId: 'finder-1', status: 'available',
    interestedUserId: null, claimState: null, claimGenerationId: null, ...extra,
  });

  beforeEach(() => {
    claimSpotCallable.mockResolvedValue({ outcome: 'claimed', claimGenerationId: G2, spotId: 'spot-1', mode: 'immediate' });
    getDoc.mockResolvedValue(snap({ interestedUserId: 'u1', claimGenerationId: G2, status: 'interested', claimState: 'heading' }));
  });

  it('opts in only on claimSpot when the Ping is available but stores a leftover generation', async () => {
    const { getFlow } = mount(available({ claimGenerationId: G1 }), { id: 'u1' });
    await act(async () => { await getFlow().handleExpressInterest(5); });
    const request = claimSpotCallable.mock.calls[0][0];
    expect(request).toEqual({ spotId: 'spot-1', attemptId: request.attemptId, mode: 'immediate', etaMinutes: 5, recoverLeftoverGeneration: true });
    expect(request).not.toHaveProperty('claimGenerationId');
    expect(prepareClaimIntentCallable.mock.calls[0][0]).not.toHaveProperty('recoverLeftoverGeneration');
    expect(getFlow().interestError).toBeNull();
  });

  it('uses rawSpot for the leftover check on a scheduled claim', async () => {
    claimSpotCallable.mockResolvedValue({ outcome: 'claimed', claimGenerationId: G2, spotId: 'spot-1', mode: 'scheduled' });
    getDoc.mockResolvedValue(snap({ interestedUserId: 'u1', claimGenerationId: G2, status: 'interested', claimState: 'committed' }));
    const { claimGenerationId: _omit, ...item } = available({ rawSpot: { claimGenerationId: 'malformed-leftover' } });
    const { getFlow } = mount(item, { id: 'u1' });
    await act(async () => { await getFlow().handleScheduledClaim(); });
    expect(Object.keys(claimSpotCallable.mock.calls[0][0]).sort()).toEqual(['attemptId', 'mode', 'recoverLeftoverGeneration', 'spotId']);
  });

  it.each([
    ['no stored generation', {}],
    ['a claimant present', { claimGenerationId: G1, interestedUserId: 'other', status: 'interested' }],
    ['a claimState present', { claimGenerationId: G1, claimState: 'heading' }],
  ])('does not opt in with %s (unchanged request)', async (_label, extra) => {
    const { getFlow } = mount(available(extra), { id: 'u1' });
    await act(async () => { await getFlow().handleExpressInterest(5); });
    expect(Object.keys(claimSpotCallable.mock.calls[0][0])).toEqual(['spotId', 'attemptId', 'mode', 'etaMinutes']);
  });
});
