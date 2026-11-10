'use strict';

const { createHash } = require('node:crypto');
const { publicCurbKey, toPublicCurb } = require('./canonicalCurbIdentity');
const { hasPrimaryTopologyAuthority } = require('./canonicalCurbResolver');
const { hasCanonicalCurbIdentityProof } = require('./canonicalCurbIdentityProof');
const {
  WRITE_AUTHORITY_SCHEME,
  generationIdFromPersistToken,
  evaluateWriteAuthority,
  associateDocumentAuthorities,
  bindDeadlineToFirestoreClock,
} = require('./writeAuthority');
const {
  LEGACY_SEGMENT_COLLECTION,
  LEGACY_RULES_SUBCOLLECTION,
  FIRESTORE_MAX_WRITES_PER_TRANSACTION,
  remapDeadlineBoundDocuments,
  publicSegmentPath,
  publicRulesCollectionPath,
  legacySegmentPath,
  legacyRulesCollectionPath,
} = require('./publicCurbCollections');

const PUBLIC_KEY = /^curb2_[a-f0-9]{32}$/;
const RULE_SET_VERSION = /^curbrules2_[a-f0-9]{20}$/;
const CACHE_COMPATIBILITY_VERSION = 'canonical-curb-cache-compatibility-1';
const PUBLIC_GEOMETRY_VERSION = 'canonical-public-geometry-1';

function publicSchedule(value) {
  if (!value || typeof value !== 'object') return null;
  const schedule = {};
  if (typeof value.side === 'string') schedule.side = value.side;
  if (Array.isArray(value.days)) schedule.days = value.days.filter(day => typeof day === 'string');
  if (typeof value.startTime === 'string') schedule.startTime = value.startTime;
  if (typeof value.endTime === 'string') schedule.endTime = value.endTime;
  if (typeof value.anytime === 'boolean') schedule.anytime = value.anytime;
  if (Number.isFinite(value.durationMinutes)) schedule.durationMinutes = value.durationMinutes;
  return Object.keys(schedule).length ? schedule : null;
}

function publicRate(value) {
  if (!value || typeof value !== 'object') return null;
  const rate = {};
  if (typeof value.kind === 'string') rate.kind = value.kind;
  if (Number.isFinite(value.unitMinutes)) rate.unitMinutes = value.unitMinutes;
  if (Number.isFinite(value.amount)) rate.amount = value.amount;
  if (typeof value.display === 'string') rate.display = value.display;
  return Object.keys(rate).length ? rate : null;
}

function toPublicRule(rule) {
  if (!rule || typeof rule !== 'object' || typeof rule.category !== 'string') return null;
  const typeByCategory = {
    cleaning: 'streetCleaning', meter: 'meter', restriction: rule.type,
    timeLimit: 'timeLimited', admin: rule.type,
  };
  const sourceByCanonicalName = {
    dot: 'nyc_open_data', sweepNyc: 'sweepnyc', parkNyc: 'park_nyc',
    admin: 'admin', nyc_open_data: 'nyc_open_data', sweepnyc: 'sweepnyc', park_nyc: 'park_nyc',
  };
  const value = { category: rule.category };
  const publicType = typeByCategory[rule.category] || rule.type;
  const publicSource = sourceByCanonicalName[rule.source] || rule.source;
  if (typeof publicType === 'string') value.type = publicType;
  if (typeof publicSource === 'string') value.source = publicSource;
  for (const key of ['side']) {
    if (typeof rule[key] === 'string') value[key] = rule[key];
  }
  for (const key of ['restrictionLevel', 'maxStayMinutes']) {
    if (Number.isFinite(rule[key])) value[key] = rule[key];
  }
  if (Array.isArray(rule.schedules)) {
    value.schedules = rule.schedules.map(publicSchedule).filter(Boolean);
  }
  if (Array.isArray(rule.windows)) {
    const windows = rule.windows.map(publicSchedule).filter(Boolean);
    if (windows.length && !value.schedules) value.schedules = windows;
  }
  const rate = publicRate(rule.rate);
  if (rate) {
    value.rate = rate;
    value.meterTerms = {
      ...(Number.isFinite(rule.maxStayMinutes) ? { maxStayMinutes: rule.maxStayMinutes } : {}),
      ...(typeof rate.display === 'string' ? { rateDisplay: rate.display } : {}),
    };
  } else if (Number.isFinite(rule.maxStayMinutes)) {
    value.meterTerms = { maxStayMinutes: rule.maxStayMinutes };
  }
  return value;
}

const canonicalNumber = value => Object.is(value, -0) ? 0 : value;

function firestoreGeometry(geometry) {
  if (geometry?.type !== 'MultiLineString' || !Array.isArray(geometry.coordinates)) return geometry;
  return {
    type: 'MultiLineString',
    lines: geometry.coordinates.map(line => ({
      points: (Array.isArray(line) ? line : []).map(point => ({
        lng: Array.isArray(point) ? point[0] : null,
        lat: Array.isArray(point) ? point[1] : null,
      })),
    })),
  };
}

function geoJsonGeometry(geometry) {
  if (!geometry || geometry.type !== 'MultiLineString' || Array.isArray(geometry.coordinates)
    || !Array.isArray(geometry.lines)) return geometry;
  return {
    type: 'MultiLineString',
    coordinates: geometry.lines.map(line => (
      (Array.isArray(line?.points) ? line.points : []).map(point => [point?.lng, point?.lat])
    )),
  };
}

function storedIdentity(identity) {
  if (!identity?.roadway) return identity;
  return {
    ...identity,
    roadway: { ...identity.roadway, geometry: firestoreGeometry(identity.roadway.geometry) },
  };
}

function restoredIdentity(identity) {
  if (!identity?.roadway) return identity;
  return {
    ...identity,
    roadway: { ...identity.roadway, geometry: geoJsonGeometry(identity.roadway.geometry) },
  };
}

function canonicalGeometry(value) {
  if (value?.type !== 'MultiLineString' || !Array.isArray(value.coordinates)) return null;
  const representation = JSON.stringify({
    schema: PUBLIC_GEOMETRY_VERSION,
    type: value.type,
    coordinates: value.coordinates.map(line => (
    line.map(point => point.map(canonicalNumber))
    )),
  });
  return createHash('sha256').update(representation).digest('hex');
}
const sorted = value => Array.isArray(value) ? [...value].sort() : [];

function compatibleIdentity(stored, current) {
  if (!stored || !current) return false;
  return stored.schemaVersion === current.schemaVersion
    && stored.jurisdiction === current.jurisdiction
    && stored.officialBlockFaceId === current.officialBlockFaceId
    && stored.csclSide === current.csclSide
    && stored.sourceVersion?.resourceId === current.sourceVersion?.resourceId
    && stored.sourceVersion?.version === current.sourceVersion?.version
    && stored.roadway?.selectedGlobalId === current.roadway?.selectedGlobalId
    && JSON.stringify(sorted(stored.roadway?.supportingGlobalIds))
      === JSON.stringify(sorted(current.roadway?.supportingGlobalIds))
    && stored.roadway?.physicalId === current.roadway?.physicalId
    && stored.roadway?.b5sc === current.roadway?.b5sc
    && canonicalGeometry(stored.roadway?.geometry) === canonicalGeometry(current.roadway?.geometry)
    && stored.names?.borough === current.names?.borough
    && stored.names?.onStreet === current.names?.onStreet
    && stored.names?.fromStreet === current.names?.fromStreet
    && stored.names?.toStreet === current.names?.toStreet
    && stored.side?.cardinal === current.side?.cardinal;
}

async function readCanonicalCache({ db, topologyResult, identityProof }) {
  if (!hasPrimaryTopologyAuthority(topologyResult)) return { hit: false, reason: 'authority_invalid' };
  if (!hasCanonicalCurbIdentityProof(identityProof, topologyResult)) {
    return { hit: false, reason: 'identity_proof_invalid' };
  }
  const identity = topologyResult.identity;
  const key = publicCurbKey(identity);
  if (!db || !PUBLIC_KEY.test(key || '')) return { hit: false, reason: 'invalid_public_key' };
  const [privateSnapshot, versionedSnapshot, legacySnapshot] = await Promise.all([
    db.doc(`curbIdentities/${key}`).get(),
    db.doc(publicSegmentPath(key)).get(),
    db.doc(legacySegmentPath(key)).get(),
  ]);
  const identityHasAuthority = Boolean(
    privateSnapshot?.exists
    && typeof privateSnapshot.data === 'function'
    && privateSnapshot.data()?.writeAuthority,
  );
  const useVersioned = Boolean(versionedSnapshot?.exists || identityHasAuthority);
  const publicSnapshot = useVersioned ? versionedSnapshot : legacySnapshot;
  if (!privateSnapshot?.exists || !publicSnapshot?.exists) {
    return { hit: false, reason: 'exact_identity_missing' };
  }
  const privateData = privateSnapshot.data();
  const storedIdentityValue = restoredIdentity(privateData?.identity);
  const publicSegment = {
    ...publicSnapshot.data(),
    geometry: geoJsonGeometry(publicSnapshot.data()?.geometry),
  };
  const currentPublic = topologyResult.publicCurb || toPublicCurb(identity);
  if (privateData?.schemaVersion !== 2 || publicSegment?.schemaVersion !== 2
    || publicSegment?.protocolVersion !== 2
    || privateData?.cacheCompatibilityVersion !== CACHE_COMPATIBILITY_VERSION
    || publicSegment?.cacheCompatibilityVersion !== CACHE_COMPATIBILITY_VERSION
    || privateData?.publicCurbKey !== key || publicCurbKey(storedIdentityValue) !== key
    || publicSegment?.segmentId !== key
    || !RULE_SET_VERSION.test(publicSegment?.activeRuleSetVersion || '')
    || !compatibleIdentity(storedIdentityValue, identity)
    || publicSegment.streetName !== currentPublic?.streetName
    || publicSegment.sideLabel !== currentPublic?.sideLabel
    || canonicalGeometry(publicSegment.geometry) !== canonicalGeometry(currentPublic?.geometry)) {
    return { hit: false, reason: 'cache_curb_mismatch' };
  }
  const privateAuth = evaluateWriteAuthority(privateData?.writeAuthority);
  const publicAuth = evaluateWriteAuthority(publicSegment?.writeAuthority);
  const associated = associateDocumentAuthorities([privateAuth, publicAuth]);
  if (associated.status === 'reject') {
    return { hit: false, reason: associated.reason || 'write_authority_rejected' };
  }
  if (associated.status === 'valid' && typeof db.collection === 'function'
    && publicSegment?.activeRuleSetVersion) {
    const rulesPath = useVersioned ? publicRulesCollectionPath(key) : legacyRulesCollectionPath(key);
    const rulesSnap = await db.collection(rulesPath)
      .where('ruleSetVersion', '==', publicSegment.activeRuleSetVersion)
      .get();
    const ruleDocs = Array.isArray(rulesSnap?.docs) ? rulesSnap.docs : [];
    const ruleEvals = ruleDocs.map((doc) => (
      evaluateWriteAuthority((typeof doc.data === 'function' ? doc.data() : doc)?.writeAuthority)
    ));
    if (ruleEvals.length) {
      const rulesAssociated = associateDocumentAuthorities([publicAuth, ...ruleEvals]);
      if (rulesAssociated.status === 'reject') {
        return { hit: false, reason: rulesAssociated.reason || 'write_authority_rejected' };
      }
    }
  }
  return { hit: true, identity: storedIdentityValue, publicSegment };
}

function writePermitted(input = {}) {
  if (input.signal?.aborted) return false;
  if (Number.isFinite(input.deadlineAt) && Date.now() >= input.deadlineAt) return false;
  if (typeof input.persistAllowed === 'function') {
    return input.persistAllowed(input.persistToken) === true;
  }
  return true;
}

function refuseWrite(input = {}) {
  if (input.signal?.aborted) return { success: false, reason: 'request_aborted' };
  if (Number.isFinite(input.deadlineAt) && Date.now() >= input.deadlineAt) {
    return { success: false, reason: 'request_aborted' };
  }
  if (typeof input.persistAllowed === 'function' && input.persistAllowed(input.persistToken) !== true) {
    return { success: false, reason: 'request_aborted' };
  }
  return null;
}

function trustedProductCaller(uid) {
  return typeof uid === 'string' && uid.length > 0 && uid.length <= 128 && !uid.includes('/');
}


function resolveFieldValue(input = {}) {
  if (input.FieldValue && typeof input.FieldValue.serverTimestamp === 'function') {
    return input.FieldValue;
  }
  try {
    return require('firebase-admin/firestore').FieldValue;
  } catch {
    return null;
  }
}

async function runGuardedPersistTransaction(input, work) {
  const db = input.db;
  const userInitiated = Object.prototype.hasOwnProperty.call(input || {}, 'callerUid');
  if (userInitiated) {
    const callerUid = input.callerUid;
    if (!trustedProductCaller(callerUid) || typeof db.runTransaction !== 'function') {
      return { success: false, reason: 'product_access_denied' };
    }
    const { userRecordDenies } = require('../productAccess');
    const denied = Symbol('product-access-denied');
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(db.doc(`users/${callerUid}`));
        const data = snap && snap.exists && typeof snap.data === 'function' ? snap.data() : null;
        if (userRecordDenies(data)) throw denied;
        if (!writePermitted(input)) throw new Error('request_aborted');
        await work(tx);
      });
    } catch (err) {
      if (err === denied) return { success: false, reason: 'product_access_denied' };
      const late = refuseWrite(input);
      if (late) return late;
      if (String(err?.message || err) === 'request_aborted') {
        return { success: false, reason: 'request_aborted' };
      }
      if (String(err?.message || err) === 'newer_valid_exists') {
        return { success: true, published: false, skipped: 'newer_valid_exists' };
      }
      throw err;
    }
    return { success: true };
  }

  try {
    await db.runTransaction(async (tx) => {
      if (!writePermitted(input)) throw new Error('request_aborted');
      await work(tx);
    });
  } catch (err) {
    const late = refuseWrite(input);
    if (late) return late;
    if (String(err?.message || err) === 'request_aborted') {
      return { success: false, reason: 'request_aborted' };
    }
    if (String(err?.message || err) === 'newer_valid_exists') {
      return { success: true, published: false, skipped: 'newer_valid_exists' };
    }
    throw err;
  }
  return { success: true };
}

async function persistDeadlineBoundCurb(input, documents, key, rules) {
  const FieldValue = resolveFieldValue(input);
  const generationId = generationIdFromPersistToken(input.persistToken);
  if (!generationId) return { success: false, reason: 'request_aborted' };
  const bound = await bindDeadlineToFirestoreClock({
    db: input.db,
    FieldValue,
    key,
    generationId,
    deadlineAt: input.deadlineAt,
    now: () => Date.now(),
  });
  if (!bound.ok) return { success: false, reason: bound.reason || 'request_aborted' };
  const refusedAfterProbe = refuseWrite(input);
  if (refusedAfterProbe) return refusedAfterProbe;

  const stagedDocuments = documents;
  const publicDocuments = remapDeadlineBoundDocuments(input.db, stagedDocuments, key);
  if (publicDocuments.length > FIRESTORE_MAX_WRITES_PER_TRANSACTION) {
    return { success: false, reason: 'request_aborted' };
  }

  const generationRef = input.db.doc(`curbWriteGenerations/${key}/generations/${generationId}`);
  const generationRecord = {
    scheme: WRITE_AUTHORITY_SCHEME,
    generationId,
    deadlineAtMs: bound.deadlineFsMs,
    committedAt: FieldValue.serverTimestamp(),
    publicCurbKey: key,
    identity: stagedDocuments.find(([ref]) => ref.path.startsWith('curbIdentities/'))?.[1] || null,
    segment: stagedDocuments.find(([ref]) => ref.path === `${LEGACY_SEGMENT_COLLECTION}/${key}`)?.[1] || null,
    rules: stagedDocuments
      .filter(([ref]) => ref.path.startsWith(`${LEGACY_SEGMENT_COLLECTION}/${key}/${LEGACY_RULES_SUBCOLLECTION}/`))
      .map(([ref, value]) => ({ path: ref.path, value })),
  };

  const phase1 = await runGuardedPersistTransaction(input, async (tx) => {
    tx.set(generationRef, generationRecord);
  });
  if (!phase1.success) return { success: false, reason: phase1.reason || 'request_aborted' };

  const genSnap = await generationRef.get();
  const generated = genSnap && typeof genSnap.data === 'function' ? genSnap.data() : null;
  const stagingAuthority = {
    scheme: WRITE_AUTHORITY_SCHEME,
    generationId,
    deadlineAtMs: bound.deadlineFsMs,
    committedAt: generated?.committedAt,
  };
  const eligibility = evaluateWriteAuthority(stagingAuthority, { role: 'staging' });
  if (eligibility.status !== 'valid' || !writePermitted(input)) {
    return { success: false, reason: 'request_aborted' };
  }

  const publicAuthority = {
    ...stagingAuthority,
    promotedAt: FieldValue.serverTimestamp(),
  };

  const phase2 = await runGuardedPersistTransaction(input, async (tx) => {
    const currentSnap = await tx.get(input.db.doc(publicSegmentPath(key)));
    const current = currentSnap && currentSnap.exists && typeof currentSnap.data === 'function'
      ? currentSnap.data()
      : null;
    const currentEval = evaluateWriteAuthority(current?.writeAuthority);
    if (currentEval.status === 'valid' && currentEval.committedAtMs > eligibility.committedAtMs) {
      throw new Error('newer_valid_exists');
    }
    for (const [ref, value] of publicDocuments) {
      tx.set(ref, {
        ...value,
        writeAuthority: publicAuthority,
        updatedAt: stagingAuthority.committedAt,
      });
    }
  });
  if (phase2.success === false) {
    return { success: false, reason: phase2.reason || 'request_aborted' };
  }
  if (phase2.skipped === 'newer_valid_exists') {
    return {
      success: true,
      publicCurbKey: key,
      ruleCount: rules.length,
      published: false,
    };
  }

  const publishedSnap = await input.db.doc(publicSegmentPath(key)).get();
  const publishedData = publishedSnap && typeof publishedSnap.data === 'function' ? publishedSnap.data() : null;
  const publishedEval = evaluateWriteAuthority(publishedData?.writeAuthority);
  if (publishedEval.status !== 'valid') {
    return {
      success: false,
      reason: 'request_aborted',
      published: false,
      storedNonAuthoritative: true,
    };
  }
  return {
    success: true,
    publicCurbKey: key,
    ruleCount: rules.length,
    published: true,
  };
}

async function persistCanonicalCurb(input = {}) {
  const { db, Timestamp, topologyResult, identityProof, selectedRules } = input || {};
  if (!hasPrimaryTopologyAuthority(topologyResult)) {
    return { success: false, reason: 'authority_invalid' };
  }
  if (!hasCanonicalCurbIdentityProof(identityProof, topologyResult)) {
    return { success: false, reason: 'identity_proof_invalid' };
  }
  const identity = topologyResult.identity;
  const key = publicCurbKey(identity);
  const publicCurb = toPublicCurb(identity);
  if (!db || !Timestamp?.now || !key || !publicCurb) {
    return { success: false, reason: 'invalid_canonical_curb' };
  }
  const rules = (Array.isArray(selectedRules?.rules) ? selectedRules.rules : [])
    .map(toPublicRule).filter(Boolean);
  const ruleSetVersion = `curbrules2_${createHash('sha256')
    .update(JSON.stringify(rules)).digest('hex').slice(0, 20)}`;
  const now = Timestamp.now();
  const documents = [
    [db.doc(`curbIdentities/${key}`), {
      schemaVersion: 2,
      cacheCompatibilityVersion: CACHE_COMPATIBILITY_VERSION,
      publicCurbKey: key,
      identity: storedIdentity(identity),
      updatedAt: now,
    }],
    [db.doc(`streetSegments/${key}`), {
      ...publicCurb,
      geometry: firestoreGeometry(publicCurb.geometry),
      status: 'active',
      protocolVersion: 2,
      cacheCompatibilityVersion: CACHE_COMPATIBILITY_VERSION,
      activeRuleSetVersion: ruleSetVersion,
      ruleSummary: {
        cleaningAvailable: Boolean(selectedRules?.cleaning),
        rulesResolved: selectedRules?.rulesResolved === true,
      },
      updatedAt: now,
    }],
    ...rules.map((rule, index) => [db.doc(`streetSegments/${key}/streetRules/${ruleSetVersion}_${index}`), {
      ...rule,
      protocolVersion: 2,
      ruleSetVersion,
      effectiveDate: now,
      supersededAt: null,
      updatedAt: now,
    }]),
  ];

  // User-initiated saves name the authenticated caller. The access read and
  // the curb writes commit in one transaction that re-checks the shared
  // deadline, abort signal, and request-scoped persist token so a late
  // commit after cancellation is refused. Callers that do not supply
  // callerUid are scheduled, internal, or test paths and keep the batch
  // only when transactions are unavailable.
  const refused = refuseWrite(input);
  if (refused) return refused;
  if (Number.isFinite(input.deadlineAt)) {
    return persistDeadlineBoundCurb(input, documents, key, rules);
  }
  const userInitiated = Object.prototype.hasOwnProperty.call(input || {}, 'callerUid');
  const useTransaction = typeof db.runTransaction === 'function'
    && (userInitiated || input.signal || Number.isFinite(input.deadlineAt) || typeof input.persistAllowed === 'function');
  if (userInitiated) {
    const callerUid = input.callerUid;
    if (!trustedProductCaller(callerUid) || typeof db.runTransaction !== 'function') {
      return { success: false, reason: 'product_access_denied' };
    }
    const { userRecordDenies } = require('../productAccess');
    const denied = Symbol('product-access-denied');
    try {
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(db.doc(`users/${callerUid}`));
        const data = snap && snap.exists && typeof snap.data === 'function' ? snap.data() : null;
        if (userRecordDenies(data)) throw denied;
        if (!writePermitted(input)) throw new Error('request_aborted');
        for (const [ref, value] of documents) tx.set(ref, value);
      });
    } catch (err) {
      if (err === denied) return { success: false, reason: 'product_access_denied' };
      const late = refuseWrite(input);
      if (late) return late;
      if (String(err?.message || err) === 'request_aborted') {
        return { success: false, reason: 'request_aborted' };
      }
      throw err;
    }
    const after = refuseWrite(input);
    if (after) return after;
    return { success: true, publicCurbKey: key, ruleCount: rules.length };
  }

  if (useTransaction) {
    try {
      await db.runTransaction(async (tx) => {
        if (!writePermitted(input)) throw new Error('request_aborted');
        for (const [ref, value] of documents) tx.set(ref, value);
      });
    } catch (err) {
      const late = refuseWrite(input);
      if (late) return late;
      if (String(err?.message || err) === 'request_aborted') {
        return { success: false, reason: 'request_aborted' };
      }
      throw err;
    }
    const after = refuseWrite(input);
    if (after) return after;
    return { success: true, publicCurbKey: key, ruleCount: rules.length };
  }

  const beforeBatch = refuseWrite(input);
  if (beforeBatch) return beforeBatch;
  const batch = db.batch();
  for (const [ref, value] of documents) batch.set(ref, value);
  const beforeCommit = refuseWrite(input);
  if (beforeCommit) return beforeCommit;
  await batch.commit();
  const afterCommit = refuseWrite(input);
  if (afterCommit) return afterCommit;
  return { success: true, publicCurbKey: key, ruleCount: rules.length };
}

async function migrateCompatibleLegacyRules(input = {}) {
  const identity = input.identity;
  const legacy = input.legacySegment;
  const sameStreet = String(legacy?.streetName || '').trim().toUpperCase()
    === String(identity?.names?.onStreet || '').trim().toUpperCase();
  const sameSide = String(legacy?.parkingSide || '').trim().toUpperCase()
    === String(identity?.side?.cardinal || '').trim().toUpperCase();
  if (input.relationshipMatches !== true || !sameStreet || !sameSide) {
    try { input.emit?.('cache_curb_mismatch', { protocolVersion: 2 }); } catch { /* fail-soft */ }
    return { copied: false, reason: 'cache_curb_mismatch', rules: [] };
  }
  const rules = (Array.isArray(input.legacyRules) ? input.legacyRules : [])
    .map(toPublicRule).filter(Boolean);
  return { copied: rules.length > 0, reason: rules.length ? 'compatible' : 'no_compatible_rules', rules };
}

module.exports = {
  readCanonicalCache,
  persistCanonicalCurb,
  migrateCompatibleLegacyRules,
  toPublicRule,
  compatibleIdentity,
  canonicalGeometry,
  CACHE_COMPATIBILITY_VERSION,
  PUBLIC_GEOMETRY_VERSION,
};
