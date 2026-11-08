'use strict';

require('./isolatedEmulatorGuard').assertIsolatedEmulator();
const { emulatorEndpoint } = require('./isolatedEmulatorGuard');

const { readFileSync } = require('fs');
const { join } = require('path');
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { initializeTestEnvironment, assertFails } = require('@firebase/rules-unit-testing');
const { doc, getDoc, setDoc } = require('firebase/firestore');
const { requireEmulatorProjectId } = require('./emulatorProjectId');
const { hooks } = require('./suspensionAccess');
const { COLLECTION, ATTEMPT_CEILING, runAuthReplicaRecovery } = require('./authReplicaRecoveryCoordinator');

const PROJECT_ID = requireEmulatorProjectId();
if (PROJECT_ID !== 'demo-parkqueen-s7-fn-iso') {
  throw new Error(`Refusing recovery coordinator tests for project ${PROJECT_ID}`);
}
if (!getApps().some((app) => app.name === '[DEFAULT]')) initializeApp({ projectId: PROJECT_ID });
const db = getFirestore();
const adminAuth = getAuth();

function uidOf(label) {
  return `recovery_${label}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

describe('auth replica recovery coordinator', () => {
  const cleanup = [];
  let rulesEnv;

  beforeAll(async () => {
    rulesEnv = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        rules: readFileSync(join(__dirname, '..', 'firestore.rules'), 'utf8'),
        host: '127.0.0.1',
        port: emulatorEndpoint('firestore').port,
      },
    });
  });

  afterAll(async () => {
    if (rulesEnv) await rulesEnv.cleanup();
  });

  afterEach(async () => {
    hooks.beforeRepairDecision = null;
    hooks.afterRepairAuthorized = null;
    for (const uid of cleanup.splice(0)) {
      await adminAuth.deleteUser(uid).catch(() => {});
      await db.recursiveDelete(db.doc(`users/${uid}`)).catch(() => {});
      await db.doc(`accountDeletionJobs/${uid}`).delete().catch(() => {});
      await db.doc(`accountLifecycle/${uid}`).delete().catch(() => {});
      await db.doc(`${COLLECTION}/${uid}`).delete().catch(() => {});
    }
  });

  async function user(label, profile, authPatch) {
    const uid = uidOf(label);
    cleanup.push(uid);
    await adminAuth.createUser({ uid, ...authPatch });
    if (profile !== null) await db.doc(`users/${uid}`).set({ id: uid, ...profile });
    return uid;
  }

  async function intent(uid, body) {
    await db.doc(`users/${uid}/private/authIntent`).set(body);
  }

  async function recordOf(uid) {
    const snap = await db.doc(`${COLLECTION}/${uid}`).get();
    return snap.exists ? snap.data() : null;
  }

  async function profileOf(uid) {
    return (await db.doc(`users/${uid}`).get()).data();
  }

  it('repairs one confirmed disable and records revocation as a follow-up', async () => {
    const uid = await user('repair', { status: 'Suspended', productAccessBlocked: true, username: 'r' }, { disabled: false });
    await intent(uid, { generation: 4, desiredDisabled: true, phase: 'confirmed' });
    const before = await profileOf(uid);
    const beforeTokens = (await adminAuth.getUser(uid)).tokensValidAfterTime;
    const result = await runAuthReplicaRecovery(uid);
    expect(result.outcome).toBe('revocation-required');
    expect(result.revocationRequired).toBe(true);
    expect(result.authMutationIssued).toBe(true);
    expect(result.stable).toBe(false);
    expect(result.administratorRequired).toBe(true);
    expect((await adminAuth.getUser(uid)).disabled).toBe(true);
    expect((await adminAuth.getUser(uid)).tokensValidAfterTime).toBe(beforeTokens);
    expect(await profileOf(uid)).toEqual(before);
    const saved = await recordOf(uid);
    expect(saved.generation).toBe(4);
    expect(saved.desiredDisabled).toBe(true);
    expect(saved.observedDisabled).toBe(true);
    expect(saved.attempts).toBe(1);
    expect(saved.errorCategory).toBe('revocation-required');
    const again = await runAuthReplicaRecovery(uid);
    expect(again.outcome).toBe('revocation-required');
    expect(again.attempts).toBe(1);
  });

  it('records a matching observation without claiming stability or issuing Auth', async () => {
    const uid = await user('match', { status: 'Active' }, { disabled: false });
    await intent(uid, { generation: 2, desiredDisabled: false, phase: 'confirmed' });
    const orig = adminAuth.updateUser.bind(adminAuth);
    const calls = [];
    adminAuth.updateUser = async (id, props) => {
      calls.push(props);
      return orig(id, props);
    };
    try {
      const result = await runAuthReplicaRecovery(uid);
      expect(result.outcome).toBe('matched');
      expect(result.authMutationIssued).toBe(false);
      expect(result.uncertain).toBe(false);
      expect(result.stable).toBe(false);
      expect(calls).toEqual([]);
    } finally {
      adminAuth.updateUser = orig;
    }
  });

  it('lets one of two concurrent invocations issue the Auth mutation', async () => {
    const uid = await user('race', { status: 'Suspended', productAccessBlocked: true }, { disabled: false });
    await intent(uid, { generation: 1, desiredDisabled: true, phase: 'confirmed' });
    const orig = adminAuth.updateUser.bind(adminAuth);
    let updates = 0;
    adminAuth.updateUser = async (id, props) => {
      if (id === uid) updates += 1;
      return orig(id, props);
    };
    try {
      const [a, b] = await Promise.all([runAuthReplicaRecovery(uid), runAuthReplicaRecovery(uid)]);
      const outcomes = [a.outcome, b.outcome].sort();
      expect(outcomes).toContain('revocation-required');
      expect(updates).toBe(1);
    } finally {
      adminAuth.updateUser = orig;
    }
  });

  it('does not mutate Auth while a suspension lease is live', async () => {
    const uid = await user('lease', { status: 'Suspended', productAccessBlocked: true }, { disabled: false });
    await intent(uid, { generation: 1, desiredDisabled: true, phase: 'confirmed' });
    await db.doc(`users/${uid}/private/suspensionLock`).set({
      ownerOperationId: 'other',
      leaseExpiresAt: Timestamp.fromMillis(Date.now() + 60000),
      generation: 1,
    });
    const result = await runAuthReplicaRecovery(uid);
    expect(result.outcome).toBe('lease-held');
    expect(result.authMutationIssued).toBe(false);
    expect((await adminAuth.getUser(uid)).disabled).toBe(false);
  });

  it('rejects stale work after the intent generation moves', async () => {
    const uid = await user('moved', { status: 'Active' }, { disabled: true });
    await intent(uid, { generation: 2, desiredDisabled: false, phase: 'pending' });
    await db.doc(`${COLLECTION}/${uid}`).set({
      generation: 1,
      desiredDisabled: true,
      attempts: 1,
      uncertain: false,
      administratorRequired: false,
      revocationRequired: false,
      outcome: 'matched',
      stable: false,
    });
    const result = await runAuthReplicaRecovery(uid);
    expect(result.outcome).toBe('ineligible');
    expect(result.authMutationIssued).toBe(false);
    expect((await adminAuth.getUser(uid)).disabled).toBe(true);
  });

  it('does not enable a pending unsuspend or a suspended profile', async () => {
    const pending = await user('pending', { status: 'Active' }, { disabled: true });
    await intent(pending, { generation: 3, desiredDisabled: false, phase: 'pending' });
    const suspended = await user('suspended', { status: 'Suspended', productAccessBlocked: true }, { disabled: true });
    await intent(suspended, { generation: 3, desiredDisabled: false, phase: 'confirmed' });
    expect((await runAuthReplicaRecovery(pending)).outcome).toBe('ineligible');
    expect((await runAuthReplicaRecovery(suspended)).outcome).toBe('ineligible');
    expect((await adminAuth.getUser(pending)).disabled).toBe(true);
    expect((await adminAuth.getUser(suspended)).disabled).toBe(true);
  });

  it('does not enable when a deletion job or fence is present', async () => {
    const job = await user('job', { status: 'Active' }, { disabled: true });
    await intent(job, { generation: 1, desiredDisabled: false, phase: 'confirmed' });
    await db.doc(`accountDeletionJobs/${job}`).set({ state: 'pending' });
    const fenced = await user('fence', { status: 'Active' }, { disabled: true });
    await intent(fenced, { generation: 1, desiredDisabled: false, phase: 'confirmed' });
    await db.doc(`accountLifecycle/${fenced}`).set({ state: 'deleting' });
    expect((await runAuthReplicaRecovery(job)).outcome).toBe('deletion');
    expect((await runAuthReplicaRecovery(fenced)).outcome).toBe('deletion');
    expect((await adminAuth.getUser(job)).disabled).toBe(true);
    expect((await adminAuth.getUser(fenced)).disabled).toBe(true);
    expect((await db.doc(`accountLifecycle/${fenced}`).get()).exists).toBe(true);
  });

  it('records an unconfirmed Auth RPC and does not send another', async () => {
    const uid = await user('unsure', { status: 'Suspended', productAccessBlocked: true }, { disabled: false });
    await intent(uid, { generation: 8, desiredDisabled: true, phase: 'confirmed' });
    const origGet = adminAuth.getUser.bind(adminAuth);
    const origUpdate = adminAuth.updateUser.bind(adminAuth);
    let writes = 0;
    let issued = false;
    adminAuth.updateUser = async (id, props) => {
      if (id === uid) {
        writes += 1;
        issued = true;
      }
      return origUpdate(id, props);
    };
    adminAuth.getUser = async (id) => {
      if (id === uid && issued) throw Object.assign(new Error('hidden'), { code: 'auth/internal-error' });
      return origGet(id);
    };
    try {
      const first = await runAuthReplicaRecovery(uid);
      expect(first.uncertain).toBe(true);
      expect(first.administratorRequired).toBe(true);
      expect(first.authMutationIssued).toBe(true);
      expect(first.errorCategory).not.toMatch(/hidden/);
      const second = await runAuthReplicaRecovery(uid);
      expect(second.outcome).toBe('uncertain-stale');
      expect(writes).toBe(1);
    } finally {
      adminAuth.getUser = origGet;
      adminAuth.updateUser = origUpdate;
    }
  });

  it('does not mutate after the attempt ceiling', async () => {
    const uid = await user('ceiling', { status: 'Suspended', productAccessBlocked: true }, { disabled: false });
    await intent(uid, { generation: 5, desiredDisabled: true, phase: 'confirmed' });
    await db.doc(`${COLLECTION}/${uid}`).set({
      generation: 5,
      desiredDisabled: true,
      attempts: ATTEMPT_CEILING,
      uncertain: false,
      administratorRequired: false,
      revocationRequired: false,
      nextEligibleAt: Timestamp.fromMillis(Date.now() - 1000),
      outcome: 'rejected',
      stable: false,
    });
    const result = await runAuthReplicaRecovery(uid);
    expect(result.outcome).toBe('attempt-exhausted');
    expect(result.administratorRequired).toBe(true);
    expect((await adminAuth.getUser(uid)).disabled).toBe(false);
  });

  it('does not replay an Auth mutation after an expired uncertain ownership', async () => {
    const uid = await user('crash', { status: 'Suspended', productAccessBlocked: true }, { disabled: false });
    await intent(uid, { generation: 6, desiredDisabled: true, phase: 'confirmed' });
    await db.doc(`${COLLECTION}/${uid}`).set({
      generation: 6,
      desiredDisabled: true,
      attempts: 1,
      uncertain: true,
      authMutationIssued: true,
      administratorRequired: false,
      revocationRequired: false,
      ownerOperationId: 'crashed',
      ownershipExpiresAt: Timestamp.fromMillis(Date.now() - 1000),
      outcome: 'pending',
      stable: false,
    });
    const result = await runAuthReplicaRecovery(uid);
    expect(result.outcome).toBe('uncertain-stale');
    expect(result.administratorRequired).toBe(true);
    expect((await adminAuth.getUser(uid)).disabled).toBe(false);
  });

  async function pauseAtRepair(uid) {
    let release = () => {};
    const gate = new Promise((resolve) => { release = resolve; });
    let opened = () => {};
    const openedP = new Promise((resolve) => { opened = resolve; });
    hooks.beforeRepairDecision = async () => {
      opened();
      await gate;
    };
    const pending = runAuthReplicaRecovery(uid);
    await openedP;
    return { pending, release };
  }

  it('does not let an expired owner overwrite a successor escalation', async () => {
    const uid = await user('staleA', { status: 'Suspended', productAccessBlocked: true }, { disabled: false });
    await intent(uid, { generation: 1, desiredDisabled: true, phase: 'confirmed' });
    const orig = adminAuth.updateUser.bind(adminAuth);
    let writes = 0;
    adminAuth.updateUser = async (id, props) => {
      if (id === uid) writes += 1;
      return orig(id, props);
    };
    const run = await pauseAtRepair(uid);
    try {
      await db.doc(`${COLLECTION}/${uid}`).update({ ownershipExpiresAt: Timestamp.fromMillis(Date.now() - 1000) });
      const successor = await runAuthReplicaRecovery(uid);
      expect(successor.outcome).toBe('uncertain-stale');
      expect(successor.uncertain).toBe(true);
      expect(successor.administratorRequired).toBe(true);
      run.release();
      const stale = await run.pending;
      expect(stale.outcome).toBe('stale-finalization');
      expect(stale.persisted).toBe(false);
      const saved = await recordOf(uid);
      expect(saved.outcome).toBe('uncertain-stale');
      expect(saved.uncertain).toBe(true);
      expect(saved.administratorRequired).toBe(true);
      expect(writes).toBeLessThanOrEqual(1);
    } finally {
      run.release();
      adminAuth.updateUser = orig;
      await run.pending.catch(() => {});
    }
  });

  it('does not finalize when the owner field is absent', async () => {
    const uid = await user('noOwner', { status: 'Suspended', productAccessBlocked: true }, { disabled: false });
    await intent(uid, { generation: 1, desiredDisabled: true, phase: 'confirmed' });
    const run = await pauseAtRepair(uid);
    try {
      await db.doc(`${COLLECTION}/${uid}`).update({ ownerOperationId: FieldValue.delete() });
      run.release();
      const stale = await run.pending;
      expect(stale.outcome).toBe('stale-finalization');
      expect(stale.persisted).toBe(false);
      const saved = await recordOf(uid);
      expect(saved.outcome).toBe('pending');
      expect(saved.uncertain).toBe(true);
      expect(saved.ownerOperationId).toBeUndefined();
    } finally {
      run.release();
      await run.pending.catch(() => {});
    }
  });

  it('does not carry a revocation follow-up onto the next generation', async () => {
    const uid = await user('nextGen', { status: 'Active' }, { disabled: false });
    await intent(uid, { generation: 4, desiredDisabled: false, phase: 'confirmed' });
    await db.doc(`${COLLECTION}/${uid}`).set({
      generation: 3,
      desiredDisabled: true,
      attempts: 1,
      outcome: 'revocation-required',
      uncertain: true,
      administratorRequired: true,
      revocationRequired: true,
      authMutationIssued: true,
      stable: false,
      retractable: false,
    });
    const orig = adminAuth.updateUser.bind(adminAuth);
    let writes = 0;
    adminAuth.updateUser = async (id, props) => {
      if (id === uid) writes += 1;
      return orig(id, props);
    };
    try {
      const result = await runAuthReplicaRecovery(uid);
      expect(result.outcome).toBe('superseded');
      expect(result.outcome).not.toBe('revocation-required');
      expect(result.revocationRequired).toBe(false);
      expect(result.uncertain).toBe(true);
      expect(result.administratorRequired).toBe(true);
      expect(writes).toBe(0);
      const saved = await recordOf(uid);
      expect(saved.attempts).toBe(1);
      expect(saved.authMutationIssued).toBe(true);
    } finally {
      adminAuth.updateUser = orig;
    }
  });

  it('keeps a deletion that appears after enable authorization unresolved', async () => {
    const uid = await user('overlap', { status: 'Active' }, { disabled: true });
    await intent(uid, { generation: 2, desiredDisabled: false, phase: 'confirmed' });
    hooks.afterRepairAuthorized = async () => {
      await db.doc(`accountDeletionJobs/${uid}`).set({ state: 'pending' });
    };
    const orig = adminAuth.updateUser.bind(adminAuth);
    let writes = 0;
    adminAuth.updateUser = async (id, props) => {
      if (id === uid) writes += 1;
      return orig(id, props);
    };
    try {
      const result = await runAuthReplicaRecovery(uid);
      expect(result.stable).toBe(false);
      expect(result.retractable).toBe(false);
      expect(result.outcome).toBe('deletion-overlap');
      expect(result.uncertain).toBe(true);
      expect(result.administratorRequired).toBe(true);
      expect((await db.doc(`accountDeletionJobs/${uid}`).get()).exists).toBe(true);
      await runAuthReplicaRecovery(uid);
      expect(writes).toBeLessThanOrEqual(1);
    } finally {
      adminAuth.updateUser = orig;
    }
  });

  it('records revocation follow-up when Auth is already disabled', async () => {
    const uid = await user('norvk', { status: 'Suspended', productAccessBlocked: true }, { disabled: true });
    await intent(uid, { generation: 9, desiredDisabled: true, phase: 'confirmed' });
    const orig = adminAuth.revokeRefreshTokens.bind(adminAuth);
    let revocations = 0;
    adminAuth.revokeRefreshTokens = async () => { revocations += 1; };
    try {
      const result = await runAuthReplicaRecovery(uid);
      expect(result.outcome).toBe('revocation-required');
      expect(result.revocationRequired).toBe(true);
      expect(result.authMutationIssued).toBe(false);
      expect(result.stable).toBe(false);
      expect(revocations).toBe(0);
    } finally {
      adminAuth.revokeRefreshTokens = orig;
    }
  });

  it.each([
    ['an omitted desiredDisabled', { generation: 1, attempts: 2, uncertain: false, outcome: 'rejected' }],
    ['desiredDisabled null', { generation: 1, attempts: 2, desiredDisabled: null, uncertain: false, outcome: 'rejected' }],
    ['a string desiredDisabled', { generation: 1, attempts: 2, desiredDisabled: 'true', uncertain: false, outcome: 'rejected' }],
    ['an omitted generation', { attempts: 2, desiredDisabled: true, uncertain: false, outcome: 'rejected' }],
    ['generation null', { generation: null, attempts: 2, desiredDisabled: true, uncertain: false, outcome: 'rejected' }],
    ['a fractional generation', { generation: 1.5, attempts: 2, desiredDisabled: true, uncertain: false, outcome: 'rejected' }],
    ['a negative generation', { generation: -1, attempts: 2, desiredDisabled: true, uncertain: false, outcome: 'rejected' }],
    ['a string generation', { generation: '1', attempts: 2, desiredDisabled: true, uncertain: false, outcome: 'rejected' }],
  ])('rejects an existing recovery record with %s', async (label, fields) => {
    const uid = await user(`shape-${label}`, { status: 'Suspended', productAccessBlocked: true }, { disabled: false });
    await intent(uid, { generation: 1, desiredDisabled: true, phase: 'confirmed' });
    const original = { ...fields, evidence: label };
    await db.doc(`${COLLECTION}/${uid}`).set(original);
    const orig = adminAuth.updateUser.bind(adminAuth);
    let writes = 0;
    adminAuth.updateUser = async (id, props) => {
      if (id === uid) writes += 1;
      return orig(id, props);
    };
    try {
      const result = await runAuthReplicaRecovery(uid);
      expect(result.outcome).toBe('invalid-record');
      expect(result.administratorRequired).toBe(true);
      expect(result.persisted).toBe(false);
      expect(writes).toBe(0);
      const saved = await recordOf(uid);
      expect(saved.attempts).toBe(original.attempts);
      expect(saved.evidence).toBe(label);
      expect(saved.desiredDisabled).toBe(original.desiredDisabled);
      expect(saved.generation).toBe(original.generation);
    } finally {
      adminAuth.updateUser = orig;
    }
  });

  it('does not reset a malformed attempt count or call the reconciler', async () => {
    const uid = await user('bad', { status: 'Suspended', productAccessBlocked: true }, { disabled: false });
    await intent(uid, { generation: 1, desiredDisabled: true, phase: 'confirmed' });
    await db.doc(`${COLLECTION}/${uid}`).set({
      generation: 1,
      desiredDisabled: true,
      attempts: '3',
      outcome: 'rejected',
      uncertain: false,
      evidence: 'keep',
    });
    const orig = adminAuth.updateUser.bind(adminAuth);
    let writes = 0;
    adminAuth.updateUser = async (id, props) => {
      if (id === uid) writes += 1;
      return orig(id, props);
    };
    try {
      const result = await runAuthReplicaRecovery(uid);
      expect(result.outcome).toBe('invalid-record');
      expect(result.administratorRequired).toBe(true);
      expect(result.persisted).toBe(false);
      expect(writes).toBe(0);
      const saved = await recordOf(uid);
      expect(saved.attempts).toBe('3');
      expect(saved.evidence).toBe('keep');
    } finally {
      adminAuth.updateUser = orig;
    }
  });

  it('denies client reads and writes of the recovery record', async () => {
    const uid = await user('rules', { status: 'Active' }, { disabled: false });
    const client = rulesEnv.authenticatedContext(uid).firestore();
    const ref = doc(client, `${COLLECTION}/${uid}`);
    await assertFails(getDoc(ref));
    await assertFails(setDoc(ref, { outcome: 'repaired', stable: true }));
  });
});
