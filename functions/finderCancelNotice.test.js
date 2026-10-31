'use strict';

const { Timestamp } = require('firebase-admin/firestore');
const { noticeId, writeFinderCancelNotice, NOTICE_MESSAGE } = require('./finderCancelNotice');
const { receiptDocumentId, receiptBody } = require('./finderCancelReceipt');

const G1 = 'a'.repeat(64);
const G2 = 'b'.repeat(64);
const FUTURE = Timestamp.fromMillis(Date.now() + 60_000);
const PAST = Timestamp.fromMillis(Date.now() - 60_000);

function memoryDb() {
  const docs = new Map();
  const db = {
    collection(name) {
      return {
        doc(id) {
          return { path: `${name}/${id}`, id, collectionName: name };
        },
      };
    },
    async runTransaction(fn) {
      const tx = {
        async get(ref) {
          if (db.failGet) {
            const error = new Error('get failed');
            error.code = 'unavailable';
            throw error;
          }
          const data = docs.get(ref.path);
          return { exists: data != null, data: () => (data == null ? undefined : { ...data }) };
        },
        set(ref, data) {
          if (db.failSet) {
            db.failSet = false;
            const error = new Error('set failed');
            error.code = 'unavailable';
            throw error;
          }
          docs.set(ref.path, { ...data });
        },
      };
      return fn(tx);
    },
    read(path) {
      const data = docs.get(path);
      return data == null ? undefined : { ...data };
    },
    failGet: false,
    failSet: false,
  };
  db.seed = (path, data) => docs.set(path, { ...data });
  return db;
}

function deletedClaim(generation, uid = 'claimer-1', extra = {}) {
  return {
    finderId: 'finder-1',
    status: 'interested',
    interestedUserId: uid,
    claimState: 'heading',
    claimGenerationId: generation,
    expiresAt: FUTURE,
    ...extra,
  };
}

function seedReceipt(db, spotId, data) {
  const identity = {
    kind: 'generation',
    finderId: data.finderId,
    status: data.status,
    interestedUserId: data.interestedUserId,
    claimState: data.claimState,
    claimGenerationId: data.claimGenerationId,
  };
  db.seed(`finderCancelReceipts/${receiptDocumentId(spotId, identity)}`, receiptBody(spotId, identity));
}

describe('deleted-claim notification', () => {
  it('writes one server notice for a receipt and ignores a second delivery', async () => {
    const db = memoryDb();
    const data = deletedClaim(G1);
    seedReceipt(db, 'spot-1', data);
    const first = await writeFinderCancelNotice(db, 'spot-1', data, 'event-1', Date.now());
    const second = await writeFinderCancelNotice(db, 'spot-1', data, 'event-1', Date.now());
    expect(first).toMatchObject({ wrote: true });
    expect(second.reason).toBe('already_recorded');
    const stored = db.read(`spotNotifications/${first.id}`);
    expect(stored.targetUserId).toBe('claimer-1');
    expect(stored.message).toBe(NOTICE_MESSAGE);
    expect(stored.claimGenerationId).toBeUndefined();
    expect(noticeId('spot-1', 'claimer-1', G1)).not.toBe(noticeId('spot-1', 'claimer-1', G2));
    expect(db.read(`spotNotifications/${noticeId('spot-1', 'claimer-1', G2)}`)).toBeUndefined();
  });

  it('does not invent an id for a missing or malformed generation', async () => {
    const db = memoryDb();
    const malformed = await writeFinderCancelNotice(db, 'spot-1', deletedClaim('not-a-generation'), 'event-1', Date.now());
    expect(malformed).toEqual({ wrote: false, reason: 'no_generation' });
    const missing = deletedClaim(null);
    missing.claimGenerationId = null;
    const result = await writeFinderCancelNotice(db, 'spot-1', missing, 'event-7', Date.now());
    expect(result).toEqual({ wrote: false, reason: 'no_generation' });
    expect(db.read('spotNotifications/finder_deleted_spot-1_claimer-1_event-7')).toBeUndefined();
    expect(noticeId('spot-1', 'claimer-1', null)).toBeNull();
  });

  it('keeps a legacy client notice and still writes the deterministic server notice', async () => {
    const db = memoryDb();
    const data = deletedClaim(G1);
    seedReceipt(db, 'spot-1', data);
    db.seed('spotNotifications/random-client-id', {
      spotId: 'spot-1',
      targetUserId: 'claimer-1',
      type: 'cancelled',
      senderId: 'finder-1',
      message: 'old client',
      createdAt: FUTURE,
    });
    for (let i = 0; i < 21; i += 1) {
      db.seed(`spotNotifications/unrelated-${i}`, {
        spotId: 'spot-1',
        targetUserId: `other-${i}`,
        type: 'delayed',
        senderId: 'finder-1',
        message: 'unrelated',
        createdAt: FUTURE,
      });
    }
    const result = await writeFinderCancelNotice(db, 'spot-1', data, 'event-1', Date.now());
    expect(result.wrote).toBe(true);
    expect(db.read('spotNotifications/random-client-id').message).toBe('old client');
    expect(db.read(`spotNotifications/${result.id}`).targetUserId).toBe('claimer-1');
    const again = await writeFinderCancelNotice(db, 'spot-1', data, 'event-2', Date.now());
    expect(again.reason).toBe('already_recorded');
  });

  it('refuses a notice when the receipt is missing or belongs to another generation', async () => {
    const db = memoryDb();
    const g1 = deletedClaim(G1);
    const missing = await writeFinderCancelNotice(db, 'spot-1', g1, 'event-1', Date.now());
    expect(missing).toEqual({ wrote: false, reason: 'no_receipt' });
    seedReceipt(db, 'spot-1', g1);
    const g2 = deletedClaim(G2, 'claimer-1');
    const mismatch = await writeFinderCancelNotice(db, 'spot-1', g2, 'event-2', Date.now());
    expect(mismatch).toEqual({ wrote: false, reason: 'no_receipt' });
    expect(db.read(`spotNotifications/${noticeId('spot-1', 'claimer-1', G2)}`)).toBeUndefined();
    const sameClaimant = deletedClaim(G2, 'claimer-1');
    seedReceipt(db, 'spot-2', sameClaimant);
    const otherSpot = await writeFinderCancelNotice(db, 'spot-2', sameClaimant, 'event-3', Date.now());
    expect(otherSpot.wrote).toBe(true);
    expect(otherSpot.id).toContain(G2);
  });

  it('does not throw when the notice write fails, then a retry records one notice', async () => {
    const db = memoryDb();
    const data = deletedClaim(G1);
    seedReceipt(db, 'spot-1', data);
    db.failSet = true;
    const failed = await writeFinderCancelNotice(db, 'spot-1', data, 'event-1', Date.now());
    expect(failed.reason).toBe('write_failed');
    const retried = await writeFinderCancelNotice(db, 'spot-1', data, 'event-1', Date.now());
    expect(retried.wrote).toBe(true);
    expect(db.read(`spotNotifications/${retried.id}`).type).toBe('cancelled');
    const expired = deletedClaim(G1);
    expired.expiresAt = PAST;
    seedReceipt(db, 'spot-expired', expired);
    expect((await writeFinderCancelNotice(db, 'spot-expired', expired, 'event-2', Date.now())).reason).toBe('not_applicable');
    const admin = deletedClaim(G1, 'claimer-1', { source: 'admin' });
    seedReceipt(db, 'spot-admin', admin);
    expect((await writeFinderCancelNotice(db, 'spot-admin', admin, 'event-3', Date.now())).reason).toBe('not_applicable');
    const accountDeletion = deletedClaim(G1);
    delete accountDeletion.source;
    expect((await writeFinderCancelNotice(memoryDb(), 'spot-account', accountDeletion, 'event-4', Date.now())).reason).toBe('no_receipt');
  });

  it('is invoked from the delete trigger after lock cleanup and trust, without a new service account', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    const start = src.indexOf('exports.updateTrustOnSpotDelete');
    const body = src.slice(start, src.indexOf('exports.adminResolveParseFailure'));
    expect(body.indexOf('clearMatchingActiveIncomingClaim')).toBeLessThan(body.indexOf('applyTrustDelta'));
    expect(body.indexOf('applyTrustDelta')).toBeLessThan(body.indexOf('writeFinderCancelNotice'));
    expect(body).toContain("serviceAccount: 'parqueen-system-events@parkqueen-46475363-ccf36.iam.gserviceaccount.com'");
    expect(body).toContain('cancellation notice failed');
    expect(body).toContain('A missing source is not a user');
    const noticeAt = body.indexOf('writeFinderCancelNotice');
    const tryAt = body.lastIndexOf('try {', noticeAt);
    expect(body.slice(tryAt, noticeAt + 80)).toContain('writeFinderCancelNotice');
  });
});
