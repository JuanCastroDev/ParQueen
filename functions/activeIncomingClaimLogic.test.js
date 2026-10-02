'use strict';

const fs = require('fs');
const path = require('path');
const {
  STALE_ACTIVE_CLAIM_LOCK_MS,
  ACTIVE_INCOMING_CLAIM_COLLECTION,
  ACTIVE_INCOMING_CLAIM_DOC_ID,
  ACTIVE_INCOMING_CLAIM_ROLLOUT_COLLECTION,
  ACTIVE_INCOMING_CLAIM_ROLLOUT_DOC_ID,
  CANONICAL_ACTIVE_CLAIM_RULE,
  pingHoldsActiveClaim,
  shouldGarbageCollectLock,
  lockNamesSpot,
  planUserReconciliation,
  auditActiveClaimGroups,
  invariantMayBeEnforced,
  releasedInterestPatch,
} = require('./activeIncomingClaimLogic');

const FIFTEEN_MIN = 15 * 60 * 1000;

describe('active incoming claim lock logic', () => {
  it('uses the approved 15-minute stale-lock TTL', () => {
    expect(STALE_ACTIVE_CLAIM_LOCK_MS).toBe(FIFTEEN_MIN);
  });

  it('treats only status=interested for this user as an active claim', () => {
    const uid = 'user-1';
    expect(pingHoldsActiveClaim({ status: 'interested', interestedUserId: uid }, uid)).toBe(true);
    expect(pingHoldsActiveClaim({ status: 'interested', interestedUserId: 'other' }, uid)).toBe(false);
    expect(pingHoldsActiveClaim({ status: 'occupied', interestedUserId: uid }, uid)).toBe(false);
    expect(pingHoldsActiveClaim({ status: 'available', interestedUserId: null }, uid)).toBe(false);
    expect(pingHoldsActiveClaim(null, uid)).toBe(false);
    expect(pingHoldsActiveClaim({ status: 'interested', claimState: 'committed', interestedUserId: uid }, uid)).toBe(true);
  });

  it('keeps a matching lock even after 15 minutes', () => {
    const now = 1_000_000_000;
    const spot = { status: 'interested', interestedUserId: 'user-1' };
    expect(shouldGarbageCollectLock(now - FIFTEEN_MIN - 1, now, spot, 'user-1')).toBe(false);
    expect(shouldGarbageCollectLock(now - (60 * 60 * 1000), now, spot, 'user-1')).toBe(false);
  });

  it('clears a non-matching lock once the 15-minute TTL has elapsed, including the exact boundary', () => {
    const now = 1_000_000_000;
    expect(shouldGarbageCollectLock(now - FIFTEEN_MIN, now, null, 'user-1')).toBe(true);
    expect(shouldGarbageCollectLock(now - FIFTEEN_MIN - 1, now, { status: 'available' }, 'user-1')).toBe(true);
    expect(shouldGarbageCollectLock(
      now - FIFTEEN_MIN,
      now,
      { status: 'occupied', interestedUserId: 'user-1' },
      'user-1',
    )).toBe(true);
    expect(shouldGarbageCollectLock(
      now - FIFTEEN_MIN,
      now,
      { status: 'interested', interestedUserId: 'someone-else' },
      'user-1',
    )).toBe(true);
  });

  it('does not clear a non-matching lock before 15 minutes', () => {
    const now = 1_000_000_000;
    expect(shouldGarbageCollectLock(now - FIFTEEN_MIN + 1, now, null, 'user-1')).toBe(false);
    expect(shouldGarbageCollectLock(now - 60_000, now, { status: 'available' }, 'user-1')).toBe(false);
  });

  it('does not clear a lock with a missing timestamp', () => {
    expect(shouldGarbageCollectLock(Number.NaN, Date.now(), null, 'user-1')).toBe(false);
  });

  it('names a spot only on an exact spotId match', () => {
    expect(lockNamesSpot({ spotId: 'spot-a' }, 'spot-a')).toBe(true);
    expect(lockNamesSpot({ spotId: 'spot-a' }, 'spot-b')).toBe(false);
    expect(lockNamesSpot(null, 'spot-a')).toBe(false);
  });

  it('keeps the client, functions, and rules lock path on users/{uid}/activeIncomingClaims/current', () => {
    const root = path.join(__dirname, '..');
    const client = fs.readFileSync(path.join(root, 'views/street-parking/activeIncomingClaim.ts'), 'utf8');
    const rules = fs.readFileSync(path.join(root, 'firestore.rules'), 'utf8');
    const server = fs.readFileSync(path.join(__dirname, 'activeIncomingClaim.js'), 'utf8');
    expect(ACTIVE_INCOMING_CLAIM_COLLECTION).toBe('activeIncomingClaims');
    expect(ACTIVE_INCOMING_CLAIM_DOC_ID).toBe('current');
    expect(client).toContain("export const ACTIVE_INCOMING_CLAIM_COLLECTION = 'activeIncomingClaims'");
    expect(client).toContain("export const ACTIVE_INCOMING_CLAIM_DOC_ID = 'current'");
    expect(server).toContain('ACTIVE_INCOMING_CLAIM_COLLECTION');
    expect(rules).toContain('match /activeIncomingClaims/{claimId}');
    expect(rules).toContain("claimId == 'current'");
    expect(rules).toContain('activeIncomingClaimInvariantEnforced()');
    expect(rules).toContain(`match /${ACTIVE_INCOMING_CLAIM_ROLLOUT_COLLECTION}/{docId}`);
    expect(rules).toContain(ACTIVE_INCOMING_CLAIM_ROLLOUT_DOC_ID);
    // 15-minute TTL is sweeper GC, not a Rules duration.
    expect(rules).not.toContain("duration.value(15, 'm')");
  });

  it('keeps the collection-group updatedAt index and omits the rejected spots status+__name__ composite', () => {
    const indexes = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'firestore.indexes.json'), 'utf8'));
    const updatedAt = indexes.fieldOverrides.find((entry) =>
      entry.collectionGroup === 'activeIncomingClaims' && entry.fieldPath === 'updatedAt');
    expect(updatedAt.indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ order: 'ASCENDING', queryScope: 'COLLECTION_GROUP' }),
    ]));
    // Firebase returns 400 for a composite of one field plus __name__: the
    // automatic single-field index on spots.status already serves
    // where(status ==).orderBy(documentId()).
    const rejected = indexes.indexes.find((entry) =>
      entry.collectionGroup === 'spots'
      && Array.isArray(entry.fields)
      && entry.fields.length === 2
      && entry.fields[0].fieldPath === 'status'
      && entry.fields[1].fieldPath === '__name__');
    expect(rejected).toBeUndefined();
  });

  it('keeps the earliest claim and orders the rest for release', () => {
    const plan = planUserReconciliation([
      { spotId: 'b', claimStartedAtMs: 200 },
      { spotId: 'a', claimStartedAtMs: 200 },
      { spotId: 'c', claimStartedAtMs: 100 },
      { spotId: 'd', claimStartedAtMs: Number.NaN },
    ]);
    expect(plan.keep.spotId).toBe('c');
    expect(plan.release.map((claim) => claim.spotId)).toEqual(['a', 'b', 'd']);
    expect(CANONICAL_ACTIVE_CLAIM_RULE).toBe('earliest_claimStartedAt_then_spotId');
  });

  it('counts lockless interested Pings and duplicate uids separately', () => {
    const audit = auditActiveClaimGroups([
      { spotIds: ['only'], lockSpotId: null },
      { spotIds: ['kept', 'extra'], lockSpotId: 'kept' },
      { spotIds: ['ready'], lockSpotId: 'ready' },
    ]);
    expect(audit).toEqual({
      locklessCount: 2,
      duplicateUserCount: 1,
      duplicatePingCount: 1,
      interestedWithClaimerCount: 4,
    });
    expect(invariantMayBeEnforced({ scanComplete: true, ...audit })).toBe(false);
    expect(invariantMayBeEnforced({
      scanComplete: true,
      locklessCount: 0,
      duplicateUserCount: 0,
      duplicatePingCount: 0,
    })).toBe(true);
    expect(invariantMayBeEnforced({
      scanComplete: false,
      locklessCount: 0,
      duplicateUserCount: 0,
      duplicatePingCount: 0,
    })).toBe(false);
  });

  it('releases a duplicate without reopening an already-expired Ping', () => {
    const now = 1_000;
    expect(releasedInterestPatch(now - 1, now).status).toBeUndefined();
    expect(releasedInterestPatch(now - 1, now).interestedUserId).toBeNull();
    expect(releasedInterestPatch(now + 1, now).status).toBe('available');
    expect(releasedInterestPatch(Number.NaN, now).status).toBe('available');
  });
});
