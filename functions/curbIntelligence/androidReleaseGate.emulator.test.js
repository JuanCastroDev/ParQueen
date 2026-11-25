import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const {
  createFirestoreReplayStore,
  evaluateAndroidReleaseEligibility,
  readAndroidReleaseGateConfig,
  streetIntelligenceRequestHash,
  ANDROID_RELEASE_POLICY,
} = require('./androidReleaseGate');

const isolated = process.env.PARQUEEN_REPLAY_EMULATOR === '1'
  && process.env.FIRESTORE_EMULATOR_HOST === '127.0.0.1:8282';
const NOW = 1_700_000_000_000;
const UID = 'user-a';
const location = { lat: 40.6682, lng: -73.9634, accuracyMeters: 6, sampleCount: 4, consistencyMeters: 4 };

describe.skipIf(!isolated)('Firestore replay transactions', () => {
  let db;
  let app;
  let first;
  let second;

  beforeAll(async () => {
    app = initializeApp({ projectId: 'demo-parkqueen-replay-test' }, 'replay-emulator');
    db = getFirestore(app);
    first = createFirestoreReplayStore(db, () => NOW);
    second = createFirestoreReplayStore(db, () => NOW);
    const existing = await db.collection('streetIntelligenceIntegrityReplay').get();
    await Promise.all(existing.docs.map(doc => doc.ref.delete()));
  });

  afterAll(async () => {
    if (app) await deleteApp(app).catch(() => {});
  });

  it('lets two store instances accept distinct tokens and reject one shared token', async () => {
    const challengeA = 'server-challenge-emulator-0001';
    const challengeB = 'server-challenge-emulator-0002';
    expect(await first.issueChallenge(challengeA, UID, NOW + 60_000)).toBe(true);
    expect(await second.issueChallenge(challengeA, UID, NOW + 60_000)).toBe(false);
    expect(await second.issueChallenge(challengeB, UID, NOW + 60_000)).toBe(true);
    const token = 'token-shared';
    const [one, two] = await Promise.all([
      first.consumeGrant({ tokenKey: token, tokenExpiresAt: NOW + 60_000, challengeId: challengeA, authUid: UID }),
      second.consumeGrant({ tokenKey: token, tokenExpiresAt: NOW + 60_000, challengeId: challengeB, authUid: UID }),
    ]);
    const results = [one, two].map(result => result.reason).sort();
    expect(results).toEqual(['consumed', 'replayed']);
    const challengeC = 'server-challenge-emulator-0003';
    expect(await first.issueChallenge(challengeC, UID, NOW + 60_000)).toBe(true);
    const fresh = await second.consumeGrant({
      tokenKey: 'token-other',
      tokenExpiresAt: NOW + 60_000,
      challengeId: challengeC,
      authUid: UID,
    });
    expect(fresh.ok).toBe(true);
  });

  it('does not consume a challenge for the wrong uid or an expired challenge', async () => {
    const wrong = 'server-challenge-emulator-wrong';
    const expired = 'server-challenge-emulator-old';
    expect(await first.issueChallenge(wrong, UID, NOW + 60_000)).toBe(true);
    expect(await first.issueChallenge(expired, UID, NOW - 1)).toBe(true);
    const wrongUid = await second.consumeGrant({
      tokenKey: 'token-wrong-uid', tokenExpiresAt: NOW + 60_000, challengeId: wrong, authUid: 'user-b',
    });
    const stale = await second.consumeGrant({
      tokenKey: 'token-expired', tokenExpiresAt: NOW + 60_000, challengeId: expired, authUid: UID,
    });
    expect(wrongUid).toMatchObject({ ok: false, reason: 'challenge_unbound' });
    expect(stale).toMatchObject({ ok: false, reason: 'challenge_expired' });
    const stillThere = await db.collection('streetIntelligenceIntegrityReplay').doc(`challenge_${wrong}`).get();
    expect(stillThere.data().used).toBe(false);
    const token = await db.collection('streetIntelligenceIntegrityReplay').doc('token_token-wrong-uid').get();
    expect(token.exists).toBe(false);
  });

  it('lets one of two concurrent challenge uses succeed', async () => {
    const challenge = 'server-challenge-emulator-race';
    expect(await first.issueChallenge(challenge, UID, NOW + 60_000)).toBe(true);
    const [left, right] = await Promise.all([
      first.consumeGrant({ tokenKey: 'race-left', tokenExpiresAt: NOW + 60_000, challengeId: challenge, authUid: UID }),
      second.consumeGrant({ tokenKey: 'race-right', tokenExpiresAt: NOW + 60_000, challengeId: challenge, authUid: UID }),
    ]);
    expect([left.ok, right.ok].filter(Boolean)).toHaveLength(1);
    expect([left, right].some(result => result.reason === 'challenge_replayed' || result.reason === 'replayed')).toBe(true);
  });

  it('replaces an expired token and leaves an expired challenge unused', async () => {
    await db.doc('streetIntelligenceIntegrityReplay/token_token-stale').set({
      expiresAt: NOW - 1,
      kind: 'token',
    });
    const challenge = 'server-challenge-emulator-ttl01';
    expect(await first.issueChallenge(challenge, UID, NOW + 60_000)).toBe(true);
    const replaced = await second.consumeGrant({
      tokenKey: 'token-stale',
      tokenExpiresAt: NOW + 60_000,
      challengeId: challenge,
      authUid: UID,
    });
    expect(replaced).toMatchObject({ ok: true, reason: 'consumed' });
    const token = await db.doc('streetIntelligenceIntegrityReplay/token_token-stale').get();
    const used = await db.doc(`streetIntelligenceIntegrityReplay/challenge_${challenge}`).get();
    expect(token.data().expiresAt).toBe(NOW + 60_000);
    expect(used.data().used).toBe(true);
    const again = await first.consumeGrant({
      tokenKey: 'token-stale',
      tokenExpiresAt: NOW + 60_000,
      challengeId: challenge,
      authUid: UID,
    });
    expect(again).toMatchObject({ ok: false, reason: 'replayed' });
  });

  it('does not grant eligibility when the transaction cannot commit', async () => {
    const failing = createFirestoreReplayStore({
      collection() { return { doc() { return {}; } }; },
      runTransaction() { return Promise.reject(new Error('unavailable')); },
    }, () => NOW);
    const request = { protocolVersion: 2, responseVersion: 2, location };
    const challengeId = 'server-challenge-emulator-down01';
    const decision = await evaluateAndroidReleaseEligibility({
      config: readAndroidReleaseGateConfig({
        CURB_ANDROID_RELEASE_GATE: 'on',
        CURB_ANDROID_CERT_SHA256: 'abc123trustedcert',
      }),
      request,
      authUid: UID,
      challengeId,
      integrityToken: 'live-looking-token',
      now: NOW,
      production: false,
      decode: async () => ({
        tokenPayloadExternal: {
          requestDetails: {
            requestPackageName: ANDROID_RELEASE_POLICY.packageName,
            requestHash: streetIntelligenceRequestHash(request, { authUid: UID, challengeId }),
            timestampMillis: String(NOW),
          },
          appIntegrity: {
            appRecognitionVerdict: 'PLAY_RECOGNIZED',
            packageName: ANDROID_RELEASE_POLICY.packageName,
            certificateSha256Digest: ['abc123trustedcert'],
            versionCode: '2',
          },
        },
      }),
      replayStore: {
        ...failing,
        issueChallenge: async () => true,
        challengeIssued: async () => true,
      },
    });
    expect(decision).toMatchObject({ eligible: false, reason: 'replay_store_unavailable' });
  });
});
