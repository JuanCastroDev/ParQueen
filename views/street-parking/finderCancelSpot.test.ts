import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getFunctions, httpsCallable, invoke } = vi.hoisted(() => {
  const invoke = vi.fn();
  return {
    getFunctions: vi.fn(() => ({ region: 'us-central1' })),
    httpsCallable: vi.fn(() => invoke),
    invoke,
  };
});

vi.mock('firebase/app', () => ({ getApp: () => ({ name: 'test' }) }));
vi.mock('firebase/functions', () => ({ getFunctions, httpsCallable }));

import { cancellationIdentity, finderCancelSpot } from './finderCancelSpot';

const G1 = 'ab'.repeat(32);
const G2 = 'cd'.repeat(32);

describe('finderCancelSpot callable client', () => {
  beforeEach(() => {
    invoke.mockReset();
    httpsCallable.mockClear();
    httpsCallable.mockReturnValue(invoke);
    invoke.mockResolvedValue({ data: { outcome: 'deleted' } });
  });

  it('sends the confirmed generation and does not send a snapshot time', async () => {
    const outcome = await finderCancelSpot({
      db: {} as never,
      spotId: 'spot-1',
      finderId: 'finder-1',
      confirmedSpot: {
        status: 'interested',
        interestedUserId: 'claimer-1',
        claimState: 'heading',
        claimGenerationId: G1,
        claimStartedAt: { toMillis: () => 5 },
      },
    });
    expect(outcome).toBe('deleted');
    expect(httpsCallable).toHaveBeenCalledWith({ region: 'us-central1' }, 'finderCancelSpot');
    expect(invoke).toHaveBeenCalledWith({
      spotId: 'spot-1',
      status: 'interested',
      interestedUserId: 'claimer-1',
      claimState: 'heading',
      claimGenerationId: G1,
    });
    expect(JSON.stringify(invoke.mock.calls[0][0])).not.toContain('claimStartedAt');
  });

  it('does not call the server for a live claim with no generation id', async () => {
    const outcome = await finderCancelSpot({
      db: {} as never,
      spotId: 'spot-1',
      finderId: 'finder-1',
      confirmedSpot: {
        status: 'interested',
        interestedUserId: 'claimer-1',
        claimState: 'heading',
        claimGenerationId: null,
      },
    });
    expect(outcome).toBe('unproven_identity');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('returns a stale outcome without a second call', async () => {
    invoke.mockResolvedValue({ data: { outcome: 'stale' } });
    const outcome = await finderCancelSpot({
      db: {} as never,
      spotId: 'spot-1',
      finderId: 'finder-1',
      confirmedSpot: {
        status: 'interested',
        interestedUserId: 'claimer-1',
        claimState: 'heading',
        claimGenerationId: G1,
      },
    });
    expect(outcome).toBe('stale');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('treats a malformed generation on a live claim as unproven', () => {
    expect(cancellationIdentity({
      finderId: 'finder-1',
      status: 'interested',
      interestedUserId: 'claimer-1',
      claimState: 'heading',
      claimGenerationId: 'not-a-generation',
    }).kind).toBe('unproven');
    expect(G2).not.toBe(G1);
  });
});
