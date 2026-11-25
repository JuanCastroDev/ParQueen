import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  ANDROID_RELEASE_POLICY,
  readAndroidReleaseGateConfig,
  streetIntelligenceRequestHash,
  createMemoryReplayStore,
  evaluateAndroidReleaseEligibility,
} = require('./androidReleaseGate');
const { buildHighConfidenceResponse } = require('./canonicalCurbPublicResponse');

const TRUSTED_CERT = 'abc123trustedcert';
const NOW = 1_700_000_000_000;
const location = { lat: 40.6682, lng: -73.9634, accuracyMeters: 6, sampleCount: 4, consistencyMeters: 4 };
const request = (overrides = {}) => ({
  protocolVersion: 2,
  responseVersion: 2,
  location,
  platform: 'android',
  ...overrides,
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

function decoded(overrides = {}) {
  const body = request();
  return {
    tokenPayloadExternal: {
      requestDetails: {
        requestPackageName: ANDROID_RELEASE_POLICY.packageName,
        requestHash: streetIntelligenceRequestHash(body),
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
  return evaluateAndroidReleaseEligibility({
    config: overrides.config || config(),
    request: body,
    integrityToken: overrides.integrityToken === undefined ? 'play-token' : overrides.integrityToken,
    requestHash: overrides.requestHash || streetIntelligenceRequestHash(body),
    now: overrides.now === undefined ? NOW : overrides.now,
    production: false,
    decode: overrides.decode || (async () => decoded(overrides.decoded || {})),
    replayStore: overrides.replayStore || createMemoryReplayStore(() => NOW),
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

  it('rejects a recognized but outdated Android build', async () => {
    const decision = await eligibility({ decoded: { appIntegrity: { versionCode: '1' } } });
    expect(decision).toMatchObject({ eligible: false, reason: 'version_below_minimum' });
  });

  it('ignores a spoofed client versionCode', async () => {
    const decision = await eligibility({
      request: request({ versionCode: 99, responseVersion: 2 }),
      decoded: { appIntegrity: { versionCode: '1' } },
    });
    expect(decision.reason).toBe('version_below_minimum');
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

  it('rejects a mismatched request hash', async () => {
    const decision = await eligibility({ requestHash: 'different-request' });
    expect(decision.reason).toBe('request_hash_mismatch');
  });

  it('rejects a replay of the same request hash', async () => {
    const replayStore = createMemoryReplayStore(() => NOW);
    const first = await eligibility({ replayStore });
    const second = await eligibility({ replayStore });
    expect(first.eligible).toBe(true);
    expect(second.reason).toBe('replayed');
  });

  it('rejects web and iOS even when the payload looks like Android', async () => {
    expect((await eligibility({ request: request({ platform: 'web' }) })).reason).toBe('platform_unsupported');
    expect((await eligibility({ request: request({ platform: 'ios' }) })).reason).toBe('platform_unsupported');
  });

  it('does not accept a local decoder or a simulated verdict in production', async () => {
    const simulated = await evaluateAndroidReleaseEligibility({
      config: config(),
      request: request(),
      integrityToken: 'play-token',
      requestHash: streetIntelligenceRequestHash(request()),
      now: NOW,
      production: true,
      googleDecoder: true,
      decode: async () => ({ simulated: true, tokenPayloadExternal: decoded().tokenPayloadExternal }),
      replayStore: createMemoryReplayStore(() => NOW),
    });
    expect(simulated.reason).toBe('simulated_verdict');
    const injected = await evaluateAndroidReleaseEligibility({
      config: config(),
      request: request(),
      integrityToken: 'play-token',
      requestHash: streetIntelligenceRequestHash(request()),
      now: NOW,
      production: true,
      decode: async () => decoded(),
      replayStore: createMemoryReplayStore(() => NOW),
    });
    expect(injected.reason).toBe('attestation_unverifiable');
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
  });
});
