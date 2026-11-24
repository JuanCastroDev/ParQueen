import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CanonicalCurbResponse, SideConfirmation } from './canonicalCurbClient';
import {
  expiredSideConfirmationReplacement,
  runCurbSelectionAttempt,
  selectionMayCommit,
  shouldRefreshSavedSpotOnForeground,
  sideConfirmationMillisRemaining,
  spotAfterSelectionResponse,
} from './curbSelectionSession';
import {
  CURB_SIDE_CONFIRMATION_LOCAL_MAX_AGE_MS,
  readSavedSpot,
  SAVED_SPOT_KEY,
  writeSavedSpot,
  type SavedSpot,
} from './savedSpot';
import { sampleSideConfirmationToken } from './sideConfirmationTokenFixture';

const leftToken = sampleSideConfirmationToken('left');
const rightToken = sampleSideConfirmationToken('right');
const nextLeftToken = sampleSideConfirmationToken('next-left');
const nextRightToken = sampleSideConfirmationToken('next-right');

const confirmation = (left = leftToken, right = rightToken): SideConfirmation => ({
  streetName: 'Melville Street',
  orientation: { north: 'up', axis: 'east-west' },
  curbs: [
    { token: left, cardinal: 'South', drivingSide: 'left' },
    { token: right, cardinal: 'North', drivingSide: 'right' },
  ],
});

const verifiedRules = [{
  type: 'streetCleaning',
  source: 'nyc_open_data',
  schedules: [{ days: ['Tue', 'Fri'], startTime: '08:30', endTime: '10:00', side: 'Northeast' }],
}];

const pending = (checkedAt: string): SavedSpot => ({
  lat: 40.85,
  lng: -73.9,
  address: 'Melville Street',
  savedAt: Date.parse(checkedAt),
  sessionId: 'session-a',
  linkedPingId: null,
  segmentId: 'curb2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  parkingSide: 'Northeast',
  restrictionVersionId: 'old-rules',
  segmentStreetName: 'Melville Street',
  streetIntelStatus: 'found',
  streetIntelReason: null,
  streetIntelCheckedAt: checkedAt,
  curbProtocolVersion: 2,
  curbResolutionStatus: 'side_confirmation_required',
  curbSelector: null,
  curbSideConfirmation: confirmation(),
  curbRefreshAttempted: true,
  gpsAccuracyMeters: 12,
  sideConfidence: 'high',
  confirmedParkingSide: 'Northeast',
  drivingSide: 'left',
  publicRules: verifiedRules,
  publicSchedules: { cleaning: [], restrictions: [], timeLimited: [], meters: [] },
  regulationStatus: 'verified',
});

const verifiedResponse: CanonicalCurbResponse = {
  protocolVersion: 2,
  status: 'high_confidence',
  segmentId: 'curb2_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  streetName: 'Melville Street',
  sideLabel: 'Northeast',
  ruleSummary: { cleaningAvailable: true },
  responseVersion: 1,
  identityConfidence: 'high',
  regulationStatus: 'verified',
  regulationCompleteness: 'complete',
  regulationAvailability: 'available',
  publicRules: verifiedRules,
  publicSchedules: {
    cleaning: [{ days: ['Tue', 'Fri'], startTime: '08:30', endTime: '10:00', side: 'Northeast' }],
    restrictions: [],
    timeLimited: [],
    meters: [],
  },
};

function memoryStorage() {
  const data = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function harness(spot: SavedSpot) {
  const gate = { current: false };
  const epoch = { current: 0 };
  let stored: SavedSpot | null = spot;
  const commits: SavedSpot[] = [];
  const commit = (startedEpoch: number, sessionId: string, next: SavedSpot) => {
    const allowed = selectionMayCommit({
      startedEpoch,
      currentEpoch: epoch.current,
      sessionId,
      stored,
      nextStatus: next.curbResolutionStatus,
    });
    if (!allowed) return false;
    stored = next;
    commits.push(next);
    return true;
  };
  return {
    gate,
    epoch,
    commits,
    commit,
    stored: () => stored,
    replaceStored: (next: SavedSpot | null) => { stored = next; },
  };
}

describe('curb selection session', () => {
  it('clears a rejected token and does not keep the previous verified rules', async () => {
    const now = Date.parse('2026-11-23T15:00:00.000Z');
    const spot = pending(new Date(now).toISOString());
    const session = harness(spot);
    const request = vi.fn(async (): Promise<CanonicalCurbResponse> => ({
      protocolVersion: 2,
      status: 'unsupported',
      reason: 'candidate_incomplete',
    }));

    const result = await runCurbSelectionAttempt({
      spot,
      candidateToken: leftToken,
      mode: 'side',
      now,
      gate: session.gate,
      currentEpoch: () => session.epoch.current,
      bumpEpoch: () => ++session.epoch.current,
      commit: session.commit,
      request,
    });

    expect(result).toBe('committed');
    expect(request).toHaveBeenCalledOnce();
    expect(session.commits).toHaveLength(1);
    expect(session.commits[0]).toMatchObject({
      curbResolutionStatus: 'unsupported',
      streetIntelStatus: 'unavailable',
      streetIntelReason: 'candidate_incomplete',
      segmentId: null,
      parkingSide: null,
      curbSideConfirmation: null,
      publicRules: null,
      publicSchedules: null,
      regulationStatus: null,
      drivingSide: null,
      confirmedParkingSide: null,
      sideConfidence: 'unknown',
    });
    expect(session.gate.current).toBe(false);
  });

  it('turns a callable failure into an unavailable result instead of leaving the selector up', async () => {
    const now = Date.parse('2026-11-23T15:00:00.000Z');
    const spot = pending(new Date(now).toISOString());
    const session = harness(spot);
    const result = await runCurbSelectionAttempt({
      spot,
      candidateToken: rightToken,
      mode: 'side',
      now,
      gate: session.gate,
      currentEpoch: () => session.epoch.current,
      bumpEpoch: () => ++session.epoch.current,
      commit: session.commit,
      request: vi.fn(async () => { throw new Error('unavailable'); }),
    });

    expect(result).toBe('committed');
    expect(session.commits[0]).toMatchObject({
      curbResolutionStatus: 'unsupported',
      streetIntelReason: 'source_unavailable',
      publicRules: null,
      regulationStatus: null,
      drivingSide: null,
      curbSideConfirmation: null,
    });
  });

  it('replaces an old challenge with the server challenge and drops stale rules', () => {
    const now = Date.parse('2026-11-23T15:00:00.000Z');
    const spot = pending(new Date(now).toISOString());
    const next = spotAfterSelectionResponse(spot, {
      protocolVersion: 2,
      status: 'side_confirmation_required',
      confirmation: confirmation(nextLeftToken, nextRightToken),
    }, 'side', leftToken, '2026-11-23T15:00:05.000Z');

    expect(next.curbResolutionStatus).toBe('side_confirmation_required');
    expect(next.curbSideConfirmation?.curbs.map(curb => curb.token)).toEqual([nextLeftToken, nextRightToken]);
    expect(next.streetIntelCheckedAt).toBe('2026-11-23T15:00:05.000Z');
    expect(next.publicRules).toBeNull();
    expect(next.regulationStatus).toBeNull();
    expect(next.segmentId).toBeNull();
    expect(next.drivingSide).toBeNull();
  });

  it('keeps the chosen driving side only when the server proves that curb', () => {
    const now = Date.parse('2026-11-23T15:00:00.000Z');
    const spot = pending(new Date(now).toISOString());
    const proved = spotAfterSelectionResponse(spot, verifiedResponse, 'side', rightToken, new Date(now).toISOString());
    expect(proved.drivingSide).toBe('right');
    expect(proved.regulationStatus).toBe('verified');
    expect(proved.segmentId).toBe('curb2_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
    expect(proved.publicRules).toEqual(verifiedRules);
    expect(proved.publicRules).not.toBe(verifiedRules);

    const partial = spotAfterSelectionResponse(spot, {
      ...verifiedResponse,
      regulationStatus: 'partial',
      regulationCompleteness: 'incomplete',
    }, 'side', leftToken);
    expect(partial.drivingSide).toBe('left');
    expect(partial.regulationStatus).toBe('partial');

    const unknownChoice = spotAfterSelectionResponse(spot, verifiedResponse, 'side', 'sidec1.not-a-choice');
    expect(unknownChoice.drivingSide).toBeNull();
  });

  it('does not submit a challenge once the local four-minute deadline has passed', async () => {
    const now = Date.parse('2026-11-23T15:04:00.000Z');
    const freshAt = now - CURB_SIDE_CONFIRMATION_LOCAL_MAX_AGE_MS;
    const spot = pending(new Date(freshAt).toISOString());
    const session = harness(spot);
    const request = vi.fn();

    const expired = await runCurbSelectionAttempt({
      spot,
      candidateToken: leftToken,
      mode: 'side',
      now,
      gate: session.gate,
      currentEpoch: () => session.epoch.current,
      bumpEpoch: () => ++session.epoch.current,
      commit: session.commit,
      request,
    });

    expect(expired).toBe('expired');
    expect(request).not.toHaveBeenCalled();
    expect(session.commits[0]).toMatchObject({
      curbResolutionStatus: 'unsupported',
      publicRules: null,
      regulationStatus: null,
      segmentId: null,
      drivingSide: null,
      curbSideConfirmation: null,
    });

    const almost = pending(new Date(now - CURB_SIDE_CONFIRMATION_LOCAL_MAX_AGE_MS + 1).toISOString());
    const live = harness(almost);
    const liveRequest = vi.fn(async (): Promise<CanonicalCurbResponse> => verifiedResponse);
    await runCurbSelectionAttempt({
      spot: almost,
      candidateToken: leftToken,
      mode: 'side',
      now,
      gate: live.gate,
      currentEpoch: () => live.epoch.current,
      bumpEpoch: () => ++live.epoch.current,
      commit: live.commit,
      request: liveRequest,
    });
    expect(liveRequest).toHaveBeenCalledOnce();
    expect(sideConfirmationMillisRemaining(almost.streetIntelCheckedAt, now)).toBe(1);
    expect(expiredSideConfirmationReplacement(spot, now)?.regulationStatus).toBeNull();
    expect(expiredSideConfirmationReplacement(almost, now)).toBeNull();
  });

  it('ignores a second tap and does not replace the first request', async () => {
    const now = Date.parse('2026-11-23T15:00:00.000Z');
    const spot = pending(new Date(now).toISOString());
    const session = harness(spot);
    let resolveRequest: (response: CanonicalCurbResponse) => void = () => {};
    const request = vi.fn(() => new Promise<CanonicalCurbResponse>(resolve => { resolveRequest = resolve; }));
    const first = runCurbSelectionAttempt({
      spot,
      candidateToken: leftToken,
      mode: 'side',
      now,
      gate: session.gate,
      currentEpoch: () => session.epoch.current,
      bumpEpoch: () => ++session.epoch.current,
      commit: session.commit,
      request,
    });
    const second = await runCurbSelectionAttempt({
      spot,
      candidateToken: rightToken,
      mode: 'side',
      now,
      gate: session.gate,
      currentEpoch: () => session.epoch.current,
      bumpEpoch: () => ++session.epoch.current,
      commit: session.commit,
      request,
    });

    expect(second).toBe('ignored');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(leftToken);
    expect(session.epoch.current).toBe(1);
    resolveRequest(verifiedResponse);
    await expect(first).resolves.toBe('committed');
    expect(session.commits[0]?.drivingSide).toBe('left');
    expect(session.gate.current).toBe(false);
  });

  it('drops an in-flight result when the driver cancels or ends the session', async () => {
    const now = Date.parse('2026-11-23T15:00:00.000Z');
    const spot = pending(new Date(now).toISOString());
    const session = harness(spot);
    let finish: (response: CanonicalCurbResponse) => void = () => {};
    const attempt = runCurbSelectionAttempt({
      spot,
      candidateToken: leftToken,
      mode: 'side',
      now,
      gate: session.gate,
      currentEpoch: () => session.epoch.current,
      bumpEpoch: () => ++session.epoch.current,
      commit: session.commit,
      request: () => new Promise(resolve => { finish = resolve; }),
    });
    session.epoch.current += 1;
    finish(verifiedResponse);
    await expect(attempt).resolves.toBe('dropped');
    expect(session.commits).toHaveLength(0);
    expect(session.stored()?.regulationStatus).toBe('verified');

    expect(selectionMayCommit({
      startedEpoch: 4,
      currentEpoch: 4,
      sessionId: 'session-a',
      stored: { sessionId: 'session-a', curbResolutionStatus: 'high_confidence' },
      nextStatus: 'unsupported',
    })).toBe(false);
    expect(selectionMayCommit({
      startedEpoch: 2,
      currentEpoch: 3,
      sessionId: 'session-a',
      stored: null,
      nextStatus: 'high_confidence',
    })).toBe(false);
    expect(selectionMayCommit({
      startedEpoch: 3,
      currentEpoch: 3,
      sessionId: 'session-a',
      stored: { sessionId: 'session-b', curbResolutionStatus: 'resolving' },
      nextStatus: 'high_confidence',
    })).toBe(false);
    expect(selectionMayCommit({
      startedEpoch: 1,
      currentEpoch: 1,
      sessionId: 'session-a',
      stored: null,
      nextStatus: 'resolving',
    })).toBe(true);
    expect(selectionMayCommit({
      startedEpoch: 1,
      currentEpoch: 1,
      sessionId: 'session-a',
      stored: null,
      nextStatus: 'high_confidence',
    })).toBe(false);
    expect(selectionMayCommit({
      startedEpoch: 1,
      currentEpoch: 1,
      sessionId: 'session-a',
      stored: null,
      nextStatus: 'unsupported',
    })).toBe(false);
  });

  it('does not recreate a session deleted during an in-flight selection', async () => {
    const now = Date.parse('2026-11-23T15:00:00.000Z');
    const spot = pending(new Date(now).toISOString());
    const session = harness(spot);
    let finish: (response: CanonicalCurbResponse) => void = () => {};
    const attempt = runCurbSelectionAttempt({
      spot,
      candidateToken: leftToken,
      mode: 'side',
      now,
      gate: session.gate,
      currentEpoch: () => session.epoch.current,
      bumpEpoch: () => ++session.epoch.current,
      commit: session.commit,
      request: () => new Promise(resolve => { finish = resolve; }),
    });
    session.replaceStored(null);
    finish(verifiedResponse);
    await expect(attempt).resolves.toBe('dropped');
    expect(session.epoch.current).toBe(1);
    expect(session.commits).toHaveLength(0);
    expect(session.stored()).toBeNull();
  });

  it('does not write an expiry or retry result over a deleted session', async () => {
    const now = Date.parse('2026-11-23T15:00:00.000Z');
    const spot = pending(new Date(now - CURB_SIDE_CONFIRMATION_LOCAL_MAX_AGE_MS).toISOString());
    const session = harness(spot);
    session.replaceStored(null);
    const expired = await runCurbSelectionAttempt({
      spot,
      candidateToken: leftToken,
      mode: 'side',
      now,
      gate: session.gate,
      currentEpoch: () => session.epoch.current,
      bumpEpoch: () => ++session.epoch.current,
      commit: session.commit,
      request: vi.fn(),
    });
    expect(expired).toBe('dropped');
    expect(session.commits).toHaveLength(0);
    expect(session.stored()).toBeNull();

    const retry = session.commit(session.epoch.current, spot.sessionId, {
      ...spot,
      curbResolutionStatus: 'unsupported',
      streetIntelStatus: 'unavailable',
    });
    expect(retry).toBe(false);
    expect(session.stored()).toBeNull();
  });

  it('still creates the first resolving session when storage is empty', () => {
    const now = Date.parse('2026-11-23T15:00:00.000Z');
    const spot = pending(new Date(now).toISOString());
    const session = harness(spot);
    session.replaceStored(null);
    session.epoch.current = 1;
    const created = session.commit(1, 'session-new', {
      ...spot,
      sessionId: 'session-new',
      curbResolutionStatus: 'resolving',
    });
    expect(created).toBe(true);
    expect(session.stored()?.sessionId).toBe('session-new');
    expect(session.stored()?.curbResolutionStatus).toBe('resolving');
  });

  it('refreshes a saved session after foreground only when no curb request is in flight', () => {
    expect(shouldRefreshSavedSpotOnForeground({
      hidden: false, selectionInFlight: false, retryInFlight: false, saveInFlight: false,
    })).toBe(true);
    expect(shouldRefreshSavedSpotOnForeground({
      hidden: true, selectionInFlight: false, retryInFlight: false, saveInFlight: false,
    })).toBe(false);
    expect(shouldRefreshSavedSpotOnForeground({
      hidden: false, selectionInFlight: true, retryInFlight: false, saveInFlight: false,
    })).toBe(false);
    expect(shouldRefreshSavedSpotOnForeground({
      hidden: false, selectionInFlight: false, retryInFlight: true, saveInFlight: false,
    })).toBe(false);
    expect(shouldRefreshSavedSpotOnForeground({
      hidden: false, selectionInFlight: false, retryInFlight: false, saveInFlight: true,
    })).toBe(false);
  });

  it('on app restart drops an expired challenge and keeps an older verified curb', () => {
    memoryStorage();
    const now = Date.parse('2026-11-23T16:00:00.000Z');
    const freshChallenge = pending(new Date(now - 60_000).toISOString());
    writeSavedSpot(freshChallenge);
    expect(readSavedSpot(now)?.curbResolutionStatus).toBe('side_confirmation_required');
    expect(readSavedSpot(now)?.curbSideConfirmation?.curbs[0]?.token).toBe(leftToken);

    const staleChallenge = pending(new Date(now - CURB_SIDE_CONFIRMATION_LOCAL_MAX_AGE_MS).toISOString());
    writeSavedSpot(staleChallenge);
    const restarted = readSavedSpot(now);
    expect(restarted).toMatchObject({
      curbResolutionStatus: 'unsupported',
      streetIntelStatus: 'unavailable',
      streetIntelReason: 'candidate_incomplete',
      segmentId: null,
      parkingSide: null,
      publicRules: null,
      regulationStatus: null,
      drivingSide: null,
      curbSideConfirmation: null,
      confirmedParkingSide: null,
    });
    expect(readSavedSpot(now)?.curbResolutionStatus).toBe('unsupported');
    expect(localStorage.getItem(SAVED_SPOT_KEY)).not.toContain(leftToken);
    expect(localStorage.getItem(SAVED_SPOT_KEY)).not.toContain('streetCleaning');

    const verified: SavedSpot = {
      ...staleChallenge,
      streetIntelCheckedAt: new Date(now - 10 * 60_000).toISOString(),
      curbResolutionStatus: 'high_confidence',
      curbSideConfirmation: null,
      streetIntelStatus: 'found',
      sideConfidence: 'high',
      confirmedParkingSide: null,
      drivingSide: 'left',
    };
    writeSavedSpot(verified);
    const kept = readSavedSpot(now);
    expect(kept?.curbResolutionStatus).toBe('high_confidence');
    expect(kept?.segmentId).toBe(verified.segmentId);
    expect(kept?.publicRules).toEqual(verifiedRules);
    expect(kept?.regulationStatus).toBe('verified');
    expect(kept?.drivingSide).toBe('left');
  });
});
