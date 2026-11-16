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
  throw new Error('Refusing fence emulator proof outside the isolated project and port');
}
if (getApps().length === 0) initializeApp({ projectId: PROJECT });
const db = getFirestore();

const FIXED = 1_700_000_000_000;
const GEN = 'ab'.repeat(32);
let sequence = 0;

function ids(label) {
  sequence += 1;
  const n = String(sequence).padStart(12, '0');
  return {
    label,
    uid: `fence_${label}_${n}`,
    finder: `finder_${label}_${n}`,
    spotId: `spot_${label}_${n}`,
    attemptId: `aaaaaaaa-aaaa-4aaa-8aaa-${n}`,
  };
}

function spot(finder, extra = {}) {
  return {
    status: 'available',
    finderId: finder,
    interestedUserId: null,
    expiresAt: Timestamp.fromMillis(FIXED + 3_600_000),
    reportedAt: Timestamp.fromMillis(FIXED + 3_600_000),
    ...extra,
  };
}

function profile() {
  return { status: 'Active', productAccessBlocked: false, username: 'ada', fullName: 'Ada' };
}

function baseDeps(extra = {}) {
  return {
    db,
    now: () => Timestamp.fromMillis(FIXED),
    checkRateLimit,
    randomBytes: () => Buffer.alloc(32, 4),
    ...extra,
  };
}

function claimData(row) {
  return { auth: { uid: row.uid }, data: { spotId: row.spotId, attemptId: row.attemptId, mode: 'immediate', etaMinutes: 4 } };
}

function cancelData(row) {
  return { auth: { uid: row.uid }, data: { spotId: row.spotId, claimGenerationId: GEN, reason: 'unspecified' } };
}

function finderData(row) {
  return {
    auth: { uid: row.finder },
    data: {
      spotId: row.spotId,
      status: 'available',
      interestedUserId: null,
      claimState: null,
      claimGenerationId: null,
    },
  };
}

async function seed(row, { fenced = false, withProfile = true, claimed = false } = {}) {
  await db.collection('spots').doc(row.spotId).set(claimed ? spot(row.finder, {
    status: 'interested',
    interestedUserId: row.uid,
    claimState: 'heading',
    claimGenerationId: GEN,
  }) : spot(row.finder));
  if (withProfile) await db.collection('users').doc(row.uid).set(profile());
  if (row.finder !== row.uid) await db.collection('users').doc(row.finder).set(profile());
  if (fenced) {
    await db.collection('accountLifecycle').doc(row.uid).set({ decision: 'delete', fenceGeneration: 1 });
    await db.collection('accountLifecycle').doc(row.finder).set({ decision: 'delete', fenceGeneration: 1 });
  }
}

async function rateDocs(uid) {
  const snap = await db.collection('rateLimits').get();
  return snap.docs.filter((doc) => doc.id.endsWith(`_${uid}`)).map((doc) => doc.id);
}

async function observe(row) {
  const [spotSnap, attemptSnap, counterSnap, lockSnap, receiptSnap] = await Promise.all([
    db.collection('spots').doc(row.spotId).get(),
    db.collection(ATTEMPT_COLLECTION).doc(row.attemptId).get(),
    db.collection(COUNTER_COLLECTION).doc(row.uid).get(),
    db.collection('users').doc(row.uid).collection('activeIncomingClaims').doc('current').get(),
    db.collection('finderCancelReceipts').doc(`${row.spotId}_unclaimed`).get(),
  ]);
  const notes = await db.collection('spotNotifications').doc(`claimer_cancelled_${row.spotId}_${GEN}`).get();
  return {
    spot: spotSnap.exists ? spotSnap.data().status : null,
    claimant: spotSnap.exists ? spotSnap.data().interestedUserId : null,
    attempt: attemptSnap.exists ? attemptSnap.data().state : null,
    counter: counterSnap.exists,
    lock: lockSnap.exists,
    receipt: receiptSnap.exists,
    notice: notes.exists,
  };
}

async function cleanup(row) {
  const paths = [
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
  for (const [collection, id] of paths) {
    await db.collection(collection).doc(id).delete();
  }
  await db.collection('users').doc(row.uid).collection('activeIncomingClaims').doc('current').delete();
  const rates = await rateDocs(row.uid);
  const finderRates = await rateDocs(row.finder);
  for (const id of rates.concat(finderRates)) await db.collection('rateLimits').doc(id).delete();
}

beforeAll(async () => {
  const probe = await db.collection('spots').doc('fenceConnectionProbe').get();
  if (probe.exists) throw new Error('Connection probe document already existed');
});

describe('parking fence on isolated Firestore', () => {
  it('keeps an unfenced missing profile able to prepare', async () => {
    const row = ids('onboard');
    await seed(row, { withProfile: false });
    const prepared = await prepareClaimIntent(claimData(row), baseDeps());
    expect(prepared.state).toBe('prepared');
    expect((await observe(row)).attempt).toBe('prepared');
    await cleanup(row);
  });

  it('still denies a suspended profile', async () => {
    const row = ids('suspended');
    await seed(row);
    await db.collection('users').doc(row.uid).set({ status: 'Suspended', productAccessBlocked: false, username: 'ada' });
    await expect(prepareClaimIntent(claimData(row), baseDeps())).rejects.toMatchObject({ code: 'permission-denied' });
    await cleanup(row);
  });

  const denied = [
    ['prepare', (row, deps) => prepareClaimIntent(claimData(row), deps)],
    ['claim', (row, deps) => claimSpot(claimData(row), deps)],
    ['revoke', (row, deps) => revokeClaimIntent(claimData(row), deps)],
    ['cancel', (row, deps) => cancelClaim(cancelData(row), deps)],
    ['finder', (row, deps) => finderCancelSpot(finderData(row), deps)],
  ];

  for (const [name, invoke] of denied) {
    it(`denies ${name} when the fence and an active profile already exist`, async () => {
      const row = ids(`${name}both`);
      await seed(row, { fenced: true, claimed: name === 'cancel' });
      const before = await observe(row);
      await expect(invoke(row, baseDeps())).rejects.toMatchObject({ code: 'permission-denied' });
      expect(await observe(row)).toEqual(before);
      expect(await rateDocs(name === 'finder' ? row.finder : row.uid)).toEqual([]);
      await cleanup(row);
    });

    it(`denies ${name} when the fence exists and the profile is gone`, async () => {
      const row = ids(`${name}nofile`);
      await seed(row, { fenced: true, withProfile: false, claimed: name === 'cancel' });
      await expect(invoke(row, baseDeps())).rejects.toMatchObject({ code: 'permission-denied' });
      const seen = await observe(row);
      expect(seen.attempt).toBeNull();
      expect(seen.receipt).toBe(false);
      expect(seen.notice).toBe(false);
      expect(seen.lock).toBe(false);
      await cleanup(row);
    });

    it(`records fence-before-product-read for ${name}`, async () => {
      const row = ids(`${name}race`);
      await seed(row, { claimed: name === 'cancel' || name === 'claim' });
      if (name === 'claim') {
        await db.collection(ATTEMPT_COLLECTION).doc(row.attemptId).set({
          uid: row.uid,
          attemptId: row.attemptId,
          spotId: row.spotId,
          mode: 'immediate',
          etaMinutes: 4,
          state: 'prepared',
          outcome: null,
          expiresAt: Timestamp.fromMillis(FIXED + 120_000),
          spotUpdateTime: (await db.collection('spots').doc(row.spotId).get()).updateTime,
        });
      }
      const order = [];
      const actor = name === 'finder' ? row.finder : row.uid;
      await expect(invoke(row, baseDeps({
        allowTestHooks: true,
        afterReads: async () => {
          order.push('product-open');
          await db.runTransaction(async (tx) => {
            tx.set(db.collection('accountLifecycle').doc(actor), {
              decision: 'delete',
              fenceGeneration: 1,
            });
          });
          order.push('fence-committed');
        },
      }))).rejects.toMatchObject({ code: 'permission-denied' });
      order.push('product-rejected');
      expect(order).toEqual(['product-open', 'fence-committed', 'product-rejected']);
      const seen = await observe(row);
      expect(seen.attempt).toBe(name === 'claim' ? 'prepared' : null);
      expect(seen.receipt).toBe(false);
      expect(seen.notice).toBe(false);
      if (name !== 'cancel' && name !== 'claim') expect(seen.spot).toBe('available');
      await cleanup(row);
    });
  }

  it('does not create a revoked tombstone when revoke has no attempt and a fence arrives inside the transaction', async () => {
    const row = ids('revokenone');
    await seed(row);
    const order = [];
    await expect(revokeClaimIntent(claimData(row), baseDeps({
      allowTestHooks: true,
      afterReads: async () => {
        order.push('product-open');
        await db.runTransaction(async (tx) => {
          tx.set(db.collection('accountLifecycle').doc(row.uid), { decision: 'delete', fenceGeneration: 1 });
        });
        order.push('fence-committed');
      },
    }))).rejects.toMatchObject({ code: 'permission-denied' });
    expect(order).toEqual(['product-open', 'fence-committed']);
    expect((await observe(row)).attempt).toBeNull();
    await cleanup(row);
  });

  it('lets an unfenced claim commit before a later fence', async () => {
    const row = ids('productfirst');
    await seed(row);
    const order = [];
    const prepared = await prepareClaimIntent(claimData(row), baseDeps());
    expect(prepared.state).toBe('prepared');
    const claimed = await claimSpot(claimData(row), baseDeps());
    order.push(`product-committed:${claimed.outcome}`);
    await db.collection('accountLifecycle').doc(row.uid).set({ decision: 'delete', fenceGeneration: 1 });
    order.push('fence-committed');
    expect(order).toEqual(['product-committed:claimed', 'fence-committed']);
    expect((await observe(row)).claimant).toBe(row.uid);
    await cleanup(row);
  });

  it('lets an unfenced finder cancel delete an available Ping', async () => {
    const row = ids('finderbase');
    await seed(row);
    const result = await finderCancelSpot(finderData(row), baseDeps());
    expect(result.outcome).toBe('deleted');
    expect((await observe(row)).spot).toBeNull();
    expect((await observe(row)).receipt).toBe(true);
    await cleanup(row);
  });

  it('lets an unfenced cancel release a live claim', async () => {
    const row = ids('cancelbase');
    await seed(row, { claimed: true });
    const result = await cancelClaim(cancelData(row), baseDeps());
    expect(result.outcome).toBe('cancelled');
    expect((await observe(row)).claimant).toBeNull();
    await cleanup(row);
  });

  it('lets an unfenced revoke of a missing attempt create one tombstone', async () => {
    const row = ids('revokebase');
    await seed(row);
    const result = await revokeClaimIntent(claimData(row), baseDeps());
    expect(result.outcome).toBe('revoked');
    expect((await observe(row)).attempt).toBe('revoked');
    await cleanup(row);
  });
});
