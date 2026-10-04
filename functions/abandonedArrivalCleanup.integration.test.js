'use strict';

const fs = require('fs');
const path = require('path');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldPath } = require('firebase-admin/firestore');
const { requireEmulatorProjectId } = require('./emulatorProjectId');
const {
  TWO_HOURS_MS,
  isEligibleAbandonedArrival,
  isLegacyOccupiedMissingArrivedAt,
  closeAbandonedArrivedHandoff,
  sweepAbandonedArrivedHandoffs,
  formatAbandonedArrivalSweepLog,
} = require('./abandonedArrivalCleanup');
const { finderAttestationId, isMutualSuccessPair } = require('./handoffSuccessContract');

const PROJECT_ID = requireEmulatorProjectId();
const APP_NAME = '__abandoned_arrival_cleanup_intg__';
const testApp = getApps().find((app) => app.name === APP_NAME) ?? initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const indexModule = require('./index.js');

const RUN = `${process.pid}_${Date.now()}`;
const NOW = 1_800_000_000_000;
const PII_USER = `pii-user-${RUN}`;
const PII_TOKEN = `pii-token-${RUN}`;

function millis(value) {
  return value && typeof value.toMillis === 'function' ? value.toMillis() : value;
}

function spot(id, overrides = {}) {
  return {
    finderId: `finder_${id}`,
    finderName: 'Finder',
    address: `addr_${id}`,
    lat: 40.7,
    lng: -74.0,
    status: 'occupied',
    claimState: 'arrived_pending_outcome',
    interestedUserId: `claimer_${id}`,
    arrivedAt: Timestamp.fromMillis(NOW - TWO_HOURS_MS - 1),
    pingMode: 'now',
    reportedAt: Timestamp.fromMillis(NOW - TWO_HOURS_MS - 10_000),
    expiresAt: Timestamp.fromMillis(NOW + 86_400_000),
    testRun: RUN,
    ...overrides,
  };
}

function feedbackId(spotId, claimerId) {
  return `${spotId}_${claimerId}`;
}

async function seed(id, overrides) {
  const data = spot(id, overrides);
  await db.doc(`spots/${id}`).set(data);
  return data;
}

function plain(data) {
  const out = {};
  for (const [key, value] of Object.entries(data || {})) {
    out[key] = millis(value);
  }
  return out;
}

async function readSpot(id) {
  const snap = await db.doc(`spots/${id}`).get();
  return snap.exists ? snap.data() : null;
}

async function readFeedback(spotId, claimerId) {
  const snap = await db.doc(`spotFeedback/${feedbackId(spotId, claimerId)}`).get();
  return snap.exists ? snap.data() : null;
}

function finderOk(finderId) {
  return typeof finderId === 'string' && finderId.length > 0 && !finderId.includes('/');
}

function safeFeedbackId(spotId, claimerId) {
  if (typeof spotId !== 'string' || typeof claimerId !== 'string') return null;
  if (!spotId || !claimerId || spotId.length > 500 || claimerId.length > 500) return null;
  if (spotId.includes('/') || claimerId.includes('/')) return null;
  return `${spotId}_${claimerId}`;
}

async function predict(nowMs) {
  const occupied = await db.collection('spots').where('status', '==', 'occupied').get();
  const expected = {
    scanned: occupied.size,
    eligible: 0,
    converted: 0,
    skippedTerminal: 0,
    skippedLegacy: 0,
    error: 0,
  };
  for (const docSnap of occupied.docs) {
    const data = docSnap.data() || {};
    if (isLegacyOccupiedMissingArrivedAt(data)) {
      expected.skippedLegacy++;
      continue;
    }
    if (!isEligibleAbandonedArrival(data, nowMs)) continue;
    const id = safeFeedbackId(docSnap.id, data.interestedUserId);
    if (!id || !finderOk(data.finderId)) {
      expected.eligible++;
      expected.error++;
      continue;
    }
    const existing = await db.doc(`spotFeedback/${id}`).get();
    const finderExisting = await db.doc(`spotFeedback/${id}_finder`).get();
    const claimerData = existing.exists ? existing.data() : null;
    const finderData = finderExisting.exists ? finderExisting.data() : null;
    if (isMutualSuccessPair({
      spotId: docSnap.id,
      claimerId: data.interestedUserId,
      finderId: data.finderId,
      claimerDocId: id,
      claimerData,
      finderDocId: finderAttestationId(docSnap.id, data.interestedUserId),
      finderData,
      spot: data,
    })) {
      expected.eligible++;
      expected.skippedTerminal++;
      continue;
    }
    if (existing.exists) {
      const outcome = (claimerData || {}).outcome;
      expected.eligible++;
      if (outcome === 'failed') expected.skippedTerminal++;
      else if (outcome === 'unconfirmed') {
        if (data.claimState !== 'unconfirmed') expected.converted++;
        else expected.skippedTerminal++;
      } else if (outcome === 'success' || outcome === 'participant_success') expected.converted++;
      else expected.skippedTerminal++;
      continue;
    }
    if (finderData && (finderData.outcome === 'participant_success' || finderData.outcome === 'success')) {
      expected.eligible++;
      expected.converted++;
      continue;
    }
    expected.eligible++;
    expected.converted++;
  }
  return expected;
}

async function commitTerminalIfAbsent({
  spotId,
  claimerId,
  finderId,
  outcome,
  confirmedByFinder = false,
  address = '1 Race St',
}) {
  const id = feedbackId(spotId, claimerId);
  const feedbackRef = db.doc(`spotFeedback/${id}`);
  const notificationRef = db.doc(`spotNotifications/handoff_success_${id}`);
  const spotRef = db.doc(`spots/${spotId}`);
  return db.runTransaction(async (tx) => {
    const spotSnap = await tx.get(spotRef);
    const feedbackSnap = await tx.get(feedbackRef);
    if (!spotSnap.exists) return 'missing-spot';
    if (feedbackSnap.exists) return 'blocked';
    const createdAt = Timestamp.fromMillis(NOW);
    const feedback = {
      spotId,
      userId: claimerId,
      finderId,
      outcome,
      failureReason: outcome === 'failed' ? 'Other' : null,
      address,
      createdAt,
    };
    if (confirmedByFinder) feedback.confirmedByFinder = true;
    tx.set(feedbackRef, feedback);
    if (outcome === 'success') {
      tx.set(notificationRef, {
        spotId,
        senderId: confirmedByFinder ? finderId : claimerId,
        targetUserId: confirmedByFinder ? claimerId : finderId,
        type: 'handoff_success',
        message: 'parked',
        createdAt,
      });
    }
    return 'created';
  });
}

function assertSingleTerminal(spotData, feedback, notes) {
  expect(feedback).toBeTruthy();
  expect(['success', 'failed', 'unconfirmed']).toContain(feedback.outcome);
  if (feedback.outcome === 'success' || feedback.outcome === 'failed') {
    expect(spotData.claimState).not.toBe('unconfirmed');
    expect(spotData.claimState).toBe('arrived_pending_outcome');
  }
  if (feedback.outcome === 'unconfirmed') {
    expect(spotData.claimState).toBe('unconfirmed');
    expect(notes).toHaveLength(0);
    expect(feedback.confirmedByFinder).toBeUndefined();
  }
  if (feedback.outcome !== 'success') {
    expect(notes.every((note) => note.type !== 'handoff_success')).toBe(true);
  }
}

describe('cleanupAbandonedArrivedHandoffs contract', () => {
  it('schedules the cleanup identity and does not mint Crowns or success notices itself', () => {
    const src = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
    const moduleSrc = fs.readFileSync(path.join(__dirname, 'abandonedArrivalCleanup.js'), 'utf8');
    const start = src.indexOf('exports.cleanupAbandonedArrivedHandoffs = onSchedule(');
    expect(start).toBeGreaterThan(-1);
    const fn = src.slice(start, src.indexOf('exports.processScheduledClaims', start));
    expect(fn).toMatch(/schedule:\s*"every 1 hours"/);
    expect(fn).toMatch(/timeZone:\s*"America\/Toronto"/);
    expect(fn).toMatch(/serviceAccount:\s*'parqueen-cleanup@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com'/);
    expect(fn).toMatch(/formatAbandonedArrivalSweepLog/);
    expect(fn).not.toMatch(/awardCrowns/);
    expect(fn).not.toMatch(/handoff_success/);
    expect(moduleSrc).not.toMatch(/awardCrowns/);
    expect(moduleSrc).not.toMatch(/handoff_success/);
    expect(moduleSrc).not.toMatch(/spotNotifications/);
    expect(moduleSrc).not.toMatch(/\.delete\(/);
  });
});

describe('cleanupAbandonedArrivedHandoffs sweep', () => {
  const ids = {
    justOver: `b4_just_over_${RUN}`,
    exact: `b4_exact_${RUN}`,
    younger: `b4_younger_${RUN}`,
    future: `b4_future_${RUN}`,
    malformed: `b4_malformed_${RUN}`,
    missing: `b4_missing_${RUN}`,
    nulled: `b4_null_${RUN}`,
    legacy: `b4_legacy_${RUN}`,
    success: `b4_success_${RUN}`,
    failed: `b4_failed_${RUN}`,
    heading: `b4_heading_${RUN}`,
    interested: `b4_interested_${RUN}`,
  };

  const seeded = new Map();

  beforeAll(async () => {
    seeded.set(ids.justOver, await seed(ids.justOver));
    seeded.set(ids.exact, await seed(ids.exact, {
      arrivedAt: Timestamp.fromMillis(NOW - TWO_HOURS_MS),
    }));
    seeded.set(ids.younger, await seed(ids.younger, {
      arrivedAt: Timestamp.fromMillis(NOW - 30 * 60_000),
    }));
    seeded.set(ids.future, await seed(ids.future, {
      arrivedAt: Timestamp.fromMillis(NOW + 60_000),
    }));
    seeded.set(ids.malformed, await seed(ids.malformed, { arrivedAt: 'not-a-timestamp' }));
    const missing = spot(ids.missing);
    delete missing.arrivedAt;
    seeded.set(ids.missing, missing);
    await db.doc(`spots/${ids.missing}`).set(missing);
    seeded.set(ids.nulled, await seed(ids.nulled, { arrivedAt: null }));
    const legacy = spot(ids.legacy, { claimState: 'heading', interestedUserId: `legacy_${RUN}` });
    delete legacy.arrivedAt;
    seeded.set(ids.legacy, legacy);
    await db.doc(`spots/${ids.legacy}`).set(legacy);
    seeded.set(ids.success, await seed(ids.success));
    seeded.set(ids.failed, await seed(ids.failed));
    await db.doc(`spotFeedback/${feedbackId(ids.success, `claimer_${ids.success}`)}`).set({
      spotId: ids.success,
      userId: `claimer_${ids.success}`,
      finderId: `finder_${ids.success}`,
      outcome: 'success',
      failureReason: null,
      address: 'kept success',
      createdAt: Timestamp.fromMillis(NOW - 1000),
    });
    await db.doc(`spotFeedback/${feedbackId(ids.failed, `claimer_${ids.failed}`)}`).set({
      spotId: ids.failed,
      userId: `claimer_${ids.failed}`,
      finderId: `finder_${ids.failed}`,
      outcome: 'failed',
      failureReason: 'Other',
      address: 'kept failed',
      createdAt: Timestamp.fromMillis(NOW - 1000),
    });
    seeded.set(ids.heading, await seed(ids.heading, { claimState: 'heading' }));
    seeded.set(ids.interested, await seed(ids.interested, { status: 'interested' }));
  });

  function expectUntouched(id) {
    return readSpot(id).then((data) => {
      expect(plain(data)).toEqual(plain(seeded.get(id)));
    });
  }

  it('closes only strictly stale arrivals and leaves the boundary, legacy, and terminal rows alone', async () => {
    const expected = await predict(NOW);
    const counts = await sweepAbandonedArrivedHandoffs(db, NOW, { pageSize: 2 });
    expect(counts).toEqual(expected);
    expect(formatAbandonedArrivalSweepLog(counts)).toMatch(
      /^cleanupAbandonedArrivedHandoffs scanned=\d+ eligible=\d+ converted=\d+ skipped-terminal=\d+ skipped-legacy=\d+ error=\d+$/,
    );

    const closed = await readSpot(ids.justOver);
    expect(closed.claimState).toBe('unconfirmed');
    expect(closed.status).toBe('occupied');
    expect(closed.arrivedAt.toMillis()).toBe(NOW - TWO_HOURS_MS - 1);
    expect(closed.interestedUserId).toBe(`claimer_${ids.justOver}`);
    const closedFeedback = await readFeedback(ids.justOver, `claimer_${ids.justOver}`);
    expect(closedFeedback).toMatchObject({
      spotId: ids.justOver,
      userId: `claimer_${ids.justOver}`,
      finderId: `finder_${ids.justOver}`,
      outcome: 'unconfirmed',
      failureReason: null,
      address: `addr_${ids.justOver}`,
    });
    expect(closedFeedback.createdAt.toMillis()).toBe(NOW);
    expect((await db.doc(`spotNotifications/handoff_success_${feedbackId(ids.justOver, `claimer_${ids.justOver}`)}`).get()).exists).toBe(false);
    expect((await db.doc(`functionEvents/awardCrowns_${feedbackId(ids.justOver, `claimer_${ids.justOver}`)}`).get()).exists).toBe(false);

    const success = await readSpot(ids.success);
    expect(success.claimState).toBe('unconfirmed');
    expect((await readFeedback(ids.success, `claimer_${ids.success}`)).outcome).toBe('success');
    const failed = await readSpot(ids.failed);
    expect(failed.claimState).toBe('arrived_pending_outcome');
    expect((await readFeedback(ids.failed, `claimer_${ids.failed}`)).outcome).toBe('failed');

    await expectUntouched(ids.exact);
    await expectUntouched(ids.younger);
    await expectUntouched(ids.future);
    await expectUntouched(ids.malformed);
    await expectUntouched(ids.missing);
    await expectUntouched(ids.nulled);
    await expectUntouched(ids.legacy);
    await expectUntouched(ids.heading);
    await expectUntouched(ids.interested);
    expect(await readFeedback(ids.exact, `claimer_${ids.exact}`)).toBeNull();
    expect(await readFeedback(ids.legacy, `legacy_${RUN}`)).toBeNull();
    expect(await readFeedback(ids.malformed, `claimer_${ids.malformed}`)).toBeNull();

    const beforeSpot = plain(closed);
    const beforeFeedback = plain(closedFeedback);
    const beforeSuccess = plain(await readFeedback(ids.success, `claimer_${ids.success}`));
    const again = await sweepAbandonedArrivedHandoffs(db, NOW, { pageSize: 2 });
    expect(again.converted).toBe(0);
    expect(plain(await readSpot(ids.justOver))).toEqual(beforeSpot);
    expect(plain(await readFeedback(ids.justOver, `claimer_${ids.justOver}`))).toEqual(beforeFeedback);
    expect(plain(await readFeedback(ids.success, `claimer_${ids.success}`))).toEqual(beforeSuccess);
    expect((await db.collection('spotFeedback').where('spotId', '==', ids.justOver).get()).size).toBe(1);
    await expectUntouched(ids.legacy);
    await expectUntouched(ids.exact);
  }, 180000);
});

describe('cleanupAbandonedArrivedHandoffs races', () => {
  async function notesFor(spotId) {
    const snap = await db.collection('spotNotifications').where('spotId', '==', spotId).get();
    return snap.docs.map((docSnap) => docSnap.data());
  }

  async function race(outcome, extra = {}) {
    const spotId = `b4_race_${outcome}_${extra.confirmedByFinder ? 'finder' : 'claimer'}_${RUN}_${Math.random().toString(16).slice(2)}`;
    const claimerId = `claimer_${spotId}`;
    const finderId = `finder_${spotId}`;
    await db.doc(`spots/${spotId}`).set(spot(spotId, {
      interestedUserId: claimerId,
      finderId,
      address: '1 Race St',
    }));
    await db.doc(`users/${claimerId}`).set({ crowns: 0 });
    await db.doc(`users/${finderId}`).set({ crowns: 0 });

    const [sweepResult, writeResult] = await Promise.all([
      closeAbandonedArrivedHandoff(db, db.doc(`spots/${spotId}`), NOW),
      commitTerminalIfAbsent({
        spotId,
        claimerId,
        finderId,
        outcome,
        address: '1 Race St',
        ...extra,
      }),
    ]);

    const spotData = await readSpot(spotId);
    const feedback = await readFeedback(spotId, claimerId);
    const notes = await notesFor(spotId);
    const feedbackDocs = await db.collection('spotFeedback').where('spotId', '==', spotId).get();
    expect(feedbackDocs.size).toBe(1);
    assertSingleTerminal(spotData, feedback, notes);
    expect([sweepResult, writeResult].filter((result) => result === 'converted' || result === 'created').length).toBe(1);
    if (feedback.outcome === 'unconfirmed') expect(writeResult).toBe('blocked');
    if (feedback.outcome === outcome) expect(sweepResult).toBe('skipped-terminal');

    await indexModule.awardCrowns.run({
      id: `event_${spotId}`,
      params: { feedbackId: feedbackId(spotId, claimerId) },
      data: { id: feedbackId(spotId, claimerId), data: () => feedback },
    });
    const driverCrowns = (await db.doc(`users/${claimerId}`).get()).data().crowns;
    const finderCrowns = (await db.doc(`users/${finderId}`).get()).data().crowns;
    expect(driverCrowns).toBe(0);
    expect(finderCrowns).toBe(0);
    expect((await db.doc(`functionEvents/awardCrowns_${feedbackId(spotId, claimerId)}`).get()).exists).toBe(false);
    return { spotData, feedback, notes };
  }

  function successAttestation(spotId, claimerId, finderId, role, createdAt) {
    return {
      spotId,
      userId: claimerId,
      finderId,
      outcome: 'participant_success',
      role,
      failureReason: null,
      address: '1 Race St',
      createdAt,
    };
  }

  it('a failed outcome racing the sweep leaves exactly one terminal outcome and zero Crowns', async () => {
    await race('failed');
  });

  it('one-sided success past 2 hours becomes unconfirmed, keeps the attestation, and is not later promotable', async () => {
    const spotId = `b4_onesided_${RUN}`;
    const claimerId = `claimer_${spotId}`;
    const finderId = `finder_${spotId}`;
    const arrivedAt = Timestamp.fromMillis(NOW - TWO_HOURS_MS - 1);
    const createdAt = Timestamp.fromMillis(arrivedAt.toMillis() + 1000);
    await seed(spotId, { interestedUserId: claimerId, finderId, address: '1 Race St', arrivedAt });
    await db.doc(`users/${claimerId}`).set({ crowns: 3 });
    await db.doc(`users/${finderId}`).set({ crowns: 4, trustStats: { handoffsCompleted: 0, handoffsCancelledByFinder: 0 } });
    const claimerDoc = successAttestation(spotId, claimerId, finderId, 'claimer', createdAt);
    await db.doc(`spotFeedback/${feedbackId(spotId, claimerId)}`).set(claimerDoc);

    expect(await closeAbandonedArrivedHandoff(db, db.doc(`spots/${spotId}`), NOW)).toBe('converted');
    const sealed = await readFeedback(spotId, claimerId);
    expect(sealed.outcome).toBe('participant_success');
    expect(sealed.role).toBe('claimer');
    expect((await readSpot(spotId)).claimState).toBe('unconfirmed');

    const finderDoc = successAttestation(spotId, claimerId, finderId, 'finder', createdAt);
    await db.doc(`spotFeedback/${feedbackId(spotId, claimerId)}_finder`).set(finderDoc);
    await indexModule.awardCrowns.run({
      id: `event_late_${spotId}`,
      params: { feedbackId: `${feedbackId(spotId, claimerId)}_finder` },
      data: { id: `${feedbackId(spotId, claimerId)}_finder`, data: () => finderDoc },
    });

    expect((await db.doc(`users/${claimerId}`).get()).data().crowns).toBe(3);
    expect((await db.doc(`users/${finderId}`).get()).data().crowns).toBe(4);
    expect((await db.doc(`users/${finderId}`).get()).data().trustStats.handoffsCompleted).toBe(0);
    expect((await readSpot(spotId)).claimState).toBe('unconfirmed');
    expect((await readFeedback(spotId, claimerId)).outcome).toBe('participant_success');
    expect(await closeAbandonedArrivedHandoff(db, db.doc(`spots/${spotId}`), NOW)).toBe('ineligible');
  });

  it('mutual success racing B4 cleanup wins and stays completed_success', async () => {
    const spotId = `b4_mutual_race_${RUN}`;
    const claimerId = `claimer_${spotId}`;
    const finderId = `finder_${spotId}`;
    const arrivedAt = Timestamp.fromMillis(NOW - TWO_HOURS_MS - 1);
    const createdAt = Timestamp.fromMillis(arrivedAt.toMillis() + 1000);
    await seed(spotId, { interestedUserId: claimerId, finderId, address: '1 Race St', arrivedAt });
    await db.doc(`users/${claimerId}`).set({ crowns: 0 });
    await db.doc(`users/${finderId}`).set({ crowns: 0 });
    const claimerDoc = successAttestation(spotId, claimerId, finderId, 'claimer', createdAt);
    const finderDoc = successAttestation(spotId, claimerId, finderId, 'finder', createdAt);
    const claimerDocId = feedbackId(spotId, claimerId);
    await db.doc(`spotFeedback/${claimerDocId}`).set(claimerDoc);
    await db.doc(`spotFeedback/${claimerDocId}_finder`).set(finderDoc);

    const claimerEvent = {
      id: `event_claimer_${spotId}`,
      params: { feedbackId: claimerDocId },
      data: { id: claimerDocId, data: () => claimerDoc },
    };
    const finderEvent = {
      id: `event_finder_${spotId}`,
      params: { feedbackId: `${claimerDocId}_finder` },
      data: { id: `${claimerDocId}_finder`, data: () => finderDoc },
    };

    await Promise.all([
      closeAbandonedArrivedHandoff(db, db.doc(`spots/${spotId}`), NOW),
      indexModule.awardCrowns.run(claimerEvent),
      indexModule.awardCrowns.run(finderEvent),
    ]);

    expect((await readSpot(spotId)).claimState).toBe('completed_success');
    expect((await readFeedback(spotId, claimerId)).outcome).toBe('participant_success');
    expect((await db.doc(`spotFeedback/${claimerDocId}_finder`).get()).data().outcome).toBe('participant_success');
    expect((await db.doc(`users/${claimerId}`).get()).data().crowns).toBe(1);
    expect((await db.doc(`users/${finderId}`).get()).data().crowns).toBe(2);
    expect((await db.doc(`users/${finderId}`).get()).data().trustStats.handoffsCompleted).toBe(1);
    expect((await db.doc(`functionEvents/awardCrowns_${claimerDocId}`).get()).data().outcome).toBe('awarded');

    expect(await closeAbandonedArrivedHandoff(db, db.doc(`spots/${spotId}`), NOW)).toBe('ineligible');
    expect((await readSpot(spotId)).claimState).toBe('completed_success');
    await indexModule.awardCrowns.run(claimerEvent);
    expect((await db.doc(`users/${claimerId}`).get()).data().crowns).toBe(1);
    expect((await db.doc(`users/${finderId}`).get()).data().crowns).toBe(2);
  });

  it('exactly two hours is not eligible, and a one-sided success written first is sealed without deleting it', async () => {
    const exactId = `b4_exact_onesided_${RUN}`;
    const staleId = `b4_stale_onesided_${RUN}`;
    const exactArrived = Timestamp.fromMillis(NOW - TWO_HOURS_MS);
    await seed(exactId, { arrivedAt: exactArrived });
    await db.doc(`spotFeedback/${feedbackId(exactId, `claimer_${exactId}`)}`).set(
      successAttestation(exactId, `claimer_${exactId}`, `finder_${exactId}`, 'claimer', exactArrived),
    );
    expect(await closeAbandonedArrivedHandoff(db, db.doc(`spots/${exactId}`), NOW)).toBe('ineligible');
    expect((await readSpot(exactId)).claimState).toBe('arrived_pending_outcome');
    expect((await readFeedback(exactId, `claimer_${exactId}`)).outcome).toBe('participant_success');

    await seed(staleId);
    await commitTerminalIfAbsent({
      spotId: staleId,
      claimerId: `claimer_${staleId}`,
      finderId: `finder_${staleId}`,
      outcome: 'success',
      address: `addr_${staleId}`,
    });
    expect(await closeAbandonedArrivedHandoff(db, db.doc(`spots/${staleId}`), NOW)).toBe('converted');
    expect((await readSpot(staleId)).claimState).toBe('unconfirmed');
    expect((await readFeedback(staleId, `claimer_${staleId}`)).outcome).toBe('success');
    expect(await closeAbandonedArrivedHandoff(db, db.doc(`spots/${staleId}`), NOW)).toBe('ineligible');
  });
});

describe('cleanupAbandonedArrivedHandoffs scheduled run', () => {
  it('logs counts only, skips a young Ping and a legacy occupied Ping, and does not mint Crowns', async () => {
    const oldId = `b4_run_old_${RUN}`;
    const youngId = `b4_run_young_${RUN}`;
    const legacyId = `b4_run_legacy_${RUN}`;
    const claimerId = `claimer_${oldId}`;
    const finderId = PII_USER;
    await db.doc(`users/${claimerId}`).set({ crowns: 4 });
    await db.doc(`users/${finderId}`).set({ crowns: 9 });
    const old = await seed(oldId, {
      finderId,
      address: PII_TOKEN,
      arrivedAt: Timestamp.fromMillis(Date.now() - TWO_HOURS_MS - 60_000),
      interestedUserId: claimerId,
      expiresAt: Timestamp.fromMillis(Date.now() - 60_000),
    });
    const young = await seed(youngId, {
      arrivedAt: Timestamp.fromMillis(Date.now() - 30 * 60_000),
    });
    const legacy = spot(legacyId, { claimState: null, finderId: PII_USER });
    delete legacy.arrivedAt;
    await db.doc(`spots/${legacyId}`).set(legacy);

    const lines = [];
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args) => { lines.push(args.map(String).join(' ')); };
    console.error = (...args) => { lines.push(args.map(String).join(' ')); };
    try {
      await indexModule.cleanupAbandonedArrivedHandoffs.run();
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }

    const summary = lines.find((line) => line.startsWith('cleanupAbandonedArrivedHandoffs scanned='));
    expect(summary).toMatch(/^cleanupAbandonedArrivedHandoffs scanned=\d+ eligible=\d+ converted=\d+ skipped-terminal=\d+ skipped-legacy=\d+ error=\d+$/);
    expect(lines.join('\n')).not.toContain(PII_USER);
    expect(lines.join('\n')).not.toContain(PII_TOKEN);

    const closed = await readSpot(oldId);
    expect(closed.claimState).toBe('unconfirmed');
    expect(closed.finderId).toBe(old.finderId);
    expect((await readFeedback(oldId, claimerId)).outcome).toBe('unconfirmed');
    expect(plain(await readSpot(youngId))).toEqual(plain(young));
    expect(plain(await readSpot(legacyId))).toEqual(plain(legacy));

    await indexModule.awardCrowns.run({
      id: `event_${oldId}`,
      params: { feedbackId: feedbackId(oldId, claimerId) },
      data: {
        id: feedbackId(oldId, claimerId),
        data: () => ({ outcome: 'unconfirmed', userId: claimerId, finderId }),
      },
    });
    expect((await db.doc(`users/${claimerId}`).get()).data().crowns).toBe(4);
    expect((await db.doc(`users/${finderId}`).get()).data().crowns).toBe(9);
    expect((await db.doc(`functionEvents/awardCrowns_${feedbackId(oldId, claimerId)}`).get()).exists).toBe(false);
    expect((await db.doc(`spotNotifications/handoff_success_${feedbackId(oldId, claimerId)}`).get()).exists).toBe(false);

    await indexModule.cleanupExpiredSpotsHourly.run();
    const stillThere = await readSpot(oldId);
    expect(stillThere.claimState).toBe('unconfirmed');
    expect(stillThere.status).toBe('occupied');
    expect((await readFeedback(oldId, claimerId)).outcome).toBe('unconfirmed');
  }, 180000);

  it('orders occupied spots by document id without a composite index', async () => {
    const indexes = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'firestore.indexes.json'), 'utf8'));
    const spotsIndexes = (indexes.indexes || []).filter((entry) => entry.collectionGroup === 'spots');
    const statusAndName = spotsIndexes.filter((entry) => {
      const fields = (entry.fields || []).map((field) => field.fieldPath);
      return fields.includes('status') && fields.includes('__name__') && !fields.includes('expiresAt');
    });
    expect(statusAndName).toEqual([]);
    const statusExemption = (indexes.fieldOverrides || []).filter((entry) => (
      entry.collectionGroup === 'spots' && entry.fieldPath === 'status'
    ));
    expect(statusExemption).toEqual([]);

    const prefix = `b4idx${RUN}`;
    const missingId = `${prefix}a`;
    const stampedId = `${prefix}b`;
    const missing = spot(missingId, { claimState: 'unconfirmed' });
    delete missing.arrivedAt;
    await db.doc(`spots/${missingId}`).set(missing);
    await seed(stampedId, { claimState: 'unconfirmed' });

    const seen = [];
    let cursor = null;
    for (let page = 0; page < 10000; page++) {
      let query = db.collection('spots')
        .where('status', '==', 'occupied')
        .orderBy(FieldPath.documentId())
        .limit(2);
      if (cursor) query = query.startAfter(cursor);
      const snap = await query.get();
      if (snap.empty) break;
      const ids = snap.docs.map((docSnap) => docSnap.id);
      expect(ids).toEqual([...ids].sort());
      if (seen.length > 0) expect(ids[0] > seen[seen.length - 1]).toBe(true);
      seen.push(...ids);
      if (seen.includes(missingId) && seen.includes(stampedId)) break;
      if (snap.size < 2) break;
      cursor = snap.docs[snap.docs.length - 1];
    }

    expect(seen).toContain(missingId);
    expect(seen).toContain(stampedId);
    expect(seen.indexOf(missingId)).toBeLessThan(seen.indexOf(stampedId));
  });

  it('counts an eligible Ping with no claimer as an error and does not write', async () => {
    const id = `b4_no_claimer_${RUN}`;
    const data = await seed(id, { interestedUserId: '' });
    expect(await closeAbandonedArrivedHandoff(db, db.doc(`spots/${id}`), NOW)).toBe('error');
    expect(plain(await readSpot(id))).toEqual(plain(data));
    const feedback = await db.collection('spotFeedback').where('spotId', '==', id).get();
    expect(feedback.size).toBe(0);
  });
});
