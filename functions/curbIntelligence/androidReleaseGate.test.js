import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  ANDROID_RELEASE_POLICY,
  readAndroidReleaseGateConfig,
  assessProductActivationInterlock,
  streetIntelligenceRequestHash,
  integrityTokenKey,
  createMemoryReplayStore,
  createDurableReplayStore,
  createFirestoreReplayStore,
  createSerializedClaim,
  createGooglePlayIntegrityDecoder,
  issueStreetIntelligenceIntegrityChallenge,
  evaluateAndroidReleaseEligibility,
  resolveAndroidReleaseGate,
} = require('./androidReleaseGate');
const { buildHighConfidenceResponse } = require('./canonicalCurbPublicResponse');
const { STREET_RULES_CLIENT_ACCESS } = require('./streetRulesClientAccess');

const TRUSTED_CERT = 'abc123trustedcert';
const NOW = 1_700_000_000_000;
const UID = 'user-a';
const CHALLENGE = 'server-challenge-0000000001';
const location = { lat: 40.6682, lng: -73.9634, accuracyMeters: 6, sampleCount: 4, consistencyMeters: 4 };
const request = (overrides = {}) => ({
  protocolVersion: 2,
  responseVersion: 2,
  location,
  platform: 'android',
  ...overrides,
});
const bindingFor = (overrides = {}) => ({
  authUid: overrides.authUid === undefined ? UID : overrides.authUid,
  challengeId: overrides.challengeId === undefined ? CHALLENGE : overrides.challengeId,
});

function config(overrides = {}) {
  return {
    ...readAndroidReleaseGateConfig({
      CURB_ANDROID_RELEASE_GATE: 'on',
      CURB_ANDROID_CERT_SHA256: TRUSTED_CERT,
    }),
    ...overrides,
  };
}

function decoded(body, binding, overrides = {}) {
  return {
    tokenPayloadExternal: {
      requestDetails: {
        requestPackageName: ANDROID_RELEASE_POLICY.packageName,
        requestHash: streetIntelligenceRequestHash(body, binding),
        timestampMillis: String(NOW),
        ...overrides.requestDetails,
      },
      appIntegrity: {
        appRecognitionVerdict: 'PLAY_RECOGNIZED',
        packageName: ANDROID_RELEASE_POLICY.packageName,
        certificateSha256Digest: [TRUSTED_CERT],
        versionCode: String(ANDROID_RELEASE_POLICY.coverageAwareVersionCode),
        ...overrides.appIntegrity,
      },
    },
  };
}

function eligibility(overrides = {}) {
  const body = overrides.request || request();
  const binding = bindingFor(overrides);
  const tokenBinding = overrides.tokenBinding || binding;
  const tokenBody = overrides.tokenRequest || request();
  const replayStore = overrides.replayStore || createMemoryReplayStore(() => NOW);
  if (overrides.issueChallenge !== false) {
    replayStore.issueChallenge(
      binding.challengeId,
      overrides.issuedUid || binding.authUid,
      NOW + ANDROID_RELEASE_POLICY.attestationMaxAgeMs,
    );
  }
  return evaluateAndroidReleaseEligibility({
    config: overrides.config || config(),
    request: body,
    authUid: binding.authUid,
    challengeId: binding.challengeId,
    integrityToken: overrides.integrityToken === undefined ? 'play-token' : overrides.integrityToken,
    now: overrides.now === undefined ? NOW : overrides.now,
    production: overrides.production === undefined ? false : overrides.production,
    decode: overrides.decode || (async () => decoded(tokenBody, tokenBinding, overrides.decoded || {})),
    replayStore,
  });
}

const curb = { segmentId: 'curb2_gate', streetName: 'MELVILLE STREET', sideLabel: 'West' };
const cleaning = {
  category: 'cleaning',
  source: 'dot',
  schedules: [{ days: ['Mon', 'Thu'], startTime: '08:30', endTime: '10:00', side: 'West' }],
};
const selected = {
  rules: [cleaning],
  cleaning,
  restrictions: [],
  timeLimits: [],
  meter: null,
  conflicts: [],
};
const sources = {
  dot: { state: 'complete', resourceId: 'nfid-uabd' },
  parkNyc: { state: 'unavailable', reason: 'source_unavailable' },
};
const localDemoEnv = {
  FUNCTIONS_EMULATOR: 'true',
  GCLOUD_PROJECT: 'demo-parkqueen-functions-test',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
  K_REVISION: '1',
  CURB_PRODUCT_PATH: 'on',
};

function publish(releaseGate, responseVersion = 2) {
  return buildHighConfidenceResponse(curb, selected, {
    includeExtended: true,
    responseVersion,
    sources,
    releaseGate,
  });
}

describe('Android release policy', () => {
  it('keeps the current production versionCode below the future coverage-aware minimum', () => {
    expect(ANDROID_RELEASE_POLICY.packageName).toBe('app.parqueen');
    expect(ANDROID_RELEASE_POLICY.currentProductionVersionCode).toBe(1);
    expect(ANDROID_RELEASE_POLICY.coverageAwareVersionCode).toBe(2);
    expect(ANDROID_RELEASE_POLICY.decodeUrl).toBe(
      'https://playintegrity.googleapis.com/v1/app.parqueen:decodeIntegrityToken',
    );
    expect(readAndroidReleaseGateConfig({}).enforced).toBe(false);
    expect(readAndroidReleaseGateConfig({ CURB_ANDROID_RELEASE_GATE: 'on' }).trustedCertificateSha256).toEqual([]);
    const gradle = readFileSync(new URL('../../android/app/build.gradle', import.meta.url), 'utf8');
    expect(gradle).toMatch(/versionCode 1/);
  });
});

describe('Play Integrity eligibility', () => {
  it('accepts a recognized current Android build', async () => {
    const decision = await eligibility();
    expect(decision).toMatchObject({ eligible: true, reason: 'play_recognized', versionCode: 2 });
  });

  it('accepts a second legitimate check of the same location when the token is fresh', async () => {
    const replayStore = createMemoryReplayStore(() => NOW);
    const first = await eligibility({
      integrityToken: 'fresh-token-1',
      challengeId: 'server-challenge-0000000001',
      replayStore,
    });
    const second = await eligibility({
      integrityToken: 'fresh-token-2',
      challengeId: 'server-challenge-0000000002',
      replayStore,
    });
    expect(first.eligible).toBe(true);
    expect(second).toMatchObject({ eligible: true, reason: 'play_recognized' });
    expect(integrityTokenKey('fresh-token-1')).not.toBe(integrityTokenKey('fresh-token-2'));
    const samePlace = streetIntelligenceRequestHash(request(), {
      authUid: UID, challengeId: 'server-challenge-0000000001',
    });
    expect(samePlace).not.toBe(integrityTokenKey('fresh-token-1'));
  });

  it('rejects reuse of the same integrity token', async () => {
    const replayStore = createMemoryReplayStore(() => NOW);
    const first = await eligibility({ integrityToken: 'same-token', replayStore });
    const second = await eligibility({
      integrityToken: 'same-token',
      challengeId: 'server-challenge-0000000002',
      replayStore,
    });
    expect(first.eligible).toBe(true);
    expect(second.reason).toBe('replayed');
  });

  it('lets only one of two concurrent uses of a token succeed', async () => {
    const replayStore = createDurableReplayStore(createSerializedClaim(() => NOW));
    const firstChallenge = 'server-challenge-concurrent-01';
    const secondChallenge = 'server-challenge-concurrent-02';
    await replayStore.issueChallenge(firstChallenge, UID, NOW + 60_000);
    await replayStore.issueChallenge(secondChallenge, UID, NOW + 60_000);
    const [first, second] = await Promise.all([
      eligibility({
        integrityToken: 'concurrent-token',
        challengeId: firstChallenge,
        replayStore,
        issueChallenge: false,
      }),
      eligibility({
        integrityToken: 'concurrent-token',
        challengeId: secondChallenge,
        replayStore,
        issueChallenge: false,
      }),
    ]);
    const reasons = [first.reason, second.reason].sort();
    expect(reasons).toEqual(['play_recognized', 'replayed']);
    expect([first.eligible, second.eligible].filter(Boolean)).toHaveLength(1);
  });

  it('rejects a token moved to another authenticated user', async () => {
    const decision = await eligibility({
      authUid: 'user-b',
      issuedUid: 'user-b',
      tokenBinding: { authUid: UID, challengeId: CHALLENGE },
    });
    expect(decision.reason).toBe('request_hash_mismatch');
  });

  it('rejects a token moved to another request', async () => {
    const decision = await eligibility({
      request: request({ location: { ...location, lat: 40.1 } }),
    });
    expect(decision.reason).toBe('request_hash_mismatch');
  });

  it('does not treat a uid or platform in the request body as the authenticated caller', () => {
    const spoofed = request({ authUid: UID, uid: UID, platform: 'android', versionCode: 99 });
    const honest = request();
    expect(streetIntelligenceRequestHash(spoofed, { authUid: 'user-b', challengeId: CHALLENGE }))
      .toBe(streetIntelligenceRequestHash(honest, { authUid: 'user-b', challengeId: CHALLENGE }));
    expect(streetIntelligenceRequestHash(spoofed, { authUid: 'user-b', challengeId: CHALLENGE }))
      .not.toBe(streetIntelligenceRequestHash(honest, { authUid: UID, challengeId: CHALLENGE }));
  });

  it('rejects a client-invented challenge and a repeated challenge', async () => {
    expect((await eligibility({ issueChallenge: false })).reason).toBe('challenge_unbound');
    const replayStore = createMemoryReplayStore(() => NOW);
    expect((await eligibility({ replayStore })).eligible).toBe(true);
    const repeated = await eligibility({
      integrityToken: 'another-token',
      replayStore,
    });
    expect(repeated.reason).toBe('challenge_replayed');
  });

  it('rejects a recognized but outdated Android build', async () => {
    const decision = await eligibility({ decoded: { appIntegrity: { versionCode: '1' } } });
    expect(decision).toMatchObject({ eligible: false, reason: 'version_below_minimum' });
  });

  it('ignores a spoofed client versionCode and a client-reported platform', async () => {
    const outdated = await eligibility({
      request: request({ versionCode: 99, platform: 'android' }),
      decoded: { appIntegrity: { versionCode: '1' } },
    });
    expect(outdated.reason).toBe('version_below_minimum');
    const web = await eligibility({
      request: request({ platform: 'web' }),
      challengeId: 'server-challenge-0000000002',
      integrityToken: 'web-labeled-token',
    });
    const ios = await eligibility({
      request: request({ platform: 'ios' }),
      challengeId: 'server-challenge-0000000003',
      integrityToken: 'ios-labeled-token',
    });
    expect(web.eligible).toBe(true);
    expect(ios.eligible).toBe(true);
  });

  it('rejects the wrong package', async () => {
    const decision = await eligibility({
      decoded: { appIntegrity: { packageName: 'app.parqueen.qa' } },
    });
    expect(decision.reason).toBe('package_mismatch');
  });

  it('rejects the wrong signing certificate', async () => {
    const decision = await eligibility({
      decoded: { appIntegrity: { certificateSha256Digest: ['debug-cert'] } },
    });
    expect(decision.reason).toBe('certificate_untrusted');
  });

  it('rejects a sideloaded build that Play does not recognize', async () => {
    const decision = await eligibility({
      decoded: { appIntegrity: { appRecognitionVerdict: 'UNRECOGNIZED_VERSION' } },
    });
    expect(decision.reason).toBe('unrecognized_version');
  });

  it('rejects missing and expired attestation', async () => {
    expect((await eligibility({ integrityToken: '' })).reason).toBe('attestation_missing');
    expect((await eligibility({
      decoded: { requestDetails: { timestampMillis: String(NOW - (6 * 60 * 1000)) } },
    })).reason).toBe('attestation_expired');
  });

  it('does not accept a local decoder, a simulated verdict, or a memory store in production', async () => {
    const missingDecoder = await evaluateAndroidReleaseEligibility({
      config: config(),
      request: request(),
      authUid: UID,
      challengeId: CHALLENGE,
      integrityToken: 'play-token',
      now: NOW,
      production: true,
      decode: async () => decoded(request(), bindingFor()),
      replayStore: createDurableReplayStore(createSerializedClaim(() => NOW)),
    });
    expect(missingDecoder.reason).toBe('attestation_unverifiable');
    const memoryStore = await evaluateAndroidReleaseEligibility({
      config: config(),
      request: request(),
      authUid: UID,
      challengeId: CHALLENGE,
      integrityToken: 'play-token',
      now: NOW,
      production: true,
      decode: createGooglePlayIntegrityDecoder(),
      replayStore: createMemoryReplayStore(() => NOW),
    });
    expect(memoryStore.reason).toBe('replay_store_unconfigured');
    const unconfigured = await createGooglePlayIntegrityDecoder()('play-token').then(
      () => 'returned',
      error => error.code,
    );
    expect(unconfigured).toBe('unconfigured');
    const issued = await issueStreetIntelligenceIntegrityChallenge({
      authUid: UID,
      replayStore: createMemoryReplayStore(() => NOW),
      now: NOW,
    });
    expect(issued.reason).toBe('replay_store_unconfigured');
  });
});

function createSharedReplayDb(now = () => NOW) {
  const docs = new Map();
  let chain = Promise.resolve();
  const db = {
    collection() {
      return { doc(id) { return { id }; } };
    },
    runTransaction(work) {
      const run = chain.then(async () => {
        const writes = [];
        const tx = {
          async get(ref) {
            const data = docs.get(ref.id);
            return { exists: data !== undefined, data: () => data };
          },
          create(ref, data) { writes.push([ref.id, data]); },
          update(ref, patch) { writes.push([ref.id, { ...docs.get(ref.id), ...patch }]); },
        };
        const result = await work(tx);
        for (const [id, data] of writes) docs.set(id, data);
        return result;
      });
      chain = run.then(() => {}, () => {});
      return run;
    },
  };
  return {
    db,
    first: createFirestoreReplayStore(db, now),
    second: createFirestoreReplayStore(db, now),
  };
}

describe('durable replay store', () => {
  it('shares one token consumption across two store instances', async () => {
    const shared = createSharedReplayDb();
    const challenge = 'server-challenge-shared-store-1';
    expect(await shared.first.issueChallenge(challenge, UID, NOW + 60_000)).toBe(true);
    expect(await shared.second.challengeIssued(challenge, UID)).toBe(true);
    expect(await shared.first.consumeToken('token-key', NOW + 60_000)).toBe(true);
    expect(await shared.second.consumeToken('token-key', NOW + 60_000)).toBe(false);
    expect(await shared.second.consumeChallenge(challenge, UID)).toBe(true);
    expect(await shared.first.challengeIssued(challenge, UID)).toBe('used');
  });

  it('is not installed on the production callable', () => {
    const callable = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    expect(callable).not.toContain('createFirestoreReplayStore');
    expect(callable).not.toContain('playIntegrityGoogleDecoder');
    expect(callable).not.toContain('decodeIntegrityToken');
  });
});

describe('product activation interlock', () => {
  it('blocks production publication when the product path is on and the Android gate is off', async () => {
    const decision = assessProductActivationInterlock({
      CURB_PRODUCT_PATH: 'on',
      GCLOUD_PROJECT: 'parkqueen-46475363-ccf36',
    });
    expect(decision).toMatchObject({
      release: 'blocked',
      publishVersion2: false,
      reason: 'product_without_android_gate',
    });
    const resolved = await resolveAndroidReleaseGate(request({ platform: 'android', versionCode: 99 }), {
      env: { CURB_PRODUCT_PATH: 'on', GCLOUD_PROJECT: 'parkqueen-46475363-ccf36' },
      callerUid: UID,
    });
    expect(resolved).toMatchObject({ enforced: true, eligible: false, reason: 'product_without_android_gate' });
  });

  it('keeps the isolated local demo able to publish while the gate is off', () => {
    const decision = assessProductActivationInterlock(localDemoEnv);
    expect(decision).toMatchObject({ release: 'local_demo', publishVersion2: true, reason: 'local_demo' });
  });

  it('requires explicit withheld decisions for web and iOS before production publication', () => {
    const missing = assessProductActivationInterlock({
      CURB_PRODUCT_PATH: 'on',
      CURB_ANDROID_RELEASE_GATE: 'on',
      GCLOUD_PROJECT: 'parkqueen-46475363-ccf36',
    });
    expect(missing.reason).toBe('web_release_undecided');
    const webOnly = assessProductActivationInterlock({
      CURB_PRODUCT_PATH: 'on',
      CURB_ANDROID_RELEASE_GATE: 'on',
      CURB_WEB_RELEASE: 'withheld',
      GCLOUD_PROJECT: 'parkqueen-46475363-ccf36',
    });
    expect(webOnly.reason).toBe('ios_release_undecided');
    const ready = assessProductActivationInterlock({
      CURB_PRODUCT_PATH: 'on',
      CURB_ANDROID_RELEASE_GATE: 'on',
      CURB_WEB_RELEASE: 'withheld',
      CURB_IOS_RELEASE: 'withheld',
      GCLOUD_PROJECT: 'parkqueen-46475363-ccf36',
    });
    expect(ready).toMatchObject({ release: 'android_gate', publishVersion2: true });
    expect(ready.decisions).toEqual({ android: 'play_integrity', web: 'withheld', ios: 'withheld' });
  });

  it('does not let a client-reported platform satisfy a missing web or iOS decision', () => {
    const decision = assessProductActivationInterlock({
      CURB_PRODUCT_PATH: 'on',
      CURB_ANDROID_RELEASE_GATE: 'on',
      platform: 'web',
      GCLOUD_PROJECT: 'parkqueen-46475363-ccf36',
    });
    expect(decision.reason).toBe('web_release_undecided');
  });
});

describe('callable schedule enforcement', () => {
  it('publishes version 2 cleaning when the gate is off', () => {
    const response = publish(undefined);
    expect(response.responseVersion).toBe(2);
    expect(response.publicRules).toHaveLength(1);
    expect(response.regulationCoverage.meters).toBe('unknown');
  });

  it('publishes version 2 only for an eligible Play verdict', () => {
    const response = publish({ enforced: true, eligible: true, reason: 'play_recognized' });
    expect(response.responseVersion).toBe(2);
    expect(response.publicRules.map(rule => rule.type)).toContain('streetCleaning');
    expect(response.regulationCoverage.meters).toBe('unknown');
  });

  it('suppresses a spoofed responseVersion 2 when the gate is enforced and the verdict is missing', () => {
    const response = publish({ enforced: true, eligible: false, reason: 'attestation_missing' });
    expect(response.responseVersion).toBe(1);
    expect(response.publicRules).toEqual([]);
    expect(response.publicSchedules.cleaning).toEqual([]);
    expect(response.ruleSummary.cleaningAvailable).toBe(false);
    expect(response.regulationStatus).not.toBe('verified');
    expect(response.regulationStatus).not.toBe('verified_empty');
    expect(response.regulationCoverage).toBeUndefined();
  });

  it('keeps version 1 suppressed even for an eligible verdict', () => {
    const response = publish({ enforced: true, eligible: true }, 1);
    expect(response.responseVersion).toBe(1);
    expect(response.publicRules).toEqual([]);
    expect(response.ruleSummary.cleaningAvailable).toBe(false);
  });

  it('restores version 2 after the gate is switched off and still suppresses version 1', () => {
    const restored = publish({ enforced: false, eligible: false, reason: 'gate_off' });
    const legacy = publish({ enforced: false, eligible: false, reason: 'gate_off' }, 1);
    expect(restored.responseVersion).toBe(2);
    expect(restored.publicRules).toHaveLength(1);
    expect(legacy.publicRules).toEqual([]);
    expect(legacy.ruleSummary.cleaningAvailable).toBe(false);
  });
});

describe('Firestore legacy access', () => {
  it('still allows a direct streetRules read, so the callable gate does not cover that path', () => {
    const rules = readFileSync(new URL('../../firestore.rules', import.meta.url), 'utf8');
    const segment = rules.slice(rules.indexOf('match /streetSegments/{segmentId}'));
    expect(segment).toMatch(/match \/streetRules\/\{ruleId\} \{\s*allow read: if true;/);
    expect(rules).toMatch(/match \/\{path=\*\*\}\/streetRules\/\{ruleId\} \{\s*allow read: if true;/);
    expect(rules).not.toContain('streetIntelligenceIntegrityReplay');
    expect(STREET_RULES_CLIENT_ACCESS.productionReadsRemainPublic).toBe(true);
    expect(STREET_RULES_CLIENT_ACCESS.proposedRules).toContain('allow read: if false;');
    expect(STREET_RULES_CLIENT_ACCESS.proposedRulesApplied).toBe(false);
  });
});
