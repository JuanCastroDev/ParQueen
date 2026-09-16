const { onSchedule } = require("firebase-functions/v2/scheduler");
const { onDocumentCreated, onDocumentDeleted } = require("firebase-functions/v2/firestore");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onObjectFinalized } = require("firebase-functions/v2/storage");
const { defineString, defineSecret } = require("firebase-functions/params");
const { GoogleGenAI, Type } = require("@google/genai");
const geminiApiKey = defineSecret("GEMINI_API_KEY");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp, FieldValue } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const { getAuth } = require("firebase-admin/auth");
const { getStorage } = require("firebase-admin/storage");

initializeApp();
const db = getFirestore();
const { geohashForLocation } = require('geofire-common');
const sendgridApiKey = defineSecret("SENDGRID_API_KEY");
// Operator action: firebase functions:secrets:set EMAIL_RATE_LIMIT_PEPPER (random 32-byte hex)
const emailRateLimitPepper = defineSecret("EMAIL_RATE_LIMIT_PEPPER");
const socrataAppToken = defineSecret("SOCRATA_APP_TOKEN");
const { osmNameToDOT, streetNameToLikePattern, dotSideToCardinal, BOROUGH_CODE_TO_NAME, nycOdSegmentDocId, selectBlockFace, findBlockContext, parseNYCOpenDataSign } = require('./nycOpenDataNormalizer');
const { redactForLog, sanitizeError } = require('./redactForLog');
const { checkRateLimit } = require('./rateLimiter');
const { requireCurrentAdmin, requireCurrentAuthenticatedUser } = require('./adminAuth');
const { isSweepNYCData, computeSegmentUpdate, computeRuleUpdate } = require('./backfillLogic');
const {
  NYC_OD_EVIDENCE_REVALIDATION_VERSION,
  deriveNYCOpenDataConfidence,
  isLegacyNYCOpenDataSegment,
  runLegacyNYCOpenDataRevalidation,
} = require('./streetIntelligenceLegacy');
const { ADMIN_READ_VIEWS } = require('./adminReadViews');
const { haversineDistMiles, filterCandidates, buildMessages, collectStaleTokens, MAX_CANDIDATES, FCM_BATCH } = require('./notifyFanout');
const { createHash, createHmac, randomInt: secureRandomInt, randomUUID, timingSafeEqual } = require('crypto');

function stableId(...parts) {
  return createHash('sha256').update(parts.map(part => String(part)).join('\u001f')).digest('hex');
}

function snapshotGeneration(snapshot) {
  const updated = snapshot.updateTime;
  return `${updated.seconds}_${updated.nanoseconds}`;
}

// Moved to ./emailAddress so the waitlist importer can share it without
// loading this module (and initializing a second Firebase app).
const { canonicalizeEmail: _canonicalizeEmail } = require('./emailAddress');

exports._canonicalizeEmail = _canonicalizeEmail;

function _generateEmailOtpCode(randomIntFn = secureRandomInt) {
  return String(randomIntFn(100000, 1000000));
}

exports._generateEmailOtpCode = _generateEmailOtpCode;

function _emailOtpMatches(storedCode, suppliedCode) {
  if (typeof storedCode !== 'string' || typeof suppliedCode !== 'string' ||
      !/^\d{6}$/.test(storedCode) || !/^\d{6}$/.test(suppliedCode)) return false;
  return timingSafeEqual(Buffer.from(storedCode, 'ascii'), Buffer.from(suppliedCode, 'ascii'));
}

exports._emailOtpMatches = _emailOtpMatches;

async function _deliverEmailOtp(email, code, fetchFn = fetch) {
  // Numeric HTTP status only, carried on the thrown error for the caller to log.
  // The response body is still discarded unread: SendGrid echoes the recipient
  // address back in its error payloads, so it can never be logged or inspected.
  let status;
  try {
    const res = await fetchFn('https://api.sendgrid.com/v3/mail/send', {
      method: 'POST',
      headers: { Authorization: `Bearer ${sendgridApiKey.value()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        personalizations: [{ to: [{ email }] }],
        from: { email: 'hello@parqueen.app', name: 'ParQueen' },
        subject: 'Your ParQueen verification code',
        content: [{ type: 'text/plain', value: `Your verification code is: ${code}\n\nThis code expires in 10 minutes.` }],
      }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res || res.ok !== true) {
      if (typeof res?.status === 'number') status = res.status;
      await res?.body?.cancel?.();
      throw new Error('Email delivery failed');
    }
  } catch {
    // Same opaque message as before — the status rides alongside it, never in it.
    // Stays undefined when there was no HTTP response at all (network error or
    // the 10s AbortSignal timeout), because then there is no status to report.
    const err = new Error('Email delivery failed');
    if (status !== undefined) err.status = status;
    throw err;
  }
}

exports._deliverEmailOtp = _deliverEmailOtp;

const _emailOtpHooks = { deliver: null, now: null, generateCode: null };
exports._emailOtpHooks = _emailOtpHooks;

// Crown title thresholds (must match client-side utils/crowns.ts)
const TITLE_THRESHOLDS = [
    { crowns: 0, title: 'Newcomer' },
    { crowns: 10, title: 'Trusted Driver' },
    { crowns: 50, title: 'Street Scout' },
    { crowns: 150, title: 'Neighborhood Guide' },
    { crowns: 400, title: 'Parking Expert' },
    { crowns: 750, title: 'Block Captain' },
    { crowns: 1500, title: 'Parking Veteran' },
    { crowns: 3000, title: 'Urban Legend' },
];

function getTitleForCrowns(crowns) {
    for (let i = TITLE_THRESHOLDS.length - 1; i >= 0; i--) {
        if (crowns >= TITLE_THRESHOLDS[i].crowns) return TITLE_THRESHOLDS[i].title;
    }
    return 'Newcomer';
}

// ─── Trust System v1 ─────────────────────────────────────────────────────────
// v2 TODOs: time decay, claimer trust, pair detection, rapid-cancel pattern scan

function defaultTrustStats() {
  return {
    handoffsCompleted: 0,
    handoffsCancelledByFinder: 0,
  };
}

// trustScore is a pure function of trustStats — replayable, no hidden state.
// Bayesian prior (α=3, β=1): new users start at 75%.
// Examples: 10 completed / 0 cancelled → 93. 5 / 5 → 57. 0 / 10 → 20.
function computeTrustScore(stats) {
  const completed = stats.handoffsCompleted || 0;
  const cancelled = stats.handoffsCancelledByFinder || 0;
  const denominator = completed + cancelled;
  const ALPHA = 3;
  const BETA = 1;
  const smoothed = (completed + ALPHA) / (denominator + ALPHA + BETA);
  const cancelPenalty = Math.min(50, cancelled * 5);
  // Floor of 10 prevents permanent lockout from edge-case cancellation loops.
  return Math.max(10, Math.round(smoothed * 100) - cancelPenalty);
}

// Atomically increments one trustStats field and recomputes trustScore.
// Idempotent: repeated calls with the same eventId are no-ops.
async function applyTrustDelta(uid, statField, eventId, source = 'user') {
  const userRef = db.doc(`users/${uid}`);
  const processedRef = db.doc(`users/${uid}/processedTrustEvents/${eventId}`);

  await db.runTransaction(async (tx) => {
    const [processedSnap, userSnap] = await Promise.all([
      tx.get(processedRef),
      tx.get(userRef),
    ]);

    if (processedSnap.exists) return; // already processed — idempotency guard
    if (!userSnap.exists) return;     // user deleted between event and function fire

    const stats = { ...defaultTrustStats(), ...(userSnap.data().trustStats || {}) };
    stats[statField] = (stats[statField] || 0) + 1;

    tx.update(userRef, {
      trustStats: stats,
      trustScore: computeTrustScore(stats),
    });
    tx.set(processedRef, {
      processedAt: Timestamp.now(),
      statField,
      source,
    });
  });
}
// ─────────────────────────────────────────────────────────────────────────────

// Initialize private/account subcollection when a new user doc is created.
// Rules set allow write: if false on private/account, so only this server trigger can create it.
//
// Retry-safety design: fills in ONLY the moderationStatus/reportCount keys
// that are not already present, inside one transaction alongside a read of
// the root user doc — not an event-identity marker. This protects the two
// fields themselves (from a delayed Eventarc redelivery clobbering a later
// legitimate change to either one) regardless of which event touches them,
// rather than just deduplicating one specific event id — the correct
// property here, since this is "ensure sane defaults exist" not "run this
// exactly once" (contrast incrementTotalSpotsPinged/awardCrowns). A root
// user doc missing at delivery time (e.g. deleted before this fires) is a
// safe no-op — no orphaned private/account is created. Because deleteAccount
// recursively deletes the whole users/{uid} tree (private/account included),
// "missing" naturally resets on any later legitimate recreation, so no
// marker bookkeeping is needed for that guarantee either.
exports.initUserPrivateAccount = onDocumentCreated(
  { document: 'users/{userId}', region: 'us-central1', retry: true, serviceAccount: 'parqueen-system-events@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (event) => {
    const { userId } = event.params;
    const userRef = db.doc(`users/${userId}`);
    const accountRef = userRef.collection('private').doc('account');

    await db.runTransaction(async (tx) => {
      const [userSnap, accountSnap] = await Promise.all([tx.get(userRef), tx.get(accountRef)]);
      if (!userSnap.exists) return; // root user already gone — safe no-op, no orphaned private/account

      const existing = accountSnap.exists ? accountSnap.data() : {};
      const fill = {};
      if (!('moderationStatus' in existing)) fill.moderationStatus = 'active';
      if (!('reportCount' in existing)) fill.reportCount = 0;
      if (Object.keys(fill).length === 0) return; // both already set — leave any later legitimate value alone

      tx.set(accountRef, fill, { merge: true });
    });
  }
);

// 1) Delete expired spots every hour
exports.cleanupExpiredSpotsHourly = onSchedule(
  {
    schedule: "every 1 hours",
    timeZone: "America/Toronto",
    region: "us-central1",
    memory: "256MiB",
    serviceAccount: 'parqueen-cleanup@parkqueen-46475363-ccf36.iam.gserviceaccount.com',
  },
  async () => {
    const now = Timestamp.now();

    // batch delete in pages of 500
    while (true) {
      const snap = await db
        .collection("spots")
        .where("expiresAt", "<=", now)
        .orderBy("expiresAt", "asc")
        .limit(500)
        .get();

      if (snap.empty) break;

      const batch = db.batch();
      snap.docs.forEach((d) => batch.delete(d.ref));
      await batch.commit();

      if (snap.size < 500) break;
    }

    console.log("✅ cleanupExpiredSpotsHourly finished");
  }
);

// 1b) Revert expired interest reservations every minute
exports.cleanupExpiredInterests = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: "America/Toronto",
    region: "us-central1",
    memory: "256MiB",
    serviceAccount: 'parqueen-cleanup@parkqueen-46475363-ccf36.iam.gserviceaccount.com',
  },
  async () => {
    const now = Timestamp.now();
    // Bounded conservatively (not the Firestore max of 500): each candidate is
    // handled as its own sequential transaction below, and this runs every
    // minute with a 60s timeout. 100 sequential single-doc transactions
    // comfortably finishes in a few seconds under realistic Firestore
    // latency; a larger backlog simply drains over successive one-minute
    // runs rather than risking the invocation timing out mid-batch.
    const snap = await db
      .collection("spots")
      .where("status", "==", "interested")
      .where("interestExpiresAt", "<=", now)
      .limit(100)
      .get();

    if (snap.empty) return;

    let released = 0;
    let skipped = 0;
    let errors = 0;
    for (const d of snap.docs) {
      try {
        const didRelease = await db.runTransaction(async (tx) => {
          const fresh = await tx.get(d.ref);
          if (!fresh.exists) return false;
          const spot = fresh.data();

          // Re-verify against fresh state — the initial query snapshot can be
          // stale by the time each transaction runs (the claimant may have
          // just committed to heading, delayed, or a newer claim may have
          // replaced this one).
          if (
            spot.status !== "interested" ||
            !spot.interestExpiresAt ||
            spot.interestExpiresAt.toMillis() > now.toMillis()
          ) return false;

          const clearFields = {
            interestedUserId: null,
            interestedUserName: null,
            interestedUserVehicleColor: null,
            interestedUserVehicleType: null,
            interestedUserVehicleBrand: null,
            interestedUserTitle: null,
            etaMinutes: null,
            interestExpiresAt: null,
            claimState: null,
            claimStartedAt: null,
            ownerLeavingNow: null,
            ownerLeavingNowAt: null,
            claimReminderAt: null,
            claimReminderSentAt: null,
            claimAutoReleaseAt: null,
            claimAutoReleasedAt: null,
          };

          // Never reopen an already-expired Ping — only clear the stale claim.
          // Once cleared, interestExpiresAt is null, which Firestore's range
          // comparison never matches — so this document will not be selected
          // as a candidate again, regardless of whether status stays
          // "interested" (an already-expired Ping is fully removed within the
          // hour by cleanupExpiredSpotsHourly regardless of status).
          const pingExpired = spot.expiresAt && spot.expiresAt.toMillis() <= now.toMillis();
          tx.update(d.ref, pingExpired ? clearFields : { ...clearFields, status: "available" });
          return true;
        });
        if (didRelease) released++; else skipped++;
      } catch (e) {
        errors++;
        console.error("cleanupExpiredInterests: failed to release spot", d.id.slice(0, 8) + "***", sanitizeError(e));
      }
    }
    console.log(
      `✅ cleanupExpiredInterests: examined ${snap.size}, released ${released}, skipped ${skipped} (already stale/renewed), errors ${errors}`
    );
  }
);

// 1c) Revert expired hold timers every minute
exports.cleanupExpiredHolds = onSchedule(
  {
    schedule: "every 1 minutes",
    timeZone: "America/Toronto",
    region: "us-central1",
    memory: "256MiB",
    serviceAccount: 'parqueen-cleanup@parkqueen-46475363-ccf36.iam.gserviceaccount.com',
  },
  async () => {
    const now = Timestamp.now();
    const snap = await db
      .collection("spots")
      .where("status", "==", "claimed")
      .where("holdRequestStatus", "==", "accepted")
      .where("holdTimerExpiresAt", "<=", now)
      .limit(500)
      .get();

    if (snap.empty) return;

    const batch = db.batch();
    snap.docs.forEach((d) => {
      batch.update(d.ref, {
        status: "available",
        holdRequestStatus: "declined",
        claimedBy: null,
        holdTimerExpiresAt: null,
        holdRequestedBy: null,
        holdRequestedByName: null,
        holdRequestExpiresAt: null,
        updatedAt: now,
      });
    });
    await batch.commit();
    console.log(`✅ cleanupExpiredHolds: reverted ${snap.size} held spots`);
  }
);

// Bilingual copy for scheduled claim notifications.
// lang defaults to 'en' for any missing/unrecognised value.
function localizeNotification(type, lang, params) {
  const es = lang === 'es';
  if (type === 'reminder') {
    return es
      ? `El lugar de ${params.name} se libera pronto — ¿vas para allá?`
      : `${params.name}'s spot opens soon — time to head over?`;
  }
  if (type === 'auto_released_claimer') {
    return es
      ? 'Tu reclamo fue liberado porque no confirmaste que ibas para allá.'
      : "Your claim was released because you didn't confirm you were heading over.";
  }
  if (type === 'auto_released_owner') {
    return es
      ? 'Tu lugar está disponible de nuevo porque el reclamo venció.'
      : 'Your spot is available again because the claim expired.';
  }
  return '';
}

const _pingNotificationHooks = {
  send: null,
  sendEach: null,
  beforeStaleTokenCleanup: null,
  now: null,
};
exports._pingNotificationHooks = _pingNotificationHooks;

// 1d) Scheduled claim reminders + auto-release every 5 minutes
exports.processScheduledClaims = onSchedule(
  {
    schedule: "every 5 minutes",
    timeZone: "America/Toronto",
    region: "us-central1",
    memory: "256MiB",
    serviceAccount: 'parqueen-messaging@parkqueen-46475363-ccf36.iam.gserviceaccount.com',
  },
  async () => {
    const now = Timestamp.now();

    // ── Pass 1: Send reminders ────────────────────────────────────────────────
    // claimReminderAt is nulled after send, so already-reminded docs won't reappear
    const reminderSnap = await db.collection("spots")
      .where("status", "==", "interested")
      .where("claimState", "==", "committed")
      .where("claimReminderAt", "<=", now)
      .limit(100)
      .get();

    for (const d of reminderSnap.docs) {
      const spot = d.data();
      if (!spot.interestedUserId || spot.interestedUserId === spot.finderId) continue;

      const finderName = spot.finderName || "Someone";

      // FCM push if token available
      const prefsSnap = await db.doc(`users/${spot.interestedUserId}/private/preferences`).get();
      const prefs = prefsSnap.exists ? prefsSnap.data() : {};
      const fcmToken = prefs.fcmToken || null;
      const message = localizeNotification('reminder', prefs.lang, { name: finderName });
      const deliveryId = await db.runTransaction(async tx => {
        const fresh = await tx.get(d.ref);
        if (!fresh.exists) return false;
        const current = fresh.data();
        if (current.status !== 'interested' || current.claimState !== 'committed' ||
            current.interestedUserId !== spot.interestedUserId || !current.claimReminderAt ||
            current.claimReminderAt.toMillis() > now.toMillis()) return false;
        const claimId = `claim_${stableId(d.id, snapshotGeneration(fresh), current.interestedUserId)}`;
        const reminderDeliveryId = `reminder_${claimId}`;
        const publicDeliveryId = `reminder_${stableId(claimId)}`;
        tx.set(db.doc(`spotNotifications/${reminderDeliveryId}`), {
          spotId: d.id,
          senderId: null,
          actorType: 'system',
          subjectUserId: current.finderId || null,
          targetUserId: current.interestedUserId,
          claimId,
          type: 'scheduled_claim_reminder',
          message,
          createdAt: now,
        });
        tx.update(d.ref, { claimReminderAt: null, claimReminderSentAt: now });
        return publicDeliveryId;
      });
      if (deliveryId && fcmToken) {
        try {
          const push = {
            token: fcmToken,
            notification: { title: prefs.lang === 'es' ? "🅿️ Lugar abriéndose pronto" : "🅿️ Spot opening soon", body: message },
            data: {
              navigationVersion: '1',
              navigationType: 'ping',
              spotId: d.id,
              deliveryId,
            },
            android: { priority: "high" },
            apns: { payload: { aps: { sound: "default", badge: 1 } } },
          };
          await (_pingNotificationHooks.send?.(push) ?? getMessaging().send(push));
        } catch (e) {
          console.error("FCM reminder failed for", (spot.interestedUserId || '').slice(0, 4) + '***', sanitizeError(e));
        }
      }

    }

    // ── Pass 2: Auto-release stale committed claims ───────────────────────────
    const releaseSnap = await db.collection("spots")
      .where("status", "==", "interested")
      .where("claimState", "==", "committed")
      .where("claimAutoReleaseAt", "<=", now)
      .limit(100)
      .get();

    for (const d of releaseSnap.docs) {
      let releasedInfo = null;
      const initialSpot = d.data();
      const [claimerSnap, ownerSnap] = await Promise.all([
        initialSpot.interestedUserId ? db.doc(`users/${initialSpot.interestedUserId}`).get() : null,
        initialSpot.finderId ? db.doc(`users/${initialSpot.finderId}`).get() : null,
      ]);
      const claimerLang = claimerSnap?.exists ? claimerSnap.data().lang : null;
      const ownerLang = ownerSnap?.exists ? ownerSnap.data().lang : null;

      try {
        await db.runTransaction(async (tx) => {
          releasedInfo = null; // reset on each retry
          const fresh = await tx.get(d.ref);
          if (!fresh.exists) return;
          const spot = fresh.data();

          // Re-verify all conditions — claimer may have tapped "I'm heading there"
          if (
            spot.status !== "interested" ||
            spot.claimState !== "committed" ||
            !spot.interestedUserId ||
            !spot.claimAutoReleaseAt ||
            spot.claimAutoReleaseAt.toMillis() > now.toMillis()
          ) return;

          const spotExpired = spot.expiresAt && spot.expiresAt.toMillis() <= now.toMillis();

          const clearFields = {
            interestedUserId: null,
            interestedUserName: null,
            interestedUserVehicleColor: null,
            interestedUserVehicleType: null,
            interestedUserVehicleBrand: null,
            interestedUserTitle: null,
            etaMinutes: null,
            interestExpiresAt: null,
            claimState: null,
            ownerLeavingNow: null,
            ownerLeavingNowAt: null,
            claimReminderAt: null,
            claimReminderSentAt: null,
            claimAutoReleaseAt: null,
            claimAutoReleasedAt: now,
          };

          const claimId = `claim_${stableId(d.id, snapshotGeneration(fresh), spot.interestedUserId)}`;

          if (spotExpired) {
            // Ping already expired — clear stale claim fields, don't revive to available
            tx.update(d.ref, clearFields);
          } else {
            tx.update(d.ref, { ...clearFields, status: "available" });
          }

          if (spot.interestedUserId !== spot.finderId) {
            tx.set(db.doc(`spotNotifications/released_claimer_${claimId}`), {
              spotId: d.id,
              senderId: null,
              actorType: 'system',
              subjectUserId: spot.finderId || null,
              targetUserId: spot.interestedUserId,
              claimId,
              type: 'scheduled_claim_auto_released',
              message: localizeNotification('auto_released_claimer', claimerLang, {}),
              createdAt: now,
            });
            if (spot.finderId && !spotExpired) {
              tx.set(db.doc(`spotNotifications/released_owner_${claimId}`), {
                spotId: d.id,
                senderId: null,
                actorType: 'system',
                subjectUserId: spot.interestedUserId,
                targetUserId: spot.finderId,
                claimId,
                type: 'scheduled_claim_released_owner',
                message: localizeNotification('auto_released_owner', ownerLang, {}),
                createdAt: now,
              });
            }
          }

          releasedInfo = {
            claimerId: spot.interestedUserId,
            finderId: spot.finderId || null,
            spotExpired,
          };
        });
      } catch (e) {
        console.error("Auto-release transaction failed for spot", d.id.slice(0, 8) + '***', sanitizeError(e));
      }

      if (!releasedInfo) continue;

    }

    console.log(
      `✅ processScheduledClaims: ${reminderSnap.size} reminders, ${releaseSnap.size} releases`
    );
  }
);

// 2) Increment total spots pinged (all-time) whenever a spot is created
exports.incrementTotalSpotsPinged = onDocumentCreated(
  {
    document: "spots/{spotId}",
    region: "us-central1",
    retry: true,
    serviceAccount: 'parqueen-system-events@parkqueen-46475363-ccf36.iam.gserviceaccount.com',
  },
  async (event) => {
    const spotId = event.params?.spotId;
    const spot = event.data?.data?.();
    if (!spotId || !spot || typeof spot.finderId !== 'string' || !spot.finderId.trim()) return;
    const statsRef = db.doc("stats/global");
    if (typeof event.id !== 'string' || !event.id) return;
    const eventRef = db.doc(`functionEvents/incrementTotalSpotsPinged_${stableId(event.id)}`);
    const userRef = db.doc(`users/${spot.finderId}`);
    await db.runTransaction(async tx => {
      const [eventSnap, userSnap] = await Promise.all([tx.get(eventRef), tx.get(userRef)]);
      // Historical markers (written before the per-user counter existed) are
      // never reprocessed — "Pings shared" is go-forward only. See the Pings
      // Shared backfill-feasibility investigation: exact historical
      // attribution is unrecoverable for the vast majority of pings.
      if (eventSnap.exists) return;
      tx.set(eventRef, {
        functionName: 'incrementTotalSpotsPinged',
        sourceEventId: event.id,
        spotId,
        actorUserId: spot.finderId,
        processedAt: Timestamp.now(),
      });
      tx.set(statsRef, { totalSpotsPinged: FieldValue.increment(1) }, { merge: true });
      if (userSnap.exists) {
        tx.set(userRef, { impactStats: { pingsShared: FieldValue.increment(1) } }, { merge: true });
      }
    });
  }
);

// 3) Geofenced Notifications for Nearby Users
exports.notifyNearbyUsers = onDocumentCreated(
  {
    document: "spots/{spotId}",
    region: "us-central1",
    serviceAccount: 'parqueen-messaging@parkqueen-46475363-ccf36.iam.gserviceaccount.com',
  },
  async (event) => {
    const spotData = event.data.data();
    if (!spotData || !spotData.geohash || typeof spotData.finderId !== 'string' || !spotData.finderId.trim() ||
        !Number.isFinite(spotData.lat) || !Number.isFinite(spotData.lng)) return;

    const spotGeohash = spotData.geohash;
    // 4-char prefix ≈ 20km coarse filter, then precise distance check
    const prefix = spotGeohash.substring(0, 4);

    try {
      const neighborsSnap = await db.collection("userLocations")
          .where("lastGeohash", ">=", prefix)
          .where("lastGeohash", "<=", prefix + "\uf8ff")
          .limit(MAX_CANDIDATES)
          .get();

      if (neighborsSnap.empty) return;

      const geofire = require("geofire-common");
      const candidates = filterCandidates(neighborsSnap, spotData, geofire, Date.now());

      if (candidates.length === 0) return;

      // Fetch all preferences concurrently — Admin SDK has no getAll() for subcollection
      // paths, so concurrent individual .get() calls are the correct batching approach.
      const prefsResults = await Promise.all(
          candidates.map(c =>
              db.doc(`users/${c.userId}/private/preferences`).get()
                .then(snap => ({ userId: c.userId, distMiles: c.distMiles, prefs: snap.exists ? snap.data() : null }))
          )
      );

      const messages = buildMessages(prefsResults, event.params.spotId);

      if (messages.length === 0) return;

      // Claim each recipient before sending. A repeated Firestore event observes
      // the durable delivery document and cannot duplicate its push or bell row.
      if (typeof event.id !== 'string' || !event.id) return;
      const claimedMessages = (await Promise.all(messages.map(async message => {
        const recipientId = message.recipientUserId;
        const deliveryId = `nearby_${stableId(event.id, recipientId)}`;
        const deliveryRef = db.doc(`notificationDeliveries/${deliveryId}`);
        const bellRef = db.doc(`spotNotifications/${deliveryId}`);
        return db.runTransaction(async tx => {
          if ((await tx.get(deliveryRef)).exists) return null;
          const claimedAt = Timestamp.now();
          tx.set(deliveryRef, {
            functionName: 'notifyNearbyUsers',
            eventId: event.id || null,
            spotId: event.params.spotId,
            actorUserId: spotData.finderId,
            recipientUserId: recipientId,
            status: 'reserved',
            reservedAt: claimedAt,
          });
          tx.set(bellRef, {
            spotId: event.params.spotId,
            senderId: spotData.finderId,
            targetUserId: recipientId,
            claimId: null,
            type: 'nearby_spot',
            message: 'A new Ping is available nearby.',
            createdAt: claimedAt,
          });
          return {
            ...message,
            data: { ...message.data, deliveryId },
            deliveryId,
          };
        });
      }))).filter(Boolean);

      if (claimedMessages.length === 0) return;

      let totalSent = 0, totalFailed = 0;
      const staleRecipients = [];
      for (let i = 0; i < claimedMessages.length; i += FCM_BATCH) {
          const chunk = claimedMessages.slice(i, i + FCM_BATCH);
          const outbound = chunk.map(({ recipientUserId, deliveryId, ...message }) => message);
          const response = await (_pingNotificationHooks.sendEach?.(outbound) ?? getMessaging().sendEach(outbound));
          totalSent += response.successCount;
          totalFailed += response.failureCount;
          const staleTokens = new Set(collectStaleTokens(outbound, response.responses));
          await Promise.all(chunk.map((message, index) => {
            const result = response.responses[index];
            if (staleTokens.has(message.token)) {
              staleRecipients.push({ userId: message.recipientUserId, token: message.token });
            }
            return db.doc(`notificationDeliveries/${message.deliveryId}`).update({
              status: result?.success ? 'sent' : 'failed',
              completedAt: Timestamp.now(),
              failureCode: result?.success ? null : String(result?.error?.code || 'messaging/unknown'),
            });
          }));
      }
      console.log(`Geofence push: ${totalSent} sent, ${totalFailed} failed, ${staleRecipients.length} stale tokens`);

      // Best-effort stale token cleanup
      if (staleRecipients.length > 0) {
          await _pingNotificationHooks.beforeStaleTokenCleanup?.();
          await Promise.all(staleRecipients.map(({ userId, token }) => {
            const prefsRef = db.doc(`users/${userId}/private/preferences`);
            return db.runTransaction(async tx => {
              const current = await tx.get(prefsRef);
              if (current.exists && current.data().fcmToken === token) {
                tx.update(prefsRef, { fcmToken: FieldValue.delete() });
              }
            }).catch(() => {});
          }));
      }
    } catch (error) {
      console.error("Error in notifyNearbyUsers:", sanitizeError(error));
    }
  }
);

// 4) Generate and send email OTP
exports.generateEmailOTP = onCall(
  { region: "us-central1", secrets: [sendgridApiKey, emailRateLimitPepper], serviceAccount: 'parqueen-email@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
    const email = _canonicalizeEmail(request.data?.email);

    const uid = request.auth.uid;
    await checkRateLimit(uid, 'generateEmailOTP', { limit: 10, windowSec: 3600 });
    // HMAC with server-only pepper prevents rainbow-table attacks on per-inbox rate limit keys.
    const emailHash = createHmac('sha256', emailRateLimitPepper.value()).update(email).digest('hex');
    await checkRateLimit(emailHash, 'generateEmailOTP_email', { limit: 10, windowSec: 3600 });
    const docRef = db.collection("emailVerificationCodes").doc(uid);
    const nowMs = _emailOtpHooks.now?.() ?? Date.now();
    const code = _emailOtpHooks.generateCode?.() ?? _generateEmailOtpCode();
    const requestId = randomUUID();
    await db.runTransaction(async tx => {
      const existing = await tx.get(docRef);
      if (existing.exists) {
        const lastSent = existing.data().createdAt?.toMillis() || 0;
        if (nowMs - lastSent < 60000) {
          throw new HttpsError("resource-exhausted", "Wait 60 seconds before requesting another code.");
        }
      }
      tx.set(docRef, {
        code, email, requestId, status: 'pending',
        createdAt: Timestamp.fromMillis(nowMs),
        expiresAt: Timestamp.fromMillis(nowMs + 10 * 60000),
      });
    });

    try {
      await (_emailOtpHooks.deliver?.(email, code) ?? _deliverEmailOtp(email, code));
      await db.runTransaction(async tx => {
        const current = await tx.get(docRef);
        if (!current.exists || current.data().requestId !== requestId || current.data().status !== 'pending') {
          throw new Error('OTP request superseded');
        }
        tx.update(docRef, { status: 'active' });
      });
    } catch (e) {
      await db.runTransaction(async tx => {
        const current = await tx.get(docRef);
        if (current.exists && current.data().requestId === requestId) tx.delete(docRef);
      }).catch(() => {});
      // A bare "delivery failed" line cost real time during a production outage:
      // it could not distinguish a rejected key (401/403) from a bad payload
      // (400) from a SendGrid outage (5xx). The numeric status is the one field
      // that separates those and carries nothing about the recipient. Absent for
      // network/timeout failures and for the superseded-request path above, in
      // which case the log line is exactly what it was before.
      const status = typeof e?.status === 'number' ? e.status : undefined;
      if (status === undefined) console.error('Email OTP delivery failed');
      else console.error('Email OTP delivery failed', { status });
      throw new HttpsError("internal", "Failed to send verification email.");
    }
    return { success: true };
  }
);

// 5) Verify email OTP
exports.verifyEmailOTP = onCall(
  { region: "us-central1", serviceAccount: 'parqueen-user@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
    const email = _canonicalizeEmail(request.data?.email);
    const code = request.data?.code;

    const uid = request.auth.uid;
    await checkRateLimit(uid, 'verifyEmailOTP', { limit: 10, windowSec: 900 });
    const docRef = db.collection("emailVerificationCodes").doc(uid);
    const userRef = db.collection("users").doc(uid);
    const privateAccountRef = userRef.collection("private").doc("account");
    const verificationOutcome = await db.runTransaction(async tx => {
      const snap = await tx.get(docRef);
      if (!snap.exists) throw new HttpsError("not-found", "No verification code found. Request a new one.");

      const data = snap.data();
      let storedEmail;
      try { storedEmail = _canonicalizeEmail(data.email); }
      catch { storedEmail = null; }
      if ((data.status && data.status !== 'active') || storedEmail !== email || !_emailOtpMatches(data.code, code)) {
        throw new HttpsError("invalid-argument", "Invalid email or code.");
      }
      if (!data.expiresAt?.toMillis || Date.now() > data.expiresAt.toMillis()) {
        tx.delete(docRef);
        return 'expired';
      }
      tx.delete(docRef);
      // Consume the OTP only if both account updates can commit with it.
      tx.set(privateAccountRef, { email }, { merge: true });
      tx.update(userRef, { emailVerified: true });
      return 'verified';
    });
    if (verificationOutcome === 'expired') {
      throw new HttpsError("deadline-exceeded", "Code expired. Request a new one.");
    }
    return { success: true };
  }
);

// ── Test seam ─────────────────────────────────────────────────────────────────
// Integration tests set _hooks.visionSafeSearch to control Vision responses
// deterministically without calling the real Vision API.
const _hooks = {
  visionSafeSearch: null, // null → use real Vision; (gcsUri) => Promise<annotation|null>
};
exports._hooks = _hooks;

// ── Callable test seams ───────────────────────────────────────────────────────
// Set to a function to replace external API calls in integration tests.
// null (default) → real provider; set in test beforeEach, clear in afterEach.
const _callableHooks = {
  sweepNYCResult: null,  // (lat, lng) => Promise<result> — replaces SweepNYC + fallback
  geminiResponse: null,  // (features) => Promise<{text}> — replaces GoogleGenAI call
  analyzeSignResponse: null,  // (imageBase64, mimeType) => Promise<{text}> — replaces GoogleGenAI vision call
  hydrantResponse: null,  // (lat, lng) => Promise<{ok, meters}> — replaces the NYC DEP lookup
  smartRepliesResponse: null,  // (lastMessage, context) => Promise<{text}> — replaces GoogleGenAI call
};
exports._callableHooks = _callableHooks;


// ── Avatar moderation helpers ──────────────────────────────────────────────────
// JPEG: FF D8 FF  |  PNG: 89 50 4E 47 0D 0A 1A 0A  |  WebP: RIFF????WEBP
function _isAllowedImageHeader(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return true;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47 &&
      buf[4] === 0x0D && buf[5] === 0x0A && buf[6] === 0x1A && buf[7] === 0x0A) return true;
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return true;
  return false;
}

// ── Retry model — two independent layers ──────────────────────────────────────
// Layer 1 — Eventarc Standard delivery (platform):
//   At-least-once delivery with exponential back-off. Default retention is
//   approximately 24 hours; no assumed five-attempt ceiling from the platform.
//   `retry: true` on the trigger activates re-delivery on uncaught throws;
//   without it, thrown errors are silently discarded and no retry occurs.
//
// Layer 2 — Application retry ceiling (ParQueen):
//   AVATAR_MAX_RETRIES = 3, tracked in avatarModeration/{uid}.retryCount.
//   On the third exhausted attempt the event is acknowledged (no throw),
//   the moderation doc status is set to "failed", and both source and
//   candidate objects are deleted. Permanent failures (invalid format,
//   content policy) are acknowledged immediately regardless of retryCount.
const AVATAR_MAX_RETRIES = 3;
// 4096 × 4096 — well above 512 × 512 output; 64× below Sharp's 268 M default.
const AVATAR_MAX_PIXELS    = 16_777_216;
const AVATAR_MAX_DIMENSION = 4096;

// Quarantine path design — prevents trigger recursion and pre-approval exposure:
//   Upload (client-writable, owner-private):  avatarUploads/{uid}/{uploadId}/original
//   Candidate (server-only, not public):      avatarCandidates/{uid}/{uploadId}.webp
//   Published (server-written, owner-read):   avatars/{uid}
//   Moderation state (client-readable):       avatarModeration/{uid}

// 6) Moderate avatar uploads via Vision SafeSearch
exports.moderateAvatarUpload = onObjectFinalized(
  { region: "us-central1", memory: "512MiB", retry: true, serviceAccount: 'parqueen-avatar-moderator@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (event) => {
    const filePath = event.data.name;

    // Only process files at exactly avatarUploads/{uid}/{uploadId}/original.
    // avatarCandidates/ and avatars/ writes by the server never re-trigger here.
    if (!filePath.startsWith("avatarUploads/")) return;
    const parts = filePath.split("/");
    if (parts.length !== 4 || parts[3] !== "original") return;

    const uid            = parts[1];
    const uploadId       = parts[2];
    const sourceGen      = String(event.data.generation || "");
    const maskedUid      = uid.slice(0, 4) + "***";
    const moderationRef  = db.collection("avatarModeration").doc(uid);
    const pendingRef     = db.doc(`users/${uid}/private/avatar`);
    const bucket         = getStorage().bucket(event.data.bucket);
    const sourceFile     = bucket.file(filePath);
    const candidatePath  = `avatarCandidates/${uid}/${uploadId}.webp`;
    const candidateFile  = bucket.file(candidatePath);
    const publishedFile  = bucket.file(`avatars/${uid}`);

    // ── Step 0: Generation-scoped idempotency via transaction ─────────────────
    // Also reads users/{uid}/private/avatar to enforce the pre-event newer-upload
    // race guard: if pendingUploadId is set to a different uploadId, a newer upload
    // was registered before this event fired — skip without processing.
    let claimResult;
    try {
      claimResult = await db.runTransaction(async (tx) => {
        const moderationSnap = await tx.get(moderationRef);
        const pendingSnap    = await tx.get(pendingRef);
        const pendingId = pendingSnap.exists ? pendingSnap.data().pendingUploadId : null;
        if (pendingId && pendingId !== uploadId) return { claimed: false, reason: "superseded_by_pending" };
        if (!moderationSnap.exists) {
          tx.set(moderationRef, {
            uid, uploadId, sourcePath: filePath, sourceGeneration: sourceGen,
            status: "processing", retryCount: 0, processedPath: null,
            failureReason: null, createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
          });
          return { claimed: true, retryCount: 0 };
        }
        const d = moderationSnap.data();
        if (d.uploadId !== uploadId) return { claimed: false, reason: "superseded" };
        if (d.status === "approved" || d.status === "rejected") return { claimed: false, reason: "terminal" };
        if (d.retryCount >= AVATAR_MAX_RETRIES) return { claimed: false, reason: "max_retries" };
        tx.update(moderationRef, { status: "processing", updatedAt: Timestamp.now() });
        return { claimed: true, retryCount: d.retryCount };
      });
    } catch (err) {
      console.error(`Avatar transaction error (${maskedUid}):`, sanitizeError(err));
      throw err; // transient — let CF retry
    }

    if (!claimResult.claimed) {
      const reason = claimResult.reason;
      console.log(`Avatar moderation skipped (${reason}) for ${maskedUid}`);
      if (reason === "superseded" || reason === "superseded_by_pending") {
        // Source has no active processor — delete immediately to prevent orphan accumulation.
        await sourceFile.delete().catch(() => {});
      } else if (reason === "max_retries") {
        // Terminal failure: record it and remove all objects for this upload.
        await Promise.all([
          moderationRef.update({ status: "failed", failureReason: "max_retries_exhausted", updatedAt: Timestamp.now() }).catch(() => {}),
          sourceFile.delete().catch(() => {}),
          candidateFile.delete().catch(() => {}),
        ]);
      }
      return;
    }
    const retryCount = claimResult.retryCount;

    // ── Step 1: Download original from quarantine path ────────────────────────
    let rawBytes;
    try {
      [rawBytes] = await sourceFile.download();
    } catch (err) {
      await moderationRef.update({ status: "retry_pending", failureReason: "download_error", retryCount: retryCount + 1, updatedAt: Timestamp.now() });
      console.error(`Avatar download error (${maskedUid}):`, sanitizeError(err));
      throw err; // transient — let CF retry
    }

    // ── Step 2: Magic-byte check — permanent rejection, no retry ─────────────
    if (!_isAllowedImageHeader(rawBytes)) {
      await Promise.all([
        sourceFile.delete().catch(() => {}),
        moderationRef.update({ status: "rejected", failureReason: "invalid_format", updatedAt: Timestamp.now() }),
      ]);
      console.log(`Avatar rejected (invalid_format) for ${maskedUid}`);
      return;
    }

    // ── Step 3: Process with Sharp — EXIF strip, resize 512×512, WebP ────────
    // Defensive construction: fail on warnings, explicit pixel/channel caps.
    // Re-encoding to WebP without .withMetadata() strips all EXIF/GPS/IPTC/XMP.
    let processedBuffer;
    try {
      const sharp = require("sharp");
      const sharpOpts = { failOn: "warning", limitInputPixels: AVATAR_MAX_PIXELS, limitInputChannels: 4, sequentialRead: true };
      const meta = await sharp(rawBytes, sharpOpts).metadata();
      if (!meta.width || meta.width <= 0 || !meta.height || meta.height <= 0)
        throw Object.assign(new Error("zero dimensions"), { _perm: true, _reason: "zero_dimensions" });
      if (meta.width > AVATAR_MAX_DIMENSION || meta.height > AVATAR_MAX_DIMENSION)
        throw Object.assign(new Error("dimension limit"), { _perm: true, _reason: "dimensions_exceeded" });
      if ((meta.width * meta.height) > AVATAR_MAX_PIXELS)
        throw Object.assign(new Error("pixel limit"), { _perm: true, _reason: "pixel_count_exceeded" });
      if (meta.pages && meta.pages > 1)
        throw Object.assign(new Error("animated"), { _perm: true, _reason: "animated_rejected" });
      processedBuffer = await sharp(rawBytes, sharpOpts)
        .resize({ width: 512, height: 512, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer();
    } catch (err) {
      if (err._perm) {
        await Promise.all([
          sourceFile.delete().catch(() => {}),
          moderationRef.update({ status: "rejected", failureReason: err._reason || "invalid_image", updatedAt: Timestamp.now() }),
        ]);
        console.log(`Avatar rejected (${err._reason || "invalid_image"}) for ${maskedUid}`);
        return;
      }
      await moderationRef.update({ status: "retry_pending", failureReason: "processing_error", retryCount: retryCount + 1, updatedAt: Timestamp.now() });
      console.error(`Avatar processing error (${maskedUid}):`, sanitizeError(err));
      throw err; // transient — let CF retry
    }

    // ── Step 4: Save to candidate path (never the trigger prefix) ────────────
    try {
      await candidateFile.save(processedBuffer, { metadata: { contentType: "image/webp" }, resumable: false });
      await moderationRef.update({ processedPath: candidatePath, updatedAt: Timestamp.now() });
    } catch (err) {
      await moderationRef.update({ status: "retry_pending", failureReason: "upload_error", retryCount: retryCount + 1, updatedAt: Timestamp.now() });
      console.error(`Avatar candidate upload error (${maskedUid}):`, sanitizeError(err));
      throw err; // transient
    }

    // ── Step 5: Vision SafeSearch on candidate — FAIL CLOSED ─────────────────
    let safeSnap;
    try {
      safeSnap = await (_hooks.visionSafeSearch
        ? _hooks.visionSafeSearch(`gs://${event.data.bucket}/${candidatePath}`)
        : (async () => {
            const vision = require("@google-cloud/vision");
            const client = new vision.ImageAnnotatorClient();
            const [result] = await client.safeSearchDetection(`gs://${event.data.bucket}/${candidatePath}`);
            return result?.safeSearchAnnotation ?? null;
          })());
    } catch (err) {
      await moderationRef.update({ status: "retry_pending", failureReason: "vision_error", retryCount: retryCount + 1, updatedAt: Timestamp.now() });
      console.error(`Avatar Vision error (${maskedUid}):`, sanitizeError(err));
      throw err; // transient — let CF retry
    }

    if (!safeSnap) {
      // Missing annotation fails closed — retry to give Vision another chance.
      await moderationRef.update({ status: "retry_pending", failureReason: "missing_annotation", retryCount: retryCount + 1, updatedAt: Timestamp.now() });
      console.error(`Avatar Vision annotation missing (${maskedUid})`);
      throw new Error("Missing Vision SafeSearch annotation");
    }

    const flagged = ["LIKELY", "VERY_LIKELY"];
    if (flagged.includes(safeSnap.adult) || flagged.includes(safeSnap.racy)) {
      await Promise.all([
        sourceFile.delete().catch(() => {}),
        candidateFile.delete().catch(() => {}),
        moderationRef.update({ status: "rejected", failureReason: "content_policy", updatedAt: Timestamp.now() }),
      ]);
      console.log(`Avatar rejected (content_policy) for ${maskedUid}`);
      return;
    }

    // ── Step 6: Approve — copy to published path, update user doc atomically ──
    // Staleness check: abort if a newer upload already claimed the moderation slot
    // or if pendingUploadId was updated to a different uploadId after Vision ran.
    try {
      await candidateFile.copy(publishedFile);
    } catch (err) {
      await moderationRef.update({ status: "retry_pending", failureReason: "publish_error", retryCount: retryCount + 1, updatedAt: Timestamp.now() });
      console.error(`Avatar publish copy error (${maskedUid}):`, sanitizeError(err));
      throw err;
    }

    // Firebase download token URL — permanent, revoked when file is deleted.
    // Copied files don't inherit download tokens, so we generate one explicitly
    // and attach it via setMetadata. getDownloadURL is not used because it
    // requires a pre-existing token (which only client-SDK uploads produce).
    const { randomUUID } = require("crypto");
    const downloadToken = randomUUID();
    try {
      await publishedFile.setMetadata({ metadata: { firebaseStorageDownloadTokens: downloadToken } });
    } catch (err) {
      // Emulator may reject setMetadata — log and continue. URL is still valid
      // in tests (truthy) and in production setMetadata always succeeds.
      console.warn(`Avatar metadata token error (${maskedUid}):`, sanitizeError(err));
    }
    const encodedPath = encodeURIComponent(`avatars/${uid}`);
    const avatarUrl = `https://firebasestorage.googleapis.com/v0/b/${event.data.bucket}/o/${encodedPath}?alt=media&token=${downloadToken}`;

    const approved = await db.runTransaction(async (tx) => {
      const moderationSnap = await tx.get(moderationRef);
      const pendingSnap    = await tx.get(pendingRef);
      const d = moderationSnap.data();
      const pendingId = pendingSnap.exists ? pendingSnap.data().pendingUploadId : null;
      // Abort if moderation slot was taken by a newer upload, or if client
      // registered a newer upload (pendingUploadId mismatch) after Vision ran.
      if (!d || d.uploadId !== uploadId) return false;
      if (pendingId && pendingId !== uploadId) return false;
      tx.update(moderationRef, { status: "approved", failureReason: null, updatedAt: Timestamp.now() });
      tx.update(db.doc(`users/${uid}`), { avatarUrl });
      // Clear the pending record now that this upload is published.
      if (pendingSnap.exists && pendingId === uploadId) tx.delete(pendingRef);
      return true;
    });

    if (approved) {
      await Promise.all([sourceFile.delete().catch(() => {}), candidateFile.delete().catch(() => {})]);
      console.log(`Avatar approved for ${maskedUid}`);
    } else {
      // Superseded mid-flight — remove both objects to prevent orphan accumulation.
      await Promise.all([sourceFile.delete().catch(() => {}), candidateFile.delete().catch(() => {})]);
      console.log(`Avatar approval skipped (superseded) for ${maskedUid}`);
    }
  }
);

// ── Orphan cleanup helper ─────────────────────────────────────────────────────
// Deletes avatarUploads/ and avatarCandidates/ objects older than cutoffMs
// (default 24 h ago) AND whose moderation status is terminal or absent.
// Active objects (processing, retry_pending) are preserved.
// avatars/ (published) is never iterated — not in ORPHAN_CLEANUP_PREFIXES.
//
// autoPaginate:false — GCS returns one page at a time; cursor advances past
//   each fully-processed page, preventing starvation of later objects.
// Persistent cursor — stored in maintenanceJobs/avatarOrphanCleanup so each
//   leased run resumes where the previous run stopped. Wraps after both prefixes
//   are exhausted. Client access is blocked by Firestore Rules.
// Lease — Firestore transaction prevents two concurrent scheduled executions
//   from racing. maxInstances is NOT set: the Firebase Functions emulator does
//   not support it on scheduled functions and fails to register the export.
// Counters — deleted increments only after a successful file.delete(); failed
//   increments when file.delete() rejects. One failed deletion does not abort.
// Stale cursor recovery — if GCS returns HTTP 400 with reason "invalid" the
//   page token has expired. The stale token is cleared transactionally in
//   Firestore (cursorResetAt / cursorResetReason recorded) and the prefix is
//   retried from page 1 in the same invocation. A per-prefix guard prevents
//   a second clear, so a bad page-1 response always propagates.
// Lease release — guaranteed by try/finally; unexpected throws cannot
//   permanently lock the job. Release errors are swallowed so the caller sees
//   the original error; bounded lease expiry recovers if release itself fails.
const ORPHAN_CLEANUP_JOB_PATH     = "maintenanceJobs/avatarOrphanCleanup";
const ORPHAN_CLEANUP_PREFIXES     = ["avatarUploads/", "avatarCandidates/"];
const ORPHAN_CLEANUP_THRESHOLD_MS = 24 * 60 * 60 * 1000;
const ORPHAN_MAX_OBJECTS_PER_RUN  = 1000;
const ORPHAN_LEASE_DURATION_MS    = 10 * 60 * 1000; // 10 minutes
const ORPHAN_TERMINAL_STATUSES    = new Set(["approved", "rejected", "failed"]);
const ORPHAN_ACTIVE_STATUSES      = new Set(["processing", "retry_pending"]);

// Classify GCS errors that represent an expired/invalid page cursor.
// Uses only stable API fields: HTTP status code and per-error reason string.
function _isInvalidStoragePageTokenError(err) {
  if (err?.code !== 400) return false;
  const reasons = (err?.errors ?? []).map(e => e.reason ?? "");
  return reasons.some(r => r === "invalid" || r === "invalidToken");
}

// Acquire a bounded cleanup lease via Firestore transaction.
// Returns the persisted cursor { currentPrefix, pageToken } on success,
// or null if a concurrent execution already holds an unexpired lease.
async function _acquireOrphanLease(firestoreDb, leaseOwner, nowMs) {
  const jobRef = firestoreDb.doc(ORPHAN_CLEANUP_JOB_PATH);
  return firestoreDb.runTransaction(async (tx) => {
    const snap = await tx.get(jobRef);
    const d    = snap.exists ? snap.data() : {};
    const exp  = d.leaseExpiresAt ? d.leaseExpiresAt.toMillis() : 0;
    if (d.leaseOwner && exp > nowMs) return null;
    const cursor = {
      currentPrefix: d.currentPrefix ?? ORPHAN_CLEANUP_PREFIXES[0],
      pageToken:     d.pageToken     ?? null,
    };
    tx.set(jobRef, {
      ...d,
      leaseOwner,
      leaseExpiresAt: Timestamp.fromMillis(nowMs + ORPHAN_LEASE_DURATION_MS),
      lastStartedAt:  Timestamp.fromMillis(nowMs),
      checkedLastRun: 0,
      deletedLastRun: 0,
      failedLastRun:  0,
    }, { merge: true });
    return cursor;
  });
}

async function _cleanOrphanedAvatarObjects(storageBucket, firestoreDb, cutoffMs, maxObjects, opts = {}) {
  const stale  = cutoffMs  ?? (Date.now() - ORPHAN_CLEANUP_THRESHOLD_MS);
  const limit  = maxObjects ?? ORPHAN_MAX_OBJECTS_PER_RUN;
  const { leaseOwner = null } = opts;

  let checked   = 0;
  let eligible  = 0;
  let deleted   = 0;
  let failed    = 0;
  let preserved = 0;

  let startPrefix = ORPHAN_CLEANUP_PREFIXES[0];
  let startToken  = null;
  if (leaseOwner) {
    const cursor = await _acquireOrphanLease(firestoreDb, leaseOwner, Date.now());
    if (!cursor) {
      console.log("Avatar orphan cleanup: lease held by concurrent execution — skipping");
      return { checked, eligible, deleted, failed, preserved, skipped: true };
    }
    startPrefix = cursor.currentPrefix;
    startToken  = cursor.pageToken;
  }

  let prefixIdx = ORPHAN_CLEANUP_PREFIXES.indexOf(startPrefix);
  if (prefixIdx < 0) prefixIdx = 0;

  // nextPrefix/nextToken: cursor persisted for the next run.
  // Default: wrap to beginning after all prefixes exhausted.
  let nextPrefix = ORPHAN_CLEANUP_PREFIXES[0];
  let nextToken  = null;
  let capHit     = false;

  // errorPrefix/errorToken: best-effort cursor for the error-exit path.
  // Updated when a token reset clears the stale value so re-saving it is avoided.
  let errorPrefix = startPrefix;
  let errorToken  = startToken;
  let didError    = false;

  try {
    for (let pi = prefixIdx; pi < ORPHAN_CLEANUP_PREFIXES.length; pi++) {
      const prefix    = ORPHAN_CLEANUP_PREFIXES[pi];
      let   pageToken = (pi === prefixIdx) ? startToken : null;
      let   tokenResetDone = false; // guard: clear stale token at most once per prefix

      // for(;;) instead of do-while: after a token reset (pageToken=null), continue
      // correctly restarts from the top rather than evaluating a while condition.
      for (;;) {
        const remaining = limit - checked;
        if (remaining <= 0) {
          // Budget exhausted before fetching the next page — persist cursor here.
          capHit     = true;
          nextPrefix = prefix;
          nextToken  = pageToken;
          break;
        }

        let files, nextQuery;
        try {
          [files, nextQuery] = await storageBucket.getFiles({
            prefix,
            maxResults:   Math.min(remaining, 500),
            pageToken:    pageToken || undefined,
            autoPaginate: false,
          });
        } catch (gcsErr) {
          if (!tokenResetDone && _isInvalidStoragePageTokenError(gcsErr)) {
            tokenResetDone = true;
            const nowMs = Date.now();
            if (leaseOwner) {
              const jobRef = firestoreDb.doc(ORPHAN_CLEANUP_JOB_PATH);
              await firestoreDb.runTransaction(async (tx) => {
                const snap = await tx.get(jobRef);
                if (snap.exists) {
                  tx.update(jobRef, {
                    pageToken:         null,
                    cursorResetAt:     Timestamp.fromMillis(nowMs),
                    cursorResetReason: "invalid_page_token",
                  });
                }
              });
            }
            console.warn(
              `Avatar orphan cleanup: stale page token cleared for prefix "${prefix}"; retrying from page 1`
            );
            // Update error-path cursor so a subsequent throw saves the cleared state.
            errorPrefix = prefix;
            errorToken  = null;
            pageToken   = null;
            continue; // restart for(;;) from page 1 of this prefix
          }
          throw gcsErr; // non-token errors propagate; finally releases lease
        }

        for (const file of files) {
          checked++;
          const created = new Date(file.metadata?.timeCreated ?? 0).getTime();
          if (created > stale) { preserved++; continue; }

          const uid = file.name.split("/")[1];
          if (!uid) {
            // Malformed path — defensive deletion; no UID to log.
            eligible++;
            try { await file.delete(); deleted++; }
            catch (err) { console.warn("Avatar orphan delete failed:", sanitizeError(err)); failed++; }
            continue;
          }

          const snap   = await firestoreDb.doc(`avatarModeration/${uid}`).get();
          const status = snap.exists ? snap.data()?.status : null;

          if (ORPHAN_ACTIVE_STATUSES.has(status)) { preserved++; continue; }

          if (!status || ORPHAN_TERMINAL_STATUSES.has(status)) {
            eligible++;
            try { await file.delete(); deleted++; }
            catch (err) { console.warn("Avatar orphan delete failed:", sanitizeError(err)); failed++; }
          } else {
            preserved++; // unknown status — conservative
          }
        }

        // Advance past the page we just finished.
        pageToken = nextQuery?.pageToken ?? null;

        // After consuming the page, check if the budget is now exhausted.
        if (checked >= limit && pageToken) {
          capHit     = true;
          nextPrefix = prefix;
          nextToken  = pageToken;
          break;
        }
        if (!pageToken) break; // prefix exhausted — move to next prefix
      }

      if (capHit) break;
    }
  } catch (err) {
    didError = true;
    throw err;
  } finally {
    if (leaseOwner) {
      // On normal completion or capHit: advance cursor.
      // On unexpected error: restore best-effort cursor (retry same position).
      const releasePrefix = (didError && !capHit) ? errorPrefix : nextPrefix;
      const releaseToken  = (didError && !capHit) ? errorToken  : nextToken;
      await firestoreDb.doc(ORPHAN_CLEANUP_JOB_PATH).update({
        leaseOwner:      null,
        leaseExpiresAt:  Timestamp.fromMillis(0),
        lastCompletedAt: Timestamp.fromMillis(Date.now()),
        currentPrefix:   releasePrefix,
        pageToken:       releaseToken,
        checkedLastRun:  checked,
        deletedLastRun:  deleted,
        failedLastRun:   failed,
      // ponytail: swallow release failure — bounded lease expiry still recovers
      }).catch(e => console.error("Avatar orphan cleanup: lease release failed:", sanitizeError(e)));
    }
  }

  console.log(`Avatar orphan cleanup: checked=${checked} eligible=${eligible} deleted=${deleted} failed=${failed} preserved=${preserved}`);
  return { checked, eligible, deleted, failed, preserved };
}
exports._cleanOrphans                   = _cleanOrphanedAvatarObjects;
exports._acquireOrphanLease             = _acquireOrphanLease;
exports._isInvalidStoragePageTokenError = _isInvalidStoragePageTokenError;

exports.cleanAvatarOrphans = onSchedule(
  { region: "us-central1", schedule: "every 24 hours", memory: "256MiB", serviceAccount: 'parqueen-avatar@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async () => {
    const { randomUUID } = require("crypto");
    return _cleanOrphanedAvatarObjects(
      getStorage().bucket(), db, undefined, undefined,
      { leaseOwner: randomUUID() }
    );
  }
);

// 7) Validate and claim a username
// --- Shared Moderation System ---

// Tier 1: substring block after compact normalization (unambiguous terms)
const BRAND_TERMS = ['parqueen', 'parkqueen'];
const STRONG_RESERVED = [
  'admin', 'administrator', 'support', 'official', 'system', 'root',
  'security', 'firebase', 'backend', 'moderator', 'staff', 'owner',
  'founder', 'developer',
];
// Tier 2: exact token match only — avoids blocking "modernDriver", "devonParks", "steam"
const SHORT_RESERVED = ['mod', 'dev', 'api', 'team', 'help'];

// BANNED_WORDS/CONTACT_PATTERNS/normalizeText/checkBannedWords/checkContactInfo
// live in ./moderation.js — shared with sendMessage, so there's exactly one
// server-side implementation instead of a third independent copy.
const { checkBannedWords, checkContactInfo, normalizeText, moderateMessageServer } = require('./moderation');

function tokenize(str) {
  return str.toLowerCase().split(/[_\-.\s]+/).filter(Boolean);
}

function checkImpersonation(text) {
  const compact = normalizeText(text);
  for (const term of BRAND_TERMS) {
    if (compact.includes(term)) return true;
  }
  for (const term of STRONG_RESERVED) {
    if (compact.includes(term)) return true;
  }
  const tokens = tokenize(text);
  for (const term of SHORT_RESERVED) {
    if (tokens.includes(term)) return true;
  }
  return false;
}

// Shared moderation callable
//
// Runtime-IAM canary (Phase 2A): first public/authenticated-user callable to
// move off the shared Editor-privileged compute default service account.
// This identity has only roles/datastore.user — the exact permission
// checkRateLimit's transaction and the moderationLog write need. No Auth
// read/write, no Storage, no Secret Manager, no FCM, no deploy/IAM/
// Scheduler/App-Check-admin capability. See adminReadView above for the
// first (admin-only) canary in this same migration.
// Authoritative server-side chat message write path — closes the direct-
// Firestore-write moderation bypass found in the dead-callable audit: the
// client's local moderateMessage() (utils/moderation.ts) is UX-only and was
// never a security boundary, since any authenticated client using the
// Firestore SDK directly could skip it and satisfy firestore.rules' schema/
// size/ownership checks with unmoderated text. sendMessage re-derives sender
// identity from request.auth.uid (never a client-supplied senderId),
// re-verifies chat membership and runs the same banned-word/contact-info
// check moderateContent already applies for type: 'message' (see
// ./moderation.js), then performs the Firestore write itself via the Admin
// SDK — which Rules cannot see or gate, so every condition Rules currently
// enforce for a legitimate client create (membership, schema, senderId,
// size) is re-verified here first.
//
// Runtime-IAM canary (Phase 2A, continued): same minimal identity as
// moderateContent — roles/datastore.user only. No Auth read/write (sender
// identity comes from the already-verified callable token, not a getUser()
// call), no Storage, no Secret Manager, no FCM (no message-creation trigger
// exists to feed), no deploy/IAM/Scheduler/App-Check-admin capability.
//
// App Check is enforced from first release — a brand-new callable with no
// legacy caller to break; the production client already initializes App
// Check (see adminReadView's already-verified Stage 4A canary).
const SEND_MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;

// Marks a chat as deleting (idempotently) and recursively removes it,
// including its messages subcollection. Callable-authorization (is the
// caller actually a participant?) is the CALLER's responsibility — deleteChat
// checks it explicitly before invoking this; deleteAccount's own chats step
// already knows uid is a participant, having just queried for these chats by
// that same field, so it calls this directly with no further check.
//
// Messages are swept BEFORE the parent chat doc is removed (not a single
// recursiveDelete(chatRef) call on the parent, whose own documented contract
// is "the provided reference is deleted regardless of whether all deletes
// succeeded" — relying on that would let the parent disappear while some
// message deletes were still failing, permanently orphaning them beyond any
// future retry's reach, since a retry's authorization check needs the parent
// doc's participants array to still exist). With messages-first ordering, a
// partial failure here leaves the parent doc in place (still marked
// deleting) as the resumable retry point, and it is never possible for the
// parent to be gone while orphaned message docs remain unswept.
async function markChatDeletingAndRecursiveDelete(chatRef) {
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(chatRef);
    if (!snap.exists) return;
    if (!snap.data().deleting) {
      tx.set(chatRef, { deleting: true, deletingAt: FieldValue.serverTimestamp() }, { merge: true });
    }
  });

  await db.recursiveDelete(chatRef.collection('messages'));
  await chatRef.delete();
}

const DELETE_CHAT_ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

// Server-mediated conversation deletion. Closes the gap where any chat
// participant could delete an arbitrary individual message (including the
// OTHER participant's message) or the chat document directly via the
// Firestore SDK — firestore.rules still permits both today (see
// docs/CHAT_MESSAGE_HARDENING.md's "Deferred" section, which addressed
// create/update but not delete). Rules are intentionally left unchanged in
// this PR — see PR B/C staging — so this callable exists with zero
// production callers until the client migrates.
//
// Concurrency: marking the chat `deleting` inside a transaction BEFORE any
// recursive deletion begins, combined with sendMessageHandler's own
// transactional check of that same flag, closes the "new message created
// while deletion is in flight" race — Firestore's transaction contention
// retry (a transaction whose read set was written by another transaction
// before it commits is automatically retried, re-reading the now-current
// state) ensures a sendMessage transaction that read the chat before the
// marker committed cannot successfully write after it.
async function deleteChatHandler(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');

  const { chatId } = request.data || {};
  if (typeof chatId !== 'string' || !DELETE_CHAT_ID_RE.test(chatId)) {
    throw new HttpsError('invalid-argument', 'A valid chatId is required.');
  }

  const uid = request.auth.uid;
  // 10/hour: deleting a conversation is a deliberate, infrequent action —
  // generous headroom over any legitimate usage pattern while bounding a
  // scripted caller to a fixed ceiling per account.
  await checkRateLimit(uid, 'deleteChat', { limit: 10, windowSec: 3600 });

  const chatRef = db.collection('chats').doc(chatId);
  const chatSnap = await chatRef.get();
  if (!chatSnap.exists) {
    // Already gone (prior success, or never existed) — indistinguishable
    // end states from the caller's perspective; both resolve as success.
    return { success: true };
  }
  const chatData = chatSnap.data();
  if (!Array.isArray(chatData.participants) || !chatData.participants.includes(uid)) {
    throw new HttpsError('permission-denied', 'Not a participant in this chat.');
  }

  await markChatDeletingAndRecursiveDelete(chatRef);
  return { success: true };
}

exports._deleteChatHandler = deleteChatHandler;

exports.deleteChat = onCall(
  {
    region: 'us-central1',
    enforceAppCheck: true,
    serviceAccount: 'parqueen-user@parkqueen-46475363-ccf36.iam.gserviceaccount.com',
  },
  deleteChatHandler
);

async function sendMessageHandler(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');

  const { chatId, clientRequestId, text } = request.data || {};
  if (
    typeof chatId !== 'string' || chatId.length === 0 || chatId.length > 200 ||
    typeof clientRequestId !== 'string' || !SEND_MESSAGE_ID_RE.test(clientRequestId) ||
    typeof text !== 'string'
  ) {
    throw new HttpsError('invalid-argument', 'chatId, clientRequestId, and text are required.');
  }
  const trimmedText = text.trim();
  if (trimmedText.length === 0) {
    throw new HttpsError('invalid-argument', 'Message text cannot be empty.');
  }
  // Bound matches firestore.rules chat message text.size() <= 1000.
  if (trimmedText.length > 1000) {
    throw new HttpsError('invalid-argument', 'Text must be 1000 characters or less.');
  }

  const uid = request.auth.uid;
  // 30/min: generous headroom over realistic human-typed conversation bursts
  // (well beyond 1 message every 2s sustained for a full minute) while still
  // bounding a scripted sender to a fixed ceiling per account.
  await checkRateLimit(uid, 'sendMessage', { limit: 30, windowSec: 60 });

  const moderation = moderateMessageServer(trimmedText);
  if (!moderation.allowed) {
    throw new HttpsError('invalid-argument', "This message couldn't be sent. Please revise and try again.");
  }

  const chatRef = db.collection('chats').doc(chatId);
  const messageRef = chatRef.collection('messages').doc(clientRequestId);

  const result = await db.runTransaction(async (tx) => {
    const [chatSnap, existingMsgSnap] = await Promise.all([tx.get(chatRef), tx.get(messageRef)]);
    if (!chatSnap.exists) {
      throw new HttpsError('not-found', 'Chat not found.');
    }
    const chatData = chatSnap.data();
    if (!Array.isArray(chatData.participants) || !chatData.participants.includes(uid)) {
      throw new HttpsError('permission-denied', 'Not a participant in this chat.');
    }
    if (chatData.deleting) {
      // Server-mediated deletion (deleteChat) is in flight for this chat —
      // this transactional read is guaranteed fresh (or retried fresh by
      // Firestore on contention) against whatever committed the `deleting`
      // marker, so no message can be created after deletion has begun.
      throw new HttpsError('failed-precondition', "This conversation is being deleted and can no longer receive messages.");
    }
    if (existingMsgSnap.exists) {
      // Idempotent retry (double-click / network retry with the same
      // clientRequestId) — return the already-created message; do not
      // duplicate the write or re-touch chat metadata.
      return { id: messageRef.id };
    }
    tx.set(messageRef, { senderId: uid, text: trimmedText, timestamp: FieldValue.serverTimestamp() });
    tx.set(chatRef, {
      lastMessage: trimmedText,
      lastMessageTimestamp: FieldValue.serverTimestamp(),
      lastSenderId: uid,
    }, { merge: true });
    return { id: messageRef.id };
  });

  return { id: result.id, success: true };
}

exports._sendMessageHandler = sendMessageHandler;

exports.sendMessage = onCall(
  {
    region: 'us-central1',
    enforceAppCheck: true,
    serviceAccount: 'parqueen-user@parkqueen-46475363-ccf36.iam.gserviceaccount.com',
  },
  sendMessageHandler
);

// Authoritative username mutation — closes the direct-write bypass found in
// the profile-identity audit: users/{uid}.username was writable directly by
// the client (Rules validated only size/type, never content), letting a
// modified client skip this callable's moderation/uniqueness checks
// entirely. claimUsername now atomically owns BOTH the usernames/{normalized}
// registry AND users/{uid}.username — including creating the initial
// users/{uid} doc (plus its private/social and private/preferences seed
// docs) when this is the very first write for a brand-new account, a
// responsibility formerly split out to the client's now-retired
// saveUserProfile(). See docs/PROFILE_IDENTITY_HARDENING.md.
//
// Runtime-IAM canary (continued): parqueen-user@... (roles/datastore.user
// only) — already production-validated by real sendMessage traffic. No
// enforceAppCheck: real production traffic for this existing callable
// (sampled over the last 30 days) showed App Check MISSING on every
// request, predating the client's current App-Check-active bundle, with
// zero fresh samples since — insufficient evidence to safely enforce
// without risking the account-creation path for real users.
exports.claimUsername = onCall(
  { region: "us-central1", serviceAccount: 'parqueen-user@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Sign in first.");
    await checkRateLimit(request.auth.uid, 'claimUsername', { limit: 5, windowSec: 3600 });

    const username = request.data?.username;
    if (!username || typeof username !== "string") throw new HttpsError("invalid-argument", "Username required.");

    // Validation rules
    const trimmed = username.trim();
    if (trimmed.length < 3) throw new HttpsError("invalid-argument", "Username must be at least 3 characters.");
    if (trimmed.length > 20) throw new HttpsError("invalid-argument", "Username must be 20 characters or less.");
    if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(trimmed)) throw new HttpsError("invalid-argument", "Username must start with a letter and contain only letters, numbers, and underscores.");
    if (/__/.test(trimmed)) throw new HttpsError("invalid-argument", "Username cannot contain consecutive underscores.");

    const normalized = trimmed.toLowerCase();

    // Impersonation check — two-tier brand + internal term match
    if (checkImpersonation(trimmed)) throw new HttpsError("invalid-argument", "Please choose a different username.");

    // Profanity check using shared system
    if (checkBannedWords(trimmed)) throw new HttpsError("invalid-argument", "This username is not available.");

    const uid = request.auth.uid;
    const usernameRef = db.collection("usernames").doc(normalized);
    const userRef = db.collection("users").doc(uid);

    // Atomically bootstraps a brand-new account (same defaults the retired
    // client-side saveUserProfile() used to establish via a separate,
    // non-atomic Promise.all) — called only from within the transaction
    // below, both on the normal first-claim path and to self-heal a
    // reservation left orphaned by an interruption before this callable
    // became responsible for atomic account creation.
    function bootstrapAccount(tx, forUid, forUsername) {
      tx.set(db.collection('users').doc(forUid), {
        id: forUid,
        username: forUsername,
        createdAt: Timestamp.now(),
        crowns: 0,
        title: 'Newcomer',
      });
      tx.set(db.collection('users').doc(forUid).collection('private').doc('social'), { blockedUsers: [] });
      tx.set(db.collection('users').doc(forUid).collection('private').doc('preferences'), { notificationRadius: 1 });
    }

    try {
      await db.runTransaction(async (tx) => {
        const existing = await tx.get(usernameRef);
        if (existing.exists) {
          if (existing.data().uid !== uid) {
            // Belongs to a different user — reject normally
            throw new HttpsError("already-exists", "Username is already taken.");
          }
          // Same UID: reservation already belongs to this user (orphaned from
          // an interrupted earlier claim). Idempotent — no cooldown, no old-
          // reservation release, since this isn't a rename. Self-heal a
          // missing account doc if the interruption happened before the
          // account itself was ever created.
          const userDoc = await tx.get(userRef);
          if (!userDoc.exists) bootstrapAccount(tx, uid, trimmed);
          return;
        }

        const userDoc = await tx.get(userRef);
        const userData = userDoc.exists ? userDoc.data() : {};

        // Enforce 30-day cooldown (skip for generated usernames starting with user_)
        if (userData.usernameChangedAt && userData.username && !userData.username.startsWith('user_')) {
          const lastChanged = userData.usernameChangedAt.toMillis();
          const daysSince = (Date.now() - lastChanged) / (1000 * 60 * 60 * 24);
          if (daysSince < 30) {
            throw new HttpsError("failed-precondition", `You can change your username again in ${Math.ceil(30 - daysSince)} days.`);
          }
        }

        // Release old username if user had one
        if (userData.username) {
          const oldNormalized = userData.username.toLowerCase();
          tx.delete(db.collection("usernames").doc(oldNormalized));
        }

        tx.set(usernameRef, { uid, claimedAt: Timestamp.now() });
        if (userDoc.exists) {
          tx.set(userRef, { username: trimmed, usernameChangedAt: Timestamp.now() }, { merge: true });
        } else {
          // First write for a brand-new account — atomically bootstrap the
          // full account shape in the same transaction as the reservation,
          // so there is no window where the registry and profile can
          // disagree, and no partial-creation risk if one write failed
          // independently of the others.
          bootstrapAccount(tx, uid, trimmed);
        }
      });
    } catch (e) {
      if (e.code) throw e;
      console.error("Username claim error:", sanitizeError(e));
      throw new HttpsError("internal", "Failed to claim username.");
    }

    return { success: true, username: trimmed };
  }
);

// Authoritative display-name mutation — closes the same class of bypass as
// claimUsername above, for users/{uid}.fullName: the client's
// moderateDisplayName() is UX-only, and the client wrote fullName directly
// to Firestore with no server-side re-check. Deliberately narrow (fullName
// only) rather than a generic profile-update endpoint — every other
// owner-editable field continues through direct Firestore writes under
// firestore.rules' unrelated-field allowlist, unaffected by this change.
//
// Runtime-IAM canary (continued): parqueen-user@... (roles/datastore.user
// only) — already production-validated by real sendMessage traffic.
// App Check is enforced from first release — a brand-new callable with no
// legacy caller to break; the production client already initializes App
// Check (see adminReadView/sendMessage's already-verified canaries).
const UPDATE_DISPLAY_NAME_MAX_LEN = 100;

async function updateDisplayNameHandler(request) {
  if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in first.');

  const { fullName } = request.data || {};
  if (typeof fullName !== 'string') {
    throw new HttpsError('invalid-argument', 'fullName is required.');
  }
  const trimmed = fullName.trim();
  if (trimmed.length === 0) {
    throw new HttpsError('invalid-argument', 'Display name cannot be empty.');
  }
  // Bound matches firestore.rules' pre-existing fullName.size() <= 100 —
  // preserving current policy, not introducing a new one.
  if (trimmed.length > UPDATE_DISPLAY_NAME_MAX_LEN) {
    throw new HttpsError('invalid-argument', 'Display name must be 100 characters or less.');
  }

  const uid = request.auth.uid;
  // 5/hour — display-name changes are a low-frequency operation; matches
  // claimUsername's existing rate for the same class of identity-field edit.
  await checkRateLimit(uid, 'updateDisplayName', { limit: 5, windowSec: 3600 });

  // Mirrors moderateDisplayName()'s exact current checks (impersonation +
  // banned words) — preserving existing display-name policy, not broadening it.
  if (checkImpersonation(trimmed)) {
    throw new HttpsError('invalid-argument', "That name can't be used. Please choose another.");
  }
  if (checkBannedWords(trimmed)) {
    throw new HttpsError('invalid-argument', "That name can't be used. Please choose another.");
  }

  try {
    await db.collection('users').doc(uid).update({ fullName: trimmed });
  } catch (e) {
    console.error('Display name update error:', sanitizeError(e));
    throw new HttpsError('internal', 'Failed to update display name.');
  }

  return { success: true, fullName: trimmed };
}

exports._updateDisplayNameHandler = updateDisplayNameHandler;

exports.updateDisplayName = onCall(
  {
    region: 'us-central1',
    enforceAppCheck: true,
    serviceAccount: 'parqueen-user@parkqueen-46475363-ccf36.iam.gserviceaccount.com',
  },
  updateDisplayNameHandler
);

// 10) Award crowns on successful parking handoff
// feedbackId (event.params.feedbackId) is the idempotency key, not event.id:
// Firestore rules derive it deterministically as `${spotId}_${userId}` and
// forbid update/delete on spotFeedback docs, so one feedbackId can only ever
// represent one real award — see functions/awardCrowns.integration.test.js.
//
// Missing-user terminal handling: spotFeedback is written directly by the
// client (Firestore rules validate the caller's own role against the spots/
// doc, not that the OTHER referenced user's account still exists), and
// deleteAccount deletes users/{uid} (step 2 of its pipeline) long before its
// spotFeedback cleanup steps run — so a driver or finder account can
// legitimately be gone by the time this fires, on the very first delivery
// attempt, not only on a delayed retry. Existing atomic all-or-nothing award
// semantics are preserved (neither party is credited if either is missing)
// but this is now a durably marked terminal outcome instead of a permanent
// tx.update()-on-missing-doc throw, so a redelivered event (retry: true)
// can't retry an unrecoverable failure for the full Eventarc window.
exports.awardCrowns = onDocumentCreated(
  {
    document: "spotFeedback/{feedbackId}",
    region: "us-central1",
    retry: true,
    serviceAccount: 'parqueen-system-events@parkqueen-46475363-ccf36.iam.gserviceaccount.com',
  },
  async (event) => {
    const data = event.data?.data();
    if (!data || data.outcome !== 'success') return;

    const driverId = data.userId;
    const finderId = data.finderId;
    if (!driverId || !finderId || driverId === finderId) return;

    const feedbackId = event.params.feedbackId;
    const driverRef = db.doc(`users/${driverId}`);
    const finderRef = db.doc(`users/${finderId}`);
    const processedRef = db.doc(`functionEvents/awardCrowns_${feedbackId}`);

    await db.runTransaction(async (tx) => {
      if ((await tx.get(processedRef)).exists) return; // already processed (awarded or terminally skipped) — idempotency guard

      const [driverSnap, finderSnap] = await Promise.all([tx.get(driverRef), tx.get(finderRef)]);

      if (!driverSnap.exists || !finderSnap.exists) {
        tx.set(processedRef, {
            functionName: 'awardCrowns',
            feedbackId,
            driverId,
            finderId,
            outcome: 'skipped_missing_user',
            processedAt: Timestamp.now(),
        });
        return;
      }

      const driverCrowns = (driverSnap.data().crowns || 0) + 1;
      const finderCrowns = (finderSnap.data().crowns || 0) + 2;

      tx.update(driverRef, {
          crowns: FieldValue.increment(1),
          title: getTitleForCrowns(driverCrowns),
      });
      tx.update(finderRef, {
          crowns: FieldValue.increment(2),
          title: getTitleForCrowns(finderCrowns),
      });
      tx.set(processedRef, {
          functionName: 'awardCrowns',
          feedbackId,
          driverId,
          finderId,
          outcome: 'awarded',
          processedAt: Timestamp.now(),
      });

      console.log(`Crowns awarded: driver ${driverId.slice(0,4)}*** +1 (${driverCrowns}), finder ${finderId.slice(0,4)}*** +2 (${finderCrowns})`);
    });
  }
);

// 13) Admin-safe spot deletion — routes through event pipeline to preserve trust integrity.
// All admin spot removals MUST use this function instead of direct Console/SDK deletes.
// Sets source: 'admin' before deletion so onDocumentDeleted skips trust penalties.
exports.adminDeleteSpot = onCall(
  { region: 'us-central1', serviceAccount: 'parqueen-admin-write@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (request) => {
    await requireCurrentAdmin(request);

    const { spotId, reason } = request.data || {};
    if (!spotId || typeof spotId !== 'string') {
      throw new HttpsError('invalid-argument', 'spotId is required.');
    }

    const spotRef = db.doc(`spots/${spotId}`);
    const spotSnap = await spotRef.get();
    if (!spotSnap.exists) {
      throw new HttpsError('not-found', 'Spot not found.');
    }

    const spotData = spotSnap.data();

    // Mark source before deletion so onDocumentDeleted skips trust penalties.
    await spotRef.update({ source: 'admin' });
    await spotRef.delete();

    const now = Timestamp.now();
    await db.collection('adminAuditLog').add({
      // Standard fields
      action: 'spot.delete',
      targetType: 'spot',
      targetId: spotId,
      targetUserId: spotData.finderId || null,
      adminId: request.auth.uid,
      reason: reason || null,
      metadata: { status: spotData.status || null },
      createdAt: now,
      // Legacy fields preserved for backward compat
      finderId: spotData.finderId || null,
      spotId,
      adminUid: request.auth.uid,
      performedAt: now,
    });

    return { success: true };
  }
);

// 14) One-time admin bootstrap — any @parqueen.app account can claim admin if none exists yet.
// Deliberately NOT gated by requireCurrentAdmin (functions/adminAuth.js): by
// design the caller is NOT yet an admin — that is the entire bootstrap
// contract. Its own singleton-transaction gate is the correct, distinct
// authorization model here, not a stale-token gap. It DOES use
// requireCurrentAuthenticatedUser (exists, not disabled, refresh tokens not
// revoked) — a session that is no longer current should not be able to
// perform this sensitive mutation just because it once held a valid token.
//
// Crash-boundary hardening (this pass — see functions/adminAuth.js history
// for the prior claimsAppliedAt/reconciledLegacyAdmin pass this builds on):
// that prior pass closed resurrection once a completion marker existed, but
// left one gap. If the Auth grant (setCustomUserClaims) itself succeeded
// and the process then crashed BEFORE claimsAppliedAt was written, a
// same-owner retry could not tell that apart from a genuine "the Auth grant
// never ran at all" partial failure — both present an IDENTICAL durable
// footprint (singleton owned by this uid, claimsAppliedAt absent, current
// role non-admin). If an administrator intentionally demoted the owner in
// between, that ambiguous retry would resurrect the demoted role. Nothing
// in adminAuditLog, bootstrappedAt, Auth metadata, or the refresh-token
// revocation timestamp distinguishes the two histories either — they were
// checked and none carry independent evidence of whether the Auth mutation
// ever ran.
//
// Fix: the singleton-claiming transaction below now reports whether THIS
// invocation is the one that transactionally created the singleton
// (createdFresh) versus found a pre-existing same-owner singleton left by
// an earlier invocation — the only reliable, durable, server-derived
// signal available (never trusted from client input; this Function accepts
// no request.data at all). setCustomUserClaims(role:'admin') is now only
// ever called on the invocation that just created the singleton — the one
// moment we can be certain no prior invocation could already have granted
// and lost that grant to a later demotion. A retry against a PRE-EXISTING
// singleton either: (a) finds the caller already admin — safe to finalize
// claimsAppliedAt with no Auth mutation (recovers exactly the
// grant-succeeded/marker-crashed crash, "State 2"); (b) finds
// bootstrapComplete already true (claimsAppliedAt or reconciledLegacyAdmin)
// — refuse, unchanged from the prior pass; or (c) finds the caller
// non-admin with no completion marker — genuinely ambiguous, and now fails
// closed with 'failed-precondition' instead of guessing.
//
// Tradeoff, taken deliberately: a crash that happens strictly BEFORE the
// Auth grant (singleton claimed, setCustomUserClaims never attempted) can
// no longer self-heal through a retry — it is durably indistinguishable
// from a demoted-owner replay, so automatic recovery is sacrificed in favor
// of never resurrecting privilege. Recovering that specific state requires
// manual/operator intervention outside this Function (e.g. a scoped one-off
// Admin SDK claims fix after confirming via review that no demotion
// occurred) — bootstrapAdmin itself must not guess. reconcileLegacyAdminSingleton
// is not repurposed for this: its one-time production purpose (an admin
// role granted out-of-band before this Function existed) is already
// complete, and widening it into a general ambiguous-bootstrap recovery
// path would reintroduce exactly the ambiguity being closed here.
//
// Serialization: bootstrapAdmin now participates in the same adminRoleLock/
// singleton protocol setStaffRole uses below (transactional acquisition,
// fenced release, 120s lease against this Function's own 60s Cloud
// Functions v2 timeout, renewed immediately before the one call site that
// can mutate Auth role state) so the two Functions can never race a
// conflicting Auth claims mutation against the same account. See
// setStaffRole's header comment for the full lease-duration proof — the
// reasoning is identical here. The lock provides in-repository
// serialization only; it does not make Firebase Auth itself transactional,
// and an out-of-band Admin SDK writer outside this repo remains outside
// this guarantee (same residual setStaffRole's own header already
// documents).
exports.bootstrapAdmin = onCall(
  { region: 'us-central1', serviceAccount: 'parqueen-admin-auth@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (request) => {
    await requireCurrentAuthenticatedUser(request);

    const email = request.auth.token.email || '';
    if (!email.endsWith('@parqueen.app')) {
      throw new HttpsError('permission-denied', 'Requires a @parqueen.app account.');
    }
    if (request.auth.token.email_verified !== true) {
      throw new HttpsError('permission-denied', 'Email address must be verified.');
    }

    const uid = request.auth.uid;
    const sentinelRef = db.doc('adminBootstrap/singleton');
    const lockRef = db.doc('adminRoleLock/singleton');
    // Server-generated, unique per invocation attempt — used only to fence
    // this invocation's ownership of adminRoleLock/singleton, the same way
    // setStaffRole's caller-supplied operationId does. Not a client input;
    // bootstrapAdmin accepts no operationId (or any other field) from
    // request.data.
    const lockOperationId = `bootstrap_${randomUUID()}`;

    // Identical acquisition protocol to setStaffRole's lock (same LEASE_MS,
    // same attempt/backoff schedule) — see that Function's header comment
    // for the full lease-duration proof.
    const LEASE_MS = 120000;
    const ACQUIRE_ATTEMPTS = 6;
    let acquired = false;
    for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS && !acquired; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(400 * attempt, 2000)));
      }
      acquired = await db.runTransaction(async (tx) => {
        const snap = await tx.get(lockRef);
        const now = Timestamp.now();
        if (snap.exists) {
          const data = snap.data();
          const expired = !data.leaseExpiresAt || data.leaseExpiresAt.toMillis() <= now.toMillis();
          const sameOwner = data.ownerOperationId === lockOperationId;
          if (!expired && !sameOwner) return false;
        }
        tx.set(lockRef, {
          ownerOperationId: lockOperationId,
          acquiredAt: now,
          leaseExpiresAt: Timestamp.fromMillis(now.toMillis() + LEASE_MS),
        });
        return true;
      });
    }
    if (!acquired) {
      throw new HttpsError('aborted', 'Another role operation is in progress; please retry.');
    }

    // Re-verify ownership and renew to a fresh full lease immediately before
    // the one call site below that can mutate Auth role state — identical
    // rationale to setStaffRole's own renewLockOrThrow.
    async function renewLockOrThrow() {
      const stillOwned = await db.runTransaction(async (tx) => {
        const snap = await tx.get(lockRef);
        if (!snap.exists || snap.data().ownerOperationId !== lockOperationId) return false;
        const now = Timestamp.now();
        tx.set(lockRef, {
          ownerOperationId: lockOperationId,
          acquiredAt: snap.data().acquiredAt,
          leaseExpiresAt: Timestamp.fromMillis(now.toMillis() + LEASE_MS),
        });
        return true;
      });
      if (!stillOwned) {
        throw new HttpsError('aborted', 'Lock ownership lost before Auth mutation; retry.');
      }
    }

    try {
      // Atomic singleton check — transaction prevents two concurrent calls
      // both passing, and reports (server-derived, not client-trusted)
      // whether THIS invocation is the one that just created the singleton
      // versus found a pre-existing same-owner singleton from an earlier
      // invocation. That boolean is the sole basis for whether a grant may
      // occur below — see header comment.
      let createdFresh;
      try {
        createdFresh = await db.runTransaction(async (tx) => {
          const sentinel = await tx.get(sentinelRef);
          if (sentinel.exists) {
            if (sentinel.data().bootstrappedBy === uid) return false;
            throw new HttpsError('already-exists', 'Admin access has already been bootstrapped.');
          }
          tx.set(sentinelRef, { bootstrappedAt: Timestamp.now(), bootstrappedBy: uid });
          return true;
        });
      } catch (err) {
        if (err.code === 'already-exists') throw err;
        throw new HttpsError('internal', 'Bootstrap failed; retry.');
      }

      // Merge rather than replace: setCustomUserClaims overwrites the entire
      // claims object, so a blind { role: 'admin' } would silently drop any
      // other claim the account happened to carry. role is the only claim
      // this codebase ever sets today, but that's not a guarantee for the
      // future — read current claims and only touch the role key.
      const currentUser = await getAuth().getUser(uid);
      const alreadyAdmin = currentUser.customClaims?.role === 'admin';

      if (!alreadyAdmin) {
        if (createdFresh) {
          // The only invocation in this singleton's history that can ever
          // reach this branch: no prior invocation could have already
          // granted and lost the grant to a later demotion, because this
          // invocation is the one that just transactionally created the
          // singleton. The sole legitimate first-bootstrap grant path.
          await renewLockOrThrow();
          await getAuth().setCustomUserClaims(uid, { ...(currentUser.customClaims || {}), role: 'admin' });
        } else {
          // Pre-existing singleton, caller currently non-admin. Cannot
          // distinguish "the Auth grant never ran" from "the Auth grant
          // succeeded once and was later intentionally reversed" — both
          // present identically here (see header). Refuse outright if a
          // completion marker already exists (unchanged from the prior
          // pass); otherwise this is genuinely ambiguous and must fail
          // closed rather than guess.
          const sentinelSnap = await sentinelRef.get();
          const sentinelData = sentinelSnap.data() || {};
          const bootstrapComplete = sentinelData.claimsAppliedAt != null || sentinelData.reconciledLegacyAdmin === true;
          if (bootstrapComplete) {
            console.warn('[bootstrapAdmin] rejected: resurrection_attempt');
            throw new HttpsError('already-exists', 'Admin access has already been bootstrapped.');
          }
          console.warn('[bootstrapAdmin] rejected: ambiguous_retry');
          throw new HttpsError(
            'failed-precondition',
            'Bootstrap could not be completed automatically; administrative review required.'
          );
        }
      }
      // Reached only when this invocation just granted admin (createdFresh)
      // or the caller was already admin (fresh-singleton idempotent no-op,
      // or a pre-existing-singleton retry recovering a grant-succeeded/
      // marker-crashed crash — State 2). The ambiguous and already-refused
      // branches above both throw before reaching here, so no audit or
      // completion marker is ever written for them (see Phase 7 policy).

      // Mark bootstrap fully completed for this singleton — from this point
      // on, a caller whose current role isn't 'admin' can never have the
      // claim (re-)applied through this function again, even if this uid is
      // later demoted. Written whenever we reach here (not only when
      // setCustomUserClaims above was actually needed) so a no-op call by
      // an already-correct admin still closes the gap for next time.
      await sentinelRef.set({ claimsAppliedAt: Timestamp.now() }, { merge: true });
      // Idempotent by construction, so safe to (re)run on every retry that
      // reaches here: the deterministic audit-log id means a retry updates
      // the same record rather than creating a duplicate.
      await db.doc(`adminAuditLog/bootstrap_${uid}`).set({
        action: 'bootstrapAdmin',
        adminUid: uid,
        email,
        performedAt: Timestamp.now(),
      }, { merge: true });

      return { success: true };
    } finally {
      // Fencing: only release if this invocation still owns the lock — a
      // stale/crashed invocation whose lease already expired and was stolen
      // by a newer operation must never release that newer operation's
      // lock. Identical to setStaffRole's release.
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(lockRef);
        if (!snap.exists) return;
        if (snap.data().ownerOperationId !== lockOperationId) return;
        tx.delete(lockRef);
      }).catch(() => {});
    }
  }
);

// 14b) Legacy-admin singleton reconciliation — for an admin role granted out-of-band
// before bootstrapAdmin/adminBootstrap existed, so adminBootstrap/singleton was never
// created. NOT a way to grant admin: gated on the caller ALREADY holding role ===
// 'admin' in their token, which an ordinary account can never satisfy — this is
// unreachable by anyone bootstrapAdmin itself would still be open to. Refuses unless
// Auth-wide admin-claim state is unambiguous (exactly one admin, matching the caller);
// a full listUsers scan is safe here specifically because this path is admin-gated and
// not part of any hot/public request flow — do not copy this pattern into a callable
// reachable by ordinary users. Never touches custom claims; the claim is already correct.
//
// Now migrated to requireCurrentAdmin (see functions/adminAuth.js): the
// exhaustive listUsers scan a few lines below already independently
// re-derives current Auth-wide admin role state whenever it actually runs
// (unambiguous — exactly one admin, matching the caller) — but that scan
// only executes on a FIRST-time reconciliation (`if (!existing.exists)`).
// The retry branch (singleton already claimed by this uid) skips the scan
// entirely and falls straight through to an idempotent audit-log write —
// it never re-derives or re-validates the caller's current role at all in
// that path. This function never touches custom claims in any branch, so
// it was never vulnerable to the privilege-resurrection issue fixed in
// bootstrapAdmin above — but a demoted/deleted/disabled/revoked caller's
// stale token could still reach the harmless-but-unauthorized retry branch
// before this change. requireCurrentAdmin closes that gap uniformly; the
// exhaustive scan below remains as additional, not substitute, defense in
// depth for the first-time path.
exports.reconcileLegacyAdminSingleton = onCall(
  { region: 'us-central1', serviceAccount: 'parqueen-admin-auth@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (request) => {
    await requireCurrentAdmin(request);

    const uid = request.auth.uid;
    const sentinelRef = db.doc('adminBootstrap/singleton');

    const existing = await sentinelRef.get();
    if (existing.exists && existing.data().bootstrappedBy !== uid) {
      throw new HttpsError('already-exists', 'Admin access has already been bootstrapped.');
    }

    // Skip the scan+transaction entirely when the singleton is already ours — not
    // just an optimization: it also means a retry that only needs to recover a
    // missing audit record (see below) never re-derives ambiguity from scratch.
    if (!existing.exists) {
      // Policy: disabled accounts are excluded from the admin-role count. A disabled
      // account cannot obtain a valid ID token, so it cannot currently exercise admin
      // privileges or contend for ownership — counting it would only make legitimate
      // reconciliation fail closed forever on a stale, unusable claim, without adding
      // any real security value (a disabled account can't claim the singleton either).
      let adminUids = [];
      let pageToken;
      do {
        const page = await getAuth().listUsers(1000, pageToken);
        for (const u of page.users) {
          if (!u.disabled && u.customClaims?.role === 'admin') adminUids.push(u.uid);
        }
        pageToken = page.pageToken;
      } while (pageToken);

      if (adminUids.length !== 1 || adminUids[0] !== uid) {
        throw new HttpsError(
          'failed-precondition',
          'Cannot reconcile: admin-role state is not unambiguous.'
        );
      }

      try {
        await db.runTransaction(async (tx) => {
          const sentinel = await tx.get(sentinelRef);
          if (sentinel.exists) {
            if (sentinel.data().bootstrappedBy === uid) return;
            throw new HttpsError('already-exists', 'Admin access has already been bootstrapped.');
          }
          tx.set(sentinelRef, {
            bootstrappedAt: Timestamp.now(),
            bootstrappedBy: uid,
            reconciledLegacyAdmin: true,
          });
        });
      } catch (err) {
        if (err.code === 'already-exists') throw err;
        throw new HttpsError('internal', 'Reconciliation failed; retry.');
      }
    }

    // Idempotent by construction, so safe to (re)run on every retry that reaches
    // here — including recovery from a prior attempt that won the singleton but
    // crashed before this write: the deterministic audit-log id means a retry
    // updates the same record rather than creating a duplicate, or leaving one
    // permanently missing. Deterministic id distinct from bootstrap_${uid} — this
    // was never a bootstrap event, and must never be described as one.
    await db.doc(`adminAuditLog/legacyReconciliation_${uid}`).set({
      action: 'legacy_admin_bootstrap_reconciliation',
      adminUid: uid,
      performedAt: Timestamp.now(),
    }, { merge: true });

    return { success: true };
  }
);

// 15) Admin-only role management — grant, change, or revoke staff/admin roles.
//
// Every call is serialized through a single Firestore-owned lock
// (adminRoleLock/singleton) and journaled per client-supplied operationId
// (adminRoleOperations/{operationId}) — not just admin-removal transitions.
// This Function is backend-only and low-volume; correctness matters far more
// than throughput, so one uniform serialized path was chosen over
// special-casing only the dangerous transitions.
//
// Why serialization is required: the last-admin check is a read-then-decide
// guard. Two concurrent removal attempts (e.g. two admins demoting each
// other) can each independently observe "another admin exists" before
// either commits, both pass, and together leave zero admins — a
// sequential-only guard cannot prevent that TOCTOU race. Holding one lock
// across the entire critical section (fresh admin count through the Auth
// mutation) closes the window: whichever of two racing operations is
// serialized second always re-evaluates the count against the first
// operation's already-committed result, so it is a mathematical invariant
// that the count can never be driven below one through this Function alone
// — the operation that would take it to zero is always the one rejected.
//
// operationId is caller-supplied but never trusted for authorization or for
// who/what/target — those are always derived from request.auth and the
// validated uid/role. It exists purely so a retried call (lost response,
// crash-and-resume) can be recognized as the SAME logical operation rather
// than risk a duplicate mutation or a duplicate audit record. Reusing an
// operationId with different actor/target/role fails closed.
//
// Firebase Auth has no compare-and-swap for custom claims. Serializing every
// setStaffRole call means two setStaffRole invocations can no longer race
// each other's read-modify-write claims cycle. It provides NO protection
// against a claims write from outside this Function (a different Function,
// a manual Admin SDK script) racing concurrently — that residual is
// accepted and documented, not solved, since no other in-repo code path
// writes the role claim.
exports.setStaffRole = onCall(
  { region: 'us-central1', serviceAccount: 'parqueen-admin-auth@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (request) => {
    await requireCurrentAdmin(request);

    const { uid, role, operationId } = request.data || {};
    if (!uid || typeof uid !== 'string') throw new HttpsError('invalid-argument', 'uid required.');
    if (role !== null && role !== 'admin' && role !== 'staff') {
      throw new HttpsError('invalid-argument', "role must be 'admin', 'staff', or null.");
    }
    if (typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(operationId)) {
      throw new HttpsError('invalid-argument', 'operationId required (8-128 chars, [A-Za-z0-9_-]).');
    }

    const actorUid = request.auth.uid;
    const lockRef = db.doc('adminRoleLock/singleton');
    const opRef = db.doc(`adminRoleOperations/${operationId}`);

    // Lease duration: this Function's own timeout is 60s (Cloud Functions v2
    // default, unchanged). A lease shorter than that would not structurally
    // guarantee serialization — a still-live invocation could reach the Auth
    // mutation after its own lease was stolen out from under it, since there
    // is no fencing token Firebase Auth itself can check. 120s (2x the
    // Function timeout) is chosen so that ANY lease acquired or renewed at
    // ANY point during this invocation's lifetime necessarily outlives the
    // latest possible moment Cloud Functions could forcibly kill it: if
    // acquisition/renewal happens at time R and the invocation started at
    // T0, then R <= T0+60s and the hard kill happens by T0+60s at the very
    // latest — so leaseExpiresAt = R+120s is always > T0+60s >= kill time.
    // The tradeoff is that a genuinely crashed invocation can block role
    // management for up to 120s before a new operation can steal the lock —
    // acceptable for this low-volume, backend-only administrative Function,
    // where correctness (never letting two invocations both reach the Auth
    // mutation) matters far more than that bounded recovery latency.
    const LEASE_MS = 120000;
    const ACQUIRE_ATTEMPTS = 6;
    let acquired = false;
    for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS && !acquired; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(400 * attempt, 2000)));
      }
      acquired = await db.runTransaction(async (tx) => {
        const snap = await tx.get(lockRef);
        const now = Timestamp.now();
        if (snap.exists) {
          const data = snap.data();
          const expired = !data.leaseExpiresAt || data.leaseExpiresAt.toMillis() <= now.toMillis();
          const sameOwner = data.ownerOperationId === operationId;
          if (!expired && !sameOwner) return false;
        }
        tx.set(lockRef, {
          ownerOperationId: operationId,
          acquiredAt: now,
          leaseExpiresAt: Timestamp.fromMillis(now.toMillis() + LEASE_MS),
        });
        return true;
      });
    }
    if (!acquired) {
      throw new HttpsError('aborted', 'Another role operation is in progress; please retry.');
    }

    // Transactionally re-verify ownership and renew the lease to a fresh
    // full LEASE_MS immediately before any irreversible Auth mutation —
    // belt-and-suspenders on top of the acquisition-time margin above, so
    // the invariant is self-verifying at the point of use rather than
    // resting solely on a proof that holds at a distance. If ownership was
    // somehow already lost (should be unreachable given the margin, but
    // never assume), fail closed rather than proceed to mutate Auth.
    async function renewLockOrThrow() {
      const stillOwned = await db.runTransaction(async (tx) => {
        const snap = await tx.get(lockRef);
        if (!snap.exists || snap.data().ownerOperationId !== operationId) return false;
        const now = Timestamp.now();
        tx.set(lockRef, {
          ownerOperationId: operationId,
          acquiredAt: snap.data().acquiredAt,
          leaseExpiresAt: Timestamp.fromMillis(now.toMillis() + LEASE_MS),
        });
        return true;
      });
      if (!stillOwned) {
        throw new HttpsError('aborted', 'Lock ownership lost before Auth mutation; retry.');
      }
    }

    try {
      // Bind (or resume) the operation journal. actor/target/requestedRole
      // and originalPreviousRole are immutable once the journal is created —
      // written exactly once, before the first Auth mutation, and never
      // recomputed on resume. This matters specifically for audit
      // truthfulness: if a retry re-derived "previous role" from Auth's
      // CURRENT state, a resume after "Auth succeeded, audit failed" would
      // see the NEW role already applied and could misrecord e.g. an
      // admin->staff transition as a false staff->staff no-op. A resume may
      // still re-read CURRENT Auth state freely for merge-safety and
      // recovery decisions — only the audited originalPreviousRole is frozen.
      let opSnap = await opRef.get();
      if (!opSnap.exists) {
        let targetUser;
        try {
          targetUser = await getAuth().getUser(uid);
        } catch (err) {
          if (err.code === 'auth/user-not-found') throw new HttpsError('not-found', 'Target user not found.');
          throw new HttpsError('internal', 'Could not load target user; retry.');
        }
        await opRef.set({
          operationId,
          actorUid,
          targetUid: uid,
          requestedRole: role,
          originalPreviousRole: targetUser.customClaims?.role || null,
          status: 'pending',
          createdAt: Timestamp.now(),
        });
        opSnap = await opRef.get();
      }

      const op = opSnap.data();
      if (op.actorUid !== actorUid || op.targetUid !== uid || op.requestedRole !== role) {
        throw new HttpsError('failed-precondition', 'operationId already used for a different request.');
      }

      if (op.status === 'completed') {
        return op.result;
      }

      const removingAdmin = op.originalPreviousRole === 'admin' && op.requestedRole !== 'admin';

      if (removingAdmin) {
        // Re-run fresh on every attempt, including resumes after a crash —
        // cheap relative to the lock's own cost, and correct even across a
        // crash-and-resume cycle rather than trusting a possibly-stale
        // earlier result. Disabled accounts are excluded (mirrors
        // reconcileLegacyAdminSingleton's policy: a disabled account can't
        // authenticate, so it can't act as admin). The target itself is
        // excluded — this correctly covers an admin demoting themselves.
        let otherActiveAdmins = 0;
        let pageToken;
        do {
          const page = await getAuth().listUsers(1000, pageToken);
          for (const u of page.users) {
            if (u.uid !== uid && !u.disabled && u.customClaims?.role === 'admin') otherActiveAdmins++;
          }
          pageToken = page.pageToken;
        } while (pageToken);

        if (otherActiveAdmins === 0) {
          throw new HttpsError('failed-precondition', 'Cannot remove the last active administrator.');
        }
      }

      // Merge rather than replace: setCustomUserClaims overwrites the entire
      // claims object, so a blind { role: ... } would silently drop any other
      // claim the account happened to carry. Only the role key is ever
      // touched, and unrelated claims are re-read fresh (not cached from
      // journal creation) so a resume reflects the current reality.
      if (op.originalPreviousRole !== op.requestedRole) {
        let currentTarget;
        try {
          currentTarget = await getAuth().getUser(uid);
        } catch (err) {
          if (err.code === 'auth/user-not-found') throw new HttpsError('not-found', 'Target user not found.');
          throw new HttpsError('internal', 'Could not load target user; retry.');
        }
        const { role: _oldRole, ...unrelatedClaims } = currentTarget.customClaims || {};
        const nextClaims = op.requestedRole ? { ...unrelatedClaims, role: op.requestedRole } : unrelatedClaims;
        await renewLockOrThrow();
        try {
          await getAuth().setCustomUserClaims(uid, nextClaims);
        } catch (err) {
          if (err.code === 'auth/user-not-found') throw new HttpsError('not-found', 'Target user not found.');
          throw new HttpsError('internal', 'Role update failed; retry.');
        }
        if (removingAdmin) {
          // Best-effort: bounds exposure to the current ID token's remaining
          // lifetime rather than persisting indefinitely via silent refresh.
          // Does NOT invalidate an already-issued, unexpired ID token in
          // flight — this callable's default auth verification does not
          // check revocation — and a transient failure here must not turn an
          // otherwise-successful role change into a reported failure.
          await getAuth().revokeRefreshTokens(uid).catch(() => {});
        }
        await opRef.set({ authMutatedAt: Timestamp.now() }, { merge: true });
      }

      const result = { success: true, previousRole: op.originalPreviousRole, role: op.requestedRole };

      // Deterministic id keyed to operationId, not .add() — exactly one
      // logical successful mutation produces exactly one successful audit
      // record, even across a crash-and-resume retry.
      await db.doc(`adminAuditLog/roleOp_${operationId}`).set({
        // Standard fields
        action: 'user.set_role',
        targetType: 'user',
        targetId: uid,
        targetUserId: uid,
        adminId: actorUid,
        metadata: {
          previousRole: op.originalPreviousRole,
          role: op.requestedRole,
          noop: op.originalPreviousRole === op.requestedRole,
          operationId,
        },
        createdAt: Timestamp.now(),
        // Legacy fields preserved for backward compat
        targetUid: uid,
        adminUid: actorUid,
        performedAt: Timestamp.now(),
      }, { merge: true });
      // If the audit write above throws, the journal stays at status
      // 'pending' (never advances to 'completed' below) and the error
      // propagates to the caller — a retry with the same operationId safely
      // resumes: the Auth mutation re-applies idempotently and the audit
      // write is retried, still landing on the same deterministic doc id.

      await opRef.set({ status: 'completed', result, completedAt: Timestamp.now() }, { merge: true });

      return result;
    } finally {
      // Fencing: only release if this operation still owns the lock — a
      // stale/crashed invocation whose lease already expired and was stolen
      // by a newer operation must never release that newer operation's lock.
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(lockRef);
        if (!snap.exists) return;
        if (snap.data().ownerOperationId !== operationId) return;
        tx.delete(lockRef);
      }).catch(() => {});
    }
  }
);

// 16) Admin suspend user — writes user doc + standardized audit log entry
exports.adminSuspendUser = onCall(
  { region: 'us-central1', serviceAccount: 'parqueen-admin-write@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (request) => {
    await requireCurrentAdmin(request);
    const { userId, reason } = request.data || {};
    if (!userId || typeof userId !== 'string') throw new HttpsError('invalid-argument', 'userId required.');
    if (!reason || typeof reason !== 'string' || !reason.trim()) throw new HttpsError('invalid-argument', 'reason required.');

    const now = Timestamp.now();
    await db.doc(`users/${userId}`).update({
      status: 'Suspended',
      suspendedAt: now,
      suspendedBy: request.auth.uid,
      suspensionReason: reason.trim(),
      unsuspendedAt: null,
      unsuspendedBy: null,
      updatedAt: now,
    });

    await db.collection('adminAuditLog').add({
      action: 'user.suspend',
      targetType: 'user',
      targetId: userId,
      targetUserId: userId,
      adminId: request.auth.uid,
      reason: reason.trim(),
      createdAt: now,
    });

    return { success: true };
  }
);

// 17) Admin unsuspend user — clears suspension + standardized audit log entry
exports.adminUnsuspendUser = onCall(
  { region: 'us-central1', serviceAccount: 'parqueen-admin-write@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (request) => {
    await requireCurrentAdmin(request);
    const { userId } = request.data || {};
    if (!userId || typeof userId !== 'string') throw new HttpsError('invalid-argument', 'userId required.');

    const now = Timestamp.now();
    await db.doc(`users/${userId}`).update({
      status: 'Active',
      unsuspendedAt: now,
      unsuspendedBy: request.auth.uid,
      suspendedAt: null,
      suspendedBy: null,
      suspensionReason: null,
      updatedAt: now,
    });

    await db.collection('adminAuditLog').add({
      action: 'user.unsuspend',
      targetType: 'user',
      targetId: userId,
      targetUserId: userId,
      adminId: request.auth.uid,
      createdAt: now,
    });

    return { success: true };
  }
);

// 18) Admin update report status — review / dismiss / reopen with audit trail
exports.adminUpdateReport = onCall(
  { region: 'us-central1', serviceAccount: 'parqueen-admin-write@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (request) => {
    await requireCurrentAdmin(request);
    const { reportId, status, adminNote } = request.data || {};
    if (!reportId || typeof reportId !== 'string') throw new HttpsError('invalid-argument', 'reportId required.');
    const allowed = ['reviewed', 'dismissed', 'pending'];
    if (!allowed.includes(status)) throw new HttpsError('invalid-argument', `status must be one of: ${allowed.join(', ')}.`);

    const reportRef = db.doc(`reports/${reportId}`);
    const reportSnap = await reportRef.get();
    if (!reportSnap.exists) throw new HttpsError('not-found', 'Report not found.');
    const reportData = reportSnap.data();

    const now = Timestamp.now();
    let update;
    let action;

    if (status === 'pending') {
      update = { status: 'pending', reviewedAt: null, reviewedBy: null, adminNote: null };
      action = 'report.reopened';
    } else {
      update = {
        status,
        reviewedAt: now,
        reviewedBy: request.auth.uid,
        adminNote: (adminNote && adminNote.trim()) || null,
      };
      action = status === 'reviewed' ? 'report.reviewed' : 'report.dismissed';
    }

    await reportRef.update(update);

    await db.collection('adminAuditLog').add({
      action,
      targetType: 'report',
      targetId: reportId,
      targetUserId: reportData.reportedUserId || null,
      adminId: request.auth.uid,
      reason: (adminNote && adminNote.trim()) || null,
      metadata: {
        reporterId: reportData.reporterId || null,
        reportedUserId: reportData.reportedUserId || null,
        previousStatus: reportData.status || null,
        conversationId: reportData.conversationId || null,
        type: reportData.type || null,
      },
      createdAt: now,
    });

    return { success: true, action };
  }
);

// 19) Admin update segment status — archive / needs_review / restore active with audit trail
exports.adminUpdateSegmentStatus = onCall(
  { region: 'us-central1', serviceAccount: 'parqueen-admin-write@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (request) => {
    await requireCurrentAdmin(request);
    const { segmentId, status, reason } = request.data || {};
    if (!segmentId || typeof segmentId !== 'string') throw new HttpsError('invalid-argument', 'segmentId required.');
    const allowed = ['active', 'needs_review', 'archived'];
    if (!allowed.includes(status)) throw new HttpsError('invalid-argument', `status must be one of: ${allowed.join(', ')}.`);

    const segRef = db.doc(`streetSegments/${segmentId}`);
    const segSnap = await segRef.get();
    if (!segSnap.exists) throw new HttpsError('not-found', 'Segment not found.');
    const segData = segSnap.data();

    const now = Timestamp.now();
    let update;
    let action;

    if (status === 'archived') {
      update = {
        status: 'archived',
        archivedAt: now,
        archivedBy: request.auth.uid,
        archiveReason: (reason && reason.trim()) || 'admin',
        updatedAt: now,
      };
      action = 'segment.archive';
    } else if (status === 'needs_review') {
      update = { status: 'needs_review', updatedAt: now };
      action = 'segment.needs_review';
    } else {
      update = { status: 'active', updatedAt: now };
      action = 'segment.restore_active';
    }

    await segRef.update(update);

    await db.collection('adminAuditLog').add({
      action,
      targetType: 'segment',
      targetId: segmentId,
      adminId: request.auth.uid,
      reason: (reason && reason.trim()) || null,
      metadata: {
        previousStatus: segData.status || null,
        streetName: segData.streetName || null,
        borough: segData.borough || null,
        source: segData.source || null,
        cslSegmentId: segData.cslSegmentId || null,
      },
      createdAt: now,
    });

    return { success: true, action };
  }
);

// 20) Admin archive suspension — soft-delete with audit trail
exports.adminArchiveSuspension = onCall(
  { region: 'us-central1', serviceAccount: 'parqueen-admin-write@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (request) => {
    await requireCurrentAdmin(request);
    const { suspensionId, reason } = request.data || {};
    if (!suspensionId || typeof suspensionId !== 'string') throw new HttpsError('invalid-argument', 'suspensionId required.');

    const suspRef = db.doc(`suspensions/${suspensionId}`);
    const suspSnap = await suspRef.get();
    if (!suspSnap.exists) throw new HttpsError('not-found', 'Suspension not found.');
    const suspData = suspSnap.data();

    const now = Timestamp.now();
    await suspRef.update({
      status: 'archived',
      archivedAt: now,
      archivedBy: request.auth.uid,
      archiveReason: (reason && reason.trim()) || 'Archived from admin dashboard',
      updatedAt: now,
    });

    await db.collection('adminAuditLog').add({
      action: 'suspension.archive',
      targetType: 'suspension',
      targetId: suspensionId,
      adminId: request.auth.uid,
      reason: (reason && reason.trim()) || null,
      metadata: {
        date: suspData.date || null,
        label: suspData.label || null,
        cityId: suspData.cityId || null,
        source: suspData.source || null,
      },
      createdAt: now,
    });

    return { success: true };
  }
);

// Delete account — idempotent; covers all user-linked collections, Storage, and Auth.
// Job document at accountDeletionJobs/{uid} tracks state: running → failed | completed.
// A 'running' lease (< 10 min old) blocks concurrent callers. A stale lease or 'failed'
// state allows retry. Completed steps are skipped on retry. Auth is deleted last.
exports.deleteAccount = onCall({ region: 'us-central1', serviceAccount: 'parqueen-account@parkqueen-46475363-ccf36.iam.gserviceaccount.com' }, async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Must be signed in.');

    // Auth-freshness check BEFORE rate limit — a stale-session rejection must not
    // consume quota; the user should re-auth and retry without hitting the daily cap.
    const authTime = request.auth.token.auth_time; // epoch seconds
    if (!authTime || (Date.now() / 1000) - authTime > 600) {
        throw new HttpsError(
            'failed-precondition',
            'Recent sign-in required to delete your account.'
        );
    }

    await checkRateLimit(uid, 'deleteAccount', { limit: 3, windowSec: 86400 });

    const jobRef = db.doc(`accountDeletionJobs/${uid}`);
    const maskedUid = uid.slice(0, 4) + '***';

    // ── Atomic lock ───────────────────────────────────────────────────────────
    // Transaction prevents two concurrent callers from both entering the deletion body.
    // A fresh 'running' lease (< 10 min) is an active worker — reject the second caller.
    // A stale lease or 'failed' state → claim the job and resume.
    let alreadyDone = false;
    let doneSteps = {};

    await db.runTransaction(async (tx) => {
        const snap = await tx.get(jobRef);
        if (snap.exists) {
            const job = snap.data();
            if (job.state === 'completed') {
                alreadyDone = true;
                return;
            }
            if (job.state === 'running') {
                const leaseAge = (Date.now() / 1000) - job.leaseAt.seconds;
                if (leaseAge < 600) {
                    throw new HttpsError('already-exists', 'A deletion request is already in progress.');
                }
                // Stale lease — previous worker died; take over and resume
            }
            // 'failed' or stale 'running' — resume from where we left off
            doneSteps = job.steps || {};
            tx.update(jobRef, {
                state: 'running',
                leaseAt: Timestamp.now(),
                currentStep: null,
                lastError: null,
                attemptNumber: (job.attemptNumber || 0) + 1,
            });
        } else {
            tx.set(jobRef, {
                state: 'running',
                leaseAt: Timestamp.now(),
                startedAt: Timestamp.now(),
                currentStep: null,
                lastError: null,
                attemptNumber: 1,
                steps: {},
            });
        }
    });

    if (alreadyDone) return { alreadyCompleted: true };

    // ── Admin-lifecycle serialization ──────────────────────────────────────────
    // Shares adminRoleLock/singleton with setStaffRole so account deletion is
    // serialized against every admin-role mutation, not just deletions that
    // already looked admin-relevant when this call started. Without this, two
    // independently-safe-looking operations — e.g. an admin deleting themselves
    // while another admin is concurrently demoted via setStaffRole, or a
    // non-admin's deletion racing their own promotion — could each observe
    // "another admin exists" and together leave zero. Same TOCTOU class of race
    // setStaffRole's own lock exists to close.
    //
    // Held across the ENTIRE destructive lifecycle (the last-admin check through
    // every cleanup step through the final Auth deletion), not acquired once and
    // released early. A narrower "check once, release, recheck only right before
    // Auth deletion" design was considered and rejected: if that late recheck
    // ever failed, this account's Firestore/Storage data would already be
    // irreversibly gone while Auth (and the admin claim) survived — a worse
    // outcome than the bounded throughput cost of holding one lock across an
    // operation that is already rate-limited to 3/day and serialized per-user by
    // the accountDeletionJobs lease below.
    //
    // Lease math is identical to setStaffRole's: this Function's own timeout is
    // 60s (confirmed against the deployed config), so a 120s lease (2x margin)
    // guarantees any lease acquired or renewed at any point in this invocation's
    // life outlives the latest possible moment Cloud Functions could kill it.
    // Deterministic per-uid, not random: at most one deletion can legitimately
    // be in flight for a given uid at a time (already enforced by the
    // accountDeletionJobs lease above), so a crash-and-resume attempt for the
    // SAME uid naturally re-identifies as the same lock owner and can reclaim
    // an unexpired lease immediately rather than needing to wait it out.
    const deletionOperationId = `delete_${uid}`;
    const lockRef = db.doc('adminRoleLock/singleton');
    const LOCK_LEASE_MS = 120000;
    const LOCK_ACQUIRE_ATTEMPTS = 6;

    async function renewLockOrThrow() {
        const stillOwned = await db.runTransaction(async (tx) => {
            const snap = await tx.get(lockRef);
            if (!snap.exists || snap.data().ownerOperationId !== deletionOperationId) return false;
            const now = Timestamp.now();
            tx.set(lockRef, {
                ownerOperationId: deletionOperationId,
                acquiredAt: snap.data().acquiredAt,
                leaseExpiresAt: Timestamp.fromMillis(now.toMillis() + LOCK_LEASE_MS),
            });
            return true;
        });
        if (!stillOwned) {
            throw new HttpsError('aborted', 'Lock ownership lost before Auth deletion; retry.');
        }
    }

    let lockAcquired = false;
    for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS && !lockAcquired; attempt++) {
        if (attempt > 0) {
            await new Promise((resolve) => setTimeout(resolve, Math.min(400 * attempt, 2000)));
        }
        lockAcquired = await db.runTransaction(async (tx) => {
            const snap = await tx.get(lockRef);
            const now = Timestamp.now();
            if (snap.exists) {
                const data = snap.data();
                const expired = !data.leaseExpiresAt || data.leaseExpiresAt.toMillis() <= now.toMillis();
                const sameOwner = data.ownerOperationId === deletionOperationId;
                if (!expired && !sameOwner) return false;
            }
            tx.set(lockRef, {
                ownerOperationId: deletionOperationId,
                acquiredAt: now,
                leaseExpiresAt: Timestamp.fromMillis(now.toMillis() + LOCK_LEASE_MS),
            });
            return true;
        });
    }
    if (!lockAcquired) {
        throw new HttpsError('aborted', 'Another admin-role operation is in progress; please retry.');
    }

    try {
        // Fresh Auth read, inside the lock, before any destructive work at all.
        let targetUser;
        try {
            targetUser = await getAuth().getUser(uid);
        } catch (err) {
            if (err.code === 'auth/user-not-found') {
                // Already gone (e.g. a prior attempt's Auth deletion succeeded but
                // the job document was never marked completed) — nothing left to
                // protect or delete.
                return { success: true };
            }
            throw new HttpsError('internal', 'Could not load account; retry.');
        }

        if (targetUser.customClaims?.role === 'admin') {
            // Exhaustive paginated scan — same policy as setStaffRole and
            // reconcileLegacyAdminSingleton: disabled accounts excluded (can't
            // authenticate, can't act as admin), target excluded (checking
            // whether anyone ELSE remains). Runs BEFORE any destructive step
            // below — Firestore profile, username, Storage, and Auth all remain
            // completely untouched if this rejects.
            let otherActiveAdmins = 0;
            let pageToken;
            do {
                const page = await getAuth().listUsers(1000, pageToken);
                for (const u of page.users) {
                    if (u.uid !== uid && !u.disabled && u.customClaims?.role === 'admin') otherActiveAdmins++;
                }
                pageToken = page.pageToken;
            } while (pageToken);

            if (otherActiveAdmins === 0) {
                await jobRef.update({
                    state: 'failed',
                    currentStep: null,
                    lastError: 'adminSafetyCheck: cannot delete the last active administrator',
                }).catch(() => {});
                throw new HttpsError(
                    'failed-precondition',
                    'You are the last active administrator. Add or promote another administrator before deleting this account.'
                );
            }
        }

        // ── True cursor-based paginated delete ────────────────────────────────
        // Does NOT load the entire result set into memory. Uses startAfter cursor to
        // page through results in chunks of 499 (below the Firestore 500-write limit).
        async function paginatedDelete(baseQuery) {
            let cursor = null;
            while (true) {
                const q = cursor
                    ? baseQuery.startAfter(cursor).limit(499)
                    : baseQuery.limit(499);
                const snap = await q.get();
                if (snap.empty) break;
                const batch = db.batch();
                snap.docs.forEach(d => batch.delete(d.ref));
                await batch.commit();
                if (snap.size < 499) break;
                cursor = snap.docs[snap.docs.length - 1];
            }
        }

        // ── True cursor-based paginated update ────────────────────────────────
        async function paginatedUpdate(baseQuery, updateData) {
            let cursor = null;
            while (true) {
                const q = cursor
                    ? baseQuery.startAfter(cursor).limit(499)
                    : baseQuery.limit(499);
                const snap = await q.get();
                if (snap.empty) break;
                const batch = db.batch();
                snap.docs.forEach(d => batch.update(d.ref, updateData));
                await batch.commit();
                if (snap.size < 499) break;
                cursor = snap.docs[snap.docs.length - 1];
            }
        }

        // ── Required step executor ──────────────────────────────────────────────
        // All personal-data cleanup is required. If any step fails, Auth is NOT deleted
        // and the job state is set to 'failed' (retryable). Already-done steps are skipped
        // on retry. Error messages are sanitized before being written to the job document.
        async function step(name, fn) {
            if (doneSteps[name] === 'done') return; // idempotent resume after 'failed'

            try {
                // Refresh lease timestamp on each step so long-running jobs don't expire
                await jobRef.update({ currentStep: name, leaseAt: Timestamp.now() });
                await fn();
                await jobRef.update({ [`steps.${name}`]: 'done', currentStep: null });
                doneSteps[name] = 'done';
            } catch (err) {
                // Strip PII from error payloads before writing to Firestore
                const safe = (err.message || 'error')
                    .replace(/\S+@\S+\.\S+/g, '[email]')
                    .replace(/\+?[0-9]{10,}/g, '[phone]')
                    .substring(0, 200);
                await jobRef.update({
                    state: 'failed',
                    currentStep: null,
                    lastError: `${name}: ${safe}`,
                    [`steps.${name}`]: 'error',
                }).catch(() => {});
                console.error(`[deleteAccount] ${maskedUid} step=${name} failed`);
                throw new HttpsError(
                    'internal',
                    `Deletion paused at "${name}". Your data is safe — retry or contact support.`
                );
            }
        }

        // ── Cleanup steps — all required; Auth is not deleted until all pass ────

        // Location cache — top-level collection, not covered by userDoc recursiveDelete
        await step('userLocations', () => db.doc(`userLocations/${uid}`).delete());

        // User document tree — recursiveDelete covers private/* and processedTrustEvents/*
        await step('userDoc', () => db.recursiveDelete(db.doc(`users/${uid}`)));

        // Username reservation record
        await step('usernames', () =>
            paginatedDelete(db.collection('usernames').where('uid', '==', uid))
        );

        // Path-keyed singleton documents — absence is success (idempotent delete)
        await step('parkingSessions',
            () => db.doc(`parkingSessions/${uid}`).delete());
        await step('avatarModeration',
            () => db.doc(`avatarModeration/${uid}`).delete());
        await step('emailVerificationCodes',
            () => db.doc(`emailVerificationCodes/${uid}`).delete());

        // spotFeedback submitted by user as driver
        await step('spotFeedbackAsDriver', () =>
            paginatedDelete(db.collection('spotFeedback').where('userId', '==', uid))
        );

        // spotFeedback where user was the finder — anonymize, retain for other party
        await step('spotFeedbackAsFinder', () =>
            paginatedUpdate(
                db.collection('spotFeedback').where('finderId', '==', uid),
                { finderId: FieldValue.delete(), address: '[removed]' }
            )
        );

        // Spot notifications in user's inbox
        await step('spotNotifications', () =>
            paginatedDelete(db.collection('spotNotifications').where('targetUserId', '==', uid))
        );

        // Spots posted as finder
        await step('spotsAsFinder', () =>
            paginatedDelete(db.collection('spots').where('finderId', '==', uid))
        );

        // Active Pings being claimed — release back to available
        await step('spotsAsClaimer', () =>
            paginatedUpdate(
                db.collection('spots').where('interestedUserId', '==', uid),
                {
                    interestedUserId: FieldValue.delete(),
                    interestedUserName: FieldValue.delete(),
                    interestedUserVehicleColor: FieldValue.delete(),
                    interestedUserVehicleType: FieldValue.delete(),
                    interestedUserVehicleBrand: FieldValue.delete(),
                    interestedUserTitle: FieldValue.delete(),
                    status: 'available',
                }
            )
        );

        // Chats — paginated to avoid loading all IDs into memory. Uses the
        // same markChatDeletingAndRecursiveDelete helper deleteChat uses —
        // this account's uid is already known to be a participant of every
        // chat enumerated here (that's exactly what the query above just
        // verified), so no further authorization check is needed before
        // calling it. Without the shared helper's deleting-marker step, a
        // concurrent sendMessage from the OTHER (still-active) participant
        // could race this recursive deletion and be silently orphaned.
        await step('chats', async () => {
            let cursor = null;
            while (true) {
                const baseQ = db.collection('chats').where('participants', 'array-contains', uid);
                const q = cursor ? baseQ.startAfter(cursor).limit(50) : baseQ.limit(50);
                const snap = await q.get();
                if (snap.empty) break;
                for (const chatDoc of snap.docs) {
                    await markChatDeletingAndRecursiveDelete(chatDoc.ref);
                }
                if (snap.size < 50) break;
                cursor = snap.docs[snap.docs.length - 1];
            }
        });

        // Reports filed by user — anonymize reporter; retain doc for compliance
        await step('reports', () =>
            paginatedUpdate(
                db.collection('reports').where('reporterId', '==', uid),
                { reporterId: '[deleted]', reporterDeletedAt: Timestamp.now() }
            )
        );

        // Moderation log — anonymize content; retain for safety review
        // LEGAL: retention period requires legal sign-off before converting to deletion
        await step('moderationLog', () =>
            paginatedUpdate(
                db.collection('moderationLog').where('userId', '==', uid),
                { userId: '[deleted]', text: '[removed]' }
            )
        );

        // Storage — clean up all three path families; absence is success (idempotent).
        await step('storageUploads',   () => getStorage().bucket().deleteFiles({ prefix: `avatarUploads/${uid}/`   }).catch(() => {}));
        await step('storageCandidates',() => getStorage().bucket().deleteFiles({ prefix: `avatarCandidates/${uid}/` }).catch(() => {}));
        await step('storagePublished', () => getStorage().bucket().deleteFiles({ prefix: `avatars/${uid}`           }).catch(() => {}));

        // ── Auth deletion — only reached after every required step passes ───────
        // Revalidate lock ownership immediately before the one irreversible step,
        // mirroring setStaffRole's own pre-mutation renewal — belt-and-suspenders
        // on top of the acquisition-time 120s margin, self-verifying at the point
        // of use. Nothing in the admin population could actually have changed
        // since the check above (this lock has been held continuously since
        // before that check), so this is ownership/lease verification only, not
        // a second full re-scan.
        await renewLockOrThrow();

        // Best-effort: bounds exposure to the current ID token's remaining
        // lifetime rather than persisting indefinitely via silent refresh, for
        // the brief window before deleteUser() itself removes the account
        // entirely. Does NOT invalidate an already-issued, unexpired ID token in
        // flight; a transient failure here must not block the deletion itself.
        await getAuth().revokeRefreshTokens(uid).catch(() => {});

        try {
            await getAuth().deleteUser(uid);
            await jobRef.update({
                state: 'completed',
                completedAt: Timestamp.now(),
                currentStep: null,
                'steps.authUser': 'done',
            });
        } catch (err) {
            if (err.code === 'auth/user-not-found') {
                // Auth was already deleted on a previous attempt — mark complete
                await jobRef.update({
                    state: 'completed',
                    completedAt: Timestamp.now(),
                    currentStep: null,
                    'steps.authUser': 'done',
                });
                return { success: true };
            }
            await jobRef.update({
                state: 'failed',
                lastError: 'authUser: deletion failed (check function logs)',
                'steps.authUser': 'error',
            }).catch(() => {});
            console.error(`[deleteAccount] ${maskedUid} authUser deletion failed`);
            throw new HttpsError('internal', 'Data deleted; Auth cleanup failed. Contact support to complete removal.');
        }

        return { success: true };
    } finally {
        // Fencing: only release if this operation still owns the lock — a
        // stale/crashed invocation whose lease already expired and was stolen
        // by a newer operation must never release that newer operation's lock.
        await db.runTransaction(async (tx) => {
            const snap = await tx.get(lockRef);
            if (!snap.exists) return;
            if (snap.data().ownerOperationId !== deletionOperationId) return;
            tx.delete(lockRef);
        }).catch(() => {});
    }
});

// 11) Trust: record successful handoff for the finder
// Fires on every spotFeedback creation; only acts on outcome === 'success'.
// eventId uses the feedback document ID (already globally unique) with a role suffix.
exports.updateTrustOnFeedback = onDocumentCreated(
  { document: 'spotFeedback/{feedbackId}', region: 'us-central1', retry: true, serviceAccount: 'parqueen-system-events@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (event) => {
    const data = event.data?.data();
    if (!data || data.outcome !== 'success') return;

    const finderId = data.finderId;
    if (!finderId) return;

    await applyTrustDelta(finderId, 'handoffsCompleted', `${event.params.feedbackId}:finder`);
  }
);

// 12) Trust: record finder-cancelled-after-interest when a spot is deleted while claimed.
// Only penalizes if status === 'interested' at deletion time — not for normal spot removal.
// eventId: spotId + ':finder-cancel' is deterministic and unique for this transition.
exports.scheduleCleaningReminders = onSchedule(
  { schedule: 'every 15 minutes', region: 'us-central1', serviceAccount: 'parqueen-messaging@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async () => {
    const snap = await db.collection('parkingSessions')
      .where('active', '==', true)
      .where('reminderEnabled', '==', true)
      .where('reminderSent', '==', false)
      .get();

    const now = new Date();
    const due = snap.docs.filter(d => {
      const ra = d.data().reminderAt;
      return ra && ra.toDate() <= now;
    });

    await Promise.all(due.map(async d => {
      const { fcmToken, streetName, reminderMinutesBefore, reminderAt, savedAt } = d.data();
      const savedAtGeneration = savedAt && typeof savedAt.toMillis === 'function'
        ? savedAt.toMillis()
        : 'legacy';
      const deliveryId = `cleaning_${stableId(d.id, savedAtGeneration, reminderAt.toMillis())}`;
      try {
        const push = {
          token: fcmToken,
          notification: {
            title: 'Move Your Car',
            body: `Street cleaning on ${streetName} starts in ${reminderMinutesBefore} minutes`,
          },
          data: {
            navigationVersion: '1',
            navigationType: 'my_car',
            deliveryId,
          },
          android: { priority: 'high' },
          apns: { payload: { aps: { sound: 'default', badge: 1 } } },
        };
        await (_pingNotificationHooks.send?.(push) ?? getMessaging().send(push));
      } catch (e) {
        console.error('FCM send failed for session', d.id.slice(0, 8) + '***', sanitizeError(e));
      }
      await d.ref.update({ reminderSent: true });
    }));
  }
);

exports.updateTrustOnSpotDelete = onDocumentDeleted(
  { document: 'spots/{spotId}', region: 'us-central1', retry: true, serviceAccount: 'parqueen-system-events@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (event) => {
    const data = event.data?.data();
    if (!data || data.status !== 'interested' || !data.finderId) return;

    // Admin-triggered deletions must not penalize the finder.
    // Requires the deletion path to set source: 'admin' on the spot before deleting.
    const source = data.source || 'user';
    if (source === 'admin') return;

    // Natural-expiration exemption: handoffsCancelledByFinder measures
    // cancellation of an ACTIVE handoff. Once the spot's own expiresAt has
    // passed, any later deletion — by cleanupExpiredSpotsHourly, a manual
    // client delete, or anything else — is normal removal of an already-dead
    // listing, not an active cancellation, regardless of which mechanism
    // physically performs the delete. Fails closed: only exempts when BOTH
    // expiresAt and event.time are genuinely valid and parseable; missing,
    // null, or malformed expiresAt (or a missing/malformed event.time)
    // preserves today's penalty behavior rather than silently granting a
    // free exemption. <= (not <) at the boundary: a spot is no longer
    // active at the exact instant it expires.
    const expiresAt = data.expiresAt;
    const deletionTimeMs = Date.parse(event.time);
    if (expiresAt instanceof Timestamp && Number.isFinite(deletionTimeMs)) {
      if (expiresAt.toMillis() <= deletionTimeMs) return;
    }

    await applyTrustDelta(
      data.finderId,
      'handoffsCancelledByFinder',
      `${event.params.spotId}:finder-cancel`,
      source
    );
  }
);

// 21) Admin resolve parse failure — marks failure as resolved with audit trail
exports.adminResolveParseFailure = onCall(
  { region: 'us-central1', serviceAccount: 'parqueen-admin-write@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (request) => {
    await requireCurrentAdmin(request);
    const { failureId, resolutionType, resolutionNote } = request.data || {};
    if (!failureId || typeof failureId !== 'string') throw new HttpsError('invalid-argument', 'failureId required.');
    const allowed = ['fixed', 'expected_ignore'];
    if (!allowed.includes(resolutionType)) throw new HttpsError('invalid-argument', "resolutionType must be 'fixed' or 'expected_ignore'.");

    const failureRef = db.doc(`parseFailures/${failureId}`);
    const failureSnap = await failureRef.get();
    if (!failureSnap.exists) throw new HttpsError('not-found', 'Parse failure not found.');
    const failureData = failureSnap.data();

    const now = Timestamp.now();
    await failureRef.update({
      resolvedAt: now,
      resolvedBy: request.auth.uid,
      resolutionType,
      resolutionNote: (resolutionNote && resolutionNote.trim()) || null,
    });

    await db.collection('adminAuditLog').add({
      action: 'parseFailure.resolve',
      targetType: 'parseFailure',
      targetId: failureId,
      adminId: request.auth.uid,
      adminEmail: request.auth.token?.email || null,
      reason: (resolutionNote && resolutionNote.trim()) || null,
      metadata: {
        resolutionType,
        rawSignText: failureData.rawSignText || null,
        parserVersion: failureData.parserVersion || null,
        count: failureData.count || null,
      },
      createdAt: now,
    });

    return { success: true };
  }
);

// 22) Admin reopen parse failure — clears resolution with audit trail
exports.adminReopenParseFailure = onCall(
  { region: 'us-central1', serviceAccount: 'parqueen-admin-write@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (request) => {
    await requireCurrentAdmin(request);
    const { failureId } = request.data || {};
    if (!failureId || typeof failureId !== 'string') throw new HttpsError('invalid-argument', 'failureId required.');

    const failureRef = db.doc(`parseFailures/${failureId}`);
    const failureSnap = await failureRef.get();
    if (!failureSnap.exists) throw new HttpsError('not-found', 'Parse failure not found.');

    const now = Timestamp.now();
    await failureRef.update({
      resolvedAt: null,
      resolvedBy: null,
      resolutionType: null,
      resolutionNote: null,
    });

    await db.collection('adminAuditLog').add({
      action: 'parseFailure.reopen',
      targetType: 'parseFailure',
      targetId: failureId,
      adminId: request.auth.uid,
      adminEmail: request.auth.token?.email || null,
      createdAt: now,
    });

    return { success: true };
  }
);

// 23) Admin add street segment — accepts fully geocoded payload from client, writes doc + audit trail.
// Geocoding (OSM + address lookup) is performed client-side; this function owns the write + audit.
exports.adminAddSegment = onCall(
  { region: 'us-central1', serviceAccount: 'parqueen-admin-write@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (request) => {
    await requireCurrentAdmin(request);
    const p = request.data || {};
    const required = ['cityId', 'streetName', 'borough', 'fromLat', 'fromLng', 'toLat', 'toLng', 'centerLat', 'centerLng', 'bearing', 'geohash'];
    for (const field of required) {
      if (p[field] == null) throw new HttpsError('invalid-argument', `${field} is required.`);
    }

    const now = Timestamp.now();
    const docRef = await db.collection('streetSegments').add({
      cityId: p.cityId,
      streetName: p.streetName,
      referenceAddress: p.referenceAddress || null,
      fromCross: p.fromCross || '',
      toCross: p.toCross || '',
      borough: p.borough,
      fromLat: p.fromLat,
      fromLng: p.fromLng,
      toLat: p.toLat,
      toLng: p.toLng,
      centerLat: p.centerLat,
      centerLng: p.centerLng,
      bearing: p.bearing,
      geohash: p.geohash,
      evenSideIsPositiveCross: p.evenSideIsPositiveCross ?? null,
      cslSegmentId: null,
      source: 'admin',
      status: 'active',
      confidenceScore: 1.0,
      editedBy: `admin:${request.auth.uid}`,
      provenance: {
        provider: 'admin',
        importedBy: request.auth.uid,
      },
      confidence: {
        level: 'parqueen_verified',
        source: 'admin',
        lastVerifiedAt: now,
        communityConfirmations: 0,
      },
      createdAt: now,
      updatedAt: now,
    });

    await db.collection('adminAuditLog').add({
      action: 'segment.create',
      targetType: 'segment',
      targetId: docRef.id,
      adminId: request.auth.uid,
      adminEmail: request.auth.token?.email || null,
      metadata: {
        streetName: p.streetName,
        borough: p.borough,
        fromCross: p.fromCross || null,
        toCross: p.toCross || null,
        source: 'admin',
        confidenceScore: 1.0,
      },
      createdAt: now,
    });

    return { success: true, segmentId: docRef.id };
  }
);

// 24) Admin add cleaning rule — creates rule in segment subcollection with audit trail
exports.adminAddCleaningRule = onCall(
  { region: 'us-central1', serviceAccount: 'parqueen-admin-write@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (request) => {
    await requireCurrentAdmin(request);
    const { segmentId, side, days, startTime, endTime } = request.data || {};
    if (!segmentId || typeof segmentId !== 'string') throw new HttpsError('invalid-argument', 'segmentId required.');
    if (!side || !['even', 'odd'].includes(side)) throw new HttpsError('invalid-argument', "side must be 'even' or 'odd'.");
    if (!Array.isArray(days) || days.length === 0) throw new HttpsError('invalid-argument', 'days must be a non-empty array.');
    if (!startTime || typeof startTime !== 'string') throw new HttpsError('invalid-argument', 'startTime required.');
    if (!endTime || typeof endTime !== 'string') throw new HttpsError('invalid-argument', 'endTime required.');

    const segSnap = await db.doc(`streetSegments/${segmentId}`).get();
    if (!segSnap.exists) throw new HttpsError('not-found', 'Segment not found.');

    const now = Timestamp.now();
    const ruleRef = await db.collection(`streetSegments/${segmentId}/streetRules`).add({
      type: 'streetCleaning',
      effectiveDate: now,
      supersededAt: null,
      schedules: [{ side, days, startTime, endTime }],
      source: 'admin',
      provenance: {
        provider: 'admin',
        importedBy: request.auth.uid,
      },
      lastSourceSync: new Date().toISOString().slice(0, 10),
      createdAt: now,
      updatedAt: now,
      editedBy: `admin:${request.auth.uid}`,
    });

    await db.collection('adminAuditLog').add({
      action: 'rule.create',
      targetType: 'rule',
      targetId: ruleRef.id,
      adminId: request.auth.uid,
      adminEmail: request.auth.token?.email || null,
      metadata: {
        segmentId,
        side,
        days,
        startTime,
        endTime,
        source: 'admin',
      },
      createdAt: now,
    });

    return { success: true, ruleId: ruleRef.id };
  }
);

// 25) Admin supersede cleaning rule — soft-deletes a rule with audit trail
exports.adminSupersedeRule = onCall(
  { region: 'us-central1', serviceAccount: 'parqueen-admin-write@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (request) => {
    await requireCurrentAdmin(request);
    const { segmentId, ruleId, reason } = request.data || {};
    if (!segmentId || typeof segmentId !== 'string') throw new HttpsError('invalid-argument', 'segmentId required.');
    if (!ruleId || typeof ruleId !== 'string') throw new HttpsError('invalid-argument', 'ruleId required.');

    const ruleRef = db.doc(`streetSegments/${segmentId}/streetRules/${ruleId}`);
    const ruleSnap = await ruleRef.get();
    if (!ruleSnap.exists) throw new HttpsError('not-found', 'Rule not found.');
    const ruleData = ruleSnap.data();
    const schedule = ruleData.schedules?.[0] || {};

    const now = Timestamp.now();
    await ruleRef.update({
      supersededAt: now,
      updatedAt: now,
      editedBy: `admin:${request.auth.uid}`,
      supersedeReason: (reason && reason.trim()) || 'Removed from admin dashboard',
    });

    await db.collection('adminAuditLog').add({
      action: 'rule.supersede',
      targetType: 'rule',
      targetId: ruleId,
      adminId: request.auth.uid,
      adminEmail: request.auth.token?.email || null,
      reason: (reason && reason.trim()) || null,
      metadata: {
        segmentId,
        side: schedule.side || null,
        days: schedule.days || null,
        startTime: schedule.startTime || null,
        endTime: schedule.endTime || null,
        previousSource: ruleData.source || null,
      },
      createdAt: now,
    });

    return { success: true };
  }
);

// 26) Admin add ASP suspension — creates suspension record with audit trail
exports.adminAddSuspension = onCall(
  { region: 'us-central1', serviceAccount: 'parqueen-admin-write@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (request) => {
    await requireCurrentAdmin(request);
    const { date, label, type } = request.data || {};
    if (!date || typeof date !== 'string') throw new HttpsError('invalid-argument', 'date required (YYYY-MM-DD).');
    if (!label || typeof label !== 'string' || !label.trim()) throw new HttpsError('invalid-argument', 'label required.');
    if (!['holiday', 'emergency'].includes(type)) throw new HttpsError('invalid-argument', "type must be 'holiday' or 'emergency'.");

    const now = Timestamp.now();
    const suspRef = await db.collection('suspensions').add({
      cityId: 'nyc',
      date,
      type,
      label: label.trim(),
      affectsTypes: ['streetCleaning'],
      source: 'admin',
      status: 'active',
      createdAt: now,
      createdBy: request.auth.uid,
      updatedAt: now,
    });

    await db.collection('adminAuditLog').add({
      action: 'suspension.create',
      targetType: 'suspension',
      targetId: suspRef.id,
      adminId: request.auth.uid,
      adminEmail: request.auth.token?.email || null,
      metadata: {
        date,
        label: label.trim(),
        type,
        cityId: 'nyc',
        source: 'admin',
      },
      createdAt: now,
    });

    return { success: true, suspensionId: suspRef.id };
  }
);

// 27) Admin backfill street intelligence schema — server-side replacement for
// the direct client Firestore writes formerly performed by
// utils/backfill.ts's backfillStreetIntelligence() from
// views/admin/StreetSegmentsPage.tsx's Data Maintenance panel. That path was
// authorized only by firestore.rules' token-only isAdmin() check, so a
// demoted/deleted/disabled admin's stale token could still invoke it — the
// same vulnerability class requireCurrentAdmin closes for callables, but
// Rules cannot re-check current server-side Auth state. firestore.rules now
// denies direct client writes to streetSegments/streetRules; this callable
// is the only way to perform the backfill going forward.
//
// Paginated (fixed page of streetSegments per call, walking each segment's
// streetRules subcollection inline) to stay well within the callable
// timeout regardless of collection size — the client repeatedly calls with
// the returned cursor until done:true. Idempotent: only ever fills in
// currently-missing fields, so a resumed/re-run page is harmless.
exports.adminBackfillStreetIntelligence = onCall(
  { region: 'us-central1', serviceAccount: 'parqueen-admin-write@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (request) => {
    await requireCurrentAdmin(request);
    const p = request.data || {};

    // Strict, narrow parameter schema — this callable encodes exactly one
    // fixed administrative operation on exactly two fixed collections. The
    // client cannot select a different collection, path, or set of fields;
    // any such extra data in the payload is simply ignored, never read.
    if (p.dryRun !== undefined && typeof p.dryRun !== 'boolean') {
      throw new HttpsError('invalid-argument', 'dryRun must be a boolean.');
    }
    if (p.cursor !== undefined && p.cursor !== null && (typeof p.cursor !== 'string' || p.cursor.length === 0)) {
      throw new HttpsError('invalid-argument', 'cursor must be a non-empty string or null.');
    }
    if (p.limit !== undefined && (!Number.isInteger(p.limit) || p.limit <= 0 || p.limit > 200)) {
      throw new HttpsError('invalid-argument', 'limit must be an integer between 1 and 200.');
    }

    const dryRun = p.dryRun === true;
    const cursorId = typeof p.cursor === 'string' && p.cursor ? p.cursor : null;
    const pageLimit = Number.isInteger(p.limit) ? p.limit : 50;

    let segQuery = db.collection('streetSegments').orderBy('__name__').limit(pageLimit);
    if (cursorId) {
      const cursorSnap = await db.collection('streetSegments').doc(cursorId).get();
      if (cursorSnap.exists) segQuery = segQuery.startAfter(cursorSnap);
    }
    const segmentsSnap = await segQuery.get();

    const result = {
      segmentsScanned: 0, segmentsUpdated: 0,
      rulesScanned: 0, rulesUpdated: 0,
      dryRun, nextCursor: null, done: true,
    };

    for (const segDoc of segmentsSnap.docs) {
      result.segmentsScanned++;
      const data = segDoc.data();
      const isSwNYC = isSweepNYCData(data);
      const segUpdate = computeSegmentUpdate(data);

      if (Object.keys(segUpdate).length > 0) {
        if (data.updatedAt == null) segUpdate.updatedAt = Timestamp.now();
        result.segmentsUpdated++;
        if (!dryRun) await segDoc.ref.update(segUpdate);
      }

      const rulesSnap = await segDoc.ref.collection('streetRules').get();
      for (const ruleDoc of rulesSnap.docs) {
        result.rulesScanned++;
        const ruleUpdate = computeRuleUpdate(ruleDoc.data(), isSwNYC);
        if (Object.keys(ruleUpdate).length > 0) {
          result.rulesUpdated++;
          if (!dryRun) await ruleDoc.ref.update(ruleUpdate);
        }
      }
    }

    if (segmentsSnap.size === pageLimit) {
      result.nextCursor = segmentsSnap.docs[segmentsSnap.docs.length - 1].id;
      result.done = false;
    }

    if (!dryRun && (result.segmentsUpdated > 0 || result.rulesUpdated > 0)) {
      await db.collection('adminAuditLog').add({
        action: 'streetIntelligence.backfill',
        targetType: 'streetSegments',
        targetId: null,
        adminId: request.auth.uid,
        adminEmail: request.auth.token?.email || null,
        metadata: {
          segmentsScanned: result.segmentsScanned,
          segmentsUpdated: result.segmentsUpdated,
          rulesScanned: result.rulesScanned,
          rulesUpdated: result.rulesUpdated,
          cursor: cursorId,
          nextCursor: result.nextCursor,
        },
        createdAt: Timestamp.now(),
      });
    }

    return result;
  }
);

// 27) Admin read views — coordinated read-side session hardening. Closes the
// same class of vulnerability as adminBackfillStreetIntelligence, but for
// READS: the Admin Dashboard used to query users/reports/adminAuditLog/
// parkingSessions/parseFailures/spots directly against the client Firestore
// SDK, authorized only by firestore.rules' token-only isAdmin() check. A
// demoted/deleted/disabled admin's stale token could keep reading that data
// until the token expired, regardless of how hardened the write path was.
// firestore.rules now denies direct client reads for these paths; this is
// the only way to read them. See functions/adminReadViews.js for the
// per-view query logic, field selection, and bounds. Deliberately NOT a
// generic adminReadCollection(collection, query) proxy — the client selects
// only a fixed view name; every collection/field/filter/limit is
// server-owned.
// Handler extracted from the onCall wrapper below so integration tests can
// exercise requireCurrentAdmin and the real dispatch logic directly, without
// going through the App Check enforcement HTTP gate (the Functions emulator
// has no App Check emulator, so a raw-HTTP test can't supply a valid token —
// see functions/adminReadViews.integration.test.js's header comment for the
// full rationale). Not itself a Cloud Function: `firebase deploy` only scans
// onCall/onRequest-wrapped exports of this file, so a bare async function
// export is invisible to function discovery, same as the existing
// _callableHooks seam above.
async function adminReadViewHandler(request) {
  await requireCurrentAdmin(request);
  const p = request.data || {};
  if (typeof p.view !== 'string' || !Object.prototype.hasOwnProperty.call(ADMIN_READ_VIEWS, p.view)) {
    throw new HttpsError('invalid-argument', 'Unknown view.');
  }
  const params = (p.params && typeof p.params === 'object' && !Array.isArray(p.params)) ? p.params : {};
  try {
    return await ADMIN_READ_VIEWS[p.view](db, params, { Timestamp });
  } catch (err) {
    if (err instanceof HttpsError) throw err;
    console.warn(`[admin-read] view failed: ${p.view}`);
    throw new HttpsError('internal', 'Read failed.');
  }
}
exports._adminReadViewHandler = adminReadViewHandler;
exports._boroughFromAddress = _boroughFromAddress;
exports._detectBorough      = _detectBorough;
exports._overpassJson       = _overpassJson;

exports.adminReadView = onCall(
  // App Check canary (Stage 4A): first callable to enforce App Check. Chosen
  // because it's admin-only, read-only, and observed 6/6 VALID in production
  // before this change — see docs/APP_CHECK_ROLLOUT.md. Independent of
  // requireCurrentAdmin inside the handler: App Check verifies the calling
  // app instance, requireCurrentAdmin verifies the calling user's live admin
  // role. Neither substitutes for the other.
  //
  // Runtime-IAM canary: also the first callable to move off the shared
  // Editor-privileged compute default service account. This identity has
  // only roles/datastore.user + roles/firebaseauth.viewer — the exact set
  // requireCurrentAdmin's getUser() call and the ADMIN_READ_VIEWS Firestore
  // queries need, nothing else (no secret access, no Auth write, no
  // Storage, no deploy/IAM/Scheduler/App-Check-admin capability).
  {
    region: 'us-central1',
    enforceAppCheck: true,
    serviceAccount: 'parqueen-admin-read@parkqueen-46475363-ccf36.iam.gserviceaccount.com',
  },
  adminReadViewHandler
);

// 28) Create segment from SweepNYC with NYC Open Data fallback.
// Called when the client finds no Firestore segment within 80m.
// Tries SweepNYC first; falls back to NYC Open Data when SweepNYC has no usable data.

async function _tryCreateFromSweepNYC(lat, lng) {
    try {
    const SWEEPNYC_BASE = 'https://sweepnyc.nyc.gov/mappingapi/api';
    const PARSER_VERSION = '1.1';

    // ── SweepNYC API ─────────────────────────────────────────────────────────────
    const sweepUrl = `${SWEEPNYC_BASE}/highlight/sweepinfo?lat=${lat}&lon=${lng}&t=${Date.now()}&radius=0.1`;
    console.log('[SweepNYC] requesting'); // TM-17: coordinates omitted (user location)
    let apiData;
    try {
      const res = await fetch(sweepUrl);
      console.log('[SweepNYC] HTTP status:', res.status);
      if (!res.ok) {
        console.warn('[SweepNYC] non-OK response:', res.status);
        return { success: false, reason: 'no_sweepnyc_data' };
      }
      apiData = await res.json();
    } catch (err) {
      console.warn('[SweepNYC] fetch error:', sanitizeError(err));
      return { success: false, reason: 'no_sweepnyc_data' };
    }

    console.log('[SweepNYC] response keys:', Object.keys(apiData || {}).join(', '));
    console.log('[SweepNYC] ObjectId:', apiData && apiData.ObjectId, '| Notes type:', typeof apiData.Notes);
    if (!apiData?.Notes || !apiData?.ObjectId) {
      console.warn('[SweepNYC] missing Notes or ObjectId — no data at this location');
      return { success: false, reason: 'no_sweepnyc_data' };
    }

    const objectId = String(apiData.ObjectId);
    const docId = `nyc_${objectId}`;

    // ── Dedup: cslSegmentId index first, then deterministic doc ID ───────────────
    const existingSnap = await db.collection('streetSegments')
      .where('cslSegmentId', '==', objectId)
      .limit(1)
      .get();

    if (!existingSnap.empty) {
      const d = existingSnap.docs[0].data();
      if (d.status === 'archived') return { success: false, reason: 'archived_segment' };
      const ps = _detectCardinalSide(lat, lng, d.fromLat, d.fromLng, d.toLat, d.toLng, d.bearing ?? 90);
      return {
        success: true,
        segmentId: existingSnap.docs[0].id,
        parkingSide: ps,
        streetName: d.streetName,
        _diag: { stage: 'dedup_index', geometrySource: 'existing', segmentStatus: d.status ?? null, signsCount: null, parsedCount: null, parseFailureCount: null, extractedStreetName: null, extractedSide: ps },
      };
    }

    // Secondary dedup: deterministic doc ID (handles race before index propagates)
    const byDocIdSnap = await db.doc(`streetSegments/${docId}`).get();
    if (byDocIdSnap.exists) {
      const d = byDocIdSnap.data();
      if (d.status === 'archived') return { success: false, reason: 'archived_segment' };
      const ps = _detectCardinalSide(lat, lng, d.fromLat, d.fromLng, d.toLat, d.toLng, d.bearing ?? 90);
      return {
        success: true,
        segmentId: docId,
        parkingSide: ps,
        streetName: d.streetName,
        _diag: { stage: 'dedup_docid', geometrySource: 'existing', segmentStatus: d.status ?? null, signsCount: null, parsedCount: null, parseFailureCount: null, extractedStreetName: null, extractedSide: ps },
      };
    }

    // ── Parse sign texts ──────────────────────────────────────────────────────────
    let notes;
    try {
      notes = typeof apiData.Notes === 'string' ? JSON.parse(apiData.Notes) : apiData.Notes;
    } catch {
      console.warn('[SweepNYC] failed to parse Notes JSON');
      return { success: false, reason: 'parse_failed', _diag: { stage: 'notes', errorMessage: 'Notes JSON parse failed' } };
    }
    if (notes === null || typeof notes !== 'object') {
      console.warn('[SweepNYC] Notes is null or non-object:', notes);
      return {
        success: false,
        reason: 'no_sweepnyc_notes',
        _diag: {
          stage: 'notes',
          sweepStatus: apiData.Status ?? null,
          responseKeys: Object.keys(apiData || {}).join(', '),
          notesType: notes === null ? 'null' : typeof notes,
          errorMessage: 'SweepNYC Notes missing or null',
        },
      };
    }
    console.log('[SweepNYC] Notes keys:', Object.keys(notes).join(', '));
    const signsRaw = Array.isArray(notes.Signs) ? notes.Signs : [];
    console.log('[SweepNYC] Signs count:', signsRaw.length, '| first 3:', JSON.stringify(signsRaw.slice(0, 3)));
    if (!signsRaw.length) {
      return {
        success: false,
        reason: 'no_signs',
        _diag: { stage: 'signs', signsCount: 0, errorMessage: 'SweepNYC Signs missing or empty' },
      };
    }

    const streetCtx = _extractStreetContext(apiData, notes);
    console.log('[SweepNYC] streetCtx:', JSON.stringify(streetCtx));
    console.log('[SweepNYC] SideOfStreet fields — apiData.SideOfStreet:', apiData.SideOfStreet ?? null, '| apiData.SideName:', apiData.SideName ?? null, '| apiData.Side:', apiData.Side ?? null, '| notes.SideOfStreet:', notes.SideOfStreet ?? null, '| streetCtx.side:', streetCtx.side ?? null);

    // ── Parse signs (try/catch prevents INTERNAL on bad sign shapes) ─────────────
    const parsed = [];
    const failurePromises = [];
    try {
      for (const sign of signsRaw) {
        const signText = sign && typeof sign.SignText === 'string' ? sign.SignText : null;
        const result = _parseSweepNYCSign(signText, streetCtx);
        if (result) {
          parsed.push(result);
        } else {
          console.warn('[SweepNYC] sign parse failed:', signText);
          if (signText) {
            failurePromises.push(
              _logParseFailure(String(apiData.Notes ?? ''), objectId, signText, lat, lng, PARSER_VERSION).catch(() => {}),
            );
          }
        }
      }
    } catch (signErr) {
      console.error('[SweepNYC] signs loop error:', sanitizeError(signErr));
      return { success: false, reason: 'parse_failed', _diag: { stage: 'signs_loop', error: sanitizeError(signErr) } };
    }
    console.log('[SweepNYC] parsed', parsed.length, '/', signsRaw.length, 'signs');
    Promise.all(failurePromises).catch(() => {});

    if (!parsed.length) {
      return { success: false, reason: 'parse_failed', _diag: { stage: 'parse', signsCount: signsRaw.length, parsedCount: 0, extractedStreetName: streetCtx.street, extractedSide: streetCtx.side } };
    }

    // ── Street geometry ───────────────────────────────────────────────────────────
    const first = parsed[0];
    const streetNameForGeo = streetCtx.street || first.street;
    console.log('[SweepNYC] fetching OSM geometry for street:', streetNameForGeo);
    let fromLat, fromLng, toLat, toLng, bearing, geometrySource;
    try {
      const geo = streetNameForGeo && streetNameForGeo !== 'Unknown Street'
        ? await _fetchStreetGeometry(streetNameForGeo, lat, lng)
        : null;
      if (geo) {
        ({ fromLat, fromLng, toLat, toLng, bearing } = geo);
        geometrySource = 'osm';
        console.log('[SweepNYC] OSM geometry found for:', streetNameForGeo);
      } else {
        // Fallback: synthetic segment centered on tested lat/lng.
        // Stored as needs_review so admins can verify before it's treated as authoritative.
        const HALF = 0.0005; // ~55 m
        fromLat = lat - HALF; fromLng = lng;
        toLat = lat + HALF; toLng = lng;
        bearing = 0;
        geometrySource = 'fallback';
        console.warn('[SweepNYC] OSM geometry not found for "' + streetNameForGeo + '" — using coordinate fallback, status=needs_review');
      }
    } catch (geoErr) {
      console.error('[SweepNYC] geometry error:', sanitizeError(geoErr));
      return { success: false, reason: 'geometry_failed', _diag: { stage: 'geometry', error: sanitizeError(geoErr) } };
    }

    const centerLat = (fromLat + toLat) / 2;
    const centerLng = (fromLng + toLng) / 2;
    let geohash;
    try {
      geohash = geohashForLocation([centerLat, centerLng], 9);
    } catch (hashErr) {
      console.error('[SweepNYC] geohash error:', sanitizeError(hashErr));
      return { success: false, reason: 'geometry_failed', _diag: { stage: 'geohash', centerLat, centerLng } };
    }

    // Cardinal side: only reliable when OSM geometry is real; fallback uses API-extracted side or null.
    const parkingSide = geometrySource === 'osm'
      ? _detectCardinalSide(lat, lng, fromLat, fromLng, toLat, toLng, bearing)
      : (streetCtx.side || null);

    const now = Timestamp.now();
    const segmentStatus = geometrySource === 'fallback' ? 'needs_review' : 'active';
    const provenance = {
      provider: 'sweepnyc',
      sweepNYCObjectId: apiData.ObjectId,
      fetchedAt: now,
      parserVersion: PARSER_VERSION,
      rawSignTexts: signsRaw.map(s => (s && s.SignText) || ''),
      geometrySource,
      refreshedAt: null,
      refreshCount: 0,
    };

    // ── Write segment + rules (try/catch prevents INTERNAL on Firestore errors) ───
    try {
      const segRef = db.doc(`streetSegments/${docId}`);
      await segRef.set({
        cityId: 'nyc',
        streetName: streetCtx.street || first.street,
        fromCross: streetCtx.fromCross || first.fromCross,
        toCross: streetCtx.toCross || first.toCross,
        borough: _detectBorough(lat, lng),
        fromLat, fromLng, toLat, toLng,
        centerLat, centerLng, bearing,
        geohash,
        evenSideIsPositiveCross: false,
        cslSegmentId: objectId,
        externalSegmentId: objectId,
        source: 'sweepnyc',
        provenance,
        status: segmentStatus,
        confidenceScore: geometrySource === 'osm' ? 0.95 : 0.6,
        confidence: {
          level: 'community',
          source: 'nyc_open_data',
          lastVerifiedAt: now,
          communityConfirmations: 0,
        },
        editedBy: 'system:sweepnyc',
        createdAt: now,
        updatedAt: now,
      });

      await segRef.collection('streetRules').doc('sweepnyc_v1').set({
        type: 'streetCleaning',
        effectiveDate: now,
        supersededAt: null,
        status: 'active',
        schedules: parsed.map(p => {
          const s = { side: p.side, days: p.days, startTime: p.startTime, endTime: p.endTime };
          if (p.ruleType) s.ruleType = p.ruleType;
          return s;
        }),
        source: 'sweepnyc',
        provenance,
        lastSourceSync: new Date().toISOString(),
        createdAt: now,
        updatedAt: now,
      });
    } catch (writeErr) {
      console.error('[SweepNYC] Firestore write error:', sanitizeError(writeErr));
      return { success: false, reason: 'firestore_write_failed', _diag: { stage: 'write', error: sanitizeError(writeErr) } };
    }

    const finalStreetName = streetCtx.street || first.street;
    console.log('[SweepNYC] wrote segment', docId, '| status:', segmentStatus, '| parkingSide:', parkingSide, '| geometrySource:', geometrySource);
    return {
      success: true,
      segmentId: docId,
      parkingSide,
      streetName: finalStreetName,
      _diag: {
        stage: 'complete',
        geometrySource,
        segmentStatus,
        signsCount: signsRaw.length,
        parsedCount: parsed.length,
        parseFailureCount: failurePromises.length,
        extractedStreetName: streetCtx.street,
        extractedSide: streetCtx.side,
      },
    };
    } catch (topErr) {
      console.error('[SweepNYC] top-level unhandled error:', sanitizeError(topErr));
      return {
        success: false,
        reason: 'unknown_error',
        _diag: {
          stage: 'top_level',
          errorName: topErr && topErr.name,
          errorMessage: topErr && topErr.message,
        },
      };
    }
}

// SweepNYC failure reasons that should trigger the NYC Open Data fallback.
// archived_segment and geometry_failed are NOT included — those are definitive or unrelated.
const _SWEEPNYC_FALLBACK_REASONS = new Set([
  'no_sweepnyc_data', 'no_sweepnyc_notes', 'no_signs', 'parse_failed',
]);

// ─── Hydrant proximity (NYC DEP) ─────────────────────────────────────────────
// NYC prohibits parking within 15 ft of either side of a hydrant. The nearest
// hydrant is resolved server-side so the client never handles the Socrata
// token and never pulls the 109k-row citywide dataset.
//
// Dataset: 5bgh-vtsn "Hydrants", attributed to the Department of Environmental
// Protection — the SODA-queryable table behind the NYCDEP Citywide Hydrants
// map asset (6pui-xhxz), which is a map type and exposes no tabular columns.
// Verified fields: the_geom (Point), latitude, longitude, unitid, boro.
const HYDRANT_DATASET = '5bgh-vtsn';
const HYDRANT_SEARCH_RADIUS_M = 60;
const HYDRANT_MAX_ROWS = 50;

/**
 * Great-circle distance in metres.
 *
 * Degree-space arithmetic is not usable here: at NYC's latitude a degree of
 * longitude is about 24% shorter than a degree of latitude, which at a 15 ft
 * threshold is the whole answer.
 */
function _haversineMeters(lat1, lng1, lat2, lng2) {
  const R = 6371008.8; // IUGG mean Earth radius
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Pulls a usable lat/lng out of a hydrant row, tolerating string columns. */
function _hydrantRowLatLng(row) {
  if (!row || typeof row !== 'object') return null;
  const geom = row.the_geom;
  if (geom && Array.isArray(geom.coordinates) && geom.coordinates.length >= 2) {
    const lng = geom.coordinates[0];
    const lat = geom.coordinates[1];
    if (typeof lat === 'number' && typeof lng === 'number'
      && Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  }
  // Number(null) and Number('') are both 0, which is finite — without this
  // guard a row with empty coordinate columns becomes a hydrant at (0, 0).
  const num = (v) => {
    if (typeof v === 'number') return Number.isFinite(v) ? v : null;
    if (typeof v !== 'string' || v.trim() === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const lat = num(row.latitude);
  const lng = num(row.longitude);
  if (lat !== null && lng !== null) return { lat, lng };
  return null;
}

/**
 * Nearest hydrant to a point, or null when the search radius holds none.
 * Returns metres only — the caller decides what that means.
 */
async function _nearestHydrantMeters(lat, lng) {
  const token = _socrataToken();
  const params = new URLSearchParams({
    // Header auth only; a token in the query string lands in access logs.
    $where: `within_circle(the_geom, ${lat}, ${lng}, ${HYDRANT_SEARCH_RADIUS_M})`,
    $select: 'the_geom,latitude,longitude',
    $limit: String(HYDRANT_MAX_ROWS),
  });
  const headers = { Accept: 'application/json' };
  if (token) headers['X-App-Token'] = token;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  let rows;
  try {
    const res = await fetch(
      `https://data.cityofnewyork.us/resource/${HYDRANT_DATASET}.json?${params}`,
      { headers, signal: controller.signal },
    );
    if (!res.ok) {
      // Status only — never the URL, which carries the queried coordinate.
      console.warn(`[checkHydrantDistance] provider status ${res.status}`);
      return { ok: false, meters: null };
    }
    rows = await res.json();
  } catch (err) {
    console.warn(`[checkHydrantDistance] provider unreachable: ${err?.name ?? 'error'}`);
    return { ok: false, meters: null };
  } finally {
    clearTimeout(timer);
  }

  if (!Array.isArray(rows)) {
    console.warn('[checkHydrantDistance] provider returned a non-array payload');
    return { ok: false, meters: null };
  }

  let nearest = null;
  for (const row of rows) {
    const point = _hydrantRowLatLng(row);
    if (!point) continue;
    const d = _haversineMeters(lat, lng, point.lat, point.lng);
    if (nearest === null || d < nearest) nearest = d;
  }
  return { ok: true, meters: nearest };
}

// NYC bounding box, generous enough to cover all five boroughs. Points outside
// it cannot be answered from a NYC-only dataset, and saying so beats returning
// "no hydrant nearby" for an address in another city.
function _isWithinNYC(lat, lng) {
  return lat >= 40.45 && lat <= 40.95 && lng >= -74.30 && lng <= -73.68;
}

exports.checkHydrantDistance = onCall(
  {
    region: 'us-central1',
    secrets: [socrataAppToken],
    enforceAppCheck: true,
    serviceAccount: 'parqueen-user@parkqueen-46475363-ccf36.iam.gserviceaccount.com',
  },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Must be signed in.');

    const { lat, lng } = request.data || {};
    if (typeof lat !== 'number' || typeof lng !== 'number'
      || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      throw new HttpsError('invalid-argument', 'lat and lng must be numbers.');
    }
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      throw new HttpsError('invalid-argument', 'lat and lng must be valid coordinates.');
    }

    await checkRateLimit(request.auth.uid, 'checkHydrantDistance', { limit: 60, windowSec: 3600 });

    if (!_isWithinNYC(lat, lng)) {
      return { status: 'out_of_area', meters: null, radiusMeters: HYDRANT_SEARCH_RADIUS_M };
    }

    const hook = _callableHooks.hydrantResponse;
    const result = hook
      ? await hook(lat, lng)
      : await _nearestHydrantMeters(lat, lng);

    if (!result || result.ok !== true) {
      return { status: 'unavailable', meters: null, radiusMeters: HYDRANT_SEARCH_RADIUS_M };
    }
    if (result.meters === null || result.meters === undefined) {
      return { status: 'none_nearby', meters: null, radiusMeters: HYDRANT_SEARCH_RADIUS_M };
    }
    // The submitted coordinate is never written to Firestore and never logged;
    // only the derived distance leaves this function.
    return { status: 'found', meters: result.meters, radiusMeters: HYDRANT_SEARCH_RADIUS_M };
  }
);

exports.createSegmentFromSweepNYC = onCall(
  { region: 'us-central1', secrets: [socrataAppToken], serviceAccount: 'parqueen-user@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Must be signed in.');

    const uid = request.auth.uid;
    await checkRateLimit(uid, 'createSegmentFromSweepNYC', { limit: 30, windowSec: 3600 });

    const { lat, lng, revalidateSegmentId } = request.data || {};
    if (typeof lat !== 'number' || typeof lng !== 'number')
      throw new HttpsError('invalid-argument', 'lat and lng must be numbers.');
    if (lat < 40.4 || lat > 40.95 || lng < -74.3 || lng > -73.65)
      throw new HttpsError('invalid-argument', 'Coordinates outside NYC bounds.');
    if (revalidateSegmentId !== undefined
      && (typeof revalidateSegmentId !== 'string'
        || revalidateSegmentId.length === 0
        || revalidateSegmentId.length > 500
        || revalidateSegmentId.includes('/'))) {
      throw new HttpsError('invalid-argument', 'Invalid segment ID.');
    }

    try {
      if (revalidateSegmentId) {
        return await _revalidateLegacyNYCOpenDataSegment(revalidateSegmentId, lat, lng);
      }
      if (_callableHooks.sweepNYCResult) {
        return await _callableHooks.sweepNYCResult(lat, lng);
      }
      const sweepResult = await _tryCreateFromSweepNYC(lat, lng);
      if (sweepResult.success) return sweepResult;
      if (!_SWEEPNYC_FALLBACK_REASONS.has(sweepResult.reason)) return sweepResult;
      console.log('[SweepNYC→NYCOpenData] falling back, sweepReason:', sweepResult.reason);
      return await _fallbackToNYCOpenData(lat, lng);
    } catch (err) {
      console.error('[createSegmentFromSweepNYC] top-level error:', sanitizeError(err));
      return { success: false, reason: 'unknown_error', _diag: { error: sanitizeError(err) } };
    }
  }
);

function _existingNYCOpenDataResult(segmentId, segment, lat, lng, stage) {
  const parkingSide = segment.fromLat != null
    ? _detectCardinalSide(lat, lng, segment.fromLat, segment.fromLng, segment.toLat, segment.toLng, segment.bearing ?? 90)
    : dotSideToCardinal(segment.sideOfStreet);
  return {
    success: true,
    segmentId,
    parkingSide,
    streetName: segment.streetName,
    revalidation: stage,
    _diag: { stage: `legacy_revalidation_${stage}`, provider: 'nyc_open_data' },
  };
}

async function _claimLegacyNYCOpenDataRevalidation(segmentId) {
  const segmentRef = db.doc(`streetSegments/${segmentId}`);
  const operationId = randomUUID();
  return db.runTransaction(async tx => {
    const snap = await tx.get(segmentRef);
    if (!snap.exists) return { acquired: false, segment: null, state: 'missing' };
    const segment = snap.data();
    if (!isLegacyNYCOpenDataSegment(segment)) {
      const isNYCOpenData = segment.source === 'nyc_open_data'
        && segment.provenance?.provider === 'nyc_open_data';
      return {
        acquired: false,
        segment: isNYCOpenData ? segment : null,
        state: isNYCOpenData ? (segment.legacyRevalidation?.state || 'cached') : 'not_legacy',
      };
    }
    tx.set(segmentRef, {
      legacyRevalidation: {
        version: NYC_OD_EVIDENCE_REVALIDATION_VERSION,
        state: 'in_progress',
        operationId,
        startedAt: Timestamp.now(),
      },
    }, { merge: true });
    return { acquired: true, segment, operationId };
  });
}

async function _markLegacyNYCOpenDataRevalidationOutcome(
  segmentId,
  operationId,
  state,
  reason,
  retryAfterMs = null,
) {
  const segmentRef = db.doc(`streetSegments/${segmentId}`);
  await db.runTransaction(async tx => {
    const snap = await tx.get(segmentRef);
    const marker = snap.exists ? snap.data().legacyRevalidation : null;
    if (marker?.version !== NYC_OD_EVIDENCE_REVALIDATION_VERSION
      || marker?.operationId !== operationId) return;
    tx.set(segmentRef, {
      legacyRevalidation: {
        ...marker,
        state,
        reason,
        completedAt: Timestamp.now(),
        ...(retryAfterMs == null ? {} : { retryAfter: Timestamp.fromMillis(retryAfterMs) }),
      },
    }, { merge: true });
  });
}

async function _revalidateLegacyNYCOpenDataSegment(segmentId, lat, lng) {
  return runLegacyNYCOpenDataRevalidation({
    segmentId,
    loadAndClaim: _claimLegacyNYCOpenDataRevalidation,
    refresh: operationId => _fallbackToNYCOpenData(lat, lng, { segmentId, operationId }),
    markFailed: (operationId, reason, retryAfterMs) =>
      _markLegacyNYCOpenDataRevalidationOutcome(
        segmentId, operationId, 'failed', reason, retryAfterMs,
      ),
    markTerminal: (operationId, reason) =>
      _markLegacyNYCOpenDataRevalidationOutcome(
        segmentId, operationId, 'terminal_caution', reason,
      ),
    cachedResult: (segment, stage) =>
      _existingNYCOpenDataResult(segmentId, segment, lat, lng, stage),
  });
}

// ── NYC Open Data fallback helpers ───────────────────────────────────────────

/** Returns true only for active ASP (Alternate Side Parking) sign descriptions. */
function _isASPSign(signDesc) {
  if (!signDesc) return false;
  const upper = signDesc.toUpperCase();
  return upper.startsWith('NO PARKING') && /\d+(?::\d+)?\s*[AP]M/i.test(signDesc);
}

// Both OSM-family services (Nominatim and Overpass) expect a real application
// identifier. Overpass answers 406 with an HTML body to User-Agent-less requests,
// which is what left cross-street lookups permanently empty. One constant so the
// two call sites cannot drift apart.
const OSM_USER_AGENT = 'ParkQueenApp/1.0';

// Only real carriageways can bound a block. Footpaths, cycleways, alleys and
// pedestrian plazas cross the target street without being intersections a DOT
// block face is ever named after (Greene Street's "GREENE STREET WALK").
const OSM_ROAD_TYPES = new Set([
  'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
  'unclassified', 'residential', 'living_street',
  'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link',
]);

/**
 * Single entry point for Overpass. Both callers previously did `await res.json()`
 * straight after `fetch`, with no status check: when Overpass is overloaded it
 * answers 504 with an HTML error page (while still sending
 * `Content-Type: application/json`), so JSON.parse threw a SyntaxError that the
 * callers swallowed. Observed in production on the Greene Street fallback.
 *
 * Returns parsed JSON, or null for any non-2xx / non-JSON / network failure.
 * Revalidation can opt into throwing those operational failures so its lease
 * records a retryable outage rather than a deterministic caution result.
 * Deliberately single-shot: no retry, so an Overpass outage is never amplified.
 *
 * Sends OSM_USER_AGENT: Overpass rejects User-Agent-less requests with 406 and an
 * HTML body, so before this header every cross-street lookup came back empty and
 * the NYC Open Data fallback could never disambiguate a block face.
 */
async function _overpassJson(query, label, strictOperationalFailures = false) {
  try {
    const res = await fetch(`https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`, {
      headers: { 'User-Agent': OSM_USER_AGENT },
    });
    if (!res.ok) {
      console.warn(`[Overpass] ${label} non-OK response:`, res.status);
      if (strictOperationalFailures) throw new Error(`overpass_${label}_unavailable`);
      return null;
    }
    const body = await res.text();
    const head = body.trimStart().slice(0, 1);
    // Overpass mislabels HTML error bodies as application/json, so sniff the
    // payload itself rather than trusting the header.
    if (head !== '{' && head !== '[') {
      console.warn(`[Overpass] ${label} returned a non-JSON body (status ${res.status})`);
      if (strictOperationalFailures) throw new Error(`overpass_${label}_invalid_response`);
      return null;
    }
    return JSON.parse(body);
  } catch (err) {
    console.warn(`[Overpass] ${label} fetch error:`, sanitizeError(err));
    if (strictOperationalFailures) throw err;
    return null;
  }
}

/**
 * Maps a Nominatim `address` object to a NYC borough code.
 *
 * Verified against live Nominatim responses for all five boroughs: `suburb` is
 * present in every one and names the borough directly ("Manhattan", "Brooklyn",
 * "Queens", "The Bronx", "Staten Island"). `city_district` and `county` are only
 * sometimes present and carry COUNTY names, so they are consulted second.
 * Returns null when nothing recognisable is present, letting the caller fall
 * back to the coordinate heuristic.
 */
function _boroughFromAddress(address) {
  if (!address || typeof address !== 'object') return null;
  const BY_SUBURB = {
    'manhattan': 'MN',
    'brooklyn': 'BK',
    'queens': 'QN',
    'the bronx': 'BX', 'bronx': 'BX',
    'staten island': 'SI',
  };
  const BY_COUNTY = {
    'new york county': 'MN',
    'kings county': 'BK',
    'queens county': 'QN',
    'bronx county': 'BX',
    'richmond county': 'SI',
  };
  const norm = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : null);
  const suburb = norm(address.suburb);
  if (suburb && BY_SUBURB[suburb]) return BY_SUBURB[suburb];
  for (const field of [address.city_district, address.county, address.borough]) {
    const v = norm(field);
    if (v && BY_COUNTY[v]) return BY_COUNTY[v];
    if (v && BY_SUBURB[v]) return BY_SUBURB[v];
  }
  return null;
}

/**
 * Determines the block the user is standing on, from one Overpass request.
 *
 * Returns the two cross streets that BOUND the block along the target street
 * (in along-street order) plus the cardinal side the user is on. Both are
 * required before a block face may be chosen.
 *
 * This replaces a nearest-midpoint heuristic that returned whichever named ways
 * happened to be closest in a straight line. Those are frequently parallel
 * streets that never meet the target at all — at Bed-Stuy it returned SAINT
 * ANDREWS PLACE, so no candidate could ever match both bounds and every lookup
 * ended as nyc_open_data_ambiguous_block.
 *
 * The bbox is wider than the old ~130 m because a bounding intersection can sit
 * a full long block away; selection is by actual crossing now, not proximity, so
 * the extra ways cost nothing but are filtered to real roads to keep footpaths
 * and service alleys from being treated as intersections.
 */
async function _fetchBlockContext(lat, lng, mainStreetOsmName, strictOperationalFailures = false) {
  const delta = 0.004; // ~440 m: enough to contain both bounds of a long block
  const bbox = `${lat - delta},${lng - delta},${lat + delta},${lng + delta}`;
  const q = `[out:json][timeout:15];way[highway][name](${bbox});out geom;`;
  const EMPTY = { crossStreets: [], side: null, bearing: null };
  try {
    const data = await _overpassJson(q, 'block-context', strictOperationalFailures);
    if (!data || !data.elements?.length) return EMPTY;
    const ways = data.elements
      .filter(el => el.tags?.name && el.geometry?.length >= 2 && OSM_ROAD_TYPES.has(el.tags.highway))
      .map(el => ({ name: osmNameToDOT(el.tags.name), geometry: el.geometry }));
    const ctx = findBlockContext(ways, lat, lng, osmNameToDOT(mainStreetOsmName));
    console.log('[NYCOpenData] block bounds:', ctx.crossStreets, '| side:', ctx.side, '| bearing:', ctx.bearing == null ? null : Math.round(ctx.bearing));
    return ctx;
  } catch (err) {
    console.warn('[NYCOpenData] block-context fetch error:', sanitizeError(err));
    if (strictOperationalFailures) throw err;
    return EMPTY;
  }
}


/** Reverse geocodes lat/lng via Nominatim → OSM road name. */
async function _reverseGeocodeStreet(lat, lng, strictOperationalFailures = false) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=17`;
    const res = await fetch(url, { headers: { 'User-Agent': OSM_USER_AGENT } });
    if (!res.ok) {
      if (strictOperationalFailures) throw new Error('nominatim_unavailable');
      return null;
    }
    const data = await res.json();
    const road = (data && data.address && data.address.road) || null;
    if (!road) return null;
    // The response already carries the borough; it used to be discarded, leaving
    // the caller to guess from coordinates alone.
    return { road, boroughCode: _boroughFromAddress(data && data.address) };
  } catch (err) {
    console.warn('[NYCOpenData] reverse geocode error:', sanitizeError(err));
    if (strictOperationalFailures) throw err;
    return null;
  }
}

/**
 * Reads the Socrata application token at request time.
 *
 * Production gets it from Secret Manager through the bound `socrataAppToken`
 * param. `.value()` throws when the secret is not bound — which is the normal
 * case for emulator and unit runs — so that falls back to the environment,
 * leaving local testing functional while production always uses the secret.
 *
 * The return value is a credential: it is only ever attached as an X-App-Token
 * header (never a query parameter, which would put it in URLs and access logs)
 * and is never logged.
 */
function _socrataToken() {
  try {
    const v = socrataAppToken.value();
    if (v) return v;
  } catch {
    // Not bound in this runtime; fall through to the environment.
  }
  return process.env.SOCRATA_APP_TOKEN || '';
}

/**
 * Queries NYC Open Data nfid-uabd for sign records matching a LIKE street pattern in a borough.
 * Paginates up to 3000 rows to handle long avenues (Broadway, 3rd Ave, Grand Concourse).
 */
async function _queryNYCOpenData(likePattern, borough, strictOperationalFailures = false) {
  const BASE = 'https://data.cityofnewyork.us/resource/nfid-uabd.json';
  const token = _socrataToken();
  if (!token) console.warn('[NYCOpenData] SOCRATA_APP_TOKEN not set — using unauthenticated rate limit');

  const PAGE = 1000;
  const MAX_PAGES = 3;
  const rows = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      // nfid-uabd names the street column `on_street`; there is no `street`
      // column, and querying one 400s the whole page (which is what silently
      // reduced this fallback to zero rows). Ordering uses Socrata's `:id`
      // system field rather than a domain column: it is present regardless of
      // dataset schema and is the documented key for stable $offset paging,
      // so pages cannot overlap or drop rows mid-scan.
      $where: `record_type='Current' AND borough='${borough}' AND on_street LIKE '${likePattern}'`,
      $limit: String(PAGE),
      $offset: String(page * PAGE),
      $order: ':id',
    });

    try {
      // Header, never `$$app_token` in the query string: a token in the URL ends
      // up in proxy and access logs. Socrata accepts X-App-Token for SODA2.
      const headers = { 'Accept': 'application/json' };
      if (token) headers['X-App-Token'] = token;
      const res = await fetch(`${BASE}?${params}`, { headers });
      if (!res.ok) {
        console.warn('[NYCOpenData] API error:', res.status);
        if (strictOperationalFailures) throw new Error('nyc_open_data_unavailable');
        break;
      }
      const batch = await res.json();
      if (!Array.isArray(batch) || !batch.length) break;
      rows.push(...batch);
      if (batch.length < PAGE) break;
    } catch (err) {
      console.warn('[NYCOpenData] fetch error page', page, ':', sanitizeError(err));
      if (strictOperationalFailures) throw err;
      break;
    }
  }

  console.log('[NYCOpenData] fetched', rows.length, 'rows for pattern:', likePattern, 'borough:', borough);
  return rows;
}

/**
 * Main NYC Open Data fallback orchestrator.
 * Called when SweepNYC has no usable data for lat/lng.
 */
async function _fallbackToNYCOpenData(lat, lng, revalidation = null) {
  try {
    const strictOperationalFailures = Boolean(revalidation);
    const geocode = await _reverseGeocodeStreet(lat, lng, strictOperationalFailures);
    if (!geocode) {
      console.warn('[NYCOpenData] reverse geocode returned null — giving up');
      return { success: false, reason: 'no_sweepnyc_data' };
    }
    const osmStreet = geocode.road;
    console.log('[NYCOpenData] OSM street:', osmStreet);

    const dotName = osmNameToDOT(osmStreet);
    const likePattern = streetNameToLikePattern(dotName);
    // Prefer the borough the reverse geocoder reported; the coordinate heuristic
    // is a coarse last resort (it used to place most of Brooklyn in Queens or
    // Manhattan, so the Socrata query searched the wrong borough and matched
    // nothing).
    const boroughSource = geocode.boroughCode ? 'reverse_geocode' : 'coordinates';
    const boroughCode = geocode.boroughCode || _detectBorough(lat, lng);
    const borough = BOROUGH_CODE_TO_NAME[boroughCode] || null;
    if (!borough) {
      console.warn('[NYCOpenData] could not detect borough');
      return { success: false, reason: 'no_sweepnyc_data' };
    }
    console.log('[NYCOpenData] DOT name:', dotName, '| borough:', borough, '| source:', boroughSource, '| pattern:', likePattern);

    const rows = await _queryNYCOpenData(likePattern, borough, strictOperationalFailures);
    const aspRows = rows.filter(r => _isASPSign(r.sign_description));
    console.log('[NYCOpenData] ASP rows:', aspRows.length, '/ total:', rows.length);
    if (!aspRows.length) {
      console.warn('[NYCOpenData] no ASP signs found');
      return { success: false, reason: 'no_sweepnyc_data' };
    }

    // Group by block face (from_street, to_street, side_of_street)
    const groups = {};
    for (const r of aspRows) {
      const key = `${r.from_street || ''}|${r.to_street || ''}|${r.side_of_street || ''}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(r);
    }
    const groupKeys = Object.keys(groups);
    console.log('[NYCOpenData] block face candidates:', groupKeys.length, '| keys:', groupKeys.join(' / '));

    // Block bounds + side from OSM geometry; both empty if Overpass is unavailable,
    // in which case selection stays conservative rather than guessing.
    const blockCtx = await _fetchBlockContext(lat, lng, osmStreet, strictOperationalFailures);
    const crossStreets = blockCtx.crossStreets;
    const userSide = blockCtx.side;
    console.log('[NYCOpenData] bounding cross streets:', crossStreets, '| user side:', userSide);

    const selection = selectBlockFace(groups, crossStreets, userSide);
    if (!selection) {
      console.warn('[NYCOpenData] ambiguous block face — ' + groupKeys.length + ' candidates, crossStreets:', crossStreets, '| side:', userSide, '— returning ambiguous.');
      return {
        success: false,
        reason: 'nyc_open_data_ambiguous_block',
        _diag: { stage: 'nyc_od_ambiguous', onStreet: dotName, borough, candidateCount: groupKeys.length, candidates: groupKeys, crossStreets, userSide },
      };
    }
    const { group: bestGroup, selectionReason, score: selectionScore } = selection;
    const fromStreet = bestGroup[0].from_street || null;
    const toStreet = bestGroup[0].to_street || null;
    const sideOfStreet = bestGroup[0].side_of_street || null;
    console.log('[NYCOpenData] block face selected:', selectionReason, '| from:', fromStreet, '| to:', toStreet, '| side:', sideOfStreet);

    // Dedup: deterministic doc ID keyed on block face — prevents broad street-level cache
    const docId = nycOdSegmentDocId(boroughCode, dotName, fromStreet, toStreet, sideOfStreet);
    if (revalidation && revalidation.segmentId !== docId) {
      return { success: false, reason: 'legacy_revalidation_target_changed' };
    }
    const existingSnap = await db.doc(`streetSegments/${docId}`).get();
    if (existingSnap.exists && !revalidation) {
      const d = existingSnap.data();
      const ps = d.fromLat != null
        ? _detectCardinalSide(lat, lng, d.fromLat, d.fromLng, d.toLat, d.toLng, d.bearing ?? 90)
        : dotSideToCardinal(sideOfStreet);
      console.log('[NYCOpenData] dedup hit block-face segment:', docId);
      return { success: true, segmentId: docId, parkingSide: ps, streetName: d.streetName,
        _diag: { stage: 'dedup_nyc_od', provider: 'nyc_open_data', selectionReason } };
    }

    const PARSER_VERSION = '1.1';
    const streetCtx = {
      street: dotName,
      side: dotSideToCardinal(sideOfStreet) || null,
      fromCross: fromStreet,
      toCross: toStreet,
    };
    // nfid-uabd writes a different sign grammar from SweepNYC — trailing arrows
    // and (SUPERSEDES ...) metadata defeated _parseSweepNYCSign's end anchor, so
    // every row failed and the fallback died at nyc_od_parse with a block face
    // already correctly selected. Source-specific parser, same canonical shape.
    const parsed = [];
    const unparsed = [];
    for (const r of bestGroup) {
      const result = parseNYCOpenDataSign(r.sign_description, streetCtx);
      if (result) parsed.push(result);
      else if (r.sign_description) unparsed.push(r.sign_description);
    }
    console.log('[NYCOpenData] parsed', parsed.length, '/', bestGroup.length, 'signs');
    if (unparsed.length) {
      // Left unparsed on purpose: a sign that cannot be read confidently must not
      // contribute an invented schedule. Logged so the grammar gap is visible.
      console.warn('[NYCOpenData] unparsed sign text:', redactForLog(unparsed[0]).slice(0, 160));
    }
    if (!parsed.length) {
      return { success: false, reason: 'no_sweepnyc_data',
        _diag: { stage: 'nyc_od_parse', aspCount: aspRows.length, groupCount: groupKeys.length, selectionReason } };
    }

    let fromLat, fromLng, toLat, toLng, bearing, geometrySource;
    try {
      const geo = await _fetchStreetGeometry(osmStreet, lat, lng, strictOperationalFailures);
      if (geo) {
        ({ fromLat, fromLng, toLat, toLng, bearing } = geo);
        geometrySource = 'osm';
      } else {
        const HALF = 0.0005;
        fromLat = lat - HALF; fromLng = lng; toLat = lat + HALF; toLng = lng; bearing = 0;
        geometrySource = 'fallback';
      }
    } catch (geoErr) {
      console.error('[NYCOpenData] geometry error:', sanitizeError(geoErr));
      if (strictOperationalFailures) throw geoErr;
      const HALF = 0.0005;
      fromLat = lat - HALF; fromLng = lng; toLat = lat + HALF; toLng = lng; bearing = 0;
      geometrySource = 'fallback';
    }

    const centerLat = (fromLat + toLat) / 2;
    const centerLng = (fromLng + toLng) / 2;
    const geohash = geohashForLocation([centerLat, centerLng], 9);
    const parkingSide = geometrySource === 'osm'
      ? _detectCardinalSide(lat, lng, fromLat, fromLng, toLat, toLng, bearing)
      : streetCtx.side;

    // selectBlockFace only returns a group when the evidence is decisive: it needs
    // BOTH bounding cross streets to match and to beat second place outright,
    // otherwise it returns null and we never get here. 'single_candidate' is the
    // one weaker case -- one group and no cross-street context to confirm it.
    const blockDecisive = selectionReason === 'bounding_pair'
      || selectionReason === 'bounding_pair_and_side';
    // A synthetic centreline only degrades the drawn line. The side then comes
    // from the DOT record's own side_of_street, which is authoritative.
    const sideResolved = Boolean(parkingSide);
    const parseComplete = unparsed.length === 0;
    const blockFaceEvidence = {
      selectionReason,
      selectionScore,
      blockDecisive,
      sideResolved,
      sideSource: geometrySource === 'osm' ? 'geometry' : 'dot_record',
      parseComplete,
      parsedCount: parsed.length,
      unparsedCount: unparsed.length,
      groupSize: bestGroup.length,
    };
    const confidenceMetadata = deriveNYCOpenDataConfidence(blockFaceEvidence);

    const now = Timestamp.now();
    const sourceOrderNumbers = bestGroup.map(r => r.order_number).filter(Boolean);
    const provenance = {
      provider: 'nyc_open_data',
      fetchedAt: now,
      parserVersion: PARSER_VERSION,
      rawSignTexts: bestGroup.map(r => r.sign_description || ''),
      geometrySource,
      sourceOrderNumbers,
      refreshedAt: revalidation ? now : null,
      refreshCount: revalidation
        ? Number(existingSnap.data()?.provenance?.refreshCount || 0) + 1
        : 0,
    };

    const segRef = db.doc(`streetSegments/${docId}`);
    const segmentWrite = {
      cityId: 'nyc',
      streetName: dotName,
      onStreet: dotName,
      fromStreet,
      toStreet,
      sideOfStreet,
      fromCross: fromStreet,
      toCross: toStreet,
      borough: boroughCode,
      fromLat, fromLng, toLat, toLng,
      centerLat, centerLng, bearing,
      geohash,
      evenSideIsPositiveCross: false,
      source: 'nyc_open_data',
      provenance,
      blockFaceEvidence,
      needsReview: confidenceMetadata.needsReview,
      status: confidenceMetadata.status,
      confidenceScore: confidenceMetadata.confidenceScore,
      confidence: {
        level: confidenceMetadata.level,
        source: 'nyc_open_data',
        lastVerifiedAt: now,
        communityConfirmations: 0,
      },
      editedBy: 'system:nyc_open_data',
      ...(revalidation ? {
        legacyRevalidation: {
          version: NYC_OD_EVIDENCE_REVALIDATION_VERSION,
          state: 'complete',
          operationId: revalidation.operationId,
          completedAt: now,
        },
      } : { createdAt: now }),
      updatedAt: now,
    };

    const ruleRef = segRef.collection('streetRules').doc('nyc_open_data_v1');
    const ruleWrite = {
      type: 'streetCleaning',
      effectiveDate: now,
      supersededAt: null,
      status: 'active',
      schedules: parsed.map(p => {
        const s = { side: p.side, days: p.days, startTime: p.startTime, endTime: p.endTime };
        if (p.ruleType) s.ruleType = p.ruleType;
        return s;
      }),
      source: 'nyc_open_data',
      provenance,
      needsReview: confidenceMetadata.needsReview,
      lastSourceSync: new Date().toISOString(),
      ...(revalidation ? {} : { createdAt: now }),
      updatedAt: now,
    };

    if (revalidation) {
      const applied = await db.runTransaction(async tx => {
        const current = await tx.get(segRef);
        const marker = current.exists ? current.data().legacyRevalidation : null;
        if (marker?.version !== NYC_OD_EVIDENCE_REVALIDATION_VERSION
          || marker?.operationId !== revalidation.operationId
          || marker?.state !== 'in_progress') return false;
        tx.set(segRef, segmentWrite, { merge: true });
        tx.set(ruleRef, ruleWrite, { merge: true });
        return true;
      });
      if (!applied) return { success: false, reason: 'legacy_revalidation_claim_lost' };
    } else {
      await segRef.set(segmentWrite);
      await ruleRef.set(ruleWrite);
    }

    console.log('[NYCOpenData] wrote segment', docId, '| parkingSide:', parkingSide, '| geometrySource:', geometrySource, '| selectionReason:', selectionReason, '| decisive:', confidenceMetadata.decisive);
    return {
      success: true,
      segmentId: docId,
      parkingSide,
      streetName: dotName,
      _diag: {
        stage: 'nyc_od_complete',
        provider: 'nyc_open_data',
        geometrySource,
        selectionReason,
        selectionScore,
        crossStreets,
        onStreet: dotName,
        fromStreet,
        toStreet,
        sideOfStreet,
        aspCount: aspRows.length,
        parsedCount: parsed.length,
        needsReview: confidenceMetadata.needsReview,
        blockFaceEvidence,
      },
    };
  } catch (err) {
    console.error('[NYCOpenData] fallback error:', sanitizeError(err));
    return { success: false, reason: 'unknown_error',
      _diag: { stage: 'nyc_od_top', error: sanitizeError(err) } };
  }
}

// ── Private helpers used by createSegmentFromSweepNYC ────────────────────────

const _DAY_ABBR = {
  Monday: 'Mon', Tuesday: 'Tue', Wednesday: 'Wed', Thursday: 'Thu',
  Friday: 'Fri', Saturday: 'Sat', Sunday: 'Sun',
  // lowercase full names
  monday: 'Mon', tuesday: 'Tue', wednesday: 'Wed', thursday: 'Thu',
  friday: 'Fri', saturday: 'Sat', sunday: 'Sun',
  // uppercase abbreviations already canonical
  MON: 'Mon', TUE: 'Tue', WED: 'Wed', THU: 'Thu', FRI: 'Fri', SAT: 'Sat', SUN: 'Sun',
};

function _parseFlexibleTime(t) {
  // Accepts: "8 AM", "8:30AM", "8:30 A.M.", "10 PM", "10:00 PM"
  const clean = t.replace(/\./g, '').replace(/\s+/g, '').toUpperCase();
  const m = clean.match(/^(\d+)(?::(\d+))?(AM|PM)$/);
  if (!m) return '00:00';
  let h = parseInt(m[1]);
  const min = m[2] ? parseInt(m[2]) : 0;
  if (m[3] === 'PM' && h !== 12) h += 12;
  if (m[3] === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function _extractStreetContext(apiData, notes) {
  // Try top-level API fields first (SweepNYC may expose them directly)
  const street = apiData.StreetName || apiData.OnStreet || apiData.Street ||
                 (notes && (notes.StreetName || notes.OnStreet)) || null;
  const fromCross = apiData.FromStreet || (notes && notes.FromStreet) || null;
  const toCross = apiData.ToStreet || (notes && notes.ToStreet) || null;
  // Side: SideOfStreet, SideName, Side
  const sideRaw = apiData.SideOfStreet || apiData.SideName || apiData.Side ||
                  (notes && (notes.SideOfStreet || notes.SideName || notes.Side)) || null;
  const SIDE_MAP = { N: 'North', S: 'South', E: 'East', W: 'West', NORTH: 'North', SOUTH: 'South', EAST: 'East', WEST: 'West' };
  const side = sideRaw ? (SIDE_MAP[String(sideRaw).toUpperCase()] || sideRaw) : null;
  return { street, fromCross, toCross, side };
}

// Maps "Except Sunday" / "Except Sunday and Holidays" → the days that DO apply.
// Unrecognised tokens (Holidays, Public, etc.) are silently ignored.
function _exceptDaysToDays(exceptStr) {
  const ALL_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const excluded = new Set();
  for (const t of exceptStr.split(/\s+and\s+|\s*,\s*|\s+/)) {
    const abbr = _DAY_ABBR[t] || _DAY_ABBR[t.toLowerCase()];
    if (abbr) excluded.add(abbr);
  }
  return ALL_DAYS.filter(d => !excluded.has(d));
}

const _SIDE_MAP = { N: 'North', S: 'South', E: 'East', W: 'West', NORTH: 'North', SOUTH: 'South', EAST: 'East', WEST: 'West' };

function _parseSweepNYCSign(signText, streetCtx) {
  if (!signText) return null;
  const ctx = streetCtx || {};

  // Branch 1: Classic ASP — "No Parking <days> <time>-<time> [on <street> ...] [(Side: X)]"
  const m = signText.match(
    /No Parking\s+(.+?)\s+(\d+(?::\d+)?\s*[AP]\.?M\.?)\s*[-–]\s*(\d+(?::\d+)?\s*[AP]\.?M\.?)(?:\s+on\s+(.+?)(?:\s+from\s+(.+?)\s+to\s+(.+?))?)?(?:\s+\(Side:\s*(\w+)\))?$/i,
  );

  if (m) {
    const [, daysRaw, startRaw, endRaw, streetInSign, fromCrossInSign, toCrossInSign, sideInSign] = m;
    const dayTokens = daysRaw.trim().split(/[\s,]+/).map(d => d.trim()).filter(Boolean);
    const days = dayTokens
      .map(d => _DAY_ABBR[d] || _DAY_ABBR[d.toUpperCase()] || (d.length <= 3 ? d.charAt(0).toUpperCase() + d.slice(1).toLowerCase() : null))
      .filter(Boolean);
    if (!days.length) return null;
    const sideRaw = ctx.side || sideInSign || null;
    return {
      street: ctx.street || streetInSign || 'Unknown Street',
      fromCross: ctx.fromCross || fromCrossInSign || null,
      toCross: ctx.toCross || toCrossInSign || null,
      side: sideRaw ? (_SIDE_MAP[String(sideRaw).toUpperCase()] || sideRaw) : null,
      days,
      startTime: _parseFlexibleTime(startRaw),
      endTime: _parseFlexibleTime(endRaw),
    };
  }

  // Branch 2: Metered short window — "No Parking <time>-<time> Except <days> on <street> [from <cross> to <cross>] [(Side: X)]"
  // e.g. "No Parking 8:30AM-9AM Except Sunday on Maran Place from White Plains Road to Cruger Avenue (Side: South)"
  const m2 = signText.match(
    /No Parking\s+(\d+(?::\d+)?\s*[AP]\.?M\.?)\s*[-–]\s*(\d+(?::\d+)?\s*[AP]\.?M\.?)\s+Except\s+(.+?)\s+on\s+(.+?)(?:\s+from\s+(.+?)\s+to\s+(.+?))?(?:\s+\(Side:\s*(\w+)\))?$/i,
  );

  if (!m2) return null;

  const [, startRaw2, endRaw2, exceptPart, streetInSign2, fromCrossInSign2, toCrossInSign2, sideInSign2] = m2;
  const days2 = _exceptDaysToDays(exceptPart);
  if (!days2.length) return null;

  const sideRaw2 = ctx.side || sideInSign2 || null;
  return {
    street: ctx.street || streetInSign2 || 'Unknown Street',
    fromCross: ctx.fromCross || fromCrossInSign2 || null,
    toCross: ctx.toCross || toCrossInSign2 || null,
    side: sideRaw2 ? (_SIDE_MAP[String(sideRaw2).toUpperCase()] || sideRaw2) : null,
    days: days2,
    startTime: _parseFlexibleTime(startRaw2),
    endTime: _parseFlexibleTime(endRaw2),
    ruleType: 'metered_no_parking_window',
  };
}

function _computeBearing(fromLat, fromLng, toLat, toLng) {
  const dLon = ((toLng - fromLng) * Math.PI) / 180;
  const lat1 = (fromLat * Math.PI) / 180;
  const lat2 = (toLat * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon);
  return (Math.atan2(y, x) * (180 / Math.PI) + 360) % 360;
}

async function _fetchStreetGeometry(streetName, lat, lng, strictOperationalFailures = false) {
  const delta = 0.003;
  const bbox = `${lat - delta},${lng - delta},${lat + delta},${lng + delta}`;
  const q = `[out:json][timeout:10];way[name="${streetName}"](${bbox});out geom;`;
  try {
    const data = await _overpassJson(q, 'street-geometry', strictOperationalFailures);
    if (!data || !data.elements?.length) return null;
    // Use the single way closest to (lat, lng) — prevents multi-block bearing errors from aggregating all ways
    const validWays = data.elements.filter(el => el.geometry && el.geometry.length >= 2);
    if (!validWays.length) return null;
    const closestWay = validWays.reduce((best, el) => {
      const mid = el.geometry[Math.floor(el.geometry.length / 2)];
      const d = (mid.lat - lat) ** 2 + (mid.lon - lng) ** 2;
      return (!best || d < best.d) ? { el, d } : best;
    }, null);
    const wayNodes = closestWay.el.geometry;
    if (wayNodes.length < 2) return null;
    let fromLat = wayNodes[0].lat, fromLng = wayNodes[0].lon;
    let toLat = wayNodes[wayNodes.length - 1].lat, toLng = wayNodes[wayNodes.length - 1].lon;
    let bearing = _computeBearing(fromLat, fromLng, toLat, toLng);
    if (bearing > 180) {
      [fromLat, toLat] = [toLat, fromLat];
      [fromLng, toLng] = [toLng, fromLng];
      bearing = _computeBearing(fromLat, fromLng, toLat, toLng);
    }
    return { fromLat, fromLng, toLat, toLng, bearing };
  } catch (err) {
    if (strictOperationalFailures) throw err;
    return null;
  }
}

/**
 * Coarse coordinate fallback, used only when the reverse geocoder gives no
 * borough (and by the SweepNYC path, which has no geocode result at all).
 *
 * The previous version tested `lat < 40.648` for Brooklyn, which only catches
 * its southern tip: Bed-Stuy, Williamsburg, Park Slope, Flatbush, Greenpoint and
 * Brooklyn Heights all fell through to Queens or Manhattan. It scored 20/27 on
 * the reference points in nycBorough.test.js and 0/8 on Brooklyn.
 *
 * This version approximates the real water boundaries: the Narrows for Staten
 * Island, the Harlem River for the Bronx (piecewise, so Manhattan's northern tip
 * at Inwood stays Manhattan), the East River for Manhattan, and the
 * Newtown Creek -> Jamaica Bay diagonal for Brooklyn/Queens. 27/27 on the same
 * reference points. Still an approximation — the geocoded borough wins whenever
 * it is available.
 */
function _detectBorough(lat, lng) {
  // Staten Island: west of the Narrows / Arthur Kill.
  if (lng < -74.035) return 'SI';
  // Bronx: north of the Harlem River. The river's longitude shifts east above
  // ~40.855, which is what keeps Inwood/Marble Hill on the Manhattan side.
  if (lat > 40.800) {
    const harlemRiver = lat > 40.855 ? -73.912 : -73.933;
    if (lng > harlemRiver) return 'BX';
  }
  // Manhattan: the island itself, eastern edge tracking the East River.
  const eastRiver = -73.972 + (lat - 40.700) * 0.36;
  if (lat >= 40.695 && lat <= 40.882 && lng >= -74.025 && lng <= eastRiver) return 'MN';
  // Everything left is Brooklyn or Queens, split by the line running from
  // Newtown Creek (40.738, -73.962) southeast to Jamaica Bay (40.640, -73.858).
  const side = 0.104 * (lat - 40.738) + 0.098 * (lng + 73.962);
  return side < 0 ? 'BK' : 'QN';
}

function _detectCardinalSide(userLat, userLng, fromLat, fromLng, toLat, toLng, bearing) {
  const dx = toLng - fromLng;
  const dy = toLat - fromLat;
  const cross = dx * (userLat - fromLat) - dy * (userLng - fromLng);
  const isPositive = cross > 0;
  if (bearing < 45) return isPositive ? 'West' : 'East';
  if (bearing < 135) return isPositive ? 'North' : 'South';
  return isPositive ? 'East' : 'West';
}

async function _logParseFailure(rawNotes, sweepNYCObjectId, rawSignText, lat, lng, parserVersion) {
  const normalized = rawSignText.trim().replace(/\s+/g, ' ');
  const b64 = Buffer.from(encodeURIComponent(normalized)).toString('base64');
  const docId = `${b64.replace(/[^a-zA-Z0-9]/g, '').slice(0, 40)}_v${parserVersion.replace(/\./g, '_')}`;
  const failureRef = db.doc(`parseFailures/${docId}`);
  const existing = await failureRef.get();
  if (existing.exists) {
    await failureRef.update({ count: FieldValue.increment(1), lastSeenAt: Timestamp.now(), lat, lng, sweepNYCObjectId });
  } else {
    await failureRef.set({
      rawSignText: normalized,
      rawNotes,
      sweepNYCObjectId,
      lat, lng,
      parserVersion,
      count: 1,
      firstSeenAt: Timestamp.now(),
      lastSeenAt: Timestamp.now(),
      resolvedAt: null,
    });
  }
}

// ─── Gemini AI — server-side proxy ───────────────────────────────────────────
// Key stored in Secret Manager; never exposed to the browser bundle.

const GEMINI_MODEL = "gemini-3.5-flash";

// analyzeSign only — deliberately NOT shared with generateSmartReplies or
// generateListingDescription, which have their own generation configs.
//
// Why a responseSchema and not just responseMimeType: with the mime type alone
// the model opened its reply with the prose preamble "Here is the JSON
// requested:" instead of a JSON object. A schema constrains decoding, so the
// first token is the object itself.
//
// Fields mirror the client's SignAnalysisResult exactly (services/geminiService.ts).
// Nothing is added here that the UI does not already consume.
const SIGN_ANALYSIS_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    status: { type: Type.STRING, enum: ["YES", "NO", "CONDITIONAL"] },
    explanation: { type: Type.STRING },
    restrictionStartsAt: { type: Type.STRING, nullable: true },
    restrictionEndsAt: { type: Type.STRING, nullable: true },
    actionableAdvice: { type: Type.STRING, nullable: true },
  },
  required: ["status", "explanation"],
  propertyOrdering: ["status", "explanation", "restrictionStartsAt", "restrictionEndsAt", "actionableAdvice"],
};

// Thinking tokens are drawn from maxOutputTokens. The previous cap of 300 was
// spent almost entirely on thinking (measured: 288 thought tokens, 8 output
// tokens, finishReason MAX_TOKENS), so the reply was truncated mid-preamble and
// never parsed. Sign reading is structured extraction rather than multi-step
// reasoning, so thinking is disabled and the whole budget goes to the answer.
// A complete answer measured 176 output tokens; 512 leaves roughly 3x headroom
// for a crowded multi-sign pole while still capping cost per call.
const SIGN_ANALYSIS_MAX_OUTPUT_TOKENS = 512;
const SIGN_ANALYSIS_THINKING_BUDGET = 0;

/**
 * Turns raw model text into the client contract, or a conservative ERROR.
 *
 * Every failure mode — empty, truncated, malformed, blocked, or a status the
 * allowlist does not recognise — resolves to ERROR. Uncertainty must never
 * become permission to park, so there is no path here that invents a YES.
 */
function _parseSignAnalysis(text) {
  if (typeof text !== "string" || text.trim() === "") {
    return { status: "ERROR", explanation: "Could not read a result from the sign analysis." };
  }
  const cleaned = text.replace(/```json/g, "").replace(/```/g, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return { status: "ERROR", explanation: "Could not parse sign analysis response." };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: "ERROR", explanation: "Could not parse sign analysis response." };
  }
  // Model output is untrusted data, not a pass-through payload, however
  // well-formed the JSON is.
  const ALLOWED_STATUS = new Set(["YES", "NO", "CONDITIONAL"]);
  const boundStr = (v, max) => (typeof v === "string" ? v.slice(0, max) : null);
  // Trimmed: a whitespace-only explanation is no explanation, and would
  // otherwise sail through the emptiness check below as a definitive verdict.
  const explanation = (boundStr(parsed.explanation, 300) || "").trim();
  // A verdict with no explanation behind it is not something to show as fact.
  if (!ALLOWED_STATUS.has(parsed.status) || explanation === "") {
    return { status: "ERROR", explanation: "Could not parse sign analysis response." };
  }
  return {
    status: parsed.status,
    explanation,
    restrictionStartsAt: boundStr(parsed.restrictionStartsAt, 40),
    restrictionEndsAt: boundStr(parsed.restrictionEndsAt, 40),
    actionableAdvice: boundStr(parsed.actionableAdvice, 150),
  };
}

// ─── generateSmartReplies ────────────────────────────────────────────────────
// Same regression as analyzeSign: thinking tokens are drawn from
// maxOutputTokens, so the 60-token cap left 2 tokens for the answer (measured:
// 54 thought / 2 output, finishReason MAX_TOKENS, a 3-character result).
//
// The old contract asked for a comma-separated list and split on ",", which
// also broke on any reply containing a comma and turned an empty response into
// [""] — a blank suggestion pill that sent an empty message when tapped.
const SMART_REPLY_COUNT = 3;
const MAX_REPLY_LENGTH = 80;
const SMART_REPLIES_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    replies: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      minItems: String(SMART_REPLY_COUNT),
      maxItems: String(SMART_REPLY_COUNT),
    },
  },
  required: ["replies"],
};
// A complete answer measured 43 output tokens with thinking disabled. The hard
// ceiling is 3 replies x MAX_REPLY_LENGTH plus JSON syntax, well under this.
const SMART_REPLIES_MAX_OUTPUT_TOKENS = 192;
const SMART_REPLIES_THINKING_BUDGET = 0;

/**
 * Returns at most SMART_REPLY_COUNT clean, distinct suggestions, or [] when the
 * model output is unusable.
 *
 * [] is deliberate: MessagesView renders the strip only when replies.length > 0,
 * so an empty array degrades to showing nothing. Never return a partial or
 * empty-string reply — the UI turns each entry into a tappable send button.
 */
function _parseSmartReplies(text) {
  if (typeof text !== "string" || text.trim() === "") return [];
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/```json/g, "").replace(/```/g, "").trim());
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.replies)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of parsed.replies) {
    if (typeof raw !== "string") continue;
    const reply = raw.trim().slice(0, MAX_REPLY_LENGTH).trim();
    if (reply === "") continue;
    const key = reply.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(reply);
    if (out.length === SMART_REPLY_COUNT) break;
  }
  return out;
}

// ─── generateListingDescription ──────────────────────────────────────────────
// Measured: 112 thought / 4 output tokens against the old 120-token cap, so the
// client received a ~20-character fragment. A fragment is truthy, so it also
// slipped past the `|| fallback` guard the old code relied on.
const MAX_DESCRIPTION_LENGTH = 400;
const LISTING_DESCRIPTION_SCHEMA = {
  type: Type.OBJECT,
  properties: { description: { type: Type.STRING } },
  required: ["description"],
};
// A complete answer measured 45 output tokens with thinking disabled; this also
// leaves room for a description that runs to the full MAX_DESCRIPTION_LENGTH.
const LISTING_DESCRIPTION_MAX_OUTPUT_TOKENS = 256;
const LISTING_DESCRIPTION_THINKING_BUDGET = 0;
const LISTING_DESCRIPTION_FALLBACK = "A great parking spot in the heart of the city.";

/** Returns a trimmed, bounded description, or null when the output is unusable. */
function _parseListingDescription(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(text.replace(/```json/g, "").replace(/```/g, "").trim());
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || typeof parsed.description !== "string") return null;
  const description = parsed.description.trim().slice(0, MAX_DESCRIPTION_LENGTH).trim();
  return description === "" ? null : description;
}

/**
 * Safe failure logging shared by the Gemini callables.
 *
 * Records only shape and budget metadata. Never the prompt, the conversation,
 * the model text or the key — smart replies carry private message content, so
 * there is nothing here that could echo it.
 */
function _logGeminiShortfall(fn, response, cap, category) {
  const usage = response?.usageMetadata || {};
  console.error(
    `[${fn}] unusable model response — model:${GEMINI_MODEL}` +
    ` finish:${response?.candidates?.[0]?.finishReason ?? "unknown"}` +
    ` block:${response?.promptFeedback?.blockReason ?? "none"}` +
    ` textLen:${typeof response?.text === "string" ? response.text.length : -1}` +
    ` thoughtTokens:${usage.thoughtsTokenCount ?? 0}` +
    ` outputTokens:${usage.candidatesTokenCount ?? 0}` +
    ` maxOutputTokens:${cap}` +
    ` category:${category}`
  );
}

// Declared after the consts above: the main export block runs earlier in the
// file, where these are still in the temporal dead zone.
exports._haversineMeters    = _haversineMeters;
exports._hydrantRowLatLng   = _hydrantRowLatLng;
exports._isWithinNYC        = _isWithinNYC;
exports._parseSignAnalysis  = _parseSignAnalysis;
exports._signAnalysisConfig = {
  schema: SIGN_ANALYSIS_SCHEMA,
  maxOutputTokens: SIGN_ANALYSIS_MAX_OUTPUT_TOKENS,
  thinkingBudget: SIGN_ANALYSIS_THINKING_BUDGET,
};
exports._parseSmartReplies       = _parseSmartReplies;
exports._parseListingDescription = _parseListingDescription;
exports._smartRepliesConfig = {
  schema: SMART_REPLIES_SCHEMA,
  maxOutputTokens: SMART_REPLIES_MAX_OUTPUT_TOKENS,
  thinkingBudget: SMART_REPLIES_THINKING_BUDGET,
  replyCount: SMART_REPLY_COUNT,
  maxReplyLength: MAX_REPLY_LENGTH,
};
exports._listingDescriptionConfig = {
  schema: LISTING_DESCRIPTION_SCHEMA,
  maxOutputTokens: LISTING_DESCRIPTION_MAX_OUTPUT_TOKENS,
  thinkingBudget: LISTING_DESCRIPTION_THINKING_BUDGET,
  maxDescriptionLength: MAX_DESCRIPTION_LENGTH,
  fallback: LISTING_DESCRIPTION_FALLBACK,
};

// Narrow image-format allowlist for analyzeSign — checked against the decoded
// byte prefix (not the client-asserted MIME, which the client never sends)
// so a non-image payload can't reach the paid vision API at all. JPEG/PNG/WEBP
// cover camera + gallery uploads; SVG and other application/* are rejected by omission.
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function detectImageMimeType(base64) {
  const header = Buffer.from(base64.slice(0, 32), "base64");
  if (header.length >= PNG_MAGIC.length && PNG_MAGIC.every((b, i) => header[i] === b)) return "image/png";
  if (header.length >= JPEG_MAGIC.length && JPEG_MAGIC.every((b, i) => header[i] === b)) return "image/jpeg";
  if (header.length >= 12 && header.toString("ascii", 0, 4) === "RIFF" && header.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  return null;
}

function classifyGeminiError(fn, err) {
  const status = err?.status ?? err?.error?.code;
  const grpcStatus = err?.error?.status ?? "";
  let code, clientMessage;
  if (status === 429 || grpcStatus === "RESOURCE_EXHAUSTED") {
    code = "resource-exhausted";
    clientMessage = "The AI service is temporarily unavailable. Please try again shortly.";
  } else if (status === 400 || grpcStatus === "INVALID_ARGUMENT") {
    code = "invalid-argument";
    clientMessage = "The request could not be processed. Check the image or input.";
  } else if (status === 401 || status === 403 || grpcStatus === "PERMISSION_DENIED" || grpcStatus === "UNAUTHENTICATED") {
    code = "failed-precondition";
    clientMessage = "The AI service is temporarily unavailable. Please try again shortly.";
  } else if (status === 404 || grpcStatus === "NOT_FOUND") {
    code = "failed-precondition";
    clientMessage = "The AI service is temporarily unavailable. Please try again shortly.";
  } else if (status === 503 || grpcStatus === "UNAVAILABLE") {
    code = "unavailable";
    clientMessage = "The AI service is temporarily unavailable. Please try again shortly.";
  } else {
    code = "internal";
    clientMessage = "The AI service is temporarily unavailable. Please try again shortly.";
  }
  console.error(`[${fn}] Gemini error — model:${GEMINI_MODEL} http:${status} grpc:${grpcStatus}`);
  throw new HttpsError(code, clientMessage);
}

exports.analyzeSign = onCall(
  { secrets: [geminiApiKey], enforceAppCheck: false, serviceAccount: 'parqueen-ai@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");
    const { imageBase64 } = request.data || {};
    if (typeof imageBase64 !== "string" || imageBase64.length === 0) {
      throw new HttpsError("invalid-argument", "imageBase64 is required.");
    }
    // ~4MB limit: base64 encodes 3 bytes as 4 chars, so 4MB raw ≈ 5.5M chars
    if (imageBase64.length > 5_500_000) {
      throw new HttpsError("invalid-argument", "Image too large. Maximum 4 MB.");
    }
    const mimeType = detectImageMimeType(imageBase64);
    if (!mimeType) {
      throw new HttpsError("invalid-argument", "Unsupported image format. Use JPEG, PNG, or WEBP.");
    }
    // Validation above is O(1)/bounded-prefix only, so it's cheap to run before
    // spending a rate-limit slot — mirrors moderateContent's ordering.
    await checkRateLimit(request.auth.uid, 'analyzeSign', { limit: 30, windowSec: 3600 });
    let response;
    try {
      if (_callableHooks.analyzeSignResponse) {
        response = await _callableHooks.analyzeSignResponse(imageBase64, mimeType);
      } else {
        const ai = new GoogleGenAI({ apiKey: geminiApiKey.value() });
        response = await ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: {
            parts: [
              { inlineData: { mimeType, data: imageBase64 } },
              {
                // The shape is enforced by SIGN_ANALYSIS_SCHEMA, so the prompt
                // no longer restates it — it carries the reading rules and the
                // conservative-status rule instead.
                text: `You are a NYC parking expert. Analyze this parking sign image.
Crucially, there may be MULTIPLE stacked signs on this pole. Read all of them carefully. Resolve any conflicting rules (e.g. temporary construction signs override permanent signs).
Report whether a driver may park at this spot right now: "YES" only if parking is clearly permitted, "NO" if clearly prohibited, and "CONDITIONAL" whenever the answer depends on the day or time, or the sign is ambiguous or only partly legible.
Give restrictionStartsAt and restrictionEndsAt as ISO timestamps, or null when unknown or not applicable. Keep the explanation to one sentence and the advice short, e.g. "Move car by 4 PM".`,
              },
            ],
          },
          config: {
            maxOutputTokens: SIGN_ANALYSIS_MAX_OUTPUT_TOKENS,
            responseMimeType: "application/json",
            responseSchema: SIGN_ANALYSIS_SCHEMA,
            thinkingConfig: { thinkingBudget: SIGN_ANALYSIS_THINKING_BUDGET },
          },
        });
      }
    } catch (err) {
      classifyGeminiError("analyzeSign", err);
    }
    const result = _parseSignAnalysis(response?.text);
    if (result.status === "ERROR") {
      // Metadata only — never the model text, the image, or the API key. This
      // is what was missing when the 300-token cap silently broke every scan:
      // the failure was invisible in logs because nothing recorded it.
      const usage = response?.usageMetadata || {};
      console.error(
        `[analyzeSign] unusable model response — model:${GEMINI_MODEL}` +
        ` finish:${response?.candidates?.[0]?.finishReason ?? "unknown"}` +
        ` block:${response?.promptFeedback?.blockReason ?? "none"}` +
        ` textLen:${typeof response?.text === "string" ? response.text.length : -1}` +
        ` thoughtTokens:${usage.thoughtsTokenCount ?? 0}` +
        ` outputTokens:${usage.candidatesTokenCount ?? 0}` +
        ` maxOutputTokens:${SIGN_ANALYSIS_MAX_OUTPUT_TOKENS}`
      );
    }
    return result;
  }
);

exports.generateSmartReplies = onCall(
  { secrets: [geminiApiKey], enforceAppCheck: false, serviceAccount: 'parqueen-ai@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");
    const { lastMessage, context } = request.data || {};
    if (typeof lastMessage !== "string" || lastMessage.length === 0) {
      throw new HttpsError("invalid-argument", "lastMessage is required.");
    }
    if (lastMessage.length > 500) {
      throw new HttpsError("invalid-argument", "lastMessage must be 500 characters or fewer.");
    }
    if (context !== undefined && typeof context !== "string") {
      throw new HttpsError("invalid-argument", "context must be a string.");
    }
    if (typeof context === "string" && context.length > 2000) {
      throw new HttpsError("invalid-argument", "context must be 2000 characters or fewer.");
    }
    // Validation above is O(1) string-length work, cheap before a rate-limit slot.
    await checkRateLimit(request.auth.uid, 'generateSmartReplies', { limit: 20, windowSec: 3600 });
    const safeMessage = lastMessage;
    const safeContext = typeof context === "string" ? context : "";
    let response;
    try {
      if (_callableHooks.smartRepliesResponse) {
        response = await _callableHooks.smartRepliesResponse(safeMessage, safeContext);
      } else {
        const ai = new GoogleGenAI({ apiKey: geminiApiKey.value() });
        response = await ai.models.generateContent({
          model: GEMINI_MODEL,
          // The array shape is enforced by SMART_REPLIES_SCHEMA, so the prompt
          // no longer asks for a comma-separated list to be split apart.
          contents: `You are an AI assistant in a parking app called ParQueen.
The user just received this message: "${safeMessage}".
Context: ${safeContext}.
Suggest exactly ${SMART_REPLY_COUNT} short, natural, polite replies the user might send back. Each must be at most 5 words, and all ${SMART_REPLY_COUNT} must be different from each other.`,
          config: {
            maxOutputTokens: SMART_REPLIES_MAX_OUTPUT_TOKENS,
            responseMimeType: "application/json",
            responseSchema: SMART_REPLIES_SCHEMA,
            thinkingConfig: { thinkingBudget: SMART_REPLIES_THINKING_BUDGET },
          },
        });
      }
    } catch (err) {
      classifyGeminiError("generateSmartReplies", err);
    }
    // A truncated reply is not a shorter reply, it is a broken one, so a
    // MAX_TOKENS finish is rejected even if what arrived happens to parse.
    const truncated = response?.candidates?.[0]?.finishReason === "MAX_TOKENS";
    const replies = truncated ? [] : _parseSmartReplies(response?.text);
    if (replies.length === 0) {
      _logGeminiShortfall(
        "generateSmartReplies", response, SMART_REPLIES_MAX_OUTPUT_TOKENS,
        truncated ? "truncated" : "unusable"
      );
    }
    // Empty means "no suggestions": the chat strip hides itself rather than
    // offering a blank pill that would send an empty message when tapped.
    return { replies };
  }
);

exports.generateListingDescription = onCall(
  { secrets: [geminiApiKey], enforceAppCheck: false, serviceAccount: 'parqueen-ai@parkqueen-46475363-ccf36.iam.gserviceaccount.com' },
  async (request) => {
    if (!request.auth) throw new HttpsError("unauthenticated", "Must be signed in.");
    const { features } = request.data || {};
    const MAX_FEATURES = 10;
    const MAX_FEATURE_LENGTH = 60;
    if (!Array.isArray(features) || features.length === 0) {
      throw new HttpsError("invalid-argument", "features array is required.");
    }
    if (features.length > MAX_FEATURES) {
      throw new HttpsError("invalid-argument", `features must contain ${MAX_FEATURES} items or fewer.`);
    }
    if (!features.every((f) => typeof f === "string" && f.length > 0 && f.length <= MAX_FEATURE_LENGTH)) {
      throw new HttpsError("invalid-argument", `Each feature must be a non-empty string of ${MAX_FEATURE_LENGTH} characters or fewer.`);
    }
    // Validation above is O(MAX_FEATURES) at most (count checked first), cheap
    // before a rate-limit slot.
    await checkRateLimit(request.auth.uid, 'generateListingDescription', { limit: 20, windowSec: 3600 });
    let response;
    try {
      if (_callableHooks.geminiResponse) {
        response = await _callableHooks.geminiResponse(features);
      } else {
        const ai = new GoogleGenAI({ apiKey: geminiApiKey.value() });
        response = await ai.models.generateContent({
          model: GEMINI_MODEL,
          contents: `Write a catchy, short marketing description (max 2 sentences) for a parking spot in NYC with these features: ${features.join(", ")}. Use a premium, trustworthy tone.`,
          config: {
            maxOutputTokens: LISTING_DESCRIPTION_MAX_OUTPUT_TOKENS,
            responseMimeType: "application/json",
            responseSchema: LISTING_DESCRIPTION_SCHEMA,
            thinkingConfig: { thinkingBudget: LISTING_DESCRIPTION_THINKING_BUDGET },
          },
        });
      }
    } catch (err) {
      classifyGeminiError("generateListingDescription", err);
    }
    // A cut-off sentence is still a truthy string, which is how the old
    // `|| fallback` guard let ~20-character fragments through to the client.
    const truncated = response?.candidates?.[0]?.finishReason === "MAX_TOKENS";
    const parsed = truncated ? null : _parseListingDescription(response?.text);
    if (parsed === null) {
      _logGeminiShortfall(
        "generateListingDescription", response, LISTING_DESCRIPTION_MAX_OUTPUT_TOKENS,
        truncated ? "truncated" : "unusable"
      );
    }
    return { description: parsed ?? LISTING_DESCRIPTION_FALLBACK };
  }
);

// ─── Marketing-site waitlist (double opt-in) ─────────────────────────────────
// Public HTTP endpoints reached same-origin through the marketing site's
// Firebase Hosting rewrites (/api/waitlist, /api/waitlist/confirm). Logic and
// the privacy contract live in ./waitlist.js; see docs/WAITLIST.md.
//
// Operator actions before deploy (random 32-byte hex for the peppers):
//   firebase functions:secrets:set WAITLIST_ID_PEPPER
//   firebase functions:secrets:set WAITLIST_RATE_LIMIT_PEPPER
//   firebase functions:secrets:set TURNSTILE_SECRET_KEY
const waitlist = require('./waitlist');
const waitlistIdPepper = defineSecret("WAITLIST_ID_PEPPER");
const waitlistRateLimitPepper = defineSecret("WAITLIST_RATE_LIMIT_PEPPER");
const turnstileSecretKey = defineSecret("TURNSTILE_SECRET_KEY");
// Public, non-secret values come from the tracked
// functions/.env.parkqueen-46475363-ccf36 (read by the emulator and by deploy).
// Deliberately no `default`: the CLI treats a default as a prompt suggestion,
// so it would not prevent a prompt, and a silent fallback could point live
// confirmation links or the Turnstile hostname allowlist at the wrong host.
const waitlistConfirmBaseUrl = defineString("WAITLIST_CONFIRM_BASE_URL");
const waitlistAllowedHostnames = defineString("WAITLIST_ALLOWED_HOSTNAMES");

// Test seams, mirroring _emailOtpHooks: integration tests replace delivery,
// Turnstile and token generation so no real email or Cloudflare call happens.
const _waitlistHooks = { deliver: null, verifyTurnstile: null, newToken: null, now: null };
exports._waitlistHooks = _waitlistHooks;

// Local end-to-end only: the Astro dev server calls the emulator cross-origin.
// In production the endpoints are same-origin through Hosting and send no CORS headers.
const WAITLIST_EMULATOR_ORIGINS = new Set(["http://localhost:4321", "http://127.0.0.1:4321"]);

function _waitlistDeps() {
  return {
    db,
    FieldValue,
    Timestamp,
    canonicalizeEmail: _canonicalizeEmail,
    checkRateLimit,
    now: () => _waitlistHooks.now?.() ?? Date.now(),
    newToken: () => _waitlistHooks.newToken?.() ?? waitlist.newConfirmToken(),
    verifyTurnstile: token => _waitlistHooks.verifyTurnstile?.(token) ?? waitlist.verifyTurnstileToken({
      token,
      secret: turnstileSecretKey.value(),
      allowedHostnames: waitlist.parseHostnameList(waitlistAllowedHostnames.value()),
    }),
    deliver: (email, confirmUrl) => _waitlistHooks.deliver?.(email, confirmUrl) ?? waitlist.sendConfirmationEmail({
      email,
      confirmUrl,
      apiKey: sendgridApiKey.value(),
    }),
    idPepper: waitlistIdPepper.value(),
    rateLimitPepper: waitlistRateLimitPepper.value(),
    confirmBaseUrl: waitlistConfirmBaseUrl.value(),
  };
}

function _waitlistEndpoint(handler) {
  return async (req, res) => {
    res.set("Cache-Control", "no-store");
    const origin = req.headers.origin;
    if (process.env.FUNCTIONS_EMULATOR === "true" && WAITLIST_EMULATOR_ORIGINS.has(origin)) {
      res.set("Access-Control-Allow-Origin", origin);
      res.set("Access-Control-Allow-Headers", "Content-Type");
      res.set("Access-Control-Allow-Methods", "POST");
      if (req.method === "OPTIONS") { res.status(204).send(""); return; }
    }
    if (req.method !== "POST") { res.status(405).json({ status: "method_not_allowed" }); return; }
    if (!req.is("application/json") || typeof req.body !== "object" || req.body === null) {
      res.status(400).json({ status: "bad_request" }); return;
    }
    try {
      const { status, body } = await handler({ body: req.body, headers: req.headers }, _waitlistDeps());
      res.status(status).json(body);
    } catch (err) {
      // Never log the request body: it carries an email address or a token.
      console.error("Waitlist endpoint failed", sanitizeError(err));
      res.status(500).json({ status: "try_again" });
    }
  };
}

const WAITLIST_HTTP_OPTIONS = {
  region: "us-central1",
  // Firebase Hosting rewrites require a publicly invokable function.
  invoker: "public",
  memory: "256MiB",
  serviceAccount: 'parqueen-email@parkqueen-46475363-ccf36.iam.gserviceaccount.com',
};

exports.joinWaitlist = onRequest(
  { ...WAITLIST_HTTP_OPTIONS, secrets: [sendgridApiKey, waitlistIdPepper, waitlistRateLimitPepper, turnstileSecretKey] },
  _waitlistEndpoint(waitlist.handleJoin)
);

exports.confirmWaitlist = onRequest(
  { ...WAITLIST_HTTP_OPTIONS, secrets: [waitlistIdPepper, waitlistRateLimitPepper] },
  _waitlistEndpoint(waitlist.handleConfirm)
);

// Unconfirmed signups are personal data we have no consent to keep: remove
// them 30 days after creation.
exports.expireStaleWaitlistSignups = onSchedule(
  {
    schedule: "every day 04:30",
    timeZone: "America/New_York",
    region: "us-central1",
    memory: "256MiB",
    serviceAccount: 'parqueen-cleanup@parkqueen-46475363-ccf36.iam.gserviceaccount.com',
  },
  async () => {
    const deleted = await waitlist.expireStalePending({
      db,
      Timestamp,
      now: () => _waitlistHooks.now?.() ?? Date.now(),
    });
    if (deleted > 0) console.log(`expireStaleWaitlistSignups: removed ${deleted} unconfirmed signup(s)`);
  }
);
