'use strict';

const { createHash } = require('node:crypto');
const { publicCurbKey, toPublicCurb } = require('./canonicalCurbIdentity');

const PUBLIC_KEY = /^curb2_[a-f0-9]{32}$/;

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

async function readCanonicalCache({ db, publicCurbKey: key }) {
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
  const identity = privateData?.identity;
  if (publicCurbKey(identity) !== key || publicSegment?.segmentId !== key) {
    return { hit: false, reason: 'cache_curb_mismatch' };
  }
  return { hit: true, identity, publicSegment };
}

async function persistCanonicalCurb({ db, Timestamp, identity, selectedRules }) {
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
    publicCurbKey: key,
    identity,
    updatedAt: now,
  });
  batch.set(db.doc(`streetSegments/${key}`), {
    ...publicCurb,
    status: 'active',
    protocolVersion: 2,
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
};
