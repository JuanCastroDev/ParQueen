'use strict';

const { createHash } = require('node:crypto');

// Scheme 1 authority: a write generation is publicly authoritative
// only when both its private staging committedAt and its public
// promotedAt (the Firestore server timestamp resolved at the public
// promotion commit) are strictly earlier than the same deadline,
// expressed in the Firestore time domain via bindDeadlineToFirestoreClock
// (remaining Functions budget minus CLOCK_DRIFT_MARGIN_MS).
// Staging-only evaluation (role: 'staging') checks committedAt alone
// so phase 1 can be validated before promotion exists.
const WRITE_AUTHORITY_SCHEME = 1;
const GENERATION_ID_PATTERN = /^[a-f0-9]{32}$/;

// After a clock probe binds remaining Functions-domain budget onto a
// Firestore server timestamp, the two clocks may still drift. Shrink the
// bound by this fail-closed margin so a commit is accepted only when it
// is safely inside the converted deadline. This does not claim the clocks
// are identical; it makes residual skew reject rather than accept.
const CLOCK_DRIFT_MARGIN_MS = 250;

function generationIdFromPersistToken(persistToken) {
  if (typeof persistToken !== 'string' || persistToken.length < 8) return null;
  return createHash('sha256').update(persistToken).digest('hex').slice(0, 32);
}

function timestampToMillis(value) {
  if (value == null) return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value.toMillis === 'function') {
    try {
      const ms = value.toMillis();
      return Number.isFinite(ms) ? ms : null;
    } catch {
      return null;
    }
  }
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value.seconds === 'number') {
    return value.seconds * 1000 + Math.floor((value.nanoseconds || 0) / 1e6);
  }
  return null;
}

function evaluateWriteAuthority(authority, options = {}) {
  if (authority == null) return { status: 'legacy' };
  if (typeof authority !== 'object') {
    return { status: 'reject', reason: 'malformed_authority' };
  }
  if (authority.scheme !== WRITE_AUTHORITY_SCHEME) {
    return { status: 'reject', reason: 'malformed_authority' };
  }
  if (typeof authority.generationId !== 'string' || !GENERATION_ID_PATTERN.test(authority.generationId)) {
    return { status: 'reject', reason: 'malformed_authority' };
  }
  if (!Number.isFinite(authority.deadlineAtMs)) {
    return { status: 'reject', reason: 'malformed_authority' };
  }
  const committedAtMs = timestampToMillis(authority.committedAt);
  if (committedAtMs == null) {
    return { status: 'reject', reason: 'malformed_authority' };
  }
  // Inclusive fail-closed: a commit at the deadline is not authorized.
  if (committedAtMs >= authority.deadlineAtMs) {
    return { status: 'reject', reason: 'committed_at_or_after_deadline' };
  }
  if (options.role === 'staging') {
    return {
      status: 'valid',
      generationId: authority.generationId,
      committedAtMs,
      deadlineAtMs: authority.deadlineAtMs,
    };
  }
  const promotedAtMs = timestampToMillis(authority.promotedAt);
  if (promotedAtMs == null) {
    return { status: 'reject', reason: 'malformed_authority' };
  }
  if (promotedAtMs >= authority.deadlineAtMs) {
    return { status: 'reject', reason: 'promoted_at_or_after_deadline' };
  }
  return {
    status: 'valid',
    generationId: authority.generationId,
    committedAtMs,
    promotedAtMs,
    deadlineAtMs: authority.deadlineAtMs,
  };
}

function associateDocumentAuthorities(evaluations) {
  const list = (Array.isArray(evaluations) ? evaluations : []).filter(Boolean);
  if (!list.length) return { status: 'legacy' };
  if (list.some(item => item.status === 'reject')) {
    const first = list.find(item => item.status === 'reject');
    return { status: 'reject', reason: first.reason || 'malformed_authority' };
  }
  const valids = list.filter(item => item.status === 'valid');
  const legacies = list.filter(item => item.status === 'legacy');
  if (valids.length && legacies.length) {
    return { status: 'reject', reason: 'inconsistent_authority' };
  }
  if (!valids.length) return { status: 'legacy' };
  const generationId = valids[0].generationId;
  if (valids.some(item => item.generationId !== generationId)) {
    return { status: 'reject', reason: 'inconsistent_authority' };
  }
  return { status: 'valid', generationId };
}

function filterAuthoritativeRules(segment, rules) {
  const segmentEval = evaluateWriteAuthority(segment && segment.writeAuthority);
  if (segmentEval.status === 'reject') {
    return { ok: false, rules: [], reason: segmentEval.reason, status: 'reject' };
  }
  const list = Array.isArray(rules) ? rules : [];
  const kept = [];
  for (const rule of list) {
    const ruleEval = evaluateWriteAuthority(rule && rule.writeAuthority);
    if (segmentEval.status === 'legacy') {
      if (ruleEval.status === 'legacy') kept.push(rule);
      continue;
    }
    if (ruleEval.status === 'valid' && ruleEval.generationId === segmentEval.generationId) {
      kept.push(rule);
    }
  }
  return {
    ok: true,
    rules: kept,
    status: segmentEval.status,
    generationId: segmentEval.generationId || null,
    reason: null,
  };
}

function segmentAllowsAuthoritativeRead(segment) {
  const evaluation = evaluateWriteAuthority(segment && segment.writeAuthority);
  if (evaluation.status === 'reject') {
    return { ok: false, reason: evaluation.reason, status: 'reject' };
  }
  return { ok: true, status: evaluation.status, generationId: evaluation.generationId || null };
}

async function bindDeadlineToFirestoreClock({
  db,
  FieldValue,
  key,
  generationId,
  deadlineAt,
  now,
} = {}) {
  const nowFn = typeof now === 'function' ? now : Date.now;
  if (!Number.isFinite(deadlineAt) || nowFn() >= deadlineAt) {
    return { ok: false, reason: 'request_aborted' };
  }
  if (!db || typeof db.doc !== 'function' || typeof FieldValue?.serverTimestamp !== 'function') {
    return { ok: false, reason: 'clock_probe_invalid' };
  }
  if (typeof generationId !== 'string' || !GENERATION_ID_PATTERN.test(generationId)) {
    return { ok: false, reason: 'malformed_authority' };
  }
  const probeRef = db.doc(`curbWriteGenerations/${key}/clockProbes/${generationId}`);
  await probeRef.set({
    sampledAt: FieldValue.serverTimestamp(),
    scheme: WRITE_AUTHORITY_SCHEME,
  });
  const snap = await probeRef.get();
  const data = snap && typeof snap.data === 'function' ? snap.data() : null;
  const sampledAtMs = timestampToMillis(data?.sampledAt);
  if (sampledAtMs == null) return { ok: false, reason: 'clock_probe_invalid' };
  const remainingMs = deadlineAt - nowFn();
  if (remainingMs <= 0) return { ok: false, reason: 'request_aborted' };
  const deadlineFsMs = sampledAtMs + remainingMs - CLOCK_DRIFT_MARGIN_MS;
  if (!(deadlineFsMs > sampledAtMs)) return { ok: false, reason: 'request_aborted' };
  return { ok: true, deadlineFsMs, sampledAtMs, remainingMs };
}

module.exports = {
  WRITE_AUTHORITY_SCHEME,
  CLOCK_DRIFT_MARGIN_MS,
  GENERATION_ID_PATTERN,
  generationIdFromPersistToken,
  timestampToMillis,
  evaluateWriteAuthority,
  associateDocumentAuthorities,
  filterAuthoritativeRules,
  segmentAllowsAuthoritativeRead,
  bindDeadlineToFirestoreClock,
};