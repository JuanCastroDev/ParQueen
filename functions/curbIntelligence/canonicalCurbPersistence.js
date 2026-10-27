'use strict';

const { createHash } = require('node:crypto');
const { publicCurbKey, toPublicCurb } = require('./canonicalCurbIdentity');
const { hasPrimaryTopologyAuthority } = require('./canonicalCurbResolver');
const { hasCanonicalCurbIdentityProof } = require('./canonicalCurbIdentityProof');

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
  const [privateSnapshot, publicSnapshot] = await Promise.all([
    db.doc(`curbIdentities/${key}`).get(),
    db.doc(`streetSegments/${key}`).get(),
  ]);
  if (!privateSnapshot?.exists || !publicSnapshot?.exists) {
    return { hit: false, reason: 'exact_identity_missing' };
  }
  const privateData = privateSnapshot.data();
  const publicSegment = publicSnapshot.data();
  const storedIdentity = privateData?.identity;
  const currentPublic = topologyResult.publicCurb || toPublicCurb(identity);
  if (privateData?.schemaVersion !== 2 || publicSegment?.schemaVersion !== 2
    || publicSegment?.protocolVersion !== 2
    || privateData?.cacheCompatibilityVersion !== CACHE_COMPATIBILITY_VERSION
    || publicSegment?.cacheCompatibilityVersion !== CACHE_COMPATIBILITY_VERSION
    || privateData?.publicCurbKey !== key || publicCurbKey(storedIdentity) !== key
    || publicSegment?.segmentId !== key
    || !RULE_SET_VERSION.test(publicSegment?.activeRuleSetVersion || '')
    || !compatibleIdentity(storedIdentity, identity)
    || publicSegment.streetName !== currentPublic?.streetName
    || publicSegment.sideLabel !== currentPublic?.sideLabel
    || canonicalGeometry(publicSegment.geometry) !== canonicalGeometry(currentPublic?.geometry)) {
    return { hit: false, reason: 'cache_curb_mismatch' };
  }
  return { hit: true, identity: storedIdentity, publicSegment };
}

async function persistCanonicalCurb({ db, Timestamp, topologyResult, identityProof, selectedRules }) {
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
  const batch = db.batch();
  batch.set(db.doc(`curbIdentities/${key}`), {
    schemaVersion: 2,
    cacheCompatibilityVersion: CACHE_COMPATIBILITY_VERSION,
    publicCurbKey: key,
    identity,
    updatedAt: now,
  });
  batch.set(db.doc(`streetSegments/${key}`), {
    ...publicCurb,
    status: 'active',
    protocolVersion: 2,
    cacheCompatibilityVersion: CACHE_COMPATIBILITY_VERSION,
    activeRuleSetVersion: ruleSetVersion,
    ruleSummary: { cleaningAvailable: Boolean(selectedRules?.cleaning) },
    updatedAt: now,
  });
  rules.forEach((rule, index) => {
    batch.set(db.doc(`streetSegments/${key}/streetRules/${ruleSetVersion}_${index}`), {
      ...rule,
      protocolVersion: 2,
      ruleSetVersion,
      effectiveDate: now,
      supersededAt: null,
      updatedAt: now,
    });
  });
  await batch.commit();
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
