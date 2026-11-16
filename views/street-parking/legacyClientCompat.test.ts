// S7 PR-B (t721u): client request shapes for the server legacy contract merged
// in #333 (cancelClaim T2-G1, finderCancelSpot T2-G2, claimSpot T2-G3).
// Generation-bearing requests must stay byte-for-byte the shapes they were.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getFunctions, httpsCallable, invoke, deleteDoc, doc, getDocFromServer } = vi.hoisted(() => ({
  getFunctions: vi.fn(() => ({ region: 'us-central1' })),
  httpsCallable: vi.fn(),
  invoke: vi.fn(),
  deleteDoc: vi.fn(),
  doc: vi.fn((_db, collection, id) => ({ collection, id })),
  getDocFromServer: vi.fn(),
}));

vi.mock('firebase/app', () => ({ getApp: () => ({ name: 'test' }) }));
vi.mock('firebase/functions', () => ({ getFunctions, httpsCallable }));
vi.mock('firebase/firestore', () => ({ deleteDoc, doc, getDocFromServer }));

import { cancelClaimCallable, cancelLegacyClaimCallable } from './cancelClaimCallable';
import { claimSpotCallable, prepareClaimIntentCallable, revokeClaimIntentCallable } from './claimSpotCallable';
import { legacyClaimStartedAt, parseLegacyClaimStartedAt } from './claimIdentity';
import { cancellationIdentity, finderCancelSpot } from './finderCancelSpot';

const G1 = 'ab'.repeat(32);
const ATTEMPT = '11111111-1111-4111-8111-111111111111';
// Firestore web Timestamp as read: seconds, nanoseconds (microsecond precision), toMillis.
const stored = (seconds: number, nanoseconds: number) => ({ seconds, nanoseconds, toMillis: () => seconds * 1000 + Math.floor(nanoseconds / 1e6) });
const STARTED = stored(1_700_000_000, 123_456_000);
const FINGERPRINT = { seconds: 1_700_000_000, nanoseconds: 123_456_000 };

beforeEach(() => {
  invoke.mockReset();
  httpsCallable.mockReset();
  httpsCallable.mockReturnValue(invoke);
  deleteDoc.mockReset();
  getDocFromServer.mockReset();
});

describe('legacy claimStartedAt fingerprint', () => {
  it('echoes the exact stored seconds and nanoseconds, not millis', () => {
    expect(legacyClaimStartedAt(STARTED)).toEqual(FINGERPRINT);
    expect(Object.keys(legacyClaimStartedAt(STARTED)!)).toEqual(['seconds', 'nanoseconds']);
  });

  it('has no fingerprint for a non-Timestamp or malformed value', () => {
    expect(legacyClaimStartedAt(null)).toBeNull();
    expect(legacyClaimStartedAt(1_700_000_000_000)).toBeNull();
    expect(legacyClaimStartedAt({ toMillis: () => 1_700_000_000_000 })).toBeNull();
    expect(legacyClaimStartedAt({ seconds: 1, nanoseconds: 0 })).toBeNull();
    expect(legacyClaimStartedAt(stored(1.5, 0))).toBeNull();
    expect(legacyClaimStartedAt(stored(1, -1))).toBeNull();
    expect(legacyClaimStartedAt(stored(1, 1_000_000_000))).toBeNull();
    expect(parseLegacyClaimStartedAt({ seconds: 1, nanoseconds: 0, extra: 1 })).toBeNull();
    expect(parseLegacyClaimStartedAt([1, 0])).toBeNull();
  });
});

describe('cancelLegacyClaimCallable (T2-G1)', () => {
  it('sends exactly spotId, legacyClaimStartedAt, and the allowlisted reason to cancelClaim', async () => {
    invoke.mockResolvedValue({ data: { outcome: 'cancelled' } });
    await expect(cancelLegacyClaimCallable({
      spotId: 'spot-1',
      legacyClaimStartedAt: FINGERPRINT,
      reason: 'Traffic is too heavy',
    })).resolves.toBe('cancelled');
    expect(httpsCallable).toHaveBeenCalledWith({ region: 'us-central1' }, 'cancelClaim');
    const sent = invoke.mock.calls[0][0];
    expect(Object.keys(sent)).toEqual(['spotId', 'legacyClaimStartedAt', 'reason']);
    expect(sent).toEqual({ spotId: 'spot-1', legacyClaimStartedAt: FINGERPRINT, reason: 'traffic' });
    expect(sent).not.toHaveProperty('claimGenerationId');
  });

  it('drops extra fields and never forwards a generation id alongside the legacy value', async () => {
    invoke.mockResolvedValue({ data: { outcome: 'stale_claim' } });
    await expect(cancelLegacyClaimCallable({
      spotId: 'spot-1',
      legacyClaimStartedAt: FINGERPRINT,
      reason: 'whatever',
      claimGenerationId: G1,
      allowTestHooks: true,
    } as never)).resolves.toBe('stale_claim');
    expect(invoke.mock.calls[0][0]).toEqual({ spotId: 'spot-1', legacyClaimStartedAt: FINGERPRINT, reason: 'unspecified' });
  });

  it.each([
    ['millis number', 1_700_000_000_123],
    ['Timestamp object with toMillis', STARTED],
    ['extra key', { ...FINGERPRINT, millis: 1 }],
    ['fractional seconds', { seconds: 1.5, nanoseconds: 0 }],
    ['negative nanoseconds', { seconds: 1, nanoseconds: -1 }],
    ['missing', undefined],
  ])('rejects a %s fingerprint locally without calling the server', async (_label, value) => {
    await expect(cancelLegacyClaimCallable({ spotId: 'spot-1', legacyClaimStartedAt: value, reason: 'x' } as never))
      .rejects.toThrow('Invalid cancellation request.');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('rejects an unsafe spot id locally', async () => {
    await expect(cancelLegacyClaimCallable({ spotId: 'a/b', legacyClaimStartedAt: FINGERPRINT, reason: 'x' }))
      .rejects.toThrow('Invalid cancellation request.');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('leaves the generation request unchanged (no regression)', async () => {
    invoke.mockResolvedValue({ data: { outcome: 'cancelled' } });
    await cancelClaimCallable({ spotId: 'spot-1', claimGenerationId: G1, reason: 'Changed my mind' });
    expect(Object.keys(invoke.mock.calls[0][0])).toEqual(['spotId', 'claimGenerationId', 'reason']);
    expect(invoke.mock.calls[0][0]).not.toHaveProperty('legacyClaimStartedAt');
  });
});

describe('finderCancelSpot legacy cancellation (T2-G2)', () => {
  const legacySpot = (extra: Record<string, unknown> = {}) => ({
    finderId: 'finder-1',
    status: 'interested',
    interestedUserId: 'claimer-1',
    claimState: 'heading',
    claimGenerationId: null,
    claimStartedAt: STARTED,
    ...extra,
  });

  it('sends the five confirmation keys plus legacyClaimStartedAt with claimGenerationId null', async () => {
    invoke.mockResolvedValue({ data: { outcome: 'deleted' } });
    await expect(finderCancelSpot({ db: {} as never, spotId: 'spot-1', finderId: 'finder-1', confirmedSpot: legacySpot() }))
      .resolves.toBe('deleted');
    expect(httpsCallable).toHaveBeenCalledWith({ region: 'us-central1' }, 'finderCancelSpot');
    const sent = invoke.mock.calls[0][0];
    expect(Object.keys(sent)).toEqual(['spotId', 'status', 'interestedUserId', 'claimState', 'claimGenerationId', 'legacyClaimStartedAt']);
    expect(sent).toEqual({
      spotId: 'spot-1',
      status: 'interested',
      interestedUserId: 'claimer-1',
      claimState: 'heading',
      claimGenerationId: null,
      legacyClaimStartedAt: FINGERPRINT,
    });
    expect(deleteDoc).not.toHaveBeenCalled();
    expect(getDocFromServer).not.toHaveBeenCalled();
  });

  it('accepts an absent generation and a null or committed claimState', async () => {
    invoke.mockResolvedValue({ data: { outcome: 'stale' } });
    const { claimGenerationId: _omit, ...absent } = legacySpot({ claimState: null });
    await expect(finderCancelSpot({ db: {} as never, spotId: 'spot-1', finderId: 'finder-1', confirmedSpot: absent }))
      .resolves.toBe('stale');
    expect(invoke.mock.calls[0][0]).toMatchObject({ claimState: null, claimGenerationId: null, legacyClaimStartedAt: FINGERPRINT });
    expect(cancellationIdentity(legacySpot({ claimState: 'committed' }))).toMatchObject({ kind: 'legacy', claimState: 'committed' });
  });

  it.each([
    ['no claimStartedAt', { claimStartedAt: undefined }],
    ['a millis-only claimStartedAt', { claimStartedAt: { toMillis: () => 1 } }],
    ['a malformed stored generation', { claimGenerationId: 'not-a-generation' }],
    ['a non-interested status', { status: 'available' }],
    ['a terminal claimState', { claimState: 'arrived' }],
    ['an unsafe claimant id', { interestedUserId: 'a/b' }],
  ])('stays unproven with %s and calls nothing', async (_label, extra) => {
    await expect(finderCancelSpot({ db: {} as never, spotId: 'spot-1', finderId: 'finder-1', confirmedSpot: legacySpot(extra) }))
      .resolves.toBe('unproven_identity');
    expect(invoke).not.toHaveBeenCalled();
    expect(deleteDoc).not.toHaveBeenCalled();
  });

  it('keeps a generation-bearing request at five keys even when claimStartedAt is present (no regression)', async () => {
    invoke.mockResolvedValue({ data: { outcome: 'deleted' } });
    await finderCancelSpot({
      db: {} as never,
      spotId: 'spot-1',
      finderId: 'finder-1',
      confirmedSpot: legacySpot({ claimGenerationId: G1 }),
    });
    const sent = invoke.mock.calls[0][0];
    expect(sent).toEqual({
      spotId: 'spot-1',
      status: 'interested',
      interestedUserId: 'claimer-1',
      claimState: 'heading',
      claimGenerationId: G1,
    });
    expect(sent).not.toHaveProperty('legacyClaimStartedAt');
  });

  it('does not let a non-finder send the legacy request', async () => {
    await expect(finderCancelSpot({ db: {} as never, spotId: 'spot-1', finderId: 'someone-else', confirmedSpot: legacySpot() }))
      .resolves.toBe('not_owner');
    expect(invoke).not.toHaveBeenCalled();
  });
});

describe('claimSpotCallable leftover-generation opt-in (T2-G3)', () => {
  const claimedResponse = { data: { outcome: 'claimed', claimGenerationId: G1, spotId: 'spot-1', mode: 'immediate' } };

  it('sends recoverLeftoverGeneration: true only when the caller opts in', async () => {
    invoke.mockResolvedValue(claimedResponse);
    await claimSpotCallable({ spotId: 'spot-1', attemptId: ATTEMPT, mode: 'immediate', etaMinutes: 5, recoverLeftoverGeneration: true });
    expect(httpsCallable).toHaveBeenCalledWith({ region: 'us-central1' }, 'claimSpot');
    expect(invoke.mock.calls[0][0]).toEqual({
      spotId: 'spot-1', attemptId: ATTEMPT, mode: 'immediate', etaMinutes: 5, recoverLeftoverGeneration: true,
    });
    expect(invoke.mock.calls[0][0]).not.toHaveProperty('claimGenerationId');
  });

  it('omits the key without opt-in and for any non-true value (no regression)', async () => {
    invoke.mockResolvedValue(claimedResponse);
    await claimSpotCallable({ spotId: 'spot-1', attemptId: ATTEMPT, mode: 'immediate', etaMinutes: 5 });
    await claimSpotCallable({ spotId: 'spot-1', attemptId: ATTEMPT, mode: 'immediate', etaMinutes: 5, recoverLeftoverGeneration: 'yes' } as never);
    for (const call of invoke.mock.calls) {
      expect(Object.keys(call[0])).toEqual(['spotId', 'attemptId', 'mode', 'etaMinutes']);
    }
  });

  it('never forwards the opt-in to prepareClaimIntent or revokeClaimIntent', async () => {
    invoke.mockResolvedValueOnce({ data: { state: 'prepared', attemptId: ATTEMPT, spotId: 'spot-1', mode: 'scheduled', claimGenerationId: null } });
    invoke.mockResolvedValueOnce({ data: { outcome: 'revoked', attemptId: ATTEMPT, spotId: 'spot-1', mode: 'scheduled', claimGenerationId: null } });
    await prepareClaimIntentCallable({ spotId: 'spot-1', attemptId: ATTEMPT, mode: 'scheduled', recoverLeftoverGeneration: true } as never);
    await revokeClaimIntentCallable({ spotId: 'spot-1', attemptId: ATTEMPT, mode: 'scheduled', recoverLeftoverGeneration: true } as never);
    for (const call of invoke.mock.calls) {
      expect(Object.keys(call[0])).toEqual(['spotId', 'attemptId', 'mode']);
    }
  });
});
