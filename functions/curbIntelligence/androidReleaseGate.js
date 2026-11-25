'use strict';

const { createHash, randomBytes } = require('node:crypto');
const { localDemoSession } = require('./localGeosupportTransport');

/**
 * Android release gate for Street Intelligence. Default off. Not a Play call.
 *
 * Trust boundary. Firebase App Check on the callable exposes request.app.appId.
 * It does not expose package, certificate, or versionCode. A client field named
 * versionCode, platform, uid, or responseVersion is not evidence.
 *
 * Standard Play Integrity (developer.android.com/google/play/integrity):
 * - requestHash binds a token to one server-calculated request. It is not a
 *   nonce. Two legitimate checks of the same curb share the business fields
 *   and must not be rejected merely because those fields hash the same way.
 * - Google clears verdicts after the same token is decrypted many times. That
 *   is not an atomic single use across Cloud Functions instances. Two
 *   overlapping decodeIntegrityToken calls can both return PLAY_RECOGNIZED.
 * - The replay key is therefore the integrity token digest, consumed once.
 *   A fresh token for the same location is a new authorization. The same
 *   token is not.
 * - Classic API nonces are a different mode. This gate verifies the standard
 *   requestHash verdict and does not invent a second nonce scheme.
 *
 * Binding. The server recomputes requestHash from the curb request, the
 * authenticated caller uid, and a server-issued challenge. The uid comes from
 * the callable auth context. The challenge is 128 random bits, stored before
 * the app asks Play for a token, and echoed inside the hash the app submits
 * to Play. A token minted for another user, place, or challenge does not match.
 *
 * Production decode and replay storage are not configured. createGooglePlayIntegrityDecoder
 * never calls Google and never returns a verdict. A function supplied by a
 * test is ignored when production is not explicitly false. A memory store is
 * not durable and is rejected on that path. The gate therefore fails closed
 * if turned on before a Play-distributed versionCode 2 build, the Play App
 * Signing certificate, a Google decode credential, and a durable replay store exist.
 *
 * Web and iOS do not become eligible by sending a platform string. Product
 * publication outside the isolated local demo stays closed unless the Android
 * gate is on and web and iOS are explicitly withheld.
 */
const GOOGLE_DECODER = Symbol('googlePlayIntegrityDecoder');
const ANDROID_RELEASE_POLICY = Object.freeze({
  packageName: 'app.parqueen',
  currentProductionVersionCode: 1,
  coverageAwareVersionCode: 2,
  attestationMaxAgeMs: 5 * 60 * 1000,
  clockSkewMs: 60 * 1000,
  decodeUrl: 'https://playintegrity.googleapis.com/v1/app.parqueen:decodeIntegrityToken',
});
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;

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

function readPlatformReleaseDecisions(env = {}) {
  const source = env && typeof env === 'object' ? env : {};
  return {
    android: source.CURB_ANDROID_RELEASE_GATE === 'on' ? 'play_integrity' : 'off',
    web: source.CURB_WEB_RELEASE === 'withheld' ? 'withheld' : 'undecided',
    ios: source.CURB_IOS_RELEASE === 'withheld' ? 'withheld' : 'undecided',
  };
}

function assessProductActivationInterlock(env = {}) {
  const source = env && typeof env === 'object' ? env : {};
  const decisions = readPlatformReleaseDecisions(source);
  if (localDemoSession(source)) {
    return { release: 'local_demo', publishVersion2: true, reason: 'local_demo', decisions };
  }
  if (source.CURB_PRODUCT_PATH !== 'on') {
    return { release: 'product_off', publishVersion2: false, reason: 'product_off', decisions };
  }
  if (decisions.android !== 'play_integrity') {
    return {
      release: 'blocked', publishVersion2: false, reason: 'product_without_android_gate', decisions,
    };
  }
  if (decisions.web !== 'withheld') {
    return { release: 'blocked', publishVersion2: false, reason: 'web_release_undecided', decisions };
  }
  if (decisions.ios !== 'withheld') {
    return { release: 'blocked', publishVersion2: false, reason: 'ios_release_undecided', decisions };
  }
  return { release: 'android_gate', publishVersion2: true, reason: 'android_gate_required', decisions };
}

function stableString(value) {
  if (Array.isArray(value)) return `[${value.map(stableString).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableString(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function boundCaller(uid) {
  return typeof uid === 'string' && uid.length > 0 && uid.length <= 128 && !uid.includes('/');
}

function streetIntelligenceRequestHash(request, binding = {}) {
  const body = request && typeof request === 'object' ? request : {};
  const source = binding && typeof binding === 'object' ? binding : {};
  return createHash('sha256').update(stableString({
    protocolVersion: body.protocolVersion,
    responseVersion: body.responseVersion ?? null,
    location: body.location ?? null,
    candidateToken: body.candidateToken || null,
    challengeId: typeof source.challengeId === 'string' ? source.challengeId : null,
    authUid: typeof source.authUid === 'string' ? source.authUid : null,
  })).digest('base64url');
}

function integrityTokenKey(token) {
  return createHash('sha256').update(String(token)).digest('base64url');
}

function prune(map, now) {
  for (const [key, expiry] of map) {
    if (expiry <= now) map.delete(key);
  }
}

function createMemoryReplayStore(now = Date.now) {
  const tokens = new Map();
  const challenges = new Map();
  const clock = typeof now === 'function' ? now : () => now;
  return {
    durable: false,
    issueChallenge(id, uid, expiresAt) {
      prune(challenges, clock());
      if (!boundCaller(uid) || challenges.has(id)) return false;
      challenges.set(id, { uid, expiresAt, used: false });
      return true;
    },
    challengeIssued(id, uid) {
      prune(challenges, clock());
      const row = challenges.get(id);
      if (!row || row.uid !== uid) return false;
      if (row.expiresAt <= clock()) return false;
      return row.used ? 'used' : true;
    },
    consumeChallenge(id, uid) {
      const issued = this.challengeIssued(id, uid);
      if (issued !== true) return false;
      challenges.get(id).used = true;
      return true;
    },
    consumeToken(key, expiresAt) {
      prune(tokens, clock());
      if (tokens.has(key) && tokens.get(key) > clock()) return false;
      tokens.set(key, expiresAt);
      return true;
    },
    consumeGrant({ tokenKey, tokenExpiresAt, challengeId, authUid }) {
      prune(tokens, clock());
      const issued = this.challengeIssued(challengeId, authUid);
      if (issued === 'used') return { ok: false, reason: 'challenge_replayed' };
      if (issued !== true) {
        const row = challenges.get(challengeId);
        if (row && row.uid === authUid && row.expiresAt <= clock()) {
          return { ok: false, reason: 'challenge_expired' };
        }
        return { ok: false, reason: 'challenge_unbound' };
      }
      const tokenExpiry = tokens.get(tokenKey);
      if (tokenExpiry !== undefined && tokenExpiry > clock()) {
        return { ok: false, reason: 'replayed' };
      }
      tokens.set(tokenKey, tokenExpiresAt);
      challenges.get(challengeId).used = true;
      return { ok: true };
    },
  };
}

function createDurableReplayStore(adapter) {
  if (!adapter || typeof adapter.claim !== 'function'
    || typeof adapter.issue !== 'function'
    || typeof adapter.consumeIssued !== 'function') {
    throw new Error('replay_store_unconfigured');
  }
  return {
    durable: true,
    issueChallenge: (id, uid, expiresAt) => adapter.issue(`challenge_${id}`, { uid, expiresAt }),
    challengeIssued: (id, uid) => adapter.consumeIssued(`challenge_${id}`, uid, true),
    consumeChallenge: (id, uid) => adapter.consumeIssued(`challenge_${id}`, uid, false),
    consumeToken: (key, expiresAt) => adapter.claim(`token_${key}`, expiresAt),
    consumeGrant: (input) => (
      typeof adapter.consumeGrant === 'function'
        ? adapter.consumeGrant(input)
        : Promise.resolve({ ok: false, reason: 'replay_store_unconfigured' })
    ),
  };
}

function createFirestoreReplayStore(db, now = Date.now) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function') {
    throw new Error('replay_store_unconfigured');
  }
  const clock = typeof now === 'function' ? now : () => now;
  const refFor = (key) => db.collection('streetIntelligenceIntegrityReplay').doc(key);
  return createDurableReplayStore({
    async claim(key, expiresAt) {
      const ref = refFor(key);
      let accepted = false;
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists) {
          accepted = false;
          return;
        }
        tx.create(ref, { expiresAt });
        accepted = true;
      });
      return accepted;
    },
    async issue(key, record) {
      const ref = refFor(key);
      let accepted = false;
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (snap.exists) {
          accepted = false;
          return;
        }
        tx.create(ref, { uid: record.uid, expiresAt: record.expiresAt, used: false });
        accepted = true;
      });
      return accepted;
    },
    async consumeGrant({ tokenKey, tokenExpiresAt, challengeId, authUid }) {
      const tokenRef = refFor(`token_${tokenKey}`);
      const challengeRef = refFor(`challenge_${challengeId}`);
      try {
        let outcome = { ok: false, reason: 'replay_store_unavailable' };
        await db.runTransaction(async (tx) => {
          const tokenSnap = await tx.get(tokenRef);
          const challengeSnap = await tx.get(challengeRef);
          const tokenData = tokenSnap.exists && typeof tokenSnap.data === 'function' ? tokenSnap.data() : null;
          const challenge = challengeSnap.exists && typeof challengeSnap.data === 'function' ? challengeSnap.data() : null;
          if (tokenData && tokenData.expiresAt > clock()) {
            outcome = { ok: false, reason: 'replayed' };
            return;
          }
          if (!challenge || challenge.uid !== authUid) {
            outcome = { ok: false, reason: 'challenge_unbound' };
            return;
          }
          if (challenge.expiresAt <= clock()) {
            outcome = { ok: false, reason: 'challenge_expired' };
            return;
          }
          if (challenge.used === true) {
            outcome = { ok: false, reason: 'challenge_replayed' };
            return;
          }
          tx.set(tokenRef, { expiresAt: tokenExpiresAt, kind: 'token' });
          tx.update(challengeRef, { used: true });
          outcome = { ok: true, reason: 'consumed' };
        });
        return outcome;
      } catch {
        return { ok: false, reason: 'replay_store_unavailable' };
      }
    },
    async consumeIssued(key, uid, peek) {
      const ref = refFor(key);
      let result = false;
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const data = snap.exists && typeof snap.data === 'function' ? snap.data() : null;
        if (!data || data.uid !== uid || data.expiresAt <= clock()) {
          result = false;
          return;
        }
        if (data.used === true) {
          result = 'used';
          return;
        }
        result = true;
        if (peek !== true) tx.update(ref, { used: true });
      });
      return result;
    },
  });
}

function createSerializedClaim(now = Date.now) {
  const tokens = new Map();
  const challenges = new Map();
  const clock = typeof now === 'function' ? now : () => now;
  let chain = Promise.resolve();
  const exclusive = (work) => {
    const run = chain.then(work, work);
    chain = run.then(() => {}, () => {});
    return run;
  };
  return {
    claim(key, expiresAt) {
      return exclusive(async () => {
        await Promise.resolve();
        if (tokens.has(key)) return false;
        await Promise.resolve();
        tokens.set(key, expiresAt);
        return true;
      });
    },
    issue(key, record) {
      return exclusive(async () => {
        if (challenges.has(key)) return false;
        challenges.set(key, { ...record, used: false });
        return true;
      });
    },
    consumeIssued(key, uid, peek) {
      return exclusive(async () => {
        await Promise.resolve();
        const row = challenges.get(key);
        if (!row || row.uid !== uid || row.expiresAt <= clock()) return false;
        if (row.used) return 'used';
        if (peek === true) return true;
        row.used = true;
        return true;
      });
    },
    consumeGrant({ tokenKey, tokenExpiresAt, challengeId, authUid }) {
      return exclusive(async () => {
        await Promise.resolve();
        const challenge = challenges.get(`challenge_${challengeId}`);
        const tokenExpiry = tokens.get(`token_${tokenKey}`);
        if (tokenExpiry !== undefined && tokenExpiry > clock()) return { ok: false, reason: 'replayed' };
        if (!challenge || challenge.uid !== authUid) return { ok: false, reason: 'challenge_unbound' };
        if (challenge.expiresAt <= clock()) return { ok: false, reason: 'challenge_expired' };
        if (challenge.used) return { ok: false, reason: 'challenge_replayed' };
        tokens.set(`token_${tokenKey}`, tokenExpiresAt);
        challenge.used = true;
        return { ok: true, reason: 'consumed' };
      });
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
  return {
    eligible: true,
    reason: 'play_recognized',
    packageName: config.packageName,
    versionCode,
    tokenExpiresAt: timestamp + config.maxAgeMs,
  };
}

function isGoogleDecoder(decode) {
  return typeof decode === 'function' && decode.kind === GOOGLE_DECODER;
}

function createGooglePlayIntegrityDecoder() {
  const decode = async () => {
    const error = new Error('play_integrity_decoder_unconfigured');
    error.code = 'unconfigured';
    throw error;
  };
  decode.kind = GOOGLE_DECODER;
  return decode;
}

async function issueStreetIntelligenceIntegrityChallenge({ authUid, replayStore, now = Date.now, production = true }) {
  if (!boundCaller(authUid)) return { issued: false, reason: 'caller_unbound' };
  if (production !== false && replayStore?.durable !== true) {
    return { issued: false, reason: 'replay_store_unconfigured' };
  }
  if (!replayStore || typeof replayStore.issueChallenge !== 'function') {
    return { issued: false, reason: 'replay_store_unconfigured' };
  }
  const clock = typeof now === 'function' ? now() : now;
  const challengeId = randomBytes(16).toString('base64url');
  const expiresAt = clock + ANDROID_RELEASE_POLICY.attestationMaxAgeMs;
  if (await replayStore.issueChallenge(challengeId, authUid, expiresAt) !== true) {
    return { issued: false, reason: 'challenge_unbound' };
  }
  return { issued: true, challengeId, expiresAt };
}

async function evaluateAndroidReleaseEligibility(input) {
  const config = input.config || readAndroidReleaseGateConfig();
  if (!config.enforced) return denied('gate_off');
  if (input.production !== false) {
    if (!isGoogleDecoder(input.decode)) return denied('attestation_unverifiable');
    if (input.replayStore?.durable !== true) return denied('replay_store_unconfigured');
  }
  const authUid = input.authUid;
  if (!boundCaller(authUid)) return denied('caller_unbound');
  const challengeId = input.challengeId;
  if (typeof challengeId !== 'string' || !CHALLENGE_PATTERN.test(challengeId)) {
    return denied('challenge_unbound');
  }
  const replayStore = input.replayStore;
  if (!replayStore || typeof replayStore.consumeToken !== 'function'
    || typeof replayStore.consumeChallenge !== 'function'
    || typeof replayStore.challengeIssued !== 'function') {
    return denied('replay_store_unconfigured');
  }
  const issued = await replayStore.challengeIssued(challengeId, authUid);
  if (issued === 'used') return denied('challenge_replayed');
  if (issued !== true) return denied('challenge_unbound');
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
  const requestHash = streetIntelligenceRequestHash(input.request, { authUid, challengeId });
  const verdict = assessDecodedPlayIntegrity(decoded, {
    config,
    requestHash,
    now: input.now,
  });
  if (verdict.eligible !== true) return verdict;
  if (typeof replayStore.consumeGrant !== 'function') return denied('replay_store_unconfigured');
  let grant;
  try {
    grant = await replayStore.consumeGrant({
      tokenKey: integrityTokenKey(input.integrityToken),
      tokenExpiresAt: verdict.tokenExpiresAt,
      challengeId,
      authUid,
    });
  } catch {
    return denied('replay_store_unavailable');
  }
  if (!grant || grant.ok !== true) return denied(grant && grant.reason ? grant.reason : 'replay_store_unavailable');
  return {
    eligible: true,
    reason: 'play_recognized',
    packageName: verdict.packageName,
    versionCode: verdict.versionCode,
  };
}

async function resolveAndroidReleaseGate(request, dependencies = {}) {
  if (dependencies.releaseGate && typeof dependencies.releaseGate === 'object') {
    return {
      enforced: dependencies.releaseGate.enforced === true,
      eligible: dependencies.releaseGate.eligible === true,
      reason: dependencies.releaseGate.reason || (dependencies.releaseGate.eligible === true ? 'play_recognized' : 'ineligible'),
    };
  }
  const env = dependencies.env || process.env;
  const interlock = assessProductActivationInterlock(env);
  if (interlock.publishVersion2 === false && interlock.reason !== 'product_off') {
    return { enforced: true, eligible: false, reason: interlock.reason };
  }
  const config = readAndroidReleaseGateConfig(env);
  if (!config.enforced) return { enforced: false, eligible: false, reason: 'gate_off' };
  const decision = await evaluateAndroidReleaseEligibility({
    config,
    request,
    authUid: dependencies.callerUid,
    challengeId: typeof request?.integrityChallengeId === 'string' ? request.integrityChallengeId : '',
    integrityToken: typeof request?.playIntegrityToken === 'string' ? request.playIntegrityToken : '',
    now: typeof dependencies.now === 'function' ? dependencies.now() : Date.now(),
    production: true,
    decode: dependencies.playIntegrityGoogleDecoder === true ? createGooglePlayIntegrityDecoder() : undefined,
    replayStore: dependencies.playIntegrityReplay,
  });
  return { enforced: true, eligible: decision.eligible === true, reason: decision.reason };
}

module.exports = {
  ANDROID_RELEASE_POLICY,
  readAndroidReleaseGateConfig,
  readPlatformReleaseDecisions,
  assessProductActivationInterlock,
  streetIntelligenceRequestHash,
  integrityTokenKey,
  createMemoryReplayStore,
  createDurableReplayStore,
  createFirestoreReplayStore,
  createSerializedClaim,
  assessDecodedPlayIntegrity,
  createGooglePlayIntegrityDecoder,
  issueStreetIntelligenceIntegrityChallenge,
  evaluateAndroidReleaseEligibility,
  resolveAndroidReleaseGate,
};
