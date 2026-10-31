'use strict';

const {
  readFinderCancelAttribution,
  finderCancelTrustEventId,
  receiptDocumentId,
  receiptBody,
} = require('./finderCancelReceipt');

const G1 = 'ab'.repeat(32);
const G2 = 'cd'.repeat(32);

function snapshot(generation, extra = {}) {
  return {
    status: 'interested',
    finderId: 'finder-1',
    interestedUserId: 'claimer-1',
    claimState: 'heading',
    claimGenerationId: generation,
    ...extra,
  };
}

function memoryDb(seed, fail = false) {
  return {
    collection(name) {
      return {
        doc(id) {
          return {
            async get() {
              if (fail) {
                const error = new Error('read failed');
                error.code = 'unavailable';
                throw error;
              }
              const data = seed[`${name}/${id}`];
              return { exists: data != null, data: () => data };
            },
          };
        },
      };
    },
  };
}

function seedReceipt(generation, data = snapshot(generation)) {
  const identity = {
    kind: 'generation',
    finderId: data.finderId,
    status: data.status,
    interestedUserId: data.interestedUserId,
    claimState: data.claimState,
    claimGenerationId: generation,
  };
  const id = receiptDocumentId('spot-1', identity);
  return { [`finderCancelReceipts/${id}`]: receiptBody('spot-1', identity) };
}

describe('finder cancellation trust attribution', () => {
  it('names the trust event by spot and generation and fails closed without a matching receipt', async () => {
    const data = snapshot(G1);
    const matched = await readFinderCancelAttribution(memoryDb(seedReceipt(G1, data)), 'spot-1', data);
    expect(matched).toEqual({ eventId: `spot-1:finder-cancel:${G1}`, claimGenerationId: G1 });
    expect(await readFinderCancelAttribution(memoryDb({}), 'spot-1', data)).toBeNull();
    expect(await readFinderCancelAttribution(memoryDb(seedReceipt(G1, data)), 'spot-1', snapshot(G2))).toBeNull();
    const otherClaimant = snapshot(G1, { interestedUserId: 'claimer-2' });
    expect(await readFinderCancelAttribution(memoryDb(seedReceipt(G1, data)), 'spot-1', otherClaimant)).toBeNull();
    expect(finderCancelTrustEventId('spot-1', 'not-a-generation')).toBeNull();
    expect(finderCancelTrustEventId('spot/1', G1)).toBeNull();
    expect(finderCancelTrustEventId('spot-1', null)).toBeNull();
  });

  it('throws when the receipt cannot be read and keeps receipt paths free of slashes', async () => {
    await expect(readFinderCancelAttribution(memoryDb({}, true), 'spot-1', snapshot(G1))).rejects.toThrow('read failed');
    const stored = receiptDocumentId('spot-1', { kind: 'stored_value', claimGenerationId: 'legacy-orphan' });
    const unclaimed = receiptDocumentId('spot-1', { kind: 'unclaimed' });
    expect(stored).toBe('spot-1_stored_legacy-orphan');
    expect(unclaimed).toBe('spot-1_unclaimed');
    expect(stored.includes('/')).toBe(false);
    expect(receiptDocumentId('bad/id', { kind: 'generation', claimGenerationId: G1 })).toBeNull();
  });
});
