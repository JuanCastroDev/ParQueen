'use strict';

require('./isolatedEmulatorGuard').assertIsolatedEmulator();

const { readFileSync } = require('node:fs');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { requireEmulatorProjectId } = require('./emulatorProjectId');
const { receiptDocumentId, receiptBody } = require('./finderCancelReceipt');

const PROJECT_ID = requireEmulatorProjectId();
const indexModule = require('./index.js');
if (getApps().length === 0) initializeApp({ projectId: PROJECT_ID });
const db = getFirestore();

const FINDER = 'finder-trigger';
const G1 = 'ab'.repeat(32);
const G2 = 'cd'.repeat(32);

function deletedEvent(spotId, data, eventId) {
  return {
    id: eventId,
    params: { spotId },
    data: { id: spotId, data: () => data },
    time: new Date().toISOString(),
  };
}

function live(uid, generation, extra = {}) {
  return {
    status: 'interested',
    finderId: FINDER,
    interestedUserId: uid,
    claimState: 'heading',
    claimGenerationId: generation,
    expiresAt: Timestamp.fromMillis(Date.now() + 60 * 60 * 1000),
    ...extra,
  };
}

async function seedReceipt(spotId, data) {
  const identity = {
    kind: 'generation',
    finderId: data.finderId,
    status: data.status,
    interestedUserId: data.interestedUserId,
    claimState: data.claimState,
    claimGenerationId: data.claimGenerationId,
  };
  await db.collection('finderCancelReceipts').doc(receiptDocumentId(spotId, identity)).set(receiptBody(spotId, identity));
}

describe('updateTrustOnSpotDelete handler execution', () => {
  it('writes the deleted generation once when the receipt matches and clears that lock', async () => {
    const spotId = `trig_${process.pid}`;
    const data = live('claimer-1', G1);
    await seedReceipt(spotId, data);
    await db.collection('users').doc('claimer-1').collection('activeIncomingClaims').doc('current').set({
      spotId,
      claimGenerationId: G1,
    });
    const event = deletedEvent(spotId, data, `event_${spotId}`);
    await indexModule.updateTrustOnSpotDelete.run(event);
    await indexModule.updateTrustOnSpotDelete.run(event);
    const notes = await db.collection('spotNotifications').where('spotId', '==', spotId).get();
    expect(notes.size).toBe(1);
    expect(notes.docs[0].id).toBe(`finder_cancelled_${spotId}_claimer-1_${G1}`);
    expect(notes.docs[0].data().targetUserId).toBe('claimer-1');
    const lock = await db.collection('users').doc('claimer-1').collection('activeIncomingClaims').doc('current').get();
    expect(lock.exists).toBe(false);
  });

  it('gives G2 its own notice and writes none for admin, expiry, or a G1 receipt', async () => {
    const spotId = `trig2_${process.pid}`;
    const g2 = live('claimer-2', G2);
    await seedReceipt(spotId, g2);
    await indexModule.updateTrustOnSpotDelete.run(deletedEvent(spotId, g2, `event_${spotId}`));
    expect((await db.collection('spotNotifications').doc(`finder_cancelled_${spotId}_claimer-2_${G2}`).get()).exists).toBe(true);
    expect((await db.collection('spotNotifications').doc(`finder_cancelled_${spotId}_claimer-2_${G1}`).get()).exists).toBe(false);

    const swapped = `swap_${process.pid}`;
    await seedReceipt(swapped, live('claimer-1', G1));
    await indexModule.updateTrustOnSpotDelete.run(deletedEvent(swapped, live('claimer-2', G2), `swap_${swapped}`));
    expect((await db.collection('spotNotifications').where('spotId', '==', swapped).get()).size).toBe(0);

    const adminSpot = `admin_${process.pid}`;
    await indexModule.updateTrustOnSpotDelete.run(deletedEvent(adminSpot, { ...live('claimer-1', G1), source: 'admin' }, `admin_${adminSpot}`));
    expect((await db.collection('spotNotifications').where('spotId', '==', adminSpot).get()).size).toBe(0);

    const expiredSpot = `expired_${process.pid}`;
    await indexModule.updateTrustOnSpotDelete.run(deletedEvent(expiredSpot, {
      ...live('claimer-1', G1),
      expiresAt: Timestamp.fromMillis(Date.now() - 60_000),
    }, `expired_${expiredSpot}`));
    expect((await db.collection('spotNotifications').where('spotId', '==', expiredSpot).get()).size).toBe(0);
  });

  it('does not turn an account deletion with no source marker into a finder-cancel notice', async () => {
    const spotId = `account_${process.pid}`;
    const data = live('claimer-1', G1);
    delete data.source;
    await db.collection('users').doc(FINDER).set({ trustStats: {} });
    await db.collection('users').doc('claimer-1').collection('activeIncomingClaims').doc('current').set({
      spotId,
      claimGenerationId: G1,
    });
    await indexModule.updateTrustOnSpotDelete.run(deletedEvent(spotId, data, `account_${spotId}`));
    expect((await db.collection('spotNotifications').where('spotId', '==', spotId).get()).size).toBe(0);
    const lock = await db.collection('users').doc('claimer-1').collection('activeIncomingClaims').doc('current').get();
    expect(lock.exists).toBe(false);
    const trust = await db.collection('users').doc(FINDER).collection('processedTrustEvents').doc(`${spotId}:finder-cancel`).get();
    expect(trust.exists).toBe(false);
    const generationTrust = await db.collection('users').doc(FINDER).collection('processedTrustEvents').doc(`${spotId}:finder-cancel:${G1}`).get();
    expect(generationTrust.exists).toBe(false);
    expect((await db.collection('users').doc(FINDER).get()).data().trustStats.handoffsCancelledByFinder || 0).toBe(0);
  });

  it('applies one penalty for a matching receipt and none for a G2 snapshot', async () => {
    const spotId = `trust_${process.pid}`;
    const data = live('claimer-1', G1);
    await seedReceipt(spotId, data);
    await db.collection('users').doc(FINDER).set({ trustStats: { handoffsCompleted: 0, handoffsCancelledByFinder: 0 } });
    const event = deletedEvent(spotId, data, `trust_${spotId}`);
    await indexModule.updateTrustOnSpotDelete.run(event);
    await indexModule.updateTrustOnSpotDelete.run(event);
    const user = await db.collection('users').doc(FINDER).get();
    expect(user.data().trustStats.handoffsCancelledByFinder).toBe(1);
    expect(user.data().trustStats.handoffsCompleted).toBe(0);
    const trust = await db.collection('users').doc(FINDER).collection('processedTrustEvents').doc(`${spotId}:finder-cancel:${G1}`).get();
    expect(trust.data().source).toBe('finder_cancel_receipt');
    expect(trust.data().statField).toBe('handoffsCancelledByFinder');

    const swapped = `trustg2_${process.pid}`;
    await seedReceipt(swapped, live('claimer-1', G1));
    await indexModule.updateTrustOnSpotDelete.run(deletedEvent(swapped, live('claimer-2', G2), `g2_${swapped}`));
    expect((await db.collection('users').doc(FINDER).get()).data().trustStats.handoffsCancelledByFinder).toBe(1);
    expect((await db.collection('spotNotifications').where('spotId', '==', swapped).get()).size).toBe(0);
  });

  it('writes the server notice beside a legacy client notice and beside twenty unrelated notices', async () => {
    const spotId = `old_${process.pid}`;
    const data = live('claimer-1', G1);
    await seedReceipt(spotId, data);
    await db.collection('spotNotifications').doc(`client_${spotId}`).set({
      spotId,
      senderId: FINDER,
      targetUserId: 'claimer-1',
      type: 'cancelled',
      message: 'Can\'t wait anymore',
      createdAt: Timestamp.now(),
    });
    for (let i = 0; i < 21; i += 1) {
      await db.collection('spotNotifications').doc(`unrelated_${spotId}_${i}`).set({
        spotId,
        senderId: FINDER,
        targetUserId: `other-${i}`,
        type: 'delayed',
        message: 'unrelated',
        createdAt: Timestamp.now(),
      });
    }
    await indexModule.updateTrustOnSpotDelete.run(deletedEvent(spotId, data, `old_event_${spotId}`));
    await indexModule.updateTrustOnSpotDelete.run(deletedEvent(spotId, data, `old_event_${spotId}_retry`));
    const notes = await db.collection('spotNotifications').where('spotId', '==', spotId).get();
    const ids = notes.docs.map((row) => row.id).sort();
    expect(ids).toContain(`client_${spotId}`);
    expect(ids).toContain(`finder_cancelled_${spotId}_claimer-1_${G1}`);
    expect(ids.filter((id) => id.startsWith('finder_cancelled_'))).toEqual([`finder_cancelled_${spotId}_claimer-1_${G1}`]);
    expect(notes.size).toBe(23);
  });

  it('writes no notice for a malformed generation and keeps the handler after trust', async () => {
    const spotId = `bad_${process.pid}`;
    await indexModule.updateTrustOnSpotDelete.run(deletedEvent(spotId, live('claimer-1', 'not-a-generation'), `bad_${spotId}`));
    expect((await db.collection('spotNotifications').where('spotId', '==', spotId).get()).size).toBe(0);
    const src = readFileSync(require('node:path').join(__dirname, 'index.js'), 'utf8');
    const start = src.indexOf('exports.updateTrustOnSpotDelete');
    const end = src.indexOf('exports.adminResolveParseFailure', start);
    const body = src.slice(start, end);
    const clearAt = body.indexOf('clearMatchingActiveIncomingClaim');
    const trustAt = body.indexOf('applyTrustDelta');
    const noticeAt = body.indexOf('writeFinderCancelNotice');
    expect(clearAt).toBeGreaterThan(-1);
    expect(trustAt).toBeGreaterThan(clearAt);
    expect(noticeAt).toBeGreaterThan(trustAt);
    const receiptAt = body.indexOf('readFinderCancelAttribution');
    expect(receiptAt).toBeGreaterThan(clearAt);
    expect(receiptAt).toBeLessThan(trustAt);
    expect(body).toContain('receipt read failed');
    expect(body).toContain('cancellation notice failed');
    expect(body).toContain("serviceAccount: 'parqueen-system-events@parkqueen-46475363-ccf36.iam.gserviceaccount.com'");
  });
});
