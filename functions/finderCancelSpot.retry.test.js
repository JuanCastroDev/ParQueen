'use strict';

const { finderCancelSpot } = require('./finderCancelSpot');

const FINDER = 'finder-1';
const G1 = 'ab'.repeat(32);
const G2 = 'cd'.repeat(32);

function ref(path) {
  return {
    path,
    collection(name) {
      return { doc: (id) => ref(`${path}/${name}/${id}`) };
    },
    async get() {
      return { exists: false, data: () => undefined };
    },
  };
}

function optimisticDb(store) {
  return {
    doc(path) {
      return ref(path);
    },
    collection(name) {
      return { doc: (id) => ref(`${name}/${id}`) };
    },
    async runTransaction(fn) {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const seen = store.version;
        const deletes = [];
        const sets = [];
        const tx = {
          async get(target) {
            if (target.path === 'spots/spot-1') {
              return {
                exists: store.spot != null,
                data: () => store.spot,
              };
            }
            const lock = store.locks[target.path];
            return {
              exists: lock != null,
              data: () => lock,
              ref: target,
            };
          },
          delete(target) {
            deletes.push(target.path);
          },
          set(target, data) {
            sets.push({ path: target.path, data });
          },
        };
        const result = await fn(tx);
        if (store.version !== seen) continue;
        if (attempt === 0 && deletes.includes('spots/spot-1') && store.replaceOnFirstDelete) {
          store.spot = store.replaceOnFirstDelete;
          store.version += 1;
          continue;
        }
        if (deletes.includes('spots/spot-1')) {
          store.spot = null;
          store.receipts = sets;
        }
        for (const path of deletes) {
          if (path !== 'spots/spot-1') delete store.locks[path];
        }
        return result;
      }
      throw new Error('retry exhausted');
    },
  };
}

function request(generation, claimant = 'claimer-1') {
  return {
    auth: { uid: FINDER },
    data: {
      spotId: 'spot-1',
      status: 'interested',
      interestedUserId: claimant,
      claimState: 'heading',
      claimGenerationId: generation,
    },
  };
}

describe('finderCancelSpot transaction retry', () => {
  it('does not apply a G1 delete after the spot becomes G2', async () => {
    const store = {
      version: 1,
      spot: {
        status: 'interested',
        finderId: FINDER,
        interestedUserId: 'claimer-1',
        claimState: 'heading',
        claimGenerationId: G1,
        claimStartedAt: 5,
      },
      locks: {
        'users/claimer-1/activeIncomingClaims/current': { spotId: 'spot-1', claimGenerationId: G1 },
      },
      replaceOnFirstDelete: {
        status: 'interested',
        finderId: FINDER,
        interestedUserId: 'claimer-2',
        claimState: 'heading',
        claimGenerationId: G2,
        claimStartedAt: 5,
      },
    };
    store.locks['users/claimer-2/activeIncomingClaims/current'] = { spotId: 'spot-1', claimGenerationId: G2 };
    const outcome = await finderCancelSpot(request(G1), {
      db: optimisticDb(store),
      checkRateLimit: async () => {},
    });
    expect(outcome).toEqual({ outcome: 'stale' });
    expect(store.spot.claimGenerationId).toBe(G2);
    expect(store.spot.interestedUserId).toBe('claimer-2');
    expect(store.locks['users/claimer-2/activeIncomingClaims/current'].claimGenerationId).toBe(G2);
    expect(store.receipts).toBeUndefined();
  });
});
