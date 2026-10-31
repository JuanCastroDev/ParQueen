import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getApp, getFunctions, httpsCallable, invoke } = vi.hoisted(() => {
  const invoke = vi.fn();
  return {
    getApp: vi.fn(() => ({ name: '[DEFAULT]' })),
    getFunctions: vi.fn(() => ({ region: 'us-central1' })),
    httpsCallable: vi.fn(() => invoke),
    invoke,
  };
});

vi.mock('firebase/app', () => ({ getApp }));
vi.mock('firebase/functions', () => ({ getFunctions, httpsCallable }));

import { claimSpotCallable, prepareClaimIntentCallable, revokeClaimIntentCallable } from './claimSpotCallable';

const app = { name: '[DEFAULT]' };
const ATTEMPT = '11111111-1111-4111-8111-111111111111';
const GENERATION = 'ab'.repeat(32);

describe('claimSpotCallable', () => {
  beforeEach(() => {
    getApp.mockClear();
    getFunctions.mockClear();
    httpsCallable.mockClear();
    invoke.mockReset();
    getApp.mockReturnValue(app);
    getFunctions.mockReturnValue({ region: 'us-central1' });
    httpsCallable.mockReturnValue(invoke);
  });

  it('sends the spot, attempt, mode, and immediate ETA, and never a generation id', async () => {
    invoke.mockResolvedValue({
      data: { outcome: 'claimed', claimGenerationId: GENERATION, spotId: 'spot-1', mode: 'immediate' },
    });
    await expect(claimSpotCallable({
      spotId: 'spot-1',
      attemptId: ATTEMPT,
      mode: 'immediate',
      etaMinutes: 5,
      claimGenerationId: GENERATION,
      interestedUserName: 'Driver',
    } as never)).resolves.toEqual({
      outcome: 'claimed',
      claimGenerationId: GENERATION,
      spotId: 'spot-1',
      mode: 'immediate',
    });
    expect(getFunctions).toHaveBeenCalledWith(app, 'us-central1');
    expect(httpsCallable).toHaveBeenCalledWith({ region: 'us-central1' }, 'claimSpot');
    expect(invoke).toHaveBeenCalledWith({
      spotId: 'spot-1',
      attemptId: ATTEMPT,
      mode: 'immediate',
      etaMinutes: 5,
    });
  });

  it('omits the ETA for a scheduled claim', async () => {
    invoke.mockResolvedValue({
      data: { outcome: 'claimed', claimGenerationId: GENERATION, spotId: 'spot-1', mode: 'scheduled' },
    });
    await claimSpotCallable({ spotId: 'spot-1', attemptId: ATTEMPT, mode: 'scheduled', etaMinutes: 5 });
    expect(invoke).toHaveBeenCalledWith({ spotId: 'spot-1', attemptId: ATTEMPT, mode: 'scheduled' });
  });

  it('rejects an already_held response that carries a generation id', async () => {
    invoke.mockResolvedValue({
      data: { outcome: 'already_held', claimGenerationId: GENERATION, spotId: 'spot-1', mode: 'immediate' },
    });
    await expect(claimSpotCallable({
      spotId: 'spot-1',
      attemptId: ATTEMPT,
      mode: 'immediate',
      etaMinutes: 5,
    })).rejects.toThrow('Invalid claim response.');
  });

  it('accepts an already_held observation that does not carry a generation id', async () => {
    invoke.mockResolvedValue({
      data: { outcome: 'already_held', claimGenerationId: null, spotId: 'spot-1', mode: 'immediate' },
    });
    await expect(claimSpotCallable({
      spotId: 'spot-1',
      attemptId: ATTEMPT,
      mode: 'immediate',
      etaMinutes: 5,
    })).resolves.toEqual({
      outcome: 'already_held',
      claimGenerationId: null,
      spotId: 'spot-1',
      mode: 'immediate',
    });
  });

  it('rejects a malformed attempt id or response before treating it as success', async () => {
    await expect(claimSpotCallable({
      spotId: 'spot-1',
      attemptId: 'not-a-uuid',
      mode: 'immediate',
      etaMinutes: 5,
    })).rejects.toThrow('Invalid claim request.');
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockResolvedValueOnce({ data: { outcome: 'claimed', claimGenerationId: null, spotId: 'spot-1', mode: 'immediate' } });
    await expect(claimSpotCallable({
      spotId: 'spot-1',
      attemptId: ATTEMPT,
      mode: 'immediate',
      etaMinutes: 5,
    })).rejects.toThrow('Invalid claim response.');
  });

  it('rejects a prepare or revoke response that carries a generation id', async () => {
    invoke.mockResolvedValueOnce({
      data: { state: 'prepared', attemptId: ATTEMPT, spotId: 'spot-1', mode: 'immediate', expiresAt: 1, claimGenerationId: GENERATION },
    });
    await expect(prepareClaimIntentCallable({
      spotId: 'spot-1', attemptId: ATTEMPT, mode: 'immediate', etaMinutes: 5,
    })).rejects.toThrow('Invalid claim response.');
    expect(httpsCallable).toHaveBeenCalledWith({ region: 'us-central1' }, 'prepareClaimIntent');

    invoke.mockResolvedValueOnce({
      data: { outcome: 'released', attemptId: ATTEMPT, spotId: 'spot-1', mode: 'immediate', claimGenerationId: GENERATION },
    });
    await expect(revokeClaimIntentCallable({
      spotId: 'spot-1', attemptId: ATTEMPT, mode: 'immediate', etaMinutes: 5,
    })).rejects.toThrow('Invalid claim response.');
    expect(httpsCallable).toHaveBeenCalledWith({ region: 'us-central1' }, 'revokeClaimIntent');
  });
});
