'use strict';

const { Timestamp } = require('firebase-admin/firestore');
const { isClaimGenerationId } = require('./claimGeneration');

const SWEEP_LIMIT = 200;

function generationShape(value) {
  if (value === undefined || value === null) return 'absent';
  if (isClaimGenerationId(value)) return 'valid';
  return 'malformed';
}

function hasClaimant(spot) {
  return spot.interestedUserId !== undefined && spot.interestedUserId !== null;
}

function hasClaimState(spot) {
  return spot.claimState !== undefined && spot.claimState !== null;
}

// Clears claimGenerationId only when this transaction rereads an available,
// unclaimed spot whose stored id is still the id the sweep observed, and no
// activeIncomingClaims lock names the spot. Any other state is left untouched.
async function clearOrphanGeneration(db, spotId, expectedId) {
  return db.runTransaction(async (tx) => {
    const ref = db.collection('spots').doc(spotId);
    const snap = await tx.get(ref);
    if (!snap.exists) {
      return { outcome: 'missing_spot', changed: false, generation: 'absent' };
    }
    const spot = snap.data() || {};
    const generation = generationShape(spot.claimGenerationId);
    if (spot.status === 'interested' && !hasClaimant(spot)) {
      return { outcome: 'incomplete_interest', changed: false, generation };
    }
    if (spot.status !== 'available') {
      return { outcome: 'not_available', changed: false, generation };
    }
    if (hasClaimant(spot)) {
      return { outcome: 'claimant_present', changed: false, generation };
    }
    if (hasClaimState(spot)) {
      return { outcome: 'claim_state', changed: false, generation };
    }
    if (generation === 'absent') {
      return { outcome: 'absent', changed: false, generation };
    }
    if (expectedId === undefined || expectedId === null || spot.claimGenerationId !== expectedId) {
      return { outcome: 'generation_replaced', changed: false, generation };
    }
    const locks = await tx.get(
      db.collectionGroup('activeIncomingClaims').where('spotId', '==', spotId).limit(1),
    );
    if (!locks.empty) {
      return { outcome: 'locked', changed: false, generation };
    }
    tx.update(ref, { claimGenerationId: null });
    return { outcome: 'cleared', changed: true, generation };
  });
}

function cutoffFrom(now) {
  if (now && typeof now.toMillis === 'function') return now;
  return Timestamp.fromMillis(now);
}

async function sweepOrphanGenerations(db, now) {
  const snap = await db.collection('spots')
    .where('status', '==', 'available')
    .where('expiresAt', '>', cutoffFrom(now))
    .orderBy('expiresAt', 'asc')
    .limit(SWEEP_LIMIT)
    .get();
  const counts = {
    pageSize: snap.size,
    examined: 0,
    cleared: 0,
    skipped: 0,
    replaced: 0,
    locked: 0,
    unproven: 0,
    errors: 0,
  };
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    if (data.claimGenerationId == null) {
      counts.skipped += 1;
      continue;
    }
    counts.examined += 1;
    try {
      const result = await clearOrphanGeneration(db, doc.id, data.claimGenerationId);
      if (result.outcome === 'cleared') counts.cleared += 1;
      else if (result.outcome === 'locked') counts.locked += 1;
      else if (result.outcome === 'generation_replaced') counts.replaced += 1;
      else counts.skipped += 1;
    } catch (error) {
      counts.errors += 1;
      counts.unproven += 1;
      console.error('orphanGenerationSweep: candidate left unchanged');
    }
  }
  console.log(
    `orphanGenerationSweep: page=${counts.pageSize} examined=${counts.examined} cleared=${counts.cleared} skipped=${counts.skipped} replaced=${counts.replaced} locked=${counts.locked} unproven=${counts.unproven} errors=${counts.errors}`,
  );
  return counts;
}

module.exports = {
  SWEEP_LIMIT,
  generationShape,
  clearOrphanGeneration,
  sweepOrphanGenerations,
};
