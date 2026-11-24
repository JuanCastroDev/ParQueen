import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getApp, getFunctions, httpsCallable, invoke } = vi.hoisted(() => ({
  getApp: vi.fn(() => ({ name: 'app' })),
  getFunctions: vi.fn(() => ({ region: 'us-central1' })),
  httpsCallable: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock('firebase/app', () => ({ getApp }));
vi.mock('firebase/functions', () => ({ getFunctions, httpsCallable }));

import { completeHandoffSuccessCallable } from './completeHandoffSuccessCallable';

describe('completeHandoffSuccessCallable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    invoke.mockResolvedValue({ data: { outcome: 'awarded' } });
    httpsCallable.mockReturnValue(invoke);
  });

  it('uses the initialized app, production region, and minimal identity payload', async () => {
    await expect(completeHandoffSuccessCallable({ spotId: 'spot-1', finderId: 'finder-1' }))
      .resolves.toEqual({ outcome: 'awarded' });
    expect(getFunctions).toHaveBeenCalledWith({ name: 'app' }, 'us-central1');
    expect(httpsCallable).toHaveBeenCalledWith({ region: 'us-central1' }, 'completeHandoffSuccess');
    expect(invoke).toHaveBeenCalledWith({ spotId: 'spot-1', finderId: 'finder-1' });
  });
});
