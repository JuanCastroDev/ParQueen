'use strict';

require('./isolatedEmulatorGuard').assertIsolatedEmulator();
const { emulatorEndpoint, emulatorOrigin } = require('./isolatedEmulatorGuard');

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { requireEmulatorProjectId } = require('./emulatorProjectId');
const { claimSpot, prepareClaimIntent, revokeClaimIntent } = require('./claimSpot');
const { cancelClaim } = require('./cancelClaim');
const { checkRateLimit } = require('./rateLimiter');

const PROJECT_ID = requireEmulatorProjectId();
const LIVE_DEMO_PROJECT = 'demo-parkqueen-functions-test';
const host = process.env.FIRESTORE_EMULATOR_HOST ?? '';
if (PROJECT_ID === LIVE_DEMO_PROJECT || host.endsWith(':8080') || host === '') {
  throw new Error('Refusing claimSpot integration tests against the live demo emulator');
}
if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID });
const db = getFirestore();

const FINDER = 'finder-claim-int';
const FIXED = 1_700_000_000_000;
let sequence = 0;

function ids() {
  sequence += 1;
  const suffix = `${process.pid}_${sequence}`;
  return {
    uid: `cs_user_${suffix}`,
    other: `cs_other_${suffix}`,
    spotId: `cs_spot_${suffix}`,
    otherSpot: `cs_other_spot_${suffix}`,
    attemptA: `11111111-1111-4111-8111-${String(sequence).padStart(12, '0')}`,
    attemptB: `22222222-2222-4222-8222-${String(sequence).padStart(12, '0')}`,
  };
}

function deps(extra = {}) {
  return {
    db,
    now: () => Timestamp.fromMillis(FIXED),
    checkRateLimit: async () => {},
    ...extra,
  };
}

async function seedAvailable(spotId, extra = {}) {
  await db.collection('spots').doc(spotId).set({
    status: 'available',
    finderId: FINDER,
    interestedUserId: null,
    expiresAt: Timestamp.fromMillis(FIXED + 3_600_000),
    reportedAt: Timestamp.fromMillis(FIXED + 3_600_000),
    ...extra,
  });
}

function claimRequest(uid, spotId, attemptId, extra = {}) {
  return {
    auth: { uid },
    data: { spotId, attemptId, mode: 'immediate', etaMinutes: 4, ...extra },
  };
}

async function claimPrepared(request, extra = {}) {
  const prepared = await prepareClaimIntent(request, deps(extra));
  if (prepared && prepared.state && prepared.state !== 'prepared' && prepared.state !== 'claimed') {
    return {
      outcome: prepared.state,
      claimGenerationId: null,
      spotId: request.data.spotId,
      mode: request.data.mode,
    };
  }
  return claimSpot(request, deps(extra));
}

describe('claimSpot emulator transaction', () => {
  it('commits one generation for a lost response, a second device, and a raced attempt', async () => {
    const { uid, spotId, attemptA, attemptB } = ids();
    await db.collection('users').doc(uid).set({
      username: 'ada', status: 'Active', productAccessBlocked: false, crowns: 10,
    });
    await seedAvailable(spotId);

    const first = await claimPrepared(claimRequest(uid, spotId, attemptA));
    const replay = await claimSpot(claimRequest(uid, spotId, attemptA), deps());
    expect(replay).toEqual(first);
    expect(first.claimGenerationId).toMatch(/^[0-9a-f]{64}$/);
    let spot = (await db.collection('spots').doc(spotId).get()).data();
    let lock = await db.collection('users').doc(uid).collection('activeIncomingClaims').doc('current').get();
    expect(spot.claimGenerationId).toBe(first.claimGenerationId);
    expect(lock.data().claimGenerationId).toBe(first.claimGenerationId);
    expect(spot.claimStartedAt.toMillis()).toBe(FIXED);
    expect(spot.interestedUserName).toBe('ada');

    const otherDevice = await claimPrepared(claimRequest(uid, spotId, attemptB));
    expect(otherDevice.outcome).toBe('already_held');
    expect(otherDevice.claimGenerationId).toBeNull();
    const otherAttempt = await db.collection('claimSpotAttempts').doc(attemptB).get();
    expect(otherAttempt.data().claimGenerationId).toBeNull();
    expect(spot.claimGenerationId).toBe(first.claimGenerationId);

    const raced = ids();
    await db.collection('users').doc(raced.uid).set({ username: 'bea', status: 'Active', productAccessBlocked: false });
    await seedAvailable(raced.spotId);
    await prepareClaimIntent(claimRequest(raced.uid, raced.spotId, raced.attemptA), deps());
    const pair = await Promise.all([
      claimSpot(claimRequest(raced.uid, raced.spotId, raced.attemptA), deps()),
      claimSpot(claimRequest(raced.uid, raced.spotId, raced.attemptA), deps()),
    ]);
    expect(pair[0].claimGenerationId).toBe(pair[1].claimGenerationId);
    expect(pair[0].outcome).toBe('claimed');
    spot = (await db.collection('spots').doc(raced.spotId).get()).data();
    expect(spot.claimGenerationId).toBe(pair[0].claimGenerationId);
    expect(spot.interestedUserId).toBe(raced.uid);

    const competing = ids();
    await db.collection('users').doc(competing.uid).set({ username: 'cy', status: 'Active', productAccessBlocked: false });
    await seedAvailable(competing.spotId);
    await prepareClaimIntent(claimRequest(competing.uid, competing.spotId, competing.attemptA), deps());
    await prepareClaimIntent(claimRequest(competing.uid, competing.spotId, competing.attemptB), deps());
    const race = await Promise.all([
      claimSpot(claimRequest(competing.uid, competing.spotId, competing.attemptA), deps()),
      claimSpot(claimRequest(competing.uid, competing.spotId, competing.attemptB), deps()),
    ]);
    const claimed = race.filter((item) => item.outcome === 'claimed');
    const closed = race.filter((item) => item.outcome === 'stale_precondition');
    expect(claimed).toHaveLength(1);
    expect(closed).toHaveLength(1);
    expect(closed[0].claimGenerationId).toBeNull();
    spot = (await db.collection('spots').doc(competing.spotId).get()).data();
    expect(spot.claimGenerationId).toBe(claimed[0].claimGenerationId);
  });

  it('keeps a released attempt from acquiring the next generation, including under an identical timestamp', async () => {
    const { uid, spotId, attemptA, attemptB } = ids();
    await db.collection('users').doc(uid).set({ username: 'ada', status: 'Active', productAccessBlocked: false });
    await seedAvailable(spotId);
    const g1 = await claimPrepared(claimRequest(uid, spotId, attemptA));
    await expect(cancelClaim({
      auth: { uid },
      data: { spotId, claimGenerationId: g1.claimGenerationId, reason: 'found_elsewhere' },
    }, deps())).resolves.toMatchObject({ outcome: 'cancelled' });
    let spot = (await db.collection('spots').doc(spotId).get()).data();
    expect(spot.status).toBe('available');
    expect(spot.claimGenerationId).toBeNull();

    const replay = await claimSpot(claimRequest(uid, spotId, attemptA), deps());
    expect(replay).toEqual(g1);
    spot = (await db.collection('spots').doc(spotId).get()).data();
    expect(spot.status).toBe('available');
    expect(spot.interestedUserId).toBeNull();

    const g2 = await claimPrepared(claimRequest(uid, spotId, attemptB));
    expect(g2.claimGenerationId).not.toBe(g1.claimGenerationId);
    spot = (await db.collection('spots').doc(spotId).get()).data();
    expect(spot.claimGenerationId).toBe(g2.claimGenerationId);
    expect(spot.claimStartedAt.toMillis()).toBe(FIXED);

    const staleAttempt = await claimSpot(claimRequest(uid, spotId, attemptA), deps());
    expect(staleAttempt.claimGenerationId).toBe(g1.claimGenerationId);
    expect(staleAttempt.claimGenerationId).not.toBe(spot.claimGenerationId);
    await expect(cancelClaim({
      auth: { uid },
      data: { spotId, claimGenerationId: g1.claimGenerationId, reason: 'traffic' },
    }, deps())).resolves.toMatchObject({ outcome: 'stale_claim' });
    spot = (await db.collection('spots').doc(spotId).get()).data();
    expect(spot.claimGenerationId).toBe(g2.claimGenerationId);
    expect(spot.interestedUserId).toBe(uid);
    const notes = await db.collection('spotNotifications').where('spotId', '==', spotId).get();
    expect(notes.size).toBe(1);

    await expect(cancelClaim({
      auth: { uid },
      data: { spotId, claimGenerationId: g2.claimGenerationId, reason: 'changed_mind' },
    }, deps())).resolves.toMatchObject({ outcome: 'cancelled' });
    spot = (await db.collection('spots').doc(spotId).get()).data();
    expect(spot.claimGenerationId).toBeNull();
    await expect(cancelClaim({
      auth: { uid },
      data: { spotId, claimGenerationId: g2.claimGenerationId, reason: 'changed_mind' },
    }, deps())).resolves.toMatchObject({ outcome: 'already_resolved' });
  });

  it('denies a suspended claimant and a second user without writing a generation', async () => {
    const { uid, other, spotId, attemptA, attemptB } = ids();
    await db.collection('users').doc(uid).set({ status: 'Suspended', productAccessBlocked: false });
    await seedAvailable(spotId);
    await expect(prepareClaimIntent(claimRequest(uid, spotId, attemptA), deps())).rejects.toMatchObject({
      code: 'permission-denied',
    });
    let spot = (await db.collection('spots').doc(spotId).get()).data();
    expect(spot.status).toBe('available');
    expect(spot.claimGenerationId == null).toBe(true);

    await db.collection('users').doc(uid).set({ status: 'Active', productAccessBlocked: false, username: 'ada' });
    const claimed = await claimPrepared(claimRequest(uid, spotId, attemptB));
    await db.collection('users').doc(other).set({ status: 'Active', productAccessBlocked: false });
    const outsider = ids();
    const denied = await claimPrepared(claimRequest(other, spotId, outsider.attemptA));
    expect(denied.outcome).toBe('unavailable');
    expect(denied.claimGenerationId).toBeNull();
    spot = (await db.collection('spots').doc(spotId).get()).data();
    expect(spot.interestedUserId).toBe(uid);
    expect(spot.claimGenerationId).toBe(claimed.claimGenerationId);
  });
});

describe('claim intent emulator protocol', () => {
  it('blocks prepare and redeem after a revocation tombstone', async () => {
    const { uid, spotId, attemptA } = ids();
    await db.collection('users').doc(uid).set({ username: 'ada', status: 'Active', productAccessBlocked: false });
    await seedAvailable(spotId);
    const request = claimRequest(uid, spotId, attemptA);
    expect(await revokeClaimIntent(request, deps())).toMatchObject({ outcome: 'revoked' });
    expect(await revokeClaimIntent(request, deps())).toMatchObject({ outcome: 'revoked' });
    expect((await prepareClaimIntent(request, deps())).state).toBe('revoked');
    expect(await claimSpot(request, deps())).toMatchObject({ outcome: 'revoked', claimGenerationId: null });
    const spot = (await db.collection('spots').doc(spotId).get()).data();
    expect(spot.status).toBe('available');
    expect(spot.claimGenerationId == null).toBe(true);
    expect((await db.collection('claimSpotAttempts').doc(attemptA).get()).exists).toBe(true);
  });

  it('fails a redeem closed when the spot changes and releases only the named generation', async () => {
    const { uid, spotId, attemptA, attemptB } = ids();
    await db.collection('users').doc(uid).set({ username: 'ada', status: 'Active', productAccessBlocked: false });
    await seedAvailable(spotId);
    await prepareClaimIntent(claimRequest(uid, spotId, attemptA), deps());
    await db.collection('spots').doc(spotId).update({ address: 'edited' });
    const closed = await claimSpot(claimRequest(uid, spotId, attemptA), deps());
    expect(closed).toMatchObject({ outcome: 'stale_precondition', claimGenerationId: null });
    let spot = (await db.collection('spots').doc(spotId).get()).data();
    expect(spot.interestedUserId).toBeNull();

    const g1 = await claimPrepared(claimRequest(uid, spotId, attemptB));
    expect(await revokeClaimIntent(claimRequest(uid, spotId, attemptB), deps())).toMatchObject({ outcome: 'released' });
    expect(await revokeClaimIntent(claimRequest(uid, spotId, attemptB), deps())).toMatchObject({ outcome: 'released' });
    const notes = await db.collection('spotNotifications').where('spotId', '==', spotId).get();
    expect(notes.size).toBe(1);
    spot = (await db.collection('spots').doc(spotId).get()).data();
    expect(spot.claimGenerationId).toBeNull();
    const attemptC = attemptB.replace('22222222-2222-4222-8222', '33333333-3333-4333-8333');
    const g2 = await claimPrepared(claimRequest(uid, spotId, attemptC));
    expect(g2.claimGenerationId).not.toBe(g1.claimGenerationId);
    expect(await revokeClaimIntent(claimRequest(uid, spotId, attemptB), deps())).toMatchObject({ outcome: 'released' });
    spot = (await db.collection('spots').doc(spotId).get()).data();
    expect(spot.claimGenerationId).toBe(g2.claimGenerationId);
  });

  it('resolves a concurrent redeem and revoke without leaving a live claim', async () => {
    const { uid, spotId, attemptA } = ids();
    await db.collection('users').doc(uid).set({ username: 'ada', status: 'Active', productAccessBlocked: false });
    await seedAvailable(spotId);
    const request = claimRequest(uid, spotId, attemptA);
    await prepareClaimIntent(request, deps());
    await Promise.all([
      claimSpot(request, deps()),
      revokeClaimIntent(request, deps()),
    ]);
    const spot = (await db.collection('spots').doc(spotId).get()).data();
    expect(spot.interestedUserId == null).toBe(true);
    expect(spot.claimGenerationId == null).toBe(true);
    const notes = await db.collection('spotNotifications').where('spotId', '==', spotId).get();
    expect(notes.size).toBeLessThanOrEqual(1);
  });

  it('charges a new prepare and not a matching terminal replay', async () => {
    const { uid, spotId, attemptA } = ids();
    await db.collection('users').doc(uid).set({ username: 'ada', status: 'Active', productAccessBlocked: false });
    await seedAvailable(spotId);
    const real = { checkRateLimit };
    for (let n = 0; n < 10; n += 1) {
      const attemptId = `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;
      const request = claimRequest(uid, spotId, attemptId);
      await prepareClaimIntent(request, deps(real));
      await revokeClaimIntent(request, deps(real));
    }
    const blocked = `44444444-4444-4444-8444-${String(10).padStart(12, '0')}`;
    await expect(prepareClaimIntent(claimRequest(uid, spotId, blocked), deps(real))).rejects.toMatchObject({
      code: 'resource-exhausted',
    });
    await expect(prepareClaimIntent(claimRequest(uid, spotId, `44444444-4444-4444-8444-${String(0).padStart(12, '0')}`), deps(real)))
      .resolves.toMatchObject({ state: 'revoked' });
    expect((await db.collection('claimSpotAttempts').doc(blocked).get()).exists).toBe(false);
  });

  it('rejects callable HTTP without an App Check token and does not write a claim', async () => {
    const { uid, spotId, attemptA } = ids();
    await db.collection('users').doc(uid).set({ username: 'ada', status: 'Active', productAccessBlocked: false });
    await seedAvailable(spotId);
    const { getAuth } = require('firebase-admin/auth');
    try { await getAuth().createUser({ uid }); } catch { /* already exists */ }
    const customToken = await getAuth().createCustomToken(uid);
    const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
    const signed = await fetch(
      `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-key`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: customToken, returnSecureToken: true }),
      },
    );
    const { idToken } = await signed.json();
    const data = { spotId, attemptId: attemptA, mode: 'immediate', etaMinutes: 4 };
    for (const name of ['prepareClaimIntent', 'claimSpot', 'revokeClaimIntent']) {
      const response = await fetch(`${emulatorOrigin('functions')}/${PROJECT_ID}/us-central1/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${idToken}` },
        body: JSON.stringify({ data }),
      });
      const body = await response.json();
      expect(body.result).toBeUndefined();
      expect(body.error).toBeTruthy();
    }
    const spot = (await db.collection('spots').doc(spotId).get()).data();
    expect(spot.status).toBe('available');
    expect(spot.claimGenerationId == null).toBe(true);
    expect((await db.collection('claimSpotAttempts').doc(attemptA).get()).exists).toBe(false);
  });

  it('denies client reads and writes of attempt records', async () => {
    const fs = require('fs');
    const path = require('path');
    const { initializeTestEnvironment, assertFails } = require('@firebase/rules-unit-testing');
    const { doc, getDoc, setDoc } = require('firebase/firestore');
    const testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: '127.0.0.1',
        port: emulatorEndpoint('firestore').port,
        rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8'),
      },
    });
    try {
      const alice = testEnv.authenticatedContext('intent-rules-alice');
      const attempt = doc(alice.firestore(), 'claimSpotAttempts', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      const counter = doc(alice.firestore(), 'claimIntentCounters', 'intent-rules-alice');
      await assertFails(getDoc(attempt));
      await assertFails(setDoc(attempt, { uid: 'intent-rules-alice', state: 'prepared' }));
      await assertFails(getDoc(counter));
      await assertFails(setDoc(counter, { preparedIds: [] }));
    } finally {
      await testEnv.cleanup();
    }
  });

  it('lets the claimer read a lock and a user-scoped claim outside any map query', async () => {
    const fs = require('fs');
    const path = require('path');
    const { initializeTestEnvironment, assertFails } = require('@firebase/rules-unit-testing');
    const { doc, getDoc, getDocs, setDoc, collection, query, where, limit } = require('firebase/firestore');
    const testEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: '127.0.0.1',
        port: emulatorEndpoint('firestore').port,
        rules: fs.readFileSync(path.join(__dirname, '..', 'firestore.rules'), 'utf8'),
      },
    });
    const generation = 'ab'.repeat(32);
    try {
      await testEnv.withSecurityRulesDisabled(async (context) => {
        const admin = context.firestore();
        await setDoc(doc(admin, 'users', 'intent-rules-alice'), { status: 'Active', productAccessBlocked: false });
        await setDoc(doc(admin, 'users', 'intent-rules-bob'), { status: 'Active', productAccessBlocked: false });
        await setDoc(doc(admin, 'users', 'intent-rules-suspended'), { status: 'Suspended' });
        await setDoc(doc(admin, 'users', 'intent-rules-alice', 'activeIncomingClaims', 'current'), {
          spotId: 'far-spot',
          claimState: 'heading',
          claimStartedAt: new Date(),
          updatedAt: new Date(),
        });
        await setDoc(doc(admin, 'users', 'intent-rules-suspended', 'activeIncomingClaims', 'current'), {
          spotId: 'far-spot',
          claimState: 'heading',
          claimStartedAt: new Date(),
          updatedAt: new Date(),
        });
        await setDoc(doc(admin, 'spots', 'far-spot'), {
          status: 'interested',
          interestedUserId: 'intent-rules-alice',
          claimState: 'heading',
          claimGenerationId: generation,
          geohash: '0000000',
          lat: 0,
          lng: 0,
          finderId: 'finder-x',
          address: 'Far away',
        });
        await setDoc(doc(admin, 'spots', 'bob-spot'), {
          status: 'interested',
          interestedUserId: 'intent-rules-bob',
          claimState: 'committed',
          claimGenerationId: 'cd'.repeat(32),
          geohash: '0000000',
          lat: 1,
          lng: 1,
          finderId: 'finder-y',
        });
      });
      const alice = testEnv.authenticatedContext('intent-rules-alice').firestore();
      const lock = await getDoc(doc(alice, 'users', 'intent-rules-alice', 'activeIncomingClaims', 'current'));
      expect(lock.exists()).toBe(true);
      expect(lock.data().spotId).toBe('far-spot');
      const spot = await getDoc(doc(alice, 'spots', 'far-spot'));
      expect(spot.data().claimGenerationId).toBe(generation);
      const own = query(
        collection(alice, 'spots'),
        where('interestedUserId', '==', 'intent-rules-alice'),
        where('claimState', 'in', ['heading', 'committed']),
        limit(10),
      );
      const found = await getDocs(own);
      expect(found.docs.map((item) => item.id)).toEqual(['far-spot']);
      const bob = testEnv.authenticatedContext('intent-rules-bob').firestore();
      await assertFails(getDoc(doc(bob, 'users', 'intent-rules-alice', 'activeIncomingClaims', 'current')));
      const suspended = testEnv.authenticatedContext('intent-rules-suspended').firestore();
      await assertFails(getDoc(doc(suspended, 'users', 'intent-rules-suspended', 'activeIncomingClaims', 'current')));
      await assertFails(getDocs(query(
        collection(suspended, 'spots'),
        where('interestedUserId', '==', 'intent-rules-suspended'),
        where('claimState', 'in', ['heading', 'committed']),
        limit(10),
      )));
    } finally {
      await testEnv.cleanup();
    }
  });
});
