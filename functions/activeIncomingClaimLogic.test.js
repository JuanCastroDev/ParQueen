'use strict';

const fs = require('fs');
const path = require('path');
const {
  STALE_ACTIVE_CLAIM_LOCK_MS,
  ACTIVE_INCOMING_CLAIM_COLLECTION,
  ACTIVE_INCOMING_CLAIM_DOC_ID,
  pingHoldsActiveClaim,
  shouldGarbageCollectLock,
  lockNamesSpot,
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
    // 15-minute TTL is sweeper GC, not a Rules duration.
    expect(rules).not.toContain("duration.value(15, 'm')");
  });
});
