'use strict';

const INPUT_SCHEMA = 'parqueen.authObservationInput.v1';
const OUTPUT_SCHEMA = 'parqueen.authObservation.v1';
const SOURCE_STATES = new Set(['present', 'missing', 'malformed', 'read_failed', 'unchecked']);
const PHASES = new Set(['confirmed', 'pending', 'intent', 'rpc-issued']);
const FLAGS = new Set(['absent', 'false', 'true', 'malformed']);
const ERROR_CATEGORIES = new Set([
  'none', 'not-found', 'unconfirmed', 'rejected', 'superseded', 'lease-held', 'deletion',
  'ineligible', 'refused', 'duplicate', 'cooldown', 'attempt-exhausted', 'uncertain-stale',
  'revocation-required', 'internal', 'matched', 'repaired',
]);

function expectedCategory(outcome) {
  if (outcome === 'revocation-required') return 'revocation-required';
  if (outcome === 'uncertain-stale') return 'uncertain-stale';
  if (outcome === 'deletion-overlap') return 'deletion';
  if (ERROR_CATEGORIES.has(outcome)) return outcome;
  return 'internal';
}
const RECOVERY_OUTCOMES = new Set([
  'matched',
  'repaired',
  'pending',
  'unconfirmed',
  'refused',
  'deletion',
  'deletion-overlap',
  'not-found',
  'superseded',
  'rejected',
  'lease-held',
  'ineligible',
  'cooldown',
  'attempt-exhausted',
  'uncertain-stale',
  'revocation-required',
  'internal',
  'stale-finalization',
  'duplicate',
  'invalid-record',
]);

function sortUnique(items) {
  return [...new Set(items)].sort();
}

function emptyFacts() {
  return {
    authExists: null,
    authDisabled: null,
    tokensValidAfterTimePresent: null,
    profileStatus: null,
    denialFlag: null,
    productDenies: null,
    profileIntentEnableCriteriaMet: null,
    intentGeneration: null,
    intentPhase: null,
    desiredDisabled: null,
    fence: null,
    deletionJob: null,
    leaseClass: null,
    recoveryUncertain: null,
    revocationRequired: null,
  };
}

function result(partial) {
  return {
    schemaVersion: OUTPUT_SCHEMA,
    observedAtMs: partial.observedAtMs ?? null,
    completeness: partial.completeness,
    interrupted: partial.interrupted === true,
    facts: partial.facts || emptyFacts(),
    primary: partial.primary,
    findings: sortUnique(partial.findings || []),
    severity: partial.severity,
    reviewRequired: partial.reviewRequired === true,
    nextAction: partial.nextAction,
  };
}

function failClosed() {
  return result({
    completeness: 'incomplete',
    primary: 'INCOMPLETE',
    findings: ['INVALID_RECORD'],
    severity: 'review',
    reviewRequired: true,
    nextAction: 'manual_review',
  });
}

function validMs(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function sourceState(source) {
  if (!source || typeof source !== 'object' || !SOURCE_STATES.has(source.state)) return null;
  return source.state;
}

function normProfile(source) {
  const state = sourceState(source);
  if (state !== 'present') return { kind: state || 'malformed' };
  const value = source.value;
  if (!value || typeof value !== 'object') return { kind: 'malformed' };
  if (value.status !== 'Active' && value.status !== 'Suspended') return { kind: 'malformed' };
  if (!FLAGS.has(value.denialFlag)) return { kind: 'malformed' };
  return { kind: 'present', status: value.status, denialFlag: value.denialFlag };
}

function normIntent(source) {
  const state = sourceState(source);
  if (state !== 'present') return { kind: state || 'malformed' };
  const value = source.value;
  if (!value || typeof value !== 'object') return { kind: 'malformed' };
  if (!Number.isSafeInteger(value.generation) || value.generation < 0) return { kind: 'malformed' };
  if (typeof value.desiredDisabled !== 'boolean') return { kind: 'malformed' };
  if (!PHASES.has(value.phase)) return { kind: 'malformed' };
  return {
    kind: 'present',
    generation: value.generation,
    desiredDisabled: value.desiredDisabled,
    phase: value.phase,
  };
}

function normLock(source, sampledAtMs) {
  const state = sourceState(source);
  if (state !== 'present') return { kind: state || 'malformed', leaseClass: state === 'missing' ? 'missing' : state };
  const value = source.value;
  if (!value || typeof value !== 'object') return { kind: 'malformed', leaseClass: 'malformed' };
  if (typeof value.owner !== 'string' || value.owner.length === 0) return { kind: 'malformed', leaseClass: 'malformed' };
  if (!Number.isSafeInteger(value.generation) || value.generation < 0) return { kind: 'malformed', leaseClass: 'malformed' };
  if (!validMs(value.leaseExpiresAtMs)) return { kind: 'malformed', leaseClass: 'malformed' };
  const leaseClass = value.leaseExpiresAtMs > sampledAtMs ? 'live' : 'expired';
  return {
    kind: 'present',
    owner: value.owner,
    generation: value.generation,
    leaseExpiresAtMs: value.leaseExpiresAtMs,
    leaseClass,
  };
}

function normPresence(source) {
  const state = sourceState(source);
  return state || 'malformed';
}

function normRecovery(source, sampledAtMs) {
  const state = sourceState(source);
  if (state !== 'present') return { kind: state || 'malformed' };
  const value = source.value;
  if (!value || typeof value !== 'object') return { kind: 'malformed' };
  if (value.stable === true || (value.stable !== undefined && value.stable !== false)) return { kind: 'malformed' };
  if (!Number.isSafeInteger(value.generation) || value.generation < 0) return { kind: 'malformed' };
  if (typeof value.desiredDisabled !== 'boolean') return { kind: 'malformed' };
  if (!Number.isSafeInteger(value.attempts) || value.attempts < 0) return { kind: 'malformed' };
  if (typeof value.administratorRequired !== 'boolean') return { kind: 'malformed' };
  if (typeof value.authMutationIssued !== 'boolean') return { kind: 'malformed' };
  if (typeof value.outcome !== 'string' || !RECOVERY_OUTCOMES.has(value.outcome)) return { kind: 'malformed' };
  if (value.errorCategory !== undefined && value.errorCategory !== expectedCategory(value.outcome)) return { kind: 'malformed' };
  if (typeof value.uncertain !== 'boolean') return { kind: 'malformed' };
  if (typeof value.revocationRequired !== 'boolean') return { kind: 'malformed' };
  if (value.ownerOperationId !== undefined && value.ownerOperationId !== null && (typeof value.ownerOperationId !== 'string' || value.ownerOperationId.length === 0)) {
    return { kind: 'malformed' };
  }
  if (value.ownershipExpiresAtMs !== undefined && value.ownershipExpiresAtMs !== null && !validMs(value.ownershipExpiresAtMs)) {
    return { kind: 'malformed' };
  }
  const ownershipHeld = (typeof value.ownerOperationId === 'string' && value.ownerOperationId.length > 0)
    || (Number.isSafeInteger(value.ownershipExpiresAtMs) && value.ownershipExpiresAtMs > sampledAtMs);
  return {
    kind: 'present',
    generation: value.generation,
    desiredDisabled: value.desiredDisabled,
    attempts: value.attempts,
    administratorRequired: value.administratorRequired,
    authMutationIssued: value.authMutationIssued,
    outcome: value.outcome,
    uncertain: value.uncertain,
    revocationRequired: value.revocationRequired,
    ownershipHeld,
    ownershipExpiresAtMs: value.ownershipExpiresAtMs === undefined || value.ownershipExpiresAtMs === null ? null : value.ownershipExpiresAtMs,
  };
}

function productDenies(profile) {
  if (!profile || profile.kind !== 'present') return null;
  if (profile.status === 'Suspended') return true;
  if (profile.denialFlag === 'true' || profile.denialFlag === 'malformed') return true;
  return false;
}

function viewOf(sample) {
  return {
    profile: normProfile(sample.profile),
    intent: normIntent(sample.intent),
    lock: normLock(sample.lock, sample.sampledAtMs),
    fence: normPresence(sample.fence),
    job: normPresence(sample.job),
    recovery: normRecovery(sample.recovery, sample.sampledAtMs),
  };
}

function fingerprint(view) {
  return JSON.stringify(view);
}

function sampleUnchecked(sample) {
  return ['profile', 'intent', 'lock', 'fence', 'job', 'recovery'].every((key) => sourceState(sample[key]) === 'unchecked');
}

function anyReadFailed(view, authKind) {
  return authKind === 'read_failed'
    || [view.profile, view.intent, view.lock, view.recovery].some((item) => item.kind === 'read_failed')
    || view.fence === 'read_failed'
    || view.job === 'read_failed';
}

function recoveryQuiet(recovery, intent) {
  return recovery.kind === 'missing'
    || (recovery.kind === 'present'
      && recovery.outcome === 'matched'
      && recovery.uncertain === false
      && recovery.revocationRequired === false
      && recovery.administratorRequired === false
      && recovery.authMutationIssued === false
      && recovery.ownershipHeld !== true
      && intent
      && intent.kind === 'present'
      && intent.phase === 'confirmed'
      && intent.generation === recovery.generation
      && intent.desiredDisabled === recovery.desiredDisabled);
}

function recoveryNeedsReview(recovery, intent) {
  if (recovery.kind !== 'present' || recoveryIncoherent(recovery)) return false;
  if (recovery.uncertain || recovery.revocationRequired || recovery.administratorRequired || recovery.authMutationIssued || recovery.ownershipHeld) return true;
  if (recovery.outcome !== 'matched') return true;
  return !!(intent && intent.kind === 'present' && intent.phase === 'confirmed' && intent.desiredDisabled !== recovery.desiredDisabled);
}

function recoveryIncoherent(recovery) {
  if (recovery.kind !== 'present') return false;
  if (recovery.outcome === 'invalid-record') return true;
  if (recovery.outcome === 'repaired' && recovery.uncertain === false && recovery.revocationRequired === false) return true;
  if (recovery.outcome === 'revocation-required' && recovery.revocationRequired === false) return true;
  if (recovery.outcome === 'uncertain-stale' && recovery.uncertain === false) return true;
  return false;
}

function sourceUnchecked(view) {
  return view.profile.kind === 'unchecked'
    || view.profile.kind === 'missing'
    || view.intent.kind === 'unchecked'
    || view.intent.kind === 'missing'
    || view.lock.kind === 'unchecked'
    || view.recovery.kind === 'unchecked'
    || view.fence === 'unchecked'
    || view.job === 'unchecked';
}

function anyMalformed(view, authKind) {
  return authKind === 'malformed'
    || authKind === 'contradictory'
    || [view.profile, view.intent, view.lock, view.recovery].some((item) => item.kind === 'malformed')
    || view.fence === 'malformed'
    || view.job === 'malformed'
    || (view.profile.kind === 'present' && view.profile.denialFlag === 'malformed')
    || recoveryIncoherent(view.recovery);
}

function factsFrom(auth, view) {
  const facts = emptyFacts();
  if (auth.kind === 'contradictory') {
    facts.authExists = false;
  } else if (auth.kind === 'present') {
    facts.authExists = auth.exists === true;
    facts.authDisabled = auth.exists === true ? auth.disabled === true : null;
    facts.tokensValidAfterTimePresent = auth.tokensValidAfterTimePresent === true;
  } else if (auth.kind === 'missing') {
    facts.authExists = false;
  }
  if (view.profile.kind === 'present') {
    facts.profileStatus = view.profile.status;
    facts.denialFlag = view.profile.denialFlag;
    facts.productDenies = productDenies(view.profile);
    const intent = view.intent;
    if (view.profile.denialFlag === 'malformed') facts.profileIntentEnableCriteriaMet = null;
    else if (view.profile.status !== 'Active' || view.profile.denialFlag !== 'absent') facts.profileIntentEnableCriteriaMet = false;
    else if (intent.kind === 'unchecked' || intent.kind === 'read_failed' || intent.kind === 'malformed') facts.profileIntentEnableCriteriaMet = null;
    else facts.profileIntentEnableCriteriaMet = intent.kind === 'present' && intent.phase === 'confirmed' && intent.desiredDisabled === false;
  }
  if (view.intent.kind === 'present') {
    facts.intentGeneration = view.intent.generation;
    facts.intentPhase = view.intent.phase;
    facts.desiredDisabled = view.intent.desiredDisabled;
  }
  if (view.fence === 'present' || view.fence === 'missing') facts.fence = view.fence === 'present';
  if (view.job === 'present' || view.job === 'missing') facts.deletionJob = view.job === 'present';
  facts.leaseClass = view.lock.leaseClass || null;
  if (view.recovery.kind === 'present') {
    facts.recoveryUncertain = view.recovery.uncertain;
    facts.revocationRequired = view.recovery.revocationRequired;
  } else if (view.recovery.kind === 'missing') {
    facts.recoveryUncertain = false;
    facts.revocationRequired = false;
  }
  return facts;
}

function collectFindings(before, after, auth, changed, onePass) {
  const findings = [];
  const views = [before, after].filter(Boolean);
  if (auth.kind === 'read_failed' || views.some((view) => anyReadFailed(view, 'ok'))) findings.push('READ_FAILED');
  if (views.some((view) => view.fence === 'present')) findings.push('DELETION_FENCE_PRESENT');
  if (views.some((view) => view.job === 'present')) findings.push('DELETION_JOB_PRESENT');
  if (views.some((view) => view.lock.leaseClass === 'live')) findings.push('LIVE_SUSPENSION_LOCK');
  if (views.some((view) => view.recovery.kind === 'malformed' || view.profile.kind === 'malformed' || view.intent.kind === 'malformed' || view.profile.denialFlag === 'malformed' || anyMalformed(view, auth.kind))) {
    findings.push('INVALID_RECORD');
  }
  if (views.some((view) => recoveryNeedsReview(view.recovery, view.intent))) findings.push('RECOVERY_UNCERTAIN');
  if (views.some((view) => {
    const recovery = view.recovery;
    const intent = view.intent;
    return recovery.kind === 'present'
      && intent.kind === 'present'
      && intent.phase === 'confirmed'
      && recovery.generation !== intent.generation;
  })) findings.push('RECOVERY_GENERATION_STALE');
  if (views.some((view) => view.recovery.kind === 'present' && view.recovery.revocationRequired)) findings.push('REVOCATION_REQUIRED');
  if (auth.kind === 'missing' || auth.kind === 'contradictory') findings.push('AUTH_USER_MISSING');
  const denies = views.some((view) => productDenies(view.profile) === true);
  if (auth.kind === 'present' && auth.exists === true && auth.disabled === false && denies) findings.push('AUTH_ENABLED_WHILE_DENIED');
  if (views.some((view) => view.profile.kind === 'present' && view.profile.denialFlag === 'false')) findings.push('EXPLICIT_FALSE_DENIAL_FLAG');
  if (views.some((view) => view.profile.kind === 'present' && view.profile.status === 'Active' && view.profile.denialFlag === 'false')) {
    findings.push('RECOVERY_ENABLE_INELIGIBLE');
  }
  if (changed.generation) findings.push('INTENT_GENERATION_CHANGED');
  if (changed.profile) findings.push('PROFILE_STATE_CHANGED');
  if (auth.kind === 'unchecked' || onePass) findings.push('OBSERVATION_INCOMPLETE');
  if (views.some((view) => sourceUnchecked(view))) findings.push('OBSERVATION_INCOMPLETE');
  const confirmedDisable = views.some((view) => view.intent.kind === 'present' && view.intent.phase === 'confirmed' && view.intent.desiredDisabled === true);
  const confirmedDisableOpen = views.some((view) => view.profile.kind === 'present'
    && productDenies(view.profile) === false
    && view.intent.kind === 'present'
    && view.intent.phase === 'confirmed'
    && view.intent.desiredDisabled === true);
  if (confirmedDisableOpen) findings.push('CONFIRMED_DISABLE_PRODUCT_OPEN');
  if (confirmedDisable && auth.kind === 'present' && auth.exists === true && auth.disabled === false) {
    findings.push('AUTH_ENABLED_AGAINST_DISABLE_INTENT');
  }
  const confirmedConflict = views.some((view) => {
    if (view.profile.kind !== 'present' || view.intent.kind !== 'present' || view.intent.phase !== 'confirmed') return false;
    const denied = productDenies(view.profile) === true;
    return denied !== view.intent.desiredDisabled;
  });
  if (confirmedConflict) findings.push('PROFILE_INTENT_CONFLICT');
  return findings;
}

function changes(before, after) {
  return {
    any: fingerprint(before) !== fingerprint(after),
    generation: before.intent.kind === 'present' && after.intent.kind === 'present' && before.intent.generation !== after.intent.generation,
    profile: fingerprint({ profile: before.profile }) !== fingerprint({ profile: after.profile }),
  };
}

function choosePrimary(ctx) {
  const { before, after, auth, changed, onePass, readFailed } = ctx;
  const view = after;
  if (readFailed) return 'INDETERMINATE';
  if (!onePass && changed.any) return 'OBSERVATION_INTERRUPTED';
  if (view.fence === 'present' || view.job === 'present' || before.fence === 'present' || before.job === 'present') return 'DELETION_IN_PROGRESS';
  if (auth.kind === 'unchecked' || onePass || sourceUnchecked(before) || sourceUnchecked(after)) return 'INCOMPLETE';
  if (auth.kind === 'contradictory' || anyMalformed(view, auth.kind) || anyMalformed(before, 'ok')) return 'INCOMPLETE';
  if (view.recovery.kind === 'present' && !recoveryQuiet(view.recovery, view.intent)) return 'RECOVERY_REVIEW_REQUIRED';
  if (auth.kind === 'missing') return 'AUTH_USER_MISSING';
  if (view.lock.leaseClass === 'live' || (view.intent.kind === 'present' && view.intent.phase !== 'confirmed')) return 'TRANSITION_IN_PROGRESS';
  if (view.profile.kind === 'present' && view.intent.kind === 'present' && view.intent.phase === 'confirmed' && productDenies(view.profile) !== view.intent.desiredDisabled) {
    return 'PROFILE_INTENT_CONFLICT';
  }
  if (view.profile.kind === 'present' && view.profile.status === 'Active' && view.profile.denialFlag === 'false' && view.intent.kind === 'present' && view.intent.desiredDisabled === false && auth.kind === 'present' && auth.exists === true && auth.disabled === false) {
    return 'NONCANONICAL_ACTIVE_STATE';
  }
  if (view.profile.kind === 'present' && view.profile.status === 'Active' && view.profile.denialFlag === 'true' && auth.kind === 'present' && auth.exists === true && auth.disabled === true) {
    return 'NONCANONICAL_ACTIVE_STATE';
  }
  const recoveryBlocks = view.recovery.kind === 'present' && (view.recovery.uncertain || view.recovery.revocationRequired);
  const authOn = auth.kind === 'present' && auth.exists === true && auth.disabled === false;
  const authOff = auth.kind === 'present' && auth.exists === true && auth.disabled === true;
  const denies = productDenies(view.profile) === true;
  if (denies && authOn) return 'SUSPENDED_AUTH_ENABLED';
  if (!denies && authOff && view.intent.kind === 'present' && view.intent.desiredDisabled === false) return 'ACTIVE_AUTH_DISABLED';
  if (recoveryBlocks) return 'RECOVERY_REVIEW_REQUIRED';
  if (authOn && view.profile.status === 'Active' && view.profile.denialFlag === 'absent' && view.intent.phase === 'confirmed' && view.intent.desiredDisabled === false) {
    return 'CONSISTENT_ACTIVE_AT_OBSERVATION';
  }
  if (authOff && view.profile.kind === 'present' && view.profile.status === 'Suspended' && view.profile.denialFlag === 'false' && view.intent.kind === 'present' && view.intent.phase === 'confirmed' && view.intent.desiredDisabled === true) {
    return 'NONCANONICAL_SUSPENDED_STATE';
  }
  if (authOff && view.profile.status === 'Suspended' && denies && view.intent.phase === 'confirmed' && view.intent.desiredDisabled === true) {
    return 'CONSISTENT_SUSPENDED_AT_OBSERVATION';
  }
  return 'INCOMPLETE';
}

function classifyAuthObservation(input) {
  if (!input || typeof input !== 'object' || input.schemaVersion !== INPUT_SCHEMA) return failClosed();
  if (!input.before || !input.auth || !input.after) return failClosed();
  if (!validMs(input.before.sampledAtMs) || !validMs(input.auth.sampledAtMs) || !validMs(input.after.sampledAtMs)) return failClosed();
  if (!(input.before.sampledAtMs <= input.auth.sampledAtMs && input.auth.sampledAtMs <= input.after.sampledAtMs)) return failClosed();
  const observedAtMs = input.observedAtMs === undefined ? input.after.sampledAtMs : input.observedAtMs;
  if (!validMs(observedAtMs) || observedAtMs < input.after.sampledAtMs) return failClosed();

  const authState = sourceState(input.auth);
  if (!authState) return failClosed();
  let auth = { kind: authState };
  if (authState === 'present') {
    const value = input.auth.value;
    if (!value || typeof value !== 'object' || typeof value.exists !== 'boolean' || typeof value.disabled !== 'boolean' || typeof value.tokensValidAfterTimePresent !== 'boolean') {
      return failClosed();
    }
    auth = value.exists === true
      ? { kind: 'present', exists: true, disabled: value.disabled, tokensValidAfterTimePresent: value.tokensValidAfterTimePresent }
      : { kind: 'contradictory', exists: false };
  } else if (authState === 'missing') {
    auth = { kind: 'missing', exists: false };
  }

  let before;
  let after;
  try {
    before = viewOf(input.before);
    after = viewOf(input.after);
  } catch {
    return failClosed();
  }
  if ([before, after].some((view) => view.profile.kind === null)) return failClosed();

  const secondOmitted = sampleUnchecked(input.after);
  const firstComplete = !sourceUnchecked(before)
    && !anyReadFailed(before, 'ok')
    && !anyMalformed(before, auth.kind);
  const authObserved = auth.kind === 'present' || auth.kind === 'missing';
  const onePass = secondOmitted && firstComplete && authObserved;
  const changed = secondOmitted ? { any: false, generation: false, profile: false } : changes(before, after);
  const readFailed = anyReadFailed(after, auth.kind) || anyReadFailed(before, 'ok');
  const primary = choosePrimary({ before, after, auth, changed, onePass, readFailed });
  const findings = collectFindings(before, onePass ? before : after, auth, changed, onePass);
  const namedConsistent = primary === 'CONSISTENT_ACTIVE_AT_OBSERVATION' || primary === 'CONSISTENT_SUSPENDED_AT_OBSERVATION';
  const canonical = namedConsistent && findings.length === 0;
  const high = findings.includes('AUTH_ENABLED_WHILE_DENIED')
    || findings.includes('CONFIRMED_DISABLE_PRODUCT_OPEN')
    || findings.includes('AUTH_ENABLED_AGAINST_DISABLE_INTENT')
    || findings.includes('DELETION_FENCE_PRESENT')
    || findings.includes('DELETION_JOB_PRESENT')
    || primary === 'SUSPENDED_AUTH_ENABLED'
    || primary === 'ACTIVE_AUTH_DISABLED'
    || primary === 'DELETION_IN_PROGRESS';
  let nextAction = 'manual_review';
  if (canonical) nextAction = 'none';
  else if (findings.includes('AUTH_ENABLED_WHILE_DENIED') || findings.includes('CONFIRMED_DISABLE_PRODUCT_OPEN') || findings.includes('AUTH_ENABLED_AGAINST_DISABLE_INTENT')) nextAction = 'urgent_manual_review';
  else if (primary === 'OBSERVATION_INTERRUPTED' && (findings.includes('DELETION_FENCE_PRESENT') || findings.includes('DELETION_JOB_PRESENT'))) nextAction = 'urgent_manual_review';
  else if (findings.includes('READ_FAILED')) nextAction = findings.includes('DELETION_FENCE_PRESENT') || findings.includes('DELETION_JOB_PRESENT') ? 'urgent_manual_review' : 'investigate_read_failure';
  else if (primary === 'DELETION_IN_PROGRESS') nextAction = 'investigate_deletion';
  else if (findings.includes('REVOCATION_REQUIRED')) nextAction = 'review_revocation_status';
  else if (primary === 'OBSERVATION_INTERRUPTED') nextAction = 'retry_observation_later';
  else if (primary === 'SUSPENDED_AUTH_ENABLED' || primary === 'ACTIVE_AUTH_DISABLED') nextAction = 'urgent_manual_review';

  return result({
    observedAtMs,
    completeness: (!onePass && (secondOmitted || readFailed || auth.kind === 'unchecked' || anyMalformed(before, auth.kind) || anyMalformed(after, auth.kind) || sourceUnchecked(before) || sourceUnchecked(after)))
      ? 'incomplete'
      : (onePass ? 'one_pass' : (changed.any ? 'interrupted' : 'bracket_unchanged')),
    interrupted: !onePass && changed.any,
    facts: factsFrom(auth, onePass ? before : after),
    primary,
    findings,
    severity: canonical ? 'info' : (high ? 'high' : 'review'),
    reviewRequired: !canonical,
    nextAction,
  });
}

module.exports = { classifyAuthObservation };
