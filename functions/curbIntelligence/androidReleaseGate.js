'use strict';

const { createHash } = require('node:crypto');

/**
 * Future Android release policy for Street Intelligence.
 *
 * The installed production package app.parqueen is versionCode 1. That build
 * is below the coverage-aware minimum. The next Play-distributed build that
 * may receive actionable schedules is versionCode 2. This module does not
 * change the Gradle versionCode and does not publish a store build.
 *
 * Play Integrity's standard verdict can attest the Play package name, the
 * Play App Signing certificate, appRecognitionVerdict, and versionCode. It
 * does not attest the git commit or the embedded web bundle SHA. Those belong
 * in the release record that maps versionCode 2 to one commit at upload time.
 * A sideloaded APK is UNRECOGNIZED_VERSION and is not a Play-recognized build.
 *
 * The trusted certificate digest is the Play App Signing certificate. It is
 * not in this repository. An empty trust set fails closed.
 *
 * Firebase App Check on the callable exposes request.app.appId only. A
 * successful App Check token is not a minimum-version verdict.
 *
 * Web and iOS cannot satisfy this Android verdict. They need their own gates.
 * CURB_ANDROID_RELEASE_GATE defaults off. Turning it on without a configured
 * Google decoder, replay store, and Play certificate suppresses every
 * responseVersion 2 schedule. Version 1 stays suppressed either way.
 */
const ANDROID_RELEASE_POLICY = Object.freeze({
  packageName: 'app.parqueen',
  currentProductionVersionCode: 1,
  coverageAwareVersionCode: 2,
  attestationMaxAgeMs: 5 * 60 * 1000,
  clockSkewMs: 60 * 1000,
});

function readAndroidReleaseGateConfig(env = {}) {
  const source = env && typeof env === 'object' ? env : {};
  const configuredCerts = String(source.CURB_ANDROID_CERT_SHA256 || '')
    .split(',')
    .map(digest => digest.trim())
    .filter(Boolean);
  return {
    enforced: source.CURB_ANDROID_RELEASE_GATE === 'on',
    packageName: ANDROID_RELEASE_POLICY.packageName,
    minimumVersionCode: ANDROID_RELEASE_POLICY.coverageAwareVersionCode,
    trustedCertificateSha256: configuredCerts,
    maxAgeMs: ANDROID_RELEASE_POLICY.attestationMaxAgeMs,
    clockSkewMs: ANDROID_RELEASE_POLICY.clockSkewMs,
  };
}

function stableString(value) {
  if (Array.isArray(value)) return `[${value.map(stableString).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableString(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function streetIntelligenceRequestHash(request) {
  const body = request && typeof request === 'object' ? request : {};
  return createHash('sha256').update(stableString({
    protocolVersion: body.protocolVersion,
    responseVersion: body.responseVersion ?? null,
    location: body.location ?? null,
    candidateToken: body.candidateToken || null,
  })).digest('base64url');
}

function createMemoryReplayStore(now = Date.now) {
  const seen = new Map();
  return {
    consume(hash, expiresAt) {
      const current = now();
      for (const [key, expiry] of seen) {
        if (expiry <= current) seen.delete(key);
      }
      if (seen.has(hash)) return false;
      seen.set(hash, expiresAt);
      return true;
    },
  };
}

function denied(reason) {
  return { eligible: false, reason };
}

function certificateAccepted(presented, trusted) {
  const allowed = new Set(trusted.map(digest => digest.toLowerCase()));
  return presented.some(digest => typeof digest === 'string' && allowed.has(digest.trim().toLowerCase()));
}

function assessDecodedPlayIntegrity(decoded, input) {
  if (!decoded || typeof decoded !== 'object' || decoded.simulated === true || decoded.localFake === true) {
    return denied('simulated_verdict');
  }
  const payload = decoded.tokenPayloadExternal;
  if (!payload || typeof payload !== 'object') return denied('attestation_malformed');
  const requestDetails = payload.requestDetails || {};
  const appIntegrity = payload.appIntegrity || {};
  const config = input.config;
  if (requestDetails.requestPackageName !== config.packageName) return denied('package_mismatch');
  if (appIntegrity.packageName !== config.packageName) return denied('package_mismatch');
  if (appIntegrity.appRecognitionVerdict !== 'PLAY_RECOGNIZED') return denied('unrecognized_version');
  if (!certificateAccepted(
    Array.isArray(appIntegrity.certificateSha256Digest) ? appIntegrity.certificateSha256Digest : [],
    config.trustedCertificateSha256,
  )) return denied('certificate_untrusted');
  if (!/^\d+$/.test(String(appIntegrity.versionCode || ''))) return denied('version_malformed');
  const versionCode = Number(appIntegrity.versionCode);
  if (!Number.isInteger(versionCode) || versionCode < config.minimumVersionCode) {
    return denied('version_below_minimum');
  }
  if (requestDetails.requestHash !== input.requestHash) return denied('request_hash_mismatch');
  const timestamp = Number(requestDetails.timestampMillis);
  if (!Number.isFinite(timestamp)) return denied('attestation_expired');
  const now = input.now;
  if (timestamp > now + config.clockSkewMs) return denied('attestation_expired');
  if (now - timestamp > config.maxAgeMs) return denied('attestation_expired');
  if (!input.replayStore || typeof input.replayStore.consume !== 'function') {
    return denied('replay_store_unconfigured');
  }
  if (input.replayStore.consume(input.requestHash, timestamp + config.maxAgeMs) !== true) {
    return denied('replayed');
  }
  return {
    eligible: true,
    reason: 'play_recognized',
    packageName: config.packageName,
    versionCode,
  };
}

/**
 * Fail closed. A client-reported versionCode is never read.
 * production !== false rejects every injected decoder, including a decoder
 * that returns a well-formed local payload. Tests pass production: false.
 */
async function evaluateAndroidReleaseEligibility(input) {
  const config = input.config || readAndroidReleaseGateConfig();
  if (!config.enforced) return denied('gate_off');
  const platform = input.request?.platform;
  if (platform != null && platform !== 'android') return denied('platform_unsupported');
  if (input.production !== false) {
    if (input.googleDecoder !== true || typeof input.decode !== 'function') {
      return denied('attestation_unverifiable');
    }
  }
  if (typeof input.integrityToken !== 'string' || input.integrityToken.length === 0) {
    return denied('attestation_missing');
  }
  if (input.integrityToken.length > 8000) return denied('attestation_malformed');
  if (typeof input.decode !== 'function') return denied('attestation_unverifiable');
  let decoded;
  try {
    decoded = await input.decode(input.integrityToken);
  } catch {
    return denied('attestation_unverifiable');
  }
  return assessDecodedPlayIntegrity(decoded, {
    config,
    requestHash: input.requestHash,
    now: input.now,
    replayStore: input.replayStore,
  });
}

async function resolveAndroidReleaseGate(request, dependencies = {}) {
  if (dependencies.releaseGate && typeof dependencies.releaseGate === 'object') {
    return {
      enforced: dependencies.releaseGate.enforced === true,
      eligible: dependencies.releaseGate.eligible === true,
      reason: dependencies.releaseGate.reason || (dependencies.releaseGate.eligible === true ? 'play_recognized' : 'ineligible'),
    };
  }
  const config = readAndroidReleaseGateConfig(dependencies.env || process.env);
  if (!config.enforced) return { enforced: false, eligible: false, reason: 'gate_off' };
  const decision = await evaluateAndroidReleaseEligibility({
    config,
    request,
    integrityToken: typeof request?.playIntegrityToken === 'string' ? request.playIntegrityToken : '',
    requestHash: streetIntelligenceRequestHash(request),
    now: typeof dependencies.now === 'function' ? dependencies.now() : Date.now(),
    production: true,
    decode: dependencies.decodePlayIntegrity,
    replayStore: dependencies.playIntegrityReplay,
    googleDecoder: dependencies.playIntegrityGoogleDecoder === true,
  });
  return { enforced: true, eligible: decision.eligible === true, reason: decision.reason };
}

module.exports = {
  ANDROID_RELEASE_POLICY,
  readAndroidReleaseGateConfig,
  streetIntelligenceRequestHash,
  createMemoryReplayStore,
  assessDecodedPlayIntegrity,
  evaluateAndroidReleaseEligibility,
  resolveAndroidReleaseGate,
};
