import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { persistCanonicalCurb, readCanonicalCache } = require('./curbIntelligence/canonicalCurbPersistence');
const { createRequestDeadline } = require('./curbIntelligence/requestDeadline');
const { evaluateWriteAuthority, filterAuthoritativeRules, segmentAllowsAuthoritativeRead } = require('./curbIntelligence/writeAuthority');
const { resolveCanonicalCurb } = require('./curbIntelligence/canonicalCurbResolver');
const { createPrivateBlockfaceResolver } = require('./curbIntelligence/privateBlockfaceResolver');
const { proveCanonicalCurbIdentity } = require('./curbIntelligence/canonicalCurbIdentityProof');
const { publicCurbKey } = require('./curbIntelligence/canonicalCurbIdentity');

const enabled = process.env.PARQUEEN_LATE_COMMIT_EMULATOR === '1';
const host = process.env.FIRESTORE_EMULATOR_HOST || '';

function wrapDb(firestore, { delayPhase2Ms = 0, beforePhase2Work } = {}) {
  let txCount = 0;
  return {
    txCount: () => txCount,
    doc: (p) => firestore.doc(p),
    collection: (p) => firestore.collection(p),
    runTransaction: (fn) => firestore.runTransaction(async (tx) => {
      txCount += 1;
      const phase = txCount;
      if (phase === 2 && typeof beforePhase2Work === 'function') await beforePhase2Work();
      const result = await fn(tx);
      if (phase === 2 && delayPhase2Ms > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayPhase2Ms));
      }
      return result;
    }),
  };
}

async function topology(firestore, suffix) {
  const row = {
    globalid: `private-global-${suffix}`, physicalid: `private-physical-${suffix}`, b5sc: `private-b5sc-${suffix}`,
    l_blockfaceid: String(2000000000 + Math.abs([...String(suffix)].reduce((sum, ch) => sum + ch.charCodeAt(0), 0))),
    r_blockfaceid: String(3000000000 + Math.abs([...String(suffix)].reduce((sum, ch) => sum + ch.charCodeAt(0), 0))),
    boroughcode: '2', rw_type: '1',
    full_street_name: 'MARAN PLACE', street_name: 'MARAN PLACE', stname_label: 'MARAN PL',
    streetwidth: '34', from_level_code: '13', to_level_code: '13', status: '2', nonped: '', accessible: '',
    from_street: 'WHITE PLAINS ROAD', to_street: 'LURTING AVENUE',
    the_geom: { type: 'MultiLineString', coordinates: [[[-74, 40.7], [-73.999, 40.7]]] },
  };
  const fetchFn = async (url) => ({
    ok: true,
    json: async () => (String(url).includes('/api/views/')
      ? { id: 'inkn-q76z', rowsUpdatedAt: 1767225600, viewLastModified: 1767225660 }
      : [row]),
  });
  const topologyResult = await resolveCanonicalCurb({
    lat: 40.70005, lng: -73.9999, accuracyMeters: 1, sampleCount: 3, consistencyMeters: 1,
  }, { fetchFn, requestNonce: `promotion-deadline-${suffix}-${Date.now()}` });
  const body = {
    ok: true,
    officialBlockFaceId: topologyResult.identity.officialBlockFaceId,
    normalizedStreetNames: {
      onStreet: 'MARAN PLACE', crossStreetOne: 'WHITE PLAINS ROAD', crossStreetTwo: 'LURTING AVENUE',
    },
    returnCode: '00', reasonCode: ' ',
    sourceVersion: { geosupportRelease: '26C', geosupportVersion: '26.3' },
  };
  const identityProof = await proveCanonicalCurbIdentity(topologyResult, {
    blockfaceResolver: createPrivateBlockfaceResolver({
      mode: 'shadow', serviceUrl: 'https://parqueen-test-resolver-uc.a.run.app',
      getIdToken: async () => 'synthetic-token',
      transport: async () => ({ status: 200, text: async () => JSON.stringify(body) }),
    }),
  });
  return { topologyResult, identityProof, key: publicCurbKey(topologyResult.identity), firestore };
}

async function persistWith(firestore, built, extra = {}) {
  const deadline = extra.deadline || createRequestDeadline({
    startedAt: extra.startedAt || Date.now(),
    budgetMs: 8000,
  });
  const db = extra.db || wrapDb(firestore, extra);
  const result = await persistCanonicalCurb({
    db,
    Timestamp,
    FieldValue,
    topologyResult: built.topologyResult,
    identityProof: built.identityProof,
    selectedRules: extra.selectedRules || { rules: [] },
    signal: deadline.signal,
    deadlineAt: deadline.deadlineAt,
    persistToken: extra.persistToken || deadline.persistToken,
    persistAllowed: extra.persistAllowed || deadline.persistAllowed,
  });
  return { result, deadline, db };
}

async function inspect(firestore, key) {
  const [v2, legacy, identity, legacyRules, v2Rules, legacyGroup] = await Promise.all([
    firestore.doc(`streetSegmentsV2/${key}`).get(),
    firestore.doc(`streetSegments/${key}`).get(),
    firestore.doc(`curbIdentities/${key}`).get(),
    firestore.collection(`streetSegments/${key}/streetRules`).get(),
    firestore.collection(`streetSegmentsV2/${key}/streetRulesV2`).get(),
    firestore.collectionGroup('streetRules').get(),
  ]);
  const v2Data = v2.exists ? v2.data() : null;
  return {
    v2Exists: v2.exists,
    legacyExists: legacy.exists,
    identityExists: identity.exists,
    v2UpdateTimeMs: v2.exists ? v2.updateTime.toMillis() : null,
    identityUpdateTimeMs: identity.exists ? identity.updateTime.toMillis() : null,
    stagingCommittedAtMs: v2Data?.writeAuthority?.committedAt?.toMillis?.() ?? null,
    promotedAtMs: v2Data?.writeAuthority?.promotedAt?.toMillis?.() ?? null,
    deadlineAtMs: v2Data?.writeAuthority?.deadlineAtMs ?? null,
    authority: evaluateWriteAuthority(v2Data?.writeAuthority),
    segmentOk: segmentAllowsAuthoritativeRead(v2Data),
    legacyRules: legacyRules.size,
    v2Rules: v2Rules.size,
    legacyGroupHasKey: legacyGroup.docs.some((doc) => doc.ref.path.includes(`${key}/streetRules/`)),
  };
}

function emulatorFirestore() {
  if (!host.startsWith('127.0.0.1:') || host.endsWith(':8080')) {
    throw new Error(`Refusing emulator host ${host}`);
  }
  const app = getApps().find((item) => item.name === 't640u-promotion')
    || initializeApp({ projectId: 'demo-parkqueen-promotion-deadline' }, 't640u-promotion');
  return getFirestore(app);
}

describe.skipIf(!enabled)('canonical curb public promotion deadline emulator', () => {
  it('publishes an on-time staging and on-time promotion only to V2', async () => {
    const firestore = emulatorFirestore();
    const built = await topology(firestore, `on-time-${Date.now()}`);
    const { result, deadline } = await persistWith(firestore, built, { startedAt: Date.now() });
    const seen = await inspect(firestore, built.key);
    const cache = await readCanonicalCache({ db: firestore, topologyResult: built.topologyResult, identityProof: built.identityProof });
    expect(result).toEqual(expect.objectContaining({ success: true, published: true }));
    expect(seen.legacyExists).toBe(false);
    expect(seen.legacyRules).toBe(0);
    expect(seen.legacyGroupHasKey).toBe(false);
    expect(seen.v2Exists).toBe(true);
    expect(seen.authority.status).toBe('valid');
    expect(seen.promotedAtMs).toBeLessThan(seen.deadlineAtMs);
    expect(seen.stagingCommittedAtMs).toBeLessThan(seen.deadlineAtMs);
    expect(cache.hit).toBe(true);
    deadline.dispose();
  }, 30_000);

  it('rejects the original late-promotion race and hides it from legacy collections', async () => {
    const firestore = emulatorFirestore();
    await firestore.doc('_t640u_warmup/ping').set({ at: FieldValue.serverTimestamp() });
    const built = await topology(firestore, `late-${Date.now()}`);
    const { result, deadline } = await persistWith(firestore, built, {
      startedAt: Date.now() - 5500,
      delayPhase2Ms: 3000,
    });
    const seen = await inspect(firestore, built.key);
    const cache = await readCanonicalCache({ db: firestore, topologyResult: built.topologyResult, identityProof: built.identityProof });
    const loaded = { rules: [] };
    if (seen.v2Exists) {
      const snap = await firestore.doc(`streetSegmentsV2/${built.key}`).get();
      loaded.segment = snap.data();
    }
    expect(result.success).toBe(false);
    expect(seen.legacyExists).toBe(false);
    expect(seen.legacyGroupHasKey).toBe(false);
    expect(seen.v2Exists).toBe(true);
    expect(seen.stagingCommittedAtMs).toBeLessThan(seen.deadlineAtMs);
    expect(seen.promotedAtMs).toBeGreaterThanOrEqual(seen.deadlineAtMs);
    expect(seen.authority.status).toBe('reject');
    expect(seen.authority.reason).toBe('promoted_at_or_after_deadline');
    expect(seen.segmentOk.ok).toBe(false);
    expect(filterAuthoritativeRules(loaded.segment, []).ok).toBe(false);
    expect(cache.hit).toBe(false);
    deadline.dispose();
  }, 30_000);

  it('does not let a delayed older promotion overwrite a newer valid generation', async () => {
    const firestore = emulatorFirestore();
    const built = await topology(firestore, `race-${Date.now()}`);
    let releaseOlder;
    const olderGate = new Promise((resolve) => { releaseOlder = resolve; });
    const olderDb = wrapDb(firestore, { beforePhase2Work: () => olderGate });
    const newerDb = wrapDb(firestore);
    const olderDeadline = createRequestDeadline({ startedAt: Date.now(), budgetMs: 8000 });
    const olderPromise = persistCanonicalCurb({
      db: olderDb, Timestamp, FieldValue,
      topologyResult: built.topologyResult, identityProof: built.identityProof,
      selectedRules: { rules: [] },
      signal: olderDeadline.signal, deadlineAt: olderDeadline.deadlineAt,
      persistToken: olderDeadline.persistToken, persistAllowed: olderDeadline.persistAllowed,
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    const newerDeadline = createRequestDeadline({ startedAt: Date.now(), budgetMs: 8000 });
    const newerResult = await persistCanonicalCurb({
      db: newerDb, Timestamp, FieldValue,
      topologyResult: built.topologyResult, identityProof: built.identityProof,
      selectedRules: { rules: [] },
      signal: newerDeadline.signal, deadlineAt: newerDeadline.deadlineAt,
      persistToken: newerDeadline.persistToken, persistAllowed: newerDeadline.persistAllowed,
    });
    const afterNewer = await firestore.doc(`streetSegmentsV2/${built.key}`).get();
    const newerGenerationId = afterNewer.data()?.writeAuthority?.generationId;
    releaseOlder();
    const olderResult = await olderPromise;
    const afterOlder = await firestore.doc(`streetSegmentsV2/${built.key}`).get();
    expect(newerResult.success).toBe(true);
    expect(olderResult.published).toBe(false);
    expect(afterOlder.data()?.writeAuthority?.generationId).toBe(newerGenerationId);
    expect((await firestore.doc(`streetSegments/${built.key}`).get()).exists).toBe(false);
    olderDeadline.dispose();
    newerDeadline.dispose();
  }, 30_000);
});
