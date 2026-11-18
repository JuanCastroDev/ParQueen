'use strict';

const { HttpsError } = require('firebase-functions/v2/https');
const { createCompleteHandoffSuccessHandler } = require('./completeHandoffSuccess');

function setup() {
  const db = {};
  const assertProductAccess = vi.fn(async () => {});
  const joinMutualSuccess = vi.fn(async () => ({ outcome: 'awarded' }));
  const handler = createCompleteHandoffSuccessHandler({
    db,
    assertProductAccess,
    joinMutualSuccess,
    deps: { marker: true },
  });
  return { db, assertProductAccess, joinMutualSuccess, handler };
}

describe('completeHandoffSuccess callable handler', () => {
  it('requires Firebase Auth before reading handoff identity', async () => {
    const { handler, assertProductAccess, joinMutualSuccess } = setup();
    await expect(handler({ data: { spotId: 'spot-1', finderId: 'finder-1' } }))
      .rejects.toMatchObject({ code: 'unauthenticated' });
    expect(assertProductAccess).not.toHaveBeenCalled();
    expect(joinMutualSuccess).not.toHaveBeenCalled();
  });

  it('enforces product access for the authenticated claimer', async () => {
    const { db, handler, assertProductAccess } = setup();
    await handler({ auth: { uid: 'claimer-1' }, data: { spotId: 'spot-1', finderId: 'finder-1' } });
    expect(assertProductAccess).toHaveBeenCalledWith('claimer-1', db);
  });

  it('rejects malformed and self-claim identities', async () => {
    const { handler, joinMutualSuccess } = setup();
    for (const data of [
      { spotId: '../spot', finderId: 'finder-1' },
      { spotId: 'spot-1', finderId: 'claimer-1' },
      { spotId: '', finderId: 'finder-1' },
    ]) {
      await expect(handler({ auth: { uid: 'claimer-1' }, data }))
        .rejects.toBeInstanceOf(HttpsError);
    }
    expect(joinMutualSuccess).not.toHaveBeenCalled();
  });

  it('re-enters the deterministic server transaction using auth as claimer', async () => {
    const { db, handler, joinMutualSuccess } = setup();
    await expect(handler({
      auth: { uid: 'claimer-1' },
      data: { spotId: 'spot-1', finderId: 'finder-1' },
    })).resolves.toEqual({ outcome: 'awarded' });

    expect(joinMutualSuccess).toHaveBeenCalledTimes(1);
    const [passedDb, event] = joinMutualSuccess.mock.calls[0];
    expect(passedDb).toBe(db);
    expect(event.params.feedbackId).toBe('spot-1_claimer-1');
    expect(event.data.data()).toEqual({
      outcome: 'participant_success',
      spotId: 'spot-1',
      userId: 'claimer-1',
      finderId: 'finder-1',
    });
  });

  it('surfaces a server denial instead of leaving the client waiting forever', async () => {
    const { handler, joinMutualSuccess } = setup();
    joinMutualSuccess.mockResolvedValueOnce({ outcome: 'skipped_generation_mismatch' });
    await expect(handler({
      auth: { uid: 'claimer-1' },
      data: { spotId: 'spot-1', finderId: 'finder-1' },
    })).rejects.toMatchObject({ code: 'failed-precondition' });
  });
});
