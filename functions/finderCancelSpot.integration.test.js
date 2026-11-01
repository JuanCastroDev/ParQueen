'use strict';

const { readFileSync } = require('node:fs');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { requireEmulatorProjectId } = require('./emulatorProjectId');
const { finderCancelSpot } = require('./finderCancelSpot');
const { prepareClaimIntent, claimSpot } = require('./claimSpot');
const { receiptDocumentId } = require('./finderCancelReceipt');

const PROJECT_ID = requireEmulatorProjectId();
if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID });
const db = getFirestore();

const FINDER = 'finder-31af';
const G1 = 'ab'.repeat(32);
const G2 = 'cd'.repeat(32);
const STARTED = 1_700_000_000_000;
let sequence = 0;

function ids() {
  sequence += 1;
  return `spot_${process.pid}_${sequence}`;
}

function confirmed(extra = {}) {
  return {
    spotId: extra.spotId,
    status: extra.status || 'interested',
    interestedUserId: Object.prototype.hasOwnProperty.call(extra, 'interestedUserId') ? extra.interestedUserId : 'claimer-1',
    claimState: Object.prototype.hasOwnProperty.call(extra, 'claimState') ? extra.claimState : 'heading',
    claimGenerationId: Object.prototype.hasOwnProperty.call(extra, 'claimGenerationId') ? extra.claimGenerationId : G1,
  };
}

function request(data) {
  return { auth: { uid: FINDER }, data };
}

async function seed(spotId, extra = {}) {
  const data = {
    status: 'interested',
    finderId: FINDER,
    interestedUserId: 'claimer-1',
    claimState: 'heading',
    claimGenerationId: G1,
    claimStartedAt: Timestamp.fromMillis(STARTED),
    expiresAt: Timestamp.fromMillis(Date.now() + 60 * 60 * 1000),
    ...extra,
  };
  await db.collection('spots').doc(spotId).set(data);
  if (data.interestedUserId) {
    await db.collection('users').doc(data.interestedUserId).collection('activeIncomingClaims').doc('current').set({
      spotId,
      claimGenerationId: data.claimGenerationId,
    });
  }
  return data;
}

async function invoke(spotId, extra = {}) {
  return finderCancelSpot(request(confirmed({ spotId, ...extra })), {
    db,
    checkRateLimit: async () => {},
  });
}

async function spotOf(spotId) {
  const snap = await db.collection('spots').doc(spotId).get();
  return snap.exists ? snap.data() : null;
}

async function lockOf(uid) {
  const snap = await db.collection('users').doc(uid).collection('activeIncomingClaims').doc('current').get();
  return snap.exists ? snap.data() : null;
}

describe('finderCancelSpot emulator transactions', () => {
  it('does not delete a different user G2 that is already stored', async () => {
    const spotId = ids();
    await seed(spotId, {
      interestedUserId: 'claimer-2',
      claimGenerationId: G2,
      claimStartedAt: Timestamp.fromMillis(STARTED),
    });
    expect(await invoke(spotId)).toEqual({ outcome: 'stale' });
    expect((await spotOf(spotId)).claimGenerationId).toBe(G2);
    expect((await lockOf('claimer-2')).claimGenerationId).toBe(G2);
    expect((await db.collection('spotNotifications').where('spotId', '==', spotId).get()).size).toBe(0);
    expect((await db.collection('finderCancelReceipts').where('spotId', '==', spotId).get()).size).toBe(0);
  });

  it('does not delete the same user G2 when the timestamp matches G1', async () => {
    const spotId = ids();
    await seed(spotId, { claimGenerationId: G2, claimStartedAt: Timestamp.fromMillis(STARTED) });
    expect(await invoke(spotId)).toEqual({ outcome: 'stale' });
    expect((await spotOf(spotId)).claimGenerationId).toBe(G2);
    expect((await lockOf('claimer-1')).claimGenerationId).toBe(G2);
  });

  it('overlaps two real cancellation transactions without deleting twice', async () => {
    const spotId = ids();
    await seed(spotId);
    const [first, second] = await Promise.all([invoke(spotId), invoke(spotId)]);
    expect([first.outcome, second.outcome].sort()).toEqual(['already_deleted', 'deleted']);
    expect(await spotOf(spotId)).toBeNull();
    expect(await lockOf('claimer-1')).toBeNull();
  });

  it('keeps G2 when a claim transaction overlaps the cancellation', async () => {
    const spotId = ids();
    await seed(spotId);
    const claim = db.runTransaction(async (tx) => {
      const ref = db.collection('spots').doc(spotId);
      const snap = await tx.get(ref);
      if (!snap.exists) return 'gone';
      tx.update(ref, { interestedUserId: 'claimer-2', claimGenerationId: G2 });
      return 'replaced';
    }).catch(() => 'lost');
    const [outcome, claimResult] = await Promise.all([invoke(spotId), claim]);
    const spot = await spotOf(spotId);
    if (claimResult === 'replaced') {
      expect(outcome.outcome).not.toBe('deleted');
      expect(spot.claimGenerationId).toBe(G2);
      expect(spot.interestedUserId).toBe('claimer-2');
    } else {
      expect(outcome.outcome).toBe('deleted');
      expect(spot).toBeNull();
    }
    expect(Boolean(spot && spot.claimGenerationId === G2 && outcome.outcome === 'deleted')).toBe(false);
  });

  it('does not delete a Ping whose claim was already revoked or released by expiry', async () => {
    for (const extra of [
      { status: 'available', interestedUserId: null, claimState: null, claimGenerationId: null },
      {
        status: 'available',
        interestedUserId: null,
        claimState: null,
        claimGenerationId: null,
        expiresAt: Timestamp.fromMillis(Date.now() - 1000),
      },
    ]) {
      const spotId = ids();
      await db.collection('spots').doc(spotId).set({ finderId: FINDER, ...extra });
      expect((await invoke(spotId)).outcome).toBe('stale');
      expect(await spotOf(spotId)).not.toBeNull();
    }
  });

  it('deletes the same generation after an ancillary update and refuses a status change', async () => {
    const same = ids();
    await seed(same, { ownerLeavingNow: true });
    expect(await invoke(same)).toEqual({ outcome: 'deleted' });
    expect(await spotOf(same)).toBeNull();
    expect(await lockOf('claimer-1')).toBeNull();

    const changed = ids();
    await seed(changed, { status: 'occupied' });
    expect(await invoke(changed)).toEqual({ outcome: 'stale' });
    expect((await spotOf(changed)).status).toBe('occupied');
    expect((await lockOf('claimer-1')).spotId).toBe(changed);
  });

  it('reports a missing Ping without clearing a lock for another Ping', async () => {
    const spotId = ids();
    await db.collection('users').doc('claimer-1').collection('activeIncomingClaims').doc('current').set({
      spotId: 'other-ping',
      claimGenerationId: G2,
    });
    expect(await invoke(spotId)).toEqual({ outcome: 'already_deleted' });
    expect((await lockOf('claimer-1')).spotId).toBe('other-ping');
  });

  it('refuses a changed owner and a suspended or blocked finder', async () => {
    const owned = ids();
    await seed(owned, { finderId: 'other-finder' });
    expect(await invoke(owned)).toEqual({ outcome: 'not_owner' });
    expect((await spotOf(owned)).finderId).toBe('other-finder');

    for (const profile of [
      { status: 'Suspended', productAccessBlocked: false },
      { status: 'Active', productAccessBlocked: true },
    ]) {
      const spotId = ids();
      await db.collection('users').doc(FINDER).set(profile);
      await seed(spotId);
      await expect(invoke(spotId)).rejects.toMatchObject({ code: 'permission-denied' });
      expect((await spotOf(spotId)).claimGenerationId).toBe(G1);
    }
    await db.collection('users').doc(FINDER).delete();
  });

  it('fails closed for a missing or malformed generation and still deletes a proven historical claim', async () => {
    const missing = ids();
    await seed(missing, { claimGenerationId: null });
    expect(await invoke(missing, { claimGenerationId: null })).toEqual({ outcome: 'unproven_identity' });
    expect((await spotOf(missing)).interestedUserId).toBe('claimer-1');

    const malformed = ids();
    await seed(malformed, { claimGenerationId: 'not-a-generation' });
    expect(await invoke(malformed, { claimGenerationId: 'not-a-generation' })).toEqual({ outcome: 'unproven_identity' });
    expect((await spotOf(malformed)).claimGenerationId).toBe('not-a-generation');

    const historical = ids();
    await seed(historical);
    expect(await invoke(historical)).toEqual({ outcome: 'deleted' });
    expect(await spotOf(historical)).toBeNull();
    expect(await lockOf('claimer-1')).toBeNull();
    const receipt = await db.collection('finderCancelReceipts').doc(receiptDocumentId(historical, {
      kind: 'generation',
      claimGenerationId: G1,
    })).get();
    expect(receipt.data()).toMatchObject({
      spotId: historical,
      finderId: FINDER,
      interestedUserId: 'claimer-1',
      claimGenerationId: G1,
      kind: 'generation',
    });
    expect(receipt.data().claimStartedAt).toBeUndefined();
  });

  it('deletes an unclaimed Ping and an available orphan value, including an unclaimed cycle with no revision', async () => {
    const open = ids();
    await db.collection('spots').doc(open).set({ status: 'available', finderId: FINDER });
    expect(await invoke(open, {
      status: 'available', interestedUserId: null, claimState: null, claimGenerationId: null,
    })).toEqual({ outcome: 'deleted' });

    const orphan = ids();
    await db.collection('spots').doc(orphan).set({
      status: 'available', finderId: FINDER, claimGenerationId: 'legacy-orphan',
    });
    expect(await invoke(orphan, {
      status: 'available', interestedUserId: null, claimState: null, claimGenerationId: 'legacy-orphan',
    })).toEqual({ outcome: 'deleted' });

    const cycled = ids();
    await db.collection('spots').doc(cycled).set({ status: 'available', finderId: FINDER });
    expect(await invoke(cycled, {
      status: 'available', interestedUserId: null, claimState: null, claimGenerationId: null,
    })).toEqual({ outcome: 'deleted' });
    const openReceipt = await db.collection('finderCancelReceipts').doc(`${open}_unclaimed`).get();
    expect(openReceipt.data().kind).toBe('unclaimed');
    expect(openReceipt.data().claimGenerationId).toBeNull();
    const orphanReceipt = await db.collection('finderCancelReceipts').doc(`${orphan}_stored_legacy-orphan`).get();
    expect(orphanReceipt.data().kind).toBe('stored_value');
  });

  it('does not let a prepared intent redeem a Ping deleted while it was unclaimed', async () => {
    const spotId = ids();
    const claimer = `intent_${spotId}`;
    const attemptId = `11111111-1111-4111-8111-${String(sequence).padStart(12, '0')}`;
    await db.collection('spots').doc(spotId).set({
      status: 'available',
      finderId: FINDER,
      interestedUserId: null,
      expiresAt: Timestamp.fromMillis(Date.now() + 3_600_000),
      reportedAt: Timestamp.fromMillis(Date.now() + 3_600_000),
    });
    const claimRequest = {
      auth: { uid: claimer },
      data: { spotId, attemptId, mode: 'immediate', etaMinutes: 4 },
    };
    const intentDeps = { db, checkRateLimit: async () => {}, now: () => Timestamp.fromMillis(STARTED) };
    expect((await prepareClaimIntent(claimRequest, intentDeps)).state).toBe('prepared');
    expect(await invoke(spotId, {
      status: 'available', interestedUserId: null, claimState: null, claimGenerationId: null,
    })).toEqual({ outcome: 'deleted' });
    expect((await claimSpot(claimRequest, intentDeps)).outcome).toBe('stale_precondition');
    expect(await spotOf(spotId)).toBeNull();
  });

  it('rejects an unauthenticated or ambiguous request without writing', async () => {
    const spotId = ids();
    await seed(spotId);
    const deps = { db, checkRateLimit: async () => {} };
    await expect(finderCancelSpot({ auth: null, data: confirmed({ spotId }) }, deps)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    await expect(finderCancelSpot(request({ ...confirmed({ spotId }), claimStartedAt: STARTED }), deps)).rejects.toMatchObject({
      code: 'invalid-argument',
    });
    expect((await spotOf(spotId)).claimGenerationId).toBe(G1);
    expect((await lockOf('claimer-1')).spotId).toBe(spotId);
  });
});

describe('finderCancelSpot export contract', () => {
  it('enforces App Check and does not select a service account', () => {
    const src = readFileSync(require('node:path').join(__dirname, 'index.js'), 'utf8');
    const start = src.indexOf('exports.finderCancelSpot = onCall(');
    const end = src.indexOf('exports.awardCrowns', start);
    const slice = src.slice(start, end);
    expect(slice).toContain('enforceAppCheck: true');
    expect(slice).not.toContain('serviceAccount');
  });
});
