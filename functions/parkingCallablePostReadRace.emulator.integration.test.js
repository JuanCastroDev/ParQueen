'use strict';

require('./isolatedEmulatorGuard').assertIsolatedEmulator({ services: ['firestore'] });

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { prepareClaimIntent, claimSpot, revokeClaimIntent, ATTEMPT_COLLECTION, COUNTER_COLLECTION } = require('./claimSpot');
const { cancelClaim } = require('./cancelClaim');
const { finderCancelSpot } = require('./finderCancelSpot');
const { checkRateLimit } = require('./rateLimiter');

const PROJECT = 'demo-parkqueen-parking-fence-iso';
const host = process.env.FIRESTORE_EMULATOR_HOST || '';
if (process.env.GCLOUD_PROJECT !== PROJECT || host === '' || host.endsWith(':8080')) {
  throw new Error('Refusing post-read race proof outside the isolated project and port');
}
if (getApps().length === 0) initializeApp({ projectId: PROJECT });
const db = getFirestore();

const FIXED = 1_700_000_000_000;
const GEN = 'cd'.repeat(32);
const PAUSE_MS = 2000;
let sequence = 0;

function ids(label) {
  sequence += 1;
  const n = String(sequence).padStart(12, '0');
  return {
    uid: `post_${label}_${n}`,
    finder: `postfinder_${label}_${n}`,
    spotId: `postspot_${label}_${n}`,
    attemptId: `bbbbbbbb-bbbb-4bbb-8bbb-${n}`,
  };
}

function available(finder) {
  return {
    status: 'available',
    finderId: finder,
    interestedUserId: null,
    expiresAt: Timestamp.fromMillis(FIXED + 3_600_000),
    reportedAt: Timestamp.fromMillis(FIXED + 3_600_000),
  };
}

function baseDeps(extra = {}) {
  return {
    db,
    now: () => Timestamp.fromMillis(FIXED),
    checkRateLimit,
    randomBytes: () => Buffer.alloc(32, 7),
    ...extra,
  };
}

function claimRequest(row) {
  return { auth: { uid: row.uid }, data: { spotId: row.spotId, attemptId: row.attemptId, mode: 'immediate', etaMinutes: 4 } };
}

async function seed(row, claimed = false) {
  await db.collection('users').doc(row.uid).set({ status: 'Active', productAccessBlocked: false, username: 'ada' });
  await db.collection('users').doc(row.finder).set({ status: 'Active', productAccessBlocked: false, username: 'bea' });
  await db.collection('spots').doc(row.spotId).set(claimed ? {
    ...available(row.finder),
    status: 'interested',
    interestedUserId: row.uid,
    claimState: 'heading',
    claimGenerationId: GEN,
  } : available(row.finder));
}

async function snapshot(row) {
  const [spotSnap, attemptSnap, counterSnap, lockSnap, receiptSnap, noticeSnap, lifeSnap] = await Promise.all([
    db.collection('spots').doc(row.spotId).get(),
    db.collection(ATTEMPT_COLLECTION).doc(row.attemptId).get(),
    db.collection(COUNTER_COLLECTION).doc(row.uid).get(),
    db.collection('users').doc(row.uid).collection('activeIncomingClaims').doc('current').get(),
    db.collection('finderCancelReceipts').doc(`${row.spotId}_unclaimed`).get(),
    db.collection('spotNotifications').doc(`claimer_cancelled_${row.spotId}_${GEN}`).get(),
    db.collection('accountLifecycle').doc(row.uid).get(),
  ]);
  return {
    spot: spotSnap.exists ? spotSnap.data().status : null,
    claimant: spotSnap.exists ? spotSnap.data().interestedUserId || null : null,
    attempt: attemptSnap.exists ? attemptSnap.data().state : null,
    generation: attemptSnap.exists ? attemptSnap.data().claimGenerationId || null : null,
    counter: counterSnap.exists,
    lock: lockSnap.exists,
    receipt: receiptSnap.exists,
    notice: noticeSnap.exists,
    fence: lifeSnap.exists,
  };
}

async function rateCount(uid) {
  const snap = await db.collection('rateLimits').get();
  return snap.docs.filter((doc) => doc.id.endsWith(`_${uid}`)).length;
}

function holdForFence(actor, events) {
  const fences = [];
  let reads = 0;
  const afterLifecycleRead = async (snap) => {
    reads += 1;
    if (snap.exists) {
      events.push(`lifecycle-reread-present:${reads}`);
      return;
    }
    if (reads > 1) {
      events.push(`lifecycle-reread-absent:${reads}`);
      return;
    }
    events.push('product-lifecycle-read-absent');
    const fence = db.runTransaction(async (tx) => {
      tx.set(db.collection('accountLifecycle').doc(actor), { decision: 'delete', fenceGeneration: 1 });
    }).then(() => {
      events.push('fence-committed');
      return 'committed';
    }).catch((error) => {
      events.push(`fence-writer-failed:${error.code || 'error'}`);
      return 'failed';
    });
    fences.push(fence);
    events.push('fence-writer-started');
    const whilePaused = await Promise.race([
      fence,
      new Promise((resolve) => { setTimeout(() => resolve('blocked'), PAUSE_MS); }),
    ]);
    events.push(whilePaused === 'committed' ? 'fence-committed-while-paused' : 'fence-blocked-while-product-held');
  };
  return { afterLifecycleRead, fences, readCount: () => reads };
}

async function settle(fences) {
  await Promise.race([
    Promise.all(fences),
    new Promise((_, reject) => { setTimeout(() => reject(new Error('fence writer did not settle')), 8000); }),
  ]);
}

async function cleanup(row) {
  const docs = [
    ['spots', row.spotId],
    [ATTEMPT_COLLECTION, row.attemptId],
    [COUNTER_COLLECTION, row.uid],
    ['accountLifecycle', row.uid],
    ['accountLifecycle', row.finder],
    ['users', row.uid],
    ['users', row.finder],
    ['finderCancelReceipts', `${row.spotId}_unclaimed`],
    ['spotNotifications', `claimer_cancelled_${row.spotId}_${GEN}`],
  ];
  for (const [name, id] of docs) await db.collection(name).doc(id).delete();
  await db.collection('users').doc(row.uid).collection('activeIncomingClaims').doc('current').delete();
  const rates = await db.collection('rateLimits').get();
  for (const doc of rates.docs) {
    if (doc.id.endsWith(`_${row.uid}`) || doc.id.endsWith(`_${row.finder}`)) await doc.ref.delete();
  }
}

beforeAll(async () => {
  await db.collection('spots').doc('postReadConnectionProbe').get();
});

describe('post-lifecycle-read fence race', () => {
  const cases = [
    {
      name: 'prepare',
      actor: (row) => row.uid,
      run: (row, deps) => prepareClaimIntent(claimRequest(row), deps),
      again: (row) => prepareClaimIntent(claimRequest(row), baseDeps()),
      productChanged: (before, after) => before.attempt !== after.attempt,
    },
    {
      name: 'claim',
      actor: (row) => row.uid,
      prepareFirst: true,
      run: (row, deps) => claimSpot(claimRequest(row), deps),
      again: (row) => claimSpot(claimRequest(row), baseDeps()),
      productChanged: (before, after) => before.attempt !== after.attempt || before.claimant !== after.claimant,
    },
    {
      name: 'revoke-absent',
      actor: (row) => row.uid,
      run: (row, deps) => revokeClaimIntent(claimRequest(row), deps),
      again: (row) => revokeClaimIntent(claimRequest(row), baseDeps()),
      productChanged: (before, after) => before.attempt !== after.attempt,
    },
    {
      name: 'revoke-claimed',
      actor: (row) => row.uid,
      claimFirst: true,
      run: (row, deps) => revokeClaimIntent(claimRequest(row), deps),
      again: (row) => revokeClaimIntent(claimRequest(row), baseDeps()),
      productChanged: (before, after) => before.spot !== after.spot || before.attempt !== after.attempt,
    },
    {
      name: 'cancel',
      actor: (row) => row.uid,
      seedClaimed: true,
      run: (row, deps) => cancelClaim({
        auth: { uid: row.uid },
        data: { spotId: row.spotId, claimGenerationId: GEN, reason: 'unspecified' },
      }, deps),
      again: (row) => cancelClaim({
        auth: { uid: row.uid },
        data: { spotId: row.spotId, claimGenerationId: GEN, reason: 'unspecified' },
      }, baseDeps()),
      productChanged: (before, after) => before.spot !== after.spot || before.notice !== after.notice,
    },
    {
      name: 'finder',
      actor: (row) => row.finder,
      run: (row, deps) => finderCancelSpot({
        auth: { uid: row.finder },
        data: {
          spotId: row.spotId,
          status: 'available',
          interestedUserId: null,
          claimState: null,
          claimGenerationId: null,
        },
      }, deps),
      again: (row) => finderCancelSpot({
        auth: { uid: row.finder },
        data: {
          spotId: row.spotId,
          status: 'available',
          interestedUserId: null,
          claimState: null,
          claimGenerationId: null,
        },
      }, baseDeps()),
      productChanged: (before, after) => before.spot !== after.spot || before.receipt !== after.receipt,
    },
  ];

  for (const spec of cases) {
    it(`settles ${spec.name} after a pause on an absent lifecycle read`, async () => {
      const row = ids(spec.name.replace(/[^a-z]/g, ''));
      await seed(row, spec.seedClaimed === true);
      if (spec.prepareFirst || spec.claimFirst) {
        const prepared = await prepareClaimIntent(claimRequest(row), baseDeps());
        expect(prepared.state).toBe('prepared');
      }
      if (spec.claimFirst) {
        const claimed = await claimSpot(claimRequest(row), baseDeps());
        expect(claimed.outcome).toBe('claimed');
      }
      const before = await snapshot(row);
      const ratesBefore = await rateCount(spec.actor(row));
      const events = [];
      const held = holdForFence(spec.actor(row), events);
      let failed = null;
      try {
        const result = await spec.run(row, baseDeps({
          allowTestHooks: true,
          afterLifecycleRead: held.afterLifecycleRead,
        }));
        events.push(`product-returned:${result.outcome || result.state}`);
      } catch (error) {
        failed = error;
        events.push(`product-failed:${error.code}`);
      }
      await settle(held.fences);
      const after = await snapshot(row);
      const actorFence = await db.collection('accountLifecycle').doc(spec.actor(row)).get();
      expect(actorFence.exists).toBe(true);
      const returnedAt = events.findIndex((item) => item.startsWith('product-returned:'));
      const failedAt = events.findIndex((item) => item.startsWith('product-failed:'));
      const fenceAt = events.indexOf('fence-committed');
      const reread = events.findIndex((item) => item.startsWith('lifecycle-reread-present:'));
      const blocked = events.indexOf('fence-blocked-while-product-held');
      const pausedFence = events.indexOf('fence-committed-while-paused');
      expect(events[0]).toBe('product-lifecycle-read-absent');
      expect(events.indexOf('fence-writer-started')).toBe(1);
      expect(fenceAt).toBeGreaterThan(1);
      if (blocked !== -1 && pausedFence === -1 && reread === -1 && returnedAt !== -1) {
        expect(blocked).toBeGreaterThan(events.indexOf('fence-writer-started'));
        expect(held.readCount()).toBe(1);
        expect(failed).toBeNull();
        expect(spec.productChanged(before, after)).toBe(true);
      } else if (pausedFence !== -1 && reread !== -1 && failedAt > reread) {
        expect(held.readCount()).toBeGreaterThan(1);
        expect(failed && failed.code).toBe('permission-denied');
        expect(spec.productChanged(before, after)).toBe(false);
      } else {
        throw new Error(`Unclassified post-read order: ${JSON.stringify(events)}`);
      }
      console.log(JSON.stringify({ handler: spec.name, events, reads: held.readCount() }));
      const replay = await spec.again(row).then(() => 'allowed').catch((error) => error.code);
      expect(replay).toBe('permission-denied');
      const finalState = await snapshot(row);
      expect(finalState).toEqual(after);
      expect(await rateCount(spec.actor(row))).toBeGreaterThanOrEqual(ratesBefore);
      await cleanup(row);
    });
  }

  it('blocks a later prepare after an earlier unfenced claim', async () => {
    const row = ids('earlier');
    await seed(row);
    const prepared = await prepareClaimIntent(claimRequest(row), baseDeps());
    const claimed = await claimSpot(claimRequest(row), baseDeps());
    expect(prepared.state).toBe('prepared');
    expect(claimed.outcome).toBe('claimed');
    await db.collection('accountLifecycle').doc(row.uid).set({ decision: 'delete', fenceGeneration: 1 });
    await expect(prepareClaimIntent({
      auth: { uid: row.uid },
      data: { spotId: row.spotId, attemptId: 'cccccccc-cccc-4ccc-8ccc-000000000001', mode: 'immediate', etaMinutes: 4 },
    }, baseDeps())).rejects.toMatchObject({ code: 'permission-denied' });
    expect((await snapshot(row)).generation).toBe(claimed.claimGenerationId);
    await cleanup(row);
  });

  it('fails closed when the preliminary or transactional lifecycle read fails', async () => {
    const handlers = [
      ['prepare', (row, deps) => prepareClaimIntent(claimRequest(row), deps), (row) => row.uid],
      ['claim', (row, deps) => claimSpot(claimRequest(row), deps), (row) => row.uid],
      ['revoke', (row, deps) => revokeClaimIntent(claimRequest(row), deps), (row) => row.uid],
      ['cancel', (row, deps) => cancelClaim({
        auth: { uid: row.uid },
        data: { spotId: row.spotId, claimGenerationId: GEN, reason: 'unspecified' },
      }, deps), (row) => row.uid],
      ['finder', (row, deps) => finderCancelSpot({
        auth: { uid: row.finder },
        data: {
          spotId: row.spotId,
          status: 'available',
          interestedUserId: null,
          claimState: null,
          claimGenerationId: null,
        },
      }, deps), (row) => row.finder],
    ];
    for (const [name, invoke, actorOf] of handlers) {
      for (const mode of ['preflight', 'transaction']) {
        const row = ids(`${name}${mode}`);
        await seed(row, name === 'cancel');
        if (name === 'claim') {
          await prepareClaimIntent(claimRequest(row), baseDeps());
        }
        const before = await snapshot(row);
        const ratesBefore = await rateCount(actorOf(row));
        const wrapped = {
          collection: (collectionName) => db.collection(collectionName),
          doc(path) {
            const ref = db.doc(path);
            if (mode === 'preflight' && path.startsWith('accountLifecycle/')) {
              return { path, get: async () => { throw new Error('preliminary lifecycle read failed'); } };
            }
            return ref;
          },
          async runTransaction(fn) {
            return db.runTransaction(async (tx) => fn({
              get: async (target) => {
                if (mode === 'transaction' && target.path && target.path.startsWith('accountLifecycle/')) {
                  throw new Error('transactional lifecycle read failed');
                }
                return tx.get(target);
              },
              set: (target, data, options) => tx.set(target, data, options),
              update: (target, data) => tx.update(target, data),
              delete: (target) => tx.delete(target),
              create: (target, data) => tx.create(target, data),
            }));
          },
        };
        await expect(invoke(row, baseDeps({ db: wrapped }))).rejects.toMatchObject({
          code: mode === 'preflight' ? 'permission-denied' : 'internal',
        });
        const after = await snapshot(row);
        expect(after.attempt).toBe(before.attempt);
        expect(after.spot).toBe(before.spot);
        expect(after.claimant).toBe(before.claimant);
        expect(after.counter).toBe(before.counter);
        expect(after.lock).toBe(before.lock);
        expect(after.receipt).toBe(before.receipt);
        expect(after.notice).toBe(before.notice);
        const ratesAfter = await rateCount(actorOf(row));
        if (mode === 'preflight' || name === 'claim') expect(ratesAfter).toBe(ratesBefore);
        else expect(ratesAfter).toBeGreaterThan(ratesBefore);
        await cleanup(row);
      }
    }
  });

  it('rejects a lifecycle hook that is not explicitly enabled', async () => {
    const row = ids('seam');
    await seed(row);
    await expect(prepareClaimIntent(claimRequest(row), baseDeps({
      afterLifecycleRead: async () => {},
    }))).rejects.toMatchObject({ code: 'internal' });
    expect((await snapshot(row)).attempt).toBeNull();
    await cleanup(row);
  });
});
