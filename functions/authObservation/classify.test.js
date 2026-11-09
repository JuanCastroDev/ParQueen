'use strict';

const { classifyAuthObservation } = require('./classify');

function src(state, value) {
  return value === undefined ? { state } : { state, value };
}

function sample(overrides = {}) {
  return {
    sampledAtMs: 1_000,
    profile: src('present', { status: 'Active', denialFlag: 'absent' }),
    intent: src('present', { generation: 1, desiredDisabled: false, phase: 'confirmed' }),
    lock: src('missing'),
    fence: src('missing'),
    job: src('missing'),
    recovery: src('missing'),
    ...overrides,
  };
}

function input(beforeOver = {}, afterOver = {}, authOver = {}) {
  return {
    schemaVersion: 'parqueen.authObservationInput.v1',
    before: sample({ sampledAtMs: 1_000, ...beforeOver }),
    auth: { sampledAtMs: 1_100, state: 'present', value: { exists: true, disabled: false, tokensValidAfterTimePresent: false }, ...authOver },
    after: sample({ sampledAtMs: 1_200, ...afterOver }),
  };
}

function uncheckedSample() {
  return {
    sampledAtMs: 1_200,
    profile: src('unchecked'),
    intent: src('unchecked'),
    lock: src('unchecked'),
    fence: src('unchecked'),
    job: src('unchecked'),
    recovery: src('unchecked'),
  };
}

describe('auth observation classifier', () => {
  it('classifies a quiet active account as consistent at observation', () => {
    const out = classifyAuthObservation(input());
    expect(out.primary).toBe('CONSISTENT_ACTIVE_AT_OBSERVATION');
    expect(out.findings).toEqual([]);
    expect(out.reviewRequired).toBe(false);
    expect(out.nextAction).toBe('none');
    expect(out.completeness).toBe('bracket_unchanged');
    expect(out.stable).toBeUndefined();
  });

  it('classifies a quiet suspended account as consistent at observation', () => {
    const suspended = {
      profile: src('present', { status: 'Suspended', denialFlag: 'true' }),
      intent: src('present', { generation: 2, desiredDisabled: true, phase: 'confirmed' }),
    };
    const out = classifyAuthObservation(input(suspended, suspended, { value: { exists: true, disabled: true, tokensValidAfterTimePresent: true } }));
    expect(out.primary).toBe('CONSISTENT_SUSPENDED_AT_OBSERVATION');
    expect(out.facts.tokensValidAfterTimePresent).toBe(true);
    expect(out.facts.authDisabled).toBe(true);
    expect(out.reviewRequired).toBe(false);
  });

  it('does not treat an explicit false denial flag as canonical active', () => {
    const flag = { profile: src('present', { status: 'Active', denialFlag: 'false' }) };
    const out = classifyAuthObservation(input(flag, flag));
    expect(out.primary).toBe('NONCANONICAL_ACTIVE_STATE');
    expect(out.findings).toEqual(['EXPLICIT_FALSE_DENIAL_FLAG', 'RECOVERY_ENABLE_INELIGIBLE']);
    expect(out.facts.productDenies).toBe(false);
    expect(out.facts.profileIntentEnableCriteriaMet).toBe(false);
  });

  it('does not treat an active denying profile as a healthy suspension', () => {
    const flag = {
      profile: src('present', { status: 'Active', denialFlag: 'true' }),
      intent: src('present', { generation: 1, desiredDisabled: true, phase: 'confirmed' }),
    };
    const out = classifyAuthObservation(input(flag, flag, { value: { exists: true, disabled: true, tokensValidAfterTimePresent: false } }));
    expect(out.primary).toBe('NONCANONICAL_ACTIVE_STATE');
    expect(out.primary).not.toBe('CONSISTENT_SUSPENDED_AT_OBSERVATION');
  });

  it('reports a suspended profile whose confirmed intent enables Auth', () => {
    const row = {
      profile: src('present', { status: 'Suspended', denialFlag: 'true' }),
      intent: src('present', { generation: 1, desiredDisabled: false, phase: 'confirmed' }),
    };
    const out = classifyAuthObservation(input(row, row, { value: { exists: true, disabled: true, tokensValidAfterTimePresent: false } }));
    expect(out.primary).toBe('PROFILE_INTENT_CONFLICT');
    expect(out.findings).toContain('PROFILE_INTENT_CONFLICT');
  });

  it('reports an active profile whose confirmed intent disables Auth', () => {
    const row = { intent: src('present', { generation: 1, desiredDisabled: true, phase: 'confirmed' }) };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('PROFILE_INTENT_CONFLICT');
  });

  it('keeps product denial when a suspended profile has an explicit false flag', () => {
    const row = {
      profile: src('present', { status: 'Suspended', denialFlag: 'false' }),
      intent: src('present', { generation: 1, desiredDisabled: true, phase: 'confirmed' }),
    };
    const out = classifyAuthObservation(input(row, row, { value: { exists: true, disabled: true, tokensValidAfterTimePresent: false } }));
    expect(out.facts.productDenies).toBe(true);
    expect(out.findings).toContain('EXPLICIT_FALSE_DENIAL_FLAG');
    expect(out.primary).not.toBe('CONSISTENT_ACTIVE_AT_OBSERVATION');
  });

  it('fails closed on a malformed denial flag', () => {
    const row = { profile: src('present', { status: 'Active', denialFlag: 'malformed' }) };
    const out = classifyAuthObservation(input(row, row));
    expect(out.findings).toContain('INVALID_RECORD');
    expect(out.facts.productDenies).toBe(true);
    expect(out.primary).not.toBe('CONSISTENT_ACTIVE_AT_OBSERVATION');
  });

  it('reports suspended product denial while Auth is enabled', () => {
    const row = {
      profile: src('present', { status: 'Suspended', denialFlag: 'true' }),
      intent: src('present', { generation: 1, desiredDisabled: true, phase: 'confirmed' }),
    };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('SUSPENDED_AUTH_ENABLED');
    expect(out.findings).toContain('AUTH_ENABLED_WHILE_DENIED');
    expect(out.nextAction).toBe('urgent_manual_review');
  });

  it('reports an active account whose Auth is disabled', () => {
    const out = classifyAuthObservation(input({}, {}, { value: { exists: true, disabled: true, tokensValidAfterTimePresent: false } }));
    expect(out.primary).toBe('ACTIVE_AUTH_DISABLED');
    expect(out.nextAction).toBe('urgent_manual_review');
  });

  it('reports a missing Auth user without calling it a completed deletion', () => {
    const out = classifyAuthObservation(input({}, {}, { state: 'missing' }));
    expect(out.primary).toBe('AUTH_USER_MISSING');
    expect(out.findings).toContain('AUTH_USER_MISSING');
    expect(out.facts.authExists).toBe(false);
  });

  it('keeps known denial when the Auth lookup fails', () => {
    const row = { profile: src('present', { status: 'Suspended', denialFlag: 'true' }) };
    const out = classifyAuthObservation(input(row, row, { state: 'read_failed' }));
    expect(out.primary).toBe('INDETERMINATE');
    expect(out.findings).toContain('READ_FAILED');
    expect(out.facts.productDenies).toBe(true);
  });

  it('treats a pending intent as a transition', () => {
    const row = { intent: src('present', { generation: 1, desiredDisabled: false, phase: 'pending' }) };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('TRANSITION_IN_PROGRESS');
  });

  it('interrupts when the intent generation changes', () => {
    const out = classifyAuthObservation(input(
      {},
      { intent: src('present', { generation: 2, desiredDisabled: false, phase: 'confirmed' }) },
    ));
    expect(out.primary).toBe('OBSERVATION_INTERRUPTED');
    expect(out.findings).toContain('INTENT_GENERATION_CHANGED');
    expect(out.nextAction).toBe('retry_observation_later');
  });

  it('interrupts when only the intent phase changes', () => {
    const out = classifyAuthObservation(input(
      {},
      { intent: src('present', { generation: 1, desiredDisabled: false, phase: 'rpc-issued' }) },
    ));
    expect(out.primary).toBe('OBSERVATION_INTERRUPTED');
    expect(out.findings).not.toContain('INTENT_GENERATION_CHANGED');
  });

  it('records a profile change between samples', () => {
    const out = classifyAuthObservation(input(
      {},
      { profile: src('present', { status: 'Suspended', denialFlag: 'true' }) },
    ));
    expect(out.primary).toBe('OBSERVATION_INTERRUPTED');
    expect(out.findings).toContain('PROFILE_STATE_CHANGED');
  });

  it('records a deletion job that appears in the second sample', () => {
    const out = classifyAuthObservation(input({}, { job: src('present') }));
    expect(out.primary).toBe('OBSERVATION_INTERRUPTED');
    expect(out.findings).toContain('DELETION_JOB_PRESENT');
  });

  it('records a deletion fence that appears between samples', () => {
    const out = classifyAuthObservation(input({}, { fence: src('present') }));
    expect(out.findings).toContain('DELETION_FENCE_PRESENT');
    expect(out.primary).toBe('OBSERVATION_INTERRUPTED');
  });

  it('detects a live lease that expires at the later sample time', () => {
    const lock = src('present', { owner: 'op', generation: 1, leaseExpiresAtMs: 1_100 });
    const out = classifyAuthObservation(input(
      { sampledAtMs: 1_000, lock },
      { sampledAtMs: 1_200, lock },
    ));
    expect(out.primary).toBe('OBSERVATION_INTERRUPTED');
    expect(out.findings).toContain('LIVE_SUSPENSION_LOCK');
    expect(out.facts.leaseClass).toBe('expired');
  });

  it('records recovery uncertainty that appears in the second sample', () => {
    const out = classifyAuthObservation(input({}, {
      recovery: src('present', {
        generation: 1,
        desiredDisabled: false,
        attempts: 1,
        administratorRequired: false,
        authMutationIssued: false,
        outcome: 'unconfirmed',
        uncertain: true,
        revocationRequired: false,
      }),
    }));
    expect(out.primary).toBe('OBSERVATION_INTERRUPTED');
    expect(out.findings).toContain('RECOVERY_UNCERTAIN');
  });

  it('names equal samples bracket_unchanged without a stability claim', () => {
    const out = classifyAuthObservation(input());
    expect(out.completeness).toBe('bracket_unchanged');
    expect(out.interrupted).toBe(false);
    expect(out.stable).toBeUndefined();
  });

  it('keeps denial and a failed recovery read together', () => {
    const row = {
      profile: src('present', { status: 'Suspended', denialFlag: 'true' }),
      recovery: src('read_failed'),
    };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('INDETERMINATE');
    expect(out.findings).toContain('READ_FAILED');
    expect(out.severity).toBe('high');
    expect(out.nextAction).toBe('urgent_manual_review');
  });

  it('keeps a deletion fence when Auth cannot be read', () => {
    const row = { fence: src('present') };
    const out = classifyAuthObservation(input(row, row, { state: 'read_failed' }));
    expect(out.primary).toBe('INDETERMINATE');
    expect(out.findings).toContain('DELETION_FENCE_PRESENT');
    expect(out.findings).toContain('READ_FAILED');
    expect(out.nextAction).toBe('urgent_manual_review');
  });

  it('does not call a matching Auth bit consistent while recovery is uncertain', () => {
    const row = {
      recovery: src('present', {
        generation: 1,
        desiredDisabled: false,
        attempts: 1,
        administratorRequired: false,
        authMutationIssued: false,
        outcome: 'unconfirmed',
        uncertain: true,
        revocationRequired: true,
      }),
    };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('RECOVERY_REVIEW_REQUIRED');
    expect(out.findings).toContain('RECOVERY_UNCERTAIN');
    expect(out.findings).toContain('REVOCATION_REQUIRED');
    expect(out.nextAction).toBe('review_revocation_status');
  });

  it('keeps deletion evidence when the intent is malformed', () => {
    const row = { intent: src('malformed'), fence: src('present') };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('DELETION_IN_PROGRESS');
    expect(out.findings).toContain('DELETION_FENCE_PRESENT');
    expect(out.findings).toContain('INVALID_RECORD');
  });

  it('sorts and deduplicates findings', () => {
    const row = { fence: src('present'), job: src('present') };
    const out = classifyAuthObservation(input(row, row));
    expect(out.findings).toEqual([...out.findings].sort());
    expect(new Set(out.findings).size).toBe(out.findings.length);
  });

  it('fails closed when required input is missing', () => {
    expect(classifyAuthObservation(undefined).primary).toBe('INCOMPLETE');
    expect(classifyAuthObservation({ schemaVersion: 'parqueen.authObservationInput.v1' }).findings).toContain('INVALID_RECORD');
  });

  it('fails closed on a malformed source wrapper', () => {
    const bad = input();
    bad.before.profile = { state: 'nope' };
    bad.after.profile = { state: 'nope' };
    expect(classifyAuthObservation(bad).primary).toBe('INCOMPLETE');
  });

  it('fails closed on an invalid or out-of-order timestamp', () => {
    const bad = input();
    bad.auth.sampledAtMs = 50;
    expect(classifyAuthObservation(bad).findings).toEqual(['INVALID_RECORD']);
    const negative = input();
    negative.before.sampledAtMs = -1;
    expect(classifyAuthObservation(negative).primary).toBe('INCOMPLETE');
  });

  it('fails closed on an unknown schema version', () => {
    const bad = input();
    bad.schemaVersion = 'other';
    expect(classifyAuthObservation(bad).primary).toBe('INCOMPLETE');
  });

  it('returns the same output for the same input and does not mutate it', () => {
    const value = input();
    Object.freeze(value);
    Object.freeze(value.before);
    const first = classifyAuthObservation(value);
    const second = classifyAuthObservation(value);
    expect(second).toEqual(first);
  });

  it('does not claim consistency for a one-pass observation', () => {
    const value = input();
    value.after = uncheckedSample();
    const out = classifyAuthObservation(value);
    expect(out.completeness).toBe('one_pass');
    expect(out.primary).not.toBe('CONSISTENT_ACTIVE_AT_OBSERVATION');
  });

  it('does not treat unchecked suspension locks as a quiet active account', () => {
    const row = { lock: src('unchecked') };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('INCOMPLETE');
    expect(out.findings).toEqual(['OBSERVATION_INCOMPLETE']);
    expect(out.severity).toBe('review');
    expect(out.reviewRequired).toBe(true);
    expect(out.completeness).toBe('incomplete');
    expect(out.nextAction).toBe('manual_review');
  });

  it('does not treat unchecked recovery records as a quiet active account', () => {
    const row = { recovery: src('unchecked') };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('INCOMPLETE');
    expect(out.findings).toEqual(['OBSERVATION_INCOMPLETE']);
    expect(out.severity).toBe('review');
    expect(out.reviewRequired).toBe(true);
    expect(out.completeness).toBe('incomplete');
    expect(out.nextAction).toBe('manual_review');
  });

  it('stays incomplete when both lock and recovery are unchecked', () => {
    const row = { lock: src('unchecked'), recovery: src('unchecked') };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('INCOMPLETE');
    expect(out.findings).toEqual(['OBSERVATION_INCOMPLETE']);
    expect(out.completeness).toBe('incomplete');
    expect(out.reviewRequired).toBe(true);
    expect(out.nextAction).toBe('manual_review');
  });

  it('does not call a suspended disabled account consistent when the denial flag is malformed', () => {
    const row = {
      profile: src('present', { status: 'Suspended', denialFlag: 'malformed' }),
      intent: src('present', { generation: 1, desiredDisabled: true, phase: 'confirmed' }),
    };
    const out = classifyAuthObservation(input(row, row, { value: { exists: true, disabled: true, tokensValidAfterTimePresent: false } }));
    expect(out.primary).toBe('INCOMPLETE');
    expect(out.findings).toEqual(['INVALID_RECORD']);
    expect(out.severity).toBe('review');
    expect(out.reviewRequired).toBe(true);
    expect(out.completeness).toBe('incomplete');
    expect(out.nextAction).toBe('manual_review');
    expect(out.facts.productDenies).toBe(true);
  });

  it('keeps high severity when an active malformed denial flag meets enabled Auth', () => {
    const row = { profile: src('present', { status: 'Active', denialFlag: 'malformed' }) };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('INCOMPLETE');
    expect(out.findings).toEqual(['AUTH_ENABLED_WHILE_DENIED', 'INVALID_RECORD', 'PROFILE_INTENT_CONFLICT']);
    expect(out.severity).toBe('high');
    expect(out.reviewRequired).toBe(true);
    expect(out.completeness).toBe('incomplete');
    expect(out.nextAction).toBe('urgent_manual_review');
  });

  it('does not accept invalid-record as a resolved recovery', () => {
    const row = { recovery: src('present', { outcome: 'invalid-record', uncertain: false, revocationRequired: false }) };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('INCOMPLETE');
    expect(out.findings).toEqual(['INVALID_RECORD']);
    expect(out.severity).toBe('review');
    expect(out.reviewRequired).toBe(true);
    expect(out.completeness).toBe('incomplete');
    expect(out.nextAction).toBe('manual_review');
  });

  it('fails closed on an unknown recovery outcome', () => {
    const row = { recovery: src('present', { outcome: 'all-clear', uncertain: false, revocationRequired: false }) };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('INCOMPLETE');
    expect(out.findings).toEqual(['INVALID_RECORD']);
    expect(out.severity).toBe('review');
    expect(out.reviewRequired).toBe(true);
    expect(out.completeness).toBe('incomplete');
    expect(out.nextAction).toBe('manual_review');
  });

  it('does not treat a missing profile as healthy', () => {
    const row = { profile: src('missing') };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('INCOMPLETE');
    expect(out.findings).toEqual(['OBSERVATION_INCOMPLETE']);
    expect(out.severity).toBe('review');
    expect(out.reviewRequired).toBe(true);
    expect(out.completeness).toBe('incomplete');
    expect(out.nextAction).toBe('manual_review');
  });

  it('keeps a deletion job visible when recovery cannot be read', () => {
    const row = { job: src('present'), recovery: src('read_failed') };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('INDETERMINATE');
    expect(out.findings).toEqual(['DELETION_JOB_PRESENT', 'READ_FAILED']);
    expect(out.severity).toBe('high');
    expect(out.reviewRequired).toBe(true);
    expect(out.completeness).toBe('incomplete');
    expect(out.nextAction).toBe('urgent_manual_review');
  });

  it('does not collapse present Auth with exists false into a clean missing user', () => {
    const out = classifyAuthObservation(input({}, {}, { value: { exists: false, disabled: false, tokensValidAfterTimePresent: false } }));
    expect(out.primary).toBe('INCOMPLETE');
    expect(out.findings).toEqual(['AUTH_USER_MISSING', 'INVALID_RECORD']);
    expect(out.facts.authExists).toBe(false);
    expect(out.facts.authDisabled).toBe(null);
    expect(out.severity).toBe('review');
    expect(out.reviewRequired).toBe(true);
    expect(out.completeness).toBe('incomplete');
    expect(out.nextAction).toBe('manual_review');
  });

  it('does not treat a repaired record with both flags false as resolved', () => {
    const row = { recovery: src('present', { outcome: 'repaired', uncertain: false, revocationRequired: false }) };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('INCOMPLETE');
    expect(out.findings).toEqual(['INVALID_RECORD']);
    expect(out.reviewRequired).toBe(true);
    expect(out.completeness).toBe('incomplete');
    expect(out.nextAction).toBe('manual_review');
  });

  it('does not treat an older matched recovery as quiet', () => {
    const row = {
      recovery: src('present', {
        generation: 1,
        desiredDisabled: false,
        attempts: 0,
        administratorRequired: false,
        authMutationIssued: false,
        outcome: 'matched',
        uncertain: false,
        revocationRequired: false,
      }),
      intent: src('present', { generation: 2, desiredDisabled: false, phase: 'confirmed' }),
    };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('RECOVERY_REVIEW_REQUIRED');
    expect(out.findings).toEqual(['RECOVERY_GENERATION_STALE']);
    expect(out.severity).toBe('review');
    expect(out.completeness).toBe('bracket_unchanged');
    expect(out.reviewRequired).toBe(true);
    expect(out.nextAction).toBe('manual_review');
  });

  it('does not treat administratorRequired matched recovery as quiet', () => {
    const row = {
      recovery: src('present', {
        generation: 1,
        desiredDisabled: false,
        attempts: 0,
        administratorRequired: true,
        authMutationIssued: false,
        outcome: 'matched',
        uncertain: false,
        revocationRequired: false,
      }),
    };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('RECOVERY_REVIEW_REQUIRED');
    expect(out.findings).toEqual(['RECOVERY_UNCERTAIN']);
    expect(out.severity).toBe('review');
    expect(out.completeness).toBe('bracket_unchanged');
    expect(out.reviewRequired).toBe(true);
    expect(out.nextAction).toBe('manual_review');
  });

  it('fails closed when a recovery record omits fields needed to judge it', () => {
    const row = { recovery: src('present', { outcome: 'matched', uncertain: false, revocationRequired: false }) };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('INCOMPLETE');
    expect(out.findings).toEqual(['INVALID_RECORD']);
    expect(out.severity).toBe('review');
    expect(out.completeness).toBe('incomplete');
    expect(out.reviewRequired).toBe(true);
    expect(out.nextAction).toBe('manual_review');
  });

  it('accepts a matched recovery for the current confirmed intent', () => {
    const row = {
      recovery: src('present', {
        generation: 1,
        desiredDisabled: false,
        attempts: 0,
        administratorRequired: false,
        authMutationIssued: false,
        outcome: 'matched',
        uncertain: false,
        revocationRequired: false,
      }),
    };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('CONSISTENT_ACTIVE_AT_OBSERVATION');
    expect(out.findings).toEqual([]);
    expect(out.severity).toBe('info');
    expect(out.completeness).toBe('bracket_unchanged');
    expect(out.reviewRequired).toBe(false);
    expect(out.nextAction).toBe('none');
  });

  it('reviews a current recovery that is still uncertain', () => {
    const row = {
      recovery: src('present', {
        generation: 1,
        desiredDisabled: false,
        attempts: 1,
        administratorRequired: false,
        authMutationIssued: false,
        outcome: 'unconfirmed',
        uncertain: true,
        revocationRequired: false,
      }),
    };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('RECOVERY_REVIEW_REQUIRED');
    expect(out.findings).toEqual(['RECOVERY_UNCERTAIN']);
    expect(out.severity).toBe('review');
    expect(out.completeness).toBe('bracket_unchanged');
    expect(out.reviewRequired).toBe(true);
    expect(out.nextAction).toBe('manual_review');
  });

  it('interrupts when an expired lease timestamp changes without a class change', () => {
    const before = { lock: src('present', { owner: 'op', generation: 1, leaseExpiresAtMs: 500 }) };
    const after = { lock: src('present', { owner: 'op', generation: 1, leaseExpiresAtMs: 700 }) };
    const out = classifyAuthObservation(input(before, after));
    expect(out.primary).toBe('OBSERVATION_INTERRUPTED');
    expect(out.findings).toEqual([]);
    expect(out.severity).toBe('review');
    expect(out.completeness).toBe('interrupted');
    expect(out.reviewRequired).toBe(true);
    expect(out.nextAction).toBe('retry_observation_later');
    expect(out.facts.leaseClass).toBe('expired');
  });

  it('interrupts when a live lease timestamp changes without a class change', () => {
    const before = { lock: src('present', { owner: 'op', generation: 1, leaseExpiresAtMs: 5_000 }) };
    const after = { lock: src('present', { owner: 'op', generation: 1, leaseExpiresAtMs: 9_000 }) };
    const out = classifyAuthObservation(input(before, after));
    expect(out.primary).toBe('OBSERVATION_INTERRUPTED');
    expect(out.facts.leaseClass).toBe('live');
    expect(out.completeness).toBe('interrupted');
    expect(out.reviewRequired).toBe(true);
    expect(out.nextAction).toBe('retry_observation_later');
  });

  it('interrupts when the lock owner or generation changes', () => {
    const owner = classifyAuthObservation(input(
      { lock: src('present', { owner: 'a', generation: 1, leaseExpiresAtMs: 500 }) },
      { lock: src('present', { owner: 'b', generation: 1, leaseExpiresAtMs: 500 }) },
    ));
    const generation = classifyAuthObservation(input(
      { lock: src('present', { owner: 'a', generation: 1, leaseExpiresAtMs: 500 }) },
      { lock: src('present', { owner: 'a', generation: 2, leaseExpiresAtMs: 500 }) },
    ));
    expect(owner.primary).toBe('OBSERVATION_INTERRUPTED');
    expect(generation.primary).toBe('OBSERVATION_INTERRUPTED');
    expect(owner.facts.leaseClass).toBe('expired');
    expect(JSON.stringify(owner.facts)).not.toMatch(/"a"|"b"/);
  });

  it('keeps an unchanged expired lease in a canonical active classification', () => {
    const lock = { lock: src('present', { owner: 'op', generation: 1, leaseExpiresAtMs: 500 }) };
    const out = classifyAuthObservation(input(lock, lock));
    expect(out.primary).toBe('CONSISTENT_ACTIVE_AT_OBSERVATION');
    expect(out.findings).toEqual([]);
    expect(out.completeness).toBe('bracket_unchanged');
    expect(out.facts.leaseClass).toBe('expired');
    expect(out.reviewRequired).toBe(false);
    expect(out.nextAction).toBe('none');
  });

  it('does not call unchecked Auth a completed bracket', () => {
    const out = classifyAuthObservation(input({}, {}, { state: 'unchecked' }));
    expect(out.primary).toBe('INCOMPLETE');
    expect(out.findings).toEqual(['OBSERVATION_INCOMPLETE']);
    expect(out.severity).toBe('review');
    expect(out.completeness).toBe('incomplete');
    expect(out.reviewRequired).toBe(true);
    expect(out.nextAction).toBe('manual_review');
  });

  it('does not describe one-pass plus an Auth read failure as a plain one-pass', () => {
    const value = input({}, {}, { state: 'read_failed' });
    value.after = uncheckedSample();
    const out = classifyAuthObservation(value);
    expect(out.primary).toBe('INDETERMINATE');
    expect(out.findings).toEqual(['OBSERVATION_INCOMPLETE', 'READ_FAILED']);
    expect(out.severity).toBe('review');
    expect(out.completeness).toBe('incomplete');
    expect(out.reviewRequired).toBe(true);
    expect(out.nextAction).toBe('investigate_read_failure');
  });

  it('does not report recovery enable eligibility while a deletion fence is present', () => {
    const row = { fence: src('present') };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('DELETION_IN_PROGRESS');
    expect(out.facts.recoveryEnableEligible).toBeUndefined();
    expect(out.facts.profileIntentEnableCriteriaMet).toBe(true);
    expect(out.findings).toContain('DELETION_FENCE_PRESENT');
    expect(out.severity).toBe('high');
    expect(out.completeness).toBe('bracket_unchanged');
    expect(out.reviewRequired).toBe(true);
    expect(out.nextAction).toBe('investigate_deletion');
  });

  it('rejects an observation timestamp earlier than the final sample', () => {
    const value = input();
    value.observedAtMs = 1_199;
    const out = classifyAuthObservation(value);
    expect(out.primary).toBe('INCOMPLETE');
    expect(out.findings).toEqual(['INVALID_RECORD']);
    expect(out.observedAtMs).toBe(null);
    expect(out.reviewRequired).toBe(true);
    expect(out.nextAction).toBe('manual_review');
  });

  it('keeps multi-finding output ordered and does not mutate the input', () => {
    const row = {
      fence: src('present'),
      recovery: src('present', {
        generation: 4,
        desiredDisabled: false,
        attempts: 1,
        administratorRequired: false,
        authMutationIssued: true,
        outcome: 'matched',
        uncertain: false,
        revocationRequired: true,
      }),
    };
    const value = input(row, row);
    const snapshot = JSON.stringify(value);
    Object.freeze(value);
    const first = classifyAuthObservation(value);
    const second = classifyAuthObservation(value);
    expect(second).toEqual(first);
    expect(JSON.stringify(value)).toBe(snapshot);
    expect(first.findings).toEqual([...first.findings].sort());
    expect(first.findings).toContain('DELETION_FENCE_PRESENT');
    expect(first.findings).toContain('RECOVERY_GENERATION_STALE');
    expect(first.primary).toBe('DELETION_IN_PROGRESS');
  });

  function quietRecovery(over = {}) {
    return src('present', {
      generation: 1,
      desiredDisabled: false,
      attempts: 0,
      administratorRequired: false,
      authMutationIssued: false,
      outcome: 'matched',
      uncertain: false,
      revocationRequired: false,
      ...over,
    });
  }

  it('requires urgent review when a deletion fence appears between samples', () => {
    const out = classifyAuthObservation(input({}, { fence: src('present') }));
    expect(out.primary).toBe('OBSERVATION_INTERRUPTED');
    expect(out.findings).toContain('DELETION_FENCE_PRESENT');
    expect(out.severity).toBe('high');
    expect(out.completeness).toBe('interrupted');
    expect(out.reviewRequired).toBe(true);
    expect(out.nextAction).toBe('urgent_manual_review');
  });

  it('requires urgent review when a deletion job appears between samples', () => {
    const out = classifyAuthObservation(input({}, { job: src('present') }));
    expect(out.primary).toBe('OBSERVATION_INTERRUPTED');
    expect(out.findings).toContain('DELETION_JOB_PRESENT');
    expect(out.nextAction).toBe('urgent_manual_review');
    expect(out.severity).toBe('high');
    expect(out.reviewRequired).toBe(true);
  });

  it('requires urgent review when deletion evidence disappears', () => {
    const out = classifyAuthObservation(input({ fence: src('present') }, { fence: src('missing') }));
    expect(out.primary).toBe('OBSERVATION_INTERRUPTED');
    expect(out.findings).toContain('DELETION_FENCE_PRESENT');
    expect(out.nextAction).toBe('urgent_manual_review');
    expect(out.severity).toBe('high');
    expect(out.reviewRequired).toBe(true);
  });

  it('requires urgent review when denial appears while Auth stays enabled', () => {
    const out = classifyAuthObservation(input(
      {},
      { profile: src('present', { status: 'Suspended', denialFlag: 'true' }) },
    ));
    expect(out.primary).toBe('OBSERVATION_INTERRUPTED');
    expect(out.findings).toContain('AUTH_ENABLED_WHILE_DENIED');
    expect(out.nextAction).toBe('urgent_manual_review');
    expect(out.severity).toBe('high');
    expect(out.reviewRequired).toBe(true);
  });

  it('keeps urgent review when denial and revocation are both visible', () => {
    const row = {
      profile: src('present', { status: 'Suspended', denialFlag: 'true' }),
      intent: src('present', { generation: 1, desiredDisabled: true, phase: 'confirmed' }),
      recovery: src('present', {
        generation: 1,
        desiredDisabled: true,
        attempts: 1,
        administratorRequired: true,
        authMutationIssued: true,
        outcome: 'revocation-required',
        uncertain: false,
        revocationRequired: true,
      }),
    };
    const out = classifyAuthObservation(input(row, row));
    expect(out.findings).toContain('AUTH_ENABLED_WHILE_DENIED');
    expect(out.findings).toContain('REVOCATION_REQUIRED');
    expect(out.nextAction).toBe('urgent_manual_review');
    expect(out.severity).toBe('high');
    expect(out.reviewRequired).toBe(true);
    expect(out.primary).not.toMatch(/^CONSISTENT_/);
  });

  it('retries an ordinary interruption that has no high-priority risk', () => {
    const out = classifyAuthObservation(input(
      {},
      { intent: src('present', { generation: 3, desiredDisabled: false, phase: 'confirmed' }) },
    ));
    expect(out.primary).toBe('OBSERVATION_INTERRUPTED');
    expect(out.findings).toEqual(['INTENT_GENERATION_CHANGED']);
    expect(out.nextAction).toBe('retry_observation_later');
    expect(out.severity).toBe('review');
    expect(out.reviewRequired).toBe(true);
  });

  it('leaves eligibility unknown when the intent was not checked', () => {
    const row = { intent: src('unchecked') };
    const out = classifyAuthObservation(input(row, row));
    expect(out.facts.profileIntentEnableCriteriaMet).toBe(null);
    expect(out.facts.profileStatus).toBe('Active');
    expect(out.facts.denialFlag).toBe('absent');
    expect(out.primary).toBe('INCOMPLETE');
    expect(out.reviewRequired).toBe(true);
    expect(out.nextAction).not.toBe('none');
  });

  it('leaves eligibility unknown when the intent read fails', () => {
    const row = { intent: src('read_failed') };
    const out = classifyAuthObservation(input(row, row));
    expect(out.facts.profileIntentEnableCriteriaMet).toBe(null);
    expect(out.primary).toBe('INDETERMINATE');
    expect(out.findings).toContain('READ_FAILED');
    expect(out.nextAction).toBe('investigate_read_failure');
  });

  it('records false eligibility when the profile conclusively disqualifies enablement', () => {
    const row = {
      profile: src('present', { status: 'Suspended', denialFlag: 'true' }),
      intent: src('present', { generation: 1, desiredDisabled: true, phase: 'confirmed' }),
    };
    const out = classifyAuthObservation(input(row, row, { value: { exists: true, disabled: true, tokensValidAfterTimePresent: false } }));
    expect(out.facts.profileIntentEnableCriteriaMet).toBe(false);
    expect(out.facts.productDenies).toBe(true);
    expect(out.primary).toBe('CONSISTENT_SUSPENDED_AT_OBSERVATION');
  });

  it('rejects matched recovery that claims stable true', () => {
    const row = { recovery: quietRecovery({ stable: true }) };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('INCOMPLETE');
    expect(out.findings).toEqual(['INVALID_RECORD']);
    expect(out.reviewRequired).toBe(true);
    expect(out.completeness).toBe('incomplete');
    expect(out.nextAction).toBe('manual_review');
  });

  it('does not treat an owned recovery record as quiet', () => {
    const row = { recovery: quietRecovery({ ownerOperationId: 'op-1' }) };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('RECOVERY_REVIEW_REQUIRED');
    expect(out.findings).toEqual(['RECOVERY_UNCERTAIN']);
    expect(out.reviewRequired).toBe(true);
    expect(out.completeness).toBe('bracket_unchanged');
    expect(out.nextAction).toBe('manual_review');
    expect(JSON.stringify(out.facts)).not.toMatch(/op-1/);
  });

  it('rejects a recovery outcome that disagrees with its error category', () => {
    const row = { recovery: quietRecovery({ errorCategory: 'internal' }) };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('INCOMPLETE');
    expect(out.findings).toEqual(['INVALID_RECORD']);
    expect(out.completeness).toBe('incomplete');
    expect(out.reviewRequired).toBe(true);
    expect(out.nextAction).toBe('manual_review');
  });

  it('does not label a suspended explicit-false profile as consistent', () => {
    const row = {
      profile: src('present', { status: 'Suspended', denialFlag: 'false' }),
      intent: src('present', { generation: 1, desiredDisabled: true, phase: 'confirmed' }),
    };
    const out = classifyAuthObservation(input(row, row, { value: { exists: true, disabled: true, tokensValidAfterTimePresent: false } }));
    expect(out.primary).toBe('NONCANONICAL_SUSPENDED_STATE');
    expect(out.facts.productDenies).toBe(true);
    expect(out.findings).toContain('EXPLICIT_FALSE_DENIAL_FLAG');
    expect(out.reviewRequired).toBe(true);
    expect(out.nextAction).toBe('manual_review');
    expect(out.primary).not.toMatch(/^CONSISTENT_/);
  });

  it('keeps a current matched recovery in the healthy active class', () => {
    const row = { recovery: quietRecovery() };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('CONSISTENT_ACTIVE_AT_OBSERVATION');
    expect(out.findings).toEqual([]);
    expect(out.reviewRequired).toBe(false);
    expect(out.nextAction).toBe('none');
  });

  it('escalates a confirmed disable intent while product access is open and Auth is enabled', () => {
    const row = { intent: src('present', { generation: 1, desiredDisabled: true, phase: 'confirmed' }) };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('PROFILE_INTENT_CONFLICT');
    expect(out.findings).toEqual(['AUTH_ENABLED_AGAINST_DISABLE_INTENT', 'CONFIRMED_DISABLE_PRODUCT_OPEN', 'PROFILE_INTENT_CONFLICT']);
    expect(out.severity).toBe('high');
    expect(out.completeness).toBe('bracket_unchanged');
    expect(out.reviewRequired).toBe(true);
    expect(out.nextAction).toBe('urgent_manual_review');
  });

  it('escalates a confirmed disable intent even when Auth is already disabled', () => {
    const row = { intent: src('present', { generation: 1, desiredDisabled: true, phase: 'confirmed' }) };
    const out = classifyAuthObservation(input(row, row, { value: { exists: true, disabled: true, tokensValidAfterTimePresent: false } }));
    expect(out.primary).toBe('PROFILE_INTENT_CONFLICT');
    expect(out.findings).toEqual(['CONFIRMED_DISABLE_PRODUCT_OPEN', 'PROFILE_INTENT_CONFLICT']);
    expect(out.facts.authDisabled).toBe(true);
    expect(out.facts.productDenies).toBe(false);
    expect(out.severity).toBe('high');
    expect(out.reviewRequired).toBe(true);
    expect(out.nextAction).toBe('urgent_manual_review');
  });

  it('escalates an explicit false denial flag with a confirmed disable intent and enabled Auth', () => {
    const row = {
      profile: src('present', { status: 'Active', denialFlag: 'false' }),
      intent: src('present', { generation: 1, desiredDisabled: true, phase: 'confirmed' }),
    };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('PROFILE_INTENT_CONFLICT');
    expect(out.findings).toEqual(['AUTH_ENABLED_AGAINST_DISABLE_INTENT', 'CONFIRMED_DISABLE_PRODUCT_OPEN', 'EXPLICIT_FALSE_DENIAL_FLAG', 'PROFILE_INTENT_CONFLICT', 'RECOVERY_ENABLE_INELIGIBLE']);
    expect(out.severity).toBe('high');
    expect(out.nextAction).toBe('urgent_manual_review');
    expect(out.reviewRequired).toBe(true);
  });

  it('keeps the confirmed-disable risk urgent when another read fails', () => {
    const row = {
      intent: src('present', { generation: 1, desiredDisabled: true, phase: 'confirmed' }),
      recovery: src('read_failed'),
    };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('INDETERMINATE');
    expect(out.findings).toContain('CONFIRMED_DISABLE_PRODUCT_OPEN');
    expect(out.findings).toContain('READ_FAILED');
    expect(out.severity).toBe('high');
    expect(out.completeness).toBe('incomplete');
    expect(out.reviewRequired).toBe(true);
    expect(out.nextAction).toBe('urgent_manual_review');
  });

  it('keeps the confirmed-disable risk urgent when the observation is interrupted', () => {
    const out = classifyAuthObservation(input(
      { intent: src('present', { generation: 1, desiredDisabled: true, phase: 'confirmed' }) },
      { intent: src('present', { generation: 2, desiredDisabled: true, phase: 'confirmed' }) },
    ));
    expect(out.primary).toBe('OBSERVATION_INTERRUPTED');
    expect(out.findings).toContain('CONFIRMED_DISABLE_PRODUCT_OPEN');
    expect(out.findings).toContain('INTENT_GENERATION_CHANGED');
    expect(out.severity).toBe('high');
    expect(out.nextAction).toBe('urgent_manual_review');
    expect(out.reviewRequired).toBe(true);
  });

  it('does not treat a pending disable intent as confirmed', () => {
    const row = { intent: src('present', { generation: 1, desiredDisabled: true, phase: 'pending' }) };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('TRANSITION_IN_PROGRESS');
    expect(out.findings).not.toContain('CONFIRMED_DISABLE_PRODUCT_OPEN');
    expect(out.findings).not.toContain('AUTH_ENABLED_AGAINST_DISABLE_INTENT');
  });

  it('does not invent a disable-risk finding for an unchecked intent', () => {
    const row = { intent: src('unchecked') };
    const out = classifyAuthObservation(input(row, row));
    expect(out.findings).not.toContain('CONFIRMED_DISABLE_PRODUCT_OPEN');
    expect(out.facts.profileIntentEnableCriteriaMet).toBe(null);
    expect(out.primary).toBe('INCOMPLETE');
  });

  it('interrupts when an expired ownership timestamp changes without becoming live', () => {
    const before = { recovery: quietRecovery({ ownershipExpiresAtMs: 100 }) };
    const after = { recovery: quietRecovery({ ownershipExpiresAtMs: 400 }) };
    const out = classifyAuthObservation(input(before, after));
    expect(out.primary).toBe('OBSERVATION_INTERRUPTED');
    expect(out.completeness).toBe('interrupted');
    expect(out.reviewRequired).toBe(true);
    expect(out.nextAction).toBe('retry_observation_later');
    expect(JSON.stringify(out.facts)).not.toMatch(/ownershipExpiresAtMs|100|400/);
  });

  it('interrupts when a live ownership expiration changes while remaining live', () => {
    const before = { recovery: quietRecovery({ ownershipExpiresAtMs: 5_000 }) };
    const after = { recovery: quietRecovery({ ownershipExpiresAtMs: 9_000 }) };
    const out = classifyAuthObservation(input(before, after));
    expect(out.primary).toBe('OBSERVATION_INTERRUPTED');
    expect(out.findings).toContain('RECOVERY_UNCERTAIN');
    expect(out.completeness).toBe('interrupted');
    expect(out.reviewRequired).toBe(true);
  });

  it('keeps an unchanged past ownership expiration canonical', () => {
    const row = { recovery: quietRecovery({ ownershipExpiresAtMs: 100 }) };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('CONSISTENT_ACTIVE_AT_OBSERVATION');
    expect(out.findings).toEqual([]);
    expect(out.reviewRequired).toBe(false);
    expect(out.nextAction).toBe('none');
    expect(out.completeness).toBe('bracket_unchanged');
  });

  it('reports a malformed lock on a one-pass observation as incomplete', () => {
    const value = input({ lock: src('malformed') });
    value.after = uncheckedSample();
    const out = classifyAuthObservation(value);
    expect(out.primary).toBe('INCOMPLETE');
    expect(out.completeness).toBe('incomplete');
    expect(out.findings).toContain('INVALID_RECORD');
    expect(out.reviewRequired).toBe(true);
    expect(out.nextAction).not.toBe('none');
  });

  it('reports a malformed recovery record on a one-pass observation as incomplete', () => {
    const value = input({ recovery: src('malformed') });
    value.after = uncheckedSample();
    const out = classifyAuthObservation(value);
    expect(out.primary).toBe('INCOMPLETE');
    expect(out.completeness).toBe('incomplete');
    expect(out.findings).toContain('INVALID_RECORD');
    expect(out.reviewRequired).toBe(true);
  });

  it('keeps a valid one-pass observation out of the canonical classes', () => {
    const value = input();
    value.after = uncheckedSample();
    const out = classifyAuthObservation(value);
    expect(out.completeness).toBe('one_pass');
    expect(out.primary).toBe('INCOMPLETE');
    expect(out.reviewRequired).toBe(true);
    expect(out.nextAction).not.toBe('none');
  });

  it('sorts confirmed-disable findings and does not mutate the input', () => {
    const row = { intent: src('present', { generation: 1, desiredDisabled: true, phase: 'confirmed' }) };
    const value = input(row, row);
    const snapshot = JSON.stringify(value);
    const first = classifyAuthObservation(value);
    const second = classifyAuthObservation(value);
    expect(second).toEqual(first);
    expect(JSON.stringify(value)).toBe(snapshot);
    expect(first.findings).toEqual([...first.findings].sort());
  });

  it('reports enabled Auth against a confirmed disable intent when the profile is missing', () => {
    const row = {
      profile: src('missing'),
      intent: src('present', { generation: 1, desiredDisabled: true, phase: 'confirmed' }),
    };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('INCOMPLETE');
    expect(out.findings).toContain('AUTH_ENABLED_AGAINST_DISABLE_INTENT');
    expect(out.findings).not.toContain('CONFIRMED_DISABLE_PRODUCT_OPEN');
    expect(out.facts.productDenies).toBe(null);
    expect(out.severity).toBe('high');
    expect(out.completeness).toBe('incomplete');
    expect(out.reviewRequired).toBe(true);
    expect(out.nextAction).toBe('urgent_manual_review');
  });

  it('reports enabled Auth against a confirmed disable intent when the profile read fails', () => {
    const row = {
      profile: src('read_failed'),
      intent: src('present', { generation: 1, desiredDisabled: true, phase: 'confirmed' }),
    };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('INDETERMINATE');
    expect(out.findings).toContain('AUTH_ENABLED_AGAINST_DISABLE_INTENT');
    expect(out.findings).toContain('READ_FAILED');
    expect(out.findings).not.toContain('CONFIRMED_DISABLE_PRODUCT_OPEN');
    expect(out.facts.productDenies).toBe(null);
    expect(out.severity).toBe('high');
    expect(out.nextAction).toBe('urgent_manual_review');
    expect(out.reviewRequired).toBe(true);
  });

  it('reports enabled Auth against a confirmed disable intent when the profile was not checked', () => {
    const row = {
      profile: src('unchecked'),
      intent: src('present', { generation: 1, desiredDisabled: true, phase: 'confirmed' }),
    };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('INCOMPLETE');
    expect(out.findings).toContain('AUTH_ENABLED_AGAINST_DISABLE_INTENT');
    expect(out.findings).not.toContain('CONFIRMED_DISABLE_PRODUCT_OPEN');
    expect(out.facts.productDenies).toBe(null);
    expect(out.severity).toBe('high');
    expect(out.nextAction).toBe('urgent_manual_review');
  });

  it('reports enabled Auth against a confirmed disable intent when the profile is malformed', () => {
    const row = {
      profile: src('malformed'),
      intent: src('present', { generation: 1, desiredDisabled: true, phase: 'confirmed' }),
    };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('INCOMPLETE');
    expect(out.findings).toContain('AUTH_ENABLED_AGAINST_DISABLE_INTENT');
    expect(out.findings).toContain('INVALID_RECORD');
    expect(out.findings).not.toContain('CONFIRMED_DISABLE_PRODUCT_OPEN');
    expect(out.facts.productDenies).toBe(null);
    expect(out.severity).toBe('high');
    expect(out.completeness).toBe('incomplete');
    expect(out.nextAction).toBe('urgent_manual_review');
  });

  it('keeps product denial and the Auth mismatch when a suspended profile has a confirmed disable intent', () => {
    const row = {
      profile: src('present', { status: 'Suspended', denialFlag: 'true' }),
      intent: src('present', { generation: 1, desiredDisabled: true, phase: 'confirmed' }),
    };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('SUSPENDED_AUTH_ENABLED');
    expect(out.findings).toContain('AUTH_ENABLED_WHILE_DENIED');
    expect(out.findings).toContain('AUTH_ENABLED_AGAINST_DISABLE_INTENT');
    expect(out.findings).not.toContain('CONFIRMED_DISABLE_PRODUCT_OPEN');
    expect(out.facts.productDenies).toBe(true);
    expect(out.severity).toBe('high');
    expect(out.nextAction).toBe('urgent_manual_review');
  });

  it('keeps both disable findings when an active profile still permits access', () => {
    const row = { intent: src('present', { generation: 1, desiredDisabled: true, phase: 'confirmed' }) };
    const out = classifyAuthObservation(input(row, row));
    expect(out.primary).toBe('PROFILE_INTENT_CONFLICT');
    expect(out.findings).toContain('CONFIRMED_DISABLE_PRODUCT_OPEN');
    expect(out.findings).toContain('AUTH_ENABLED_AGAINST_DISABLE_INTENT');
    expect(out.severity).toBe('high');
    expect(out.nextAction).toBe('urgent_manual_review');
  });

  it('does not claim Auth is enabled when a disable intent meets disabled Auth and an unreadable profile', () => {
    const row = {
      profile: src('read_failed'),
      intent: src('present', { generation: 1, desiredDisabled: true, phase: 'confirmed' }),
    };
    const out = classifyAuthObservation(input(row, row, { value: { exists: true, disabled: true, tokensValidAfterTimePresent: false } }));
    expect(out.primary).toBe('INDETERMINATE');
    expect(out.findings).not.toContain('AUTH_ENABLED_AGAINST_DISABLE_INTENT');
    expect(out.findings).not.toContain('CONFIRMED_DISABLE_PRODUCT_OPEN');
    expect(out.facts.productDenies).toBe(null);
    expect(out.facts.authDisabled).toBe(true);
    expect(out.nextAction).toBe('investigate_read_failure');
  });

  it('does not treat a pending disable intent as a confirmed Auth mismatch', () => {
    const row = { intent: src('present', { generation: 1, desiredDisabled: true, phase: 'pending' }) };
    const out = classifyAuthObservation(input(row, row));
    expect(out.findings).not.toContain('AUTH_ENABLED_AGAINST_DISABLE_INTENT');
    expect(out.findings).not.toContain('CONFIRMED_DISABLE_PRODUCT_OPEN');
    expect(out.primary).toBe('TRANSITION_IN_PROGRESS');
  });

  it('does not add a disable-risk finding for a confirmed enable intent', () => {
    const out = classifyAuthObservation(input());
    expect(out.primary).toBe('CONSISTENT_ACTIVE_AT_OBSERVATION');
    expect(out.findings).not.toContain('AUTH_ENABLED_AGAINST_DISABLE_INTENT');
    expect(out.findings).not.toContain('CONFIRMED_DISABLE_PRODUCT_OPEN');
    expect(out.nextAction).toBe('none');
  });

  it('does not call two unchecked Firestore samples a one-pass observation', () => {
    const value = input();
    value.before = uncheckedSample();
    value.before.sampledAtMs = 1_000;
    value.after = uncheckedSample();
    const out = classifyAuthObservation(value);
    expect(out.primary).toBe('INCOMPLETE');
    expect(out.completeness).toBe('incomplete');
    expect(out.findings).toContain('OBSERVATION_INCOMPLETE');
    expect(out.reviewRequired).toBe(true);
    expect(out.nextAction).not.toBe('none');
  });

  it('does not treat a partial first sample plus an omitted second sample as one-pass', () => {
    const value = input({ lock: src('unchecked') });
    value.after = uncheckedSample();
    const out = classifyAuthObservation(value);
    expect(out.primary).toBe('INCOMPLETE');
    expect(out.completeness).toBe('incomplete');
    expect(out.findings).toContain('OBSERVATION_INCOMPLETE');
    expect(out.reviewRequired).toBe(true);
  });

  it('keeps a valid omitted second sample as one_pass', () => {
    const value = input();
    value.after = uncheckedSample();
    const out = classifyAuthObservation(value);
    expect(out.completeness).toBe('one_pass');
    expect(out.primary).toBe('INCOMPLETE');
    expect(out.reviewRequired).toBe(true);
    expect(out.primary).not.toMatch(/^CONSISTENT_/);
  });

  it('keeps the Auth-versus-intent finding stable and does not mutate input', () => {
    const row = {
      profile: src('missing'),
      intent: src('present', { generation: 1, desiredDisabled: true, phase: 'confirmed' }),
    };
    const value = input(row, row);
    const snapshot = JSON.stringify(value);
    const first = classifyAuthObservation(value);
    const second = classifyAuthObservation(value);
    expect(second).toEqual(first);
    expect(JSON.stringify(value)).toBe(snapshot);
    expect(first.findings).toEqual([...first.findings].sort());
  });

  it('imports no firebase module', () => {
    const fs = require('fs');
    const source = fs.readFileSync(require.resolve('./classify.js'), 'utf8');
    expect(source).not.toMatch(/firebase-admin|firebase\/|updateUser|revokeRefreshTokens|deleteUser|reconcileAuthReplica|runAuthReplicaRecovery|Date\.now\(/);
  });
});
