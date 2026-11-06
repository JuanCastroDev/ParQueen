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

import { cancellationIdentity, finderCancelSpot } from './finderCancelSpot';

const G1 = 'ab'.repeat(32);
const stamp = (millis: number) => ({ toMillis: () => millis });
const available = (extra: Record<string, unknown> = {}) => ({
  finderId: 'finder-1', status: 'available', claimState: null, claimGenerationId: null,
  pingMode: 'now', reportedAt: stamp(100), expiresAt: stamp(200), ...extra,
});
const snapshot = (data: Record<string, unknown>) => ({ exists: () => true, data: () => data });

describe('finderCancelSpot client mechanism selection', () => {
  beforeEach(() => {
    invoke.mockReset();
    httpsCallable.mockReset();
    httpsCallable.mockReturnValue(invoke);
    invoke.mockResolvedValue({ data: { outcome: 'deleted' } });
    deleteDoc.mockReset();
    deleteDoc.mockResolvedValue(undefined);
    getDocFromServer.mockReset();
    getDocFromServer.mockResolvedValue(snapshot(available()));
  });

  it('server-reads and directly deletes an available unclaimed Ping without invoking the callable', async () => {
    const db = {} as never;
    await expect(finderCancelSpot({ db, spotId: 'spot-1', finderId: 'finder-1', confirmedSpot: available() })).resolves.toBe('deleted');
    expect(doc).toHaveBeenCalledWith(db, 'spots', 'spot-1');
    expect(getDocFromServer).toHaveBeenCalledTimes(1);
    expect(deleteDoc).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('uses the same server-verified direct path for an eligible scheduled Ping', async () => {
    const scheduled = available({ pingMode: 'later', reportedAt: stamp(300), expiresAt: stamp(400) });
    getDocFromServer.mockResolvedValue(snapshot(scheduled));
    await expect(finderCancelSpot({ db: {} as never, spotId: 'spot-1', finderId: 'finder-1', confirmedSpot: scheduled })).resolves.toBe('deleted');
    expect(deleteDoc).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails safely when stable server identity fields changed after confirmation', async () => {
    getDocFromServer.mockResolvedValue(snapshot(available({ expiresAt: stamp(201) })));
    await expect(finderCancelSpot({ db: {} as never, spotId: 'spot-1', finderId: 'finder-1', confirmedSpot: available() })).resolves.toBe('stale');
    expect(deleteDoc).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('fails safely when a claim appears before the server read', async () => {
    getDocFromServer.mockResolvedValue(snapshot(available({
      status: 'interested', interestedUserId: 'claimer-1', claimState: 'heading', claimGenerationId: G1,
    })));
    await expect(finderCancelSpot({ db: {} as never, spotId: 'spot-1', finderId: 'finder-1', confirmedSpot: available() })).resolves.toBe('stale');
    expect(deleteDoc).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not invoke either deletion path for a non-owner confirmation', async () => {
    await expect(finderCancelSpot({
      db: {} as never, spotId: 'spot-1', finderId: 'finder-1', confirmedSpot: available({ finderId: 'finder-2' }),
    })).resolves.toBe('not_owner');
    expect(getDocFromServer).not.toHaveBeenCalled();
    expect(deleteDoc).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(['firestore/permission-denied', 'firestore/unavailable', 'firestore/deadline-exceeded'])
  ('does not retry or invoke the callable when the server read fails with %s', async (code) => {
    const failure = Object.assign(new Error(code), { code });
    getDocFromServer.mockRejectedValue(failure);
    await expect(finderCancelSpot({ db: {} as never, spotId: 'spot-1', finderId: 'finder-1', confirmedSpot: available() })).rejects.toBe(failure);
    expect(getDocFromServer).toHaveBeenCalledTimes(1);
    expect(deleteDoc).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it.each(['firestore/permission-denied', 'firestore/unavailable'])
  ('does not retry when the direct delete fails with %s', async (code) => {
    const failure = Object.assign(new Error(code), { code });
    deleteDoc.mockRejectedValue(failure);
    await expect(finderCancelSpot({ db: {} as never, spotId: 'spot-1', finderId: 'finder-1', confirmedSpot: available() })).rejects.toBe(failure);
    expect(deleteDoc).toHaveBeenCalledTimes(1);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('returns already_deleted when the server confirms the document is absent', async () => {
    getDocFromServer.mockResolvedValue({ exists: () => false });
    await expect(finderCancelSpot({ db: {} as never, spotId: 'spot-1', finderId: 'finder-1', confirmedSpot: available() })).resolves.toBe('already_deleted');
    expect(deleteDoc).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('keeps a live claim on the callable path and sends its generation identity', async () => {
    const outcome = await finderCancelSpot({
      db: {} as never, spotId: 'spot-1', finderId: 'finder-1',
      confirmedSpot: { finderId: 'finder-1', status: 'interested', interestedUserId: 'claimer-1', claimState: 'heading', claimGenerationId: G1 },
    });
    expect(outcome).toBe('deleted');
    expect(getDocFromServer).not.toHaveBeenCalled();
    expect(deleteDoc).not.toHaveBeenCalled();
    expect(invoke).toHaveBeenCalledWith({
      spotId: 'spot-1', status: 'interested', interestedUserId: 'claimer-1', claimState: 'heading', claimGenerationId: G1,
    });
  });

  it('keeps a retained generation on the callable path', async () => {
    await finderCancelSpot({
      db: {} as never, spotId: 'spot-1', finderId: 'finder-1', confirmedSpot: available({ claimGenerationId: G1 }),
    });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(getDocFromServer).not.toHaveBeenCalled();
    expect(deleteDoc).not.toHaveBeenCalled();
  });

  it('fails closed for a live claim with no valid generation', async () => {
    const outcome = await finderCancelSpot({
      db: {} as never, spotId: 'spot-1', finderId: 'finder-1',
      confirmedSpot: { finderId: 'finder-1', status: 'interested', interestedUserId: 'claimer-1', claimState: 'heading', claimGenerationId: null },
    });
    expect(outcome).toBe('unproven_identity');
    expect(getDocFromServer).not.toHaveBeenCalled();
    expect(deleteDoc).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();
  });

  it('treats a malformed generation on a live claim as unproven', () => {
    expect(cancellationIdentity({
      finderId: 'finder-1', status: 'interested', interestedUserId: 'claimer-1', claimState: 'heading', claimGenerationId: 'bad',
    }).kind).toBe('unproven');
  });
});
