import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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

import { cancelClaimCallable, cancelClaimReasonForUi } from './cancelClaimCallable';

const app = { name: '[DEFAULT]' };

describe('cancelClaimCallable', () => {
  beforeEach(() => {
    getApp.mockClear();
    getFunctions.mockClear();
    httpsCallable.mockClear();
    invoke.mockReset();
    getApp.mockReturnValue(app);
    getFunctions.mockReturnValue({ region: 'us-central1' });
    httpsCallable.mockReturnValue(invoke);
    invoke.mockResolvedValue({ data: { outcome: 'cancelled' } });
  });

  it('maps the existing UI reasons and sends an unknown reason as unspecified', () => {
    expect(cancelClaimReasonForUi('Found parking elsewhere')).toBe('found_elsewhere');
    expect(cancelClaimReasonForUi('Traffic is too heavy')).toBe('traffic');
    expect(cancelClaimReasonForUi('Changed my mind')).toBe('changed_mind');
    expect(cancelClaimReasonForUi('Because I said so')).toBe('unspecified');
    expect(cancelClaimReasonForUi('found_elsewhere')).toBe('found_elsewhere');
  });

  it('sends exactly spotId, a millisecond fingerprint or null, and the allowlisted reason', async () => {
    await expect(cancelClaimCallable({
      spotId: 'spot-1',
      fingerprint: 1_700_000_000_000,
      reason: 'Found parking elsewhere',
    })).resolves.toBe('cancelled');

    expect(getFunctions).toHaveBeenCalledWith(app, 'us-central1');
    expect(httpsCallable).toHaveBeenCalledWith({ region: 'us-central1' }, 'cancelClaim');
    expect(invoke).toHaveBeenCalledWith({
      spotId: 'spot-1',
      fingerprint: 1_700_000_000_000,
      reason: 'found_elsewhere',
    });
    expect(Object.keys(invoke.mock.calls[0][0])).toEqual(['spotId', 'fingerprint', 'reason']);

    await cancelClaimCallable({ spotId: 'spot-1', fingerprint: null, reason: 'Traffic is too heavy' });
    expect(invoke).toHaveBeenLastCalledWith({
      spotId: 'spot-1',
      fingerprint: null,
      reason: 'traffic',
    });
  });

  it('drops client-controlled fields, including test hooks, instead of forwarding them', async () => {
    await cancelClaimCallable({
      spotId: 'spot-1',
      fingerprint: 5,
      reason: 'Changed my mind',
      claimantId: 'u1',
      finderId: 'finder',
      message: 'raw text',
      allowTestHooks: true,
      afterReads: async () => {},
    } as never);

    const sent = invoke.mock.calls[0][0];
    expect(sent).toEqual({ spotId: 'spot-1', fingerprint: 5, reason: 'changed_mind' });
    expect(sent).not.toHaveProperty('allowTestHooks');
    expect(sent).not.toHaveProperty('afterReads');
    expect(sent).not.toHaveProperty('claimantId');
  });

  it('rejects a fingerprint that is not null or a safe integer millisecond value', async () => {
    await expect(cancelClaimCallable({
      spotId: 'spot-1',
      fingerprint: 1.5,
      reason: 'unspecified',
    })).rejects.toThrow('Invalid cancellation request.');
    await expect(cancelClaimCallable({
      spotId: 'spot-1',
      fingerprint: -1,
      reason: 'unspecified',
    })).rejects.toThrow('Invalid cancellation request.');
    expect(invoke).not.toHaveBeenCalled();
  });

  it('returns only the three allowed outcomes and rejects a malformed response', async () => {
    for (const outcome of ['cancelled', 'already_resolved', 'stale_claim'] as const) {
      invoke.mockResolvedValueOnce({ data: { outcome } });
      await expect(cancelClaimCallable({
        spotId: 'spot-1',
        fingerprint: null,
        reason: 'unspecified',
      })).resolves.toBe(outcome);
    }

    invoke.mockResolvedValueOnce({ data: {} });
    await expect(cancelClaimCallable({
      spotId: 'spot-1',
      fingerprint: null,
      reason: 'unspecified',
    })).rejects.toThrow('Invalid cancellation response.');

    invoke.mockResolvedValueOnce({ data: { outcome: 'success' } });
    await expect(cancelClaimCallable({
      spotId: 'spot-1',
      fingerprint: null,
      reason: 'unspecified',
    })).rejects.toThrow('Invalid cancellation response.');

    invoke.mockResolvedValueOnce(undefined);
    await expect(cancelClaimCallable({
      spotId: 'spot-1',
      fingerprint: null,
      reason: 'unspecified',
    })).rejects.toThrow('Invalid cancellation response.');
  });

  it('propagates callable failures instead of turning them into a success outcome', async () => {
    const unavailable = Object.assign(new Error('backend down'), { code: 'functions/unavailable' });
    invoke.mockRejectedValueOnce(unavailable);
    await expect(cancelClaimCallable({
      spotId: 'spot-1',
      fingerprint: null,
      reason: 'unspecified',
    })).rejects.toBe(unavailable);
  });

  it('keeps the production cancellation flow off the legacy direct transaction', () => {
    const flow = readFileSync(join(__dirname, 'useInterestFlow.ts'), 'utf8');
    const view = readFileSync(join(__dirname, '..', 'StreetParkingView.tsx'), 'utf8');
    expect(flow).not.toContain('cancelClaimTransaction');
    expect(flow).toContain('cancelClaimCallable');
    expect(view).not.toContain('cancelClaimTransaction');
  });
});
