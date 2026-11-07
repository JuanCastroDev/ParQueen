'use strict';

require('./isolatedEmulatorGuard').assertIsolatedEmulator();

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');

const { requireEmulatorProjectId } = require('./emulatorProjectId');
const PROJECT_ID = requireEmulatorProjectId();
const APP_NAME = '__adminContinuity_intg__';
const testApp = getApps().find((app) => app.name === APP_NAME) ?? initializeApp({ projectId: PROJECT_ID }, APP_NAME);
const db = getFirestore(testApp);
const adminAuth = getAuth(testApp);

const { setStaffRole, adminSuspendUser, adminUnsuspendUser, reconcileLegacyAdminSingleton, _suspensionConcurrencyHooks: hooks } = require('./index.js');
const {
  acquireRoleLock, releaseRoleLock, recordRemoval, countOtherReservedUsableAdmins, listReservedUsableAdminUids,
} = require('./adminContinuity');
const defaultAuth = getAuth();
const originalClaims = defaultAuth.setCustomUserClaims.bind(defaultAuth);
const originalUpdate = defaultAuth.updateUser.bind(defaultAuth);
const originalGetUser = defaultAuth.getUser.bind(defaultAuth);
const originalListUsers = defaultAuth.listUsers.bind(defaultAuth);

function stamp() {
  return `ac_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
}

function adminRequest(uid, data) {
  const fresh = Math.floor(Date.now() / 1000);
  return {
    data,
    auth: { uid, token: { uid, role: 'admin', auth_time: fresh, iat: fresh, exp: fresh + 3600 } },
    rawRequest: { headers: {} },
  };
}

async function makeAdmin(label) {
  const uid = stamp() + label;
  await adminAuth.createUser({ uid });
  await adminAuth.setCustomUserClaims(uid, { role: 'admin' });
  await db.doc(`users/${uid}`).set({ id: uid, status: 'Active', productAccessBlocked: false });
  return uid;
}

async function usable(uid) {
  const user = await adminAuth.getUser(uid).catch(() => null);
  if (!user || user.disabled || user.customClaims?.role !== 'admin') return false;
  if ((await db.doc(`accountLifecycle/${uid}`).get()).exists) return false;
  const profile = await db.doc(`users/${uid}`).get();
  const data = profile.exists ? profile.data() || {} : null;
  if (data && data.status === 'Suspended') return false;
  if (data && Object.prototype.hasOwnProperty.call(data, 'productAccessBlocked') && data.productAccessBlocked !== false) return false;
  return true;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function capture(fn) {
  try {
    return { result: await fn() };
  } catch (error) {
    return { error };
  }
}

async function cleanup(uids) {
  hooks.beforeAuthRpc = null;
  defaultAuth.setCustomUserClaims = originalClaims;
  defaultAuth.updateUser = originalUpdate;
  defaultAuth.getUser = originalGetUser;
  defaultAuth.listUsers = originalListUsers;
  for (const uid of uids) {
    await adminAuth.deleteUser(uid).catch(() => {});
    await db.recursiveDelete(db.doc(`users/${uid}`)).catch(() => {});
    await db.doc(`adminContinuity/${uid}`).delete().catch(() => {});
  }
  await db.doc('adminRoleLock/singleton').delete().catch(() => {});
  await db.doc('adminBootstrap/singleton').delete().catch(() => {});
}

describe('administrator continuity races', () => {
  const created = [];
  afterEach(async () => {
    await cleanup(created.splice(0));
  });

  it('race A: a suspension during demotion does not leave zero usable administrators', async () => {
    const adminA = await makeAdmin('a');
    const adminB = await makeAdmin('b');
    created.push(adminA, adminB);
    const auth = getAuth();
    const originalClaims = auth.setCustomUserClaims.bind(auth);
    let interleaved = false;
    auth.setCustomUserClaims = async (uid, claims) => {
      if (uid === adminA && !interleaved) {
        interleaved = true;
        await adminSuspendUser.run(adminRequest(adminA, { userId: adminB, reason: 'race-a' }));
      }
      return originalClaims(uid, claims);
    };
    await setStaffRole.run(adminRequest(adminB, {
      uid: adminA, role: null, operationId: `op_${Date.now()}_race_a`,
    })).catch(() => {});
    const remaining = (await usable(adminA) ? 1 : 0) + (await usable(adminB) ? 1 : 0);
    expect(remaining).toBeGreaterThan(0);
  });

  it('race B: demotion reaches the continuity decision after both calls are authorized', async () => {
    const adminA = await makeAdmin('a');
    const adminB = await makeAdmin('b');
    created.push(adminA, adminB);
    let authorized = null;
    let suspendPromise = null;
    let armed = true;
    defaultAuth.getUser = async (uid) => {
      const user = await originalGetUser(uid);
      if (armed && uid === adminB) {
        armed = false;
        authorized = { disabled: user.disabled, role: user.customClaims && user.customClaims.role };
        suspendPromise = adminSuspendUser.run(adminRequest(adminA, { userId: adminB, reason: 'race-b' }));
        const started = Date.now();
        while (Date.now() - started < 4000) {
          const lock = await db.doc('adminRoleLock/singleton').get();
          if (lock.exists && String((lock.data() || {}).ownerOperationId || '').startsWith('suspend_')) break;
          await sleep(25);
        }
      }
      return user;
    };
    const demotion = await capture(() => setStaffRole.run(adminRequest(adminB, {
      uid: adminA, role: null, operationId: `op_${Date.now()}_race_b`,
    })));
    await suspendPromise;
    expect(authorized).toEqual({ disabled: false, role: 'admin' });
    expect(demotion.error && demotion.error.code).toBe('failed-precondition');
    expect(demotion.error.message).toContain('last active administrator');
    const continuity = (await db.doc(`adminContinuity/${adminB}`).get()).data();
    expect(continuity.kind).toBe('suspend');
    expect(await usable(adminA)).toBe(true);
    expect(await usable(adminB)).toBe(false);
  });

  it('race C: a delayed accepted disable stays unresolved and blocks the competing demotion', async () => {
    const adminA = await makeAdmin('a');
    const adminB = await makeAdmin('b');
    created.push(adminA, adminB);
    let applyDisable = null;
    defaultAuth.updateUser = async (uid, props) => {
      if (uid === adminB && props && props.disabled === true && !applyDisable) {
        applyDisable = () => originalUpdate(uid, props);
        const error = new Error('accepted disable timed out before it was observed');
        error.code = 'auth/internal-error';
        throw error;
      }
      return originalUpdate(uid, props);
    };
    const suspension = await capture(() => adminSuspendUser.run(adminRequest(adminA, { userId: adminB, reason: 'race-c' })));
    expect(suspension.error && suspension.error.code).toBe('aborted');
    expect((await db.doc(`adminContinuity/${adminB}`).get()).data().phase).toBe('rpc-issued');
    expect((await adminAuth.getUser(adminB)).disabled).toBe(false);
    await db.doc(`users/${adminB}`).set({ id: adminB, status: 'Active', productAccessBlocked: false });
    const demotion = await capture(() => setStaffRole.run(adminRequest(adminA, {
      uid: adminA, role: null, operationId: `op_${Date.now()}_race_c`,
    })));
    expect(demotion.error && demotion.error.code).toBe('failed-precondition');
    expect(demotion.error.message).toContain('last active administrator');
    await applyDisable();
    expect(await usable(adminA)).toBe(true);
    expect((await adminAuth.getUser(adminB)).disabled).toBe(true);
  });
});

describe('administrator continuity durability', () => {
  const created = [];
  afterEach(async () => {
    await cleanup(created.splice(0));
  });

  it('an expired role lock does not make a pending administrator a survivor', async () => {
    const adminA = await makeAdmin('a');
    const adminB = await makeAdmin('b');
    created.push(adminA, adminB);
    await db.doc(`adminContinuity/${adminB}`).set({
      generation: 20, kind: 'suspend', phase: 'rpc-issued', roleLockGeneration: 20, ownerOperationId: 'expired-suspend',
    });
    await db.doc('adminRoleLock/singleton').set({
      ownerOperationId: 'expired-suspend',
      roleLockGeneration: 20,
      leaseExpiresAt: new Date(Date.now() - 1000),
    });
    const demotion = await capture(() => setStaffRole.run(adminRequest(adminA, {
      uid: adminA, role: null, operationId: `op_${Date.now()}_expired_lock`,
    })));
    expect(demotion.error && demotion.error.code).toBe('failed-precondition');
    expect((await db.doc(`adminContinuity/${adminB}`).get()).data().phase).toBe('rpc-issued');
    expect(await usable(adminA)).toBe(true);
  });

  it('a stale role-lock release does not delete the successor lock', async () => {
    const first = await acquireRoleLock('owner-old');
    await db.doc('adminRoleLock/singleton').set({
      ownerOperationId: 'owner-new',
      roleLockGeneration: first.generation + 1,
      leaseExpiresAt: new Date(Date.now() + 60000),
    });
    await releaseRoleLock(first);
    const lock = (await db.doc('adminRoleLock/singleton').get()).data();
    expect(lock.ownerOperationId).toBe('owner-new');
    expect(lock.roleLockGeneration).toBe(first.generation + 1);
  });

  it('a crash after intent and after rpc-issued keeps the administrator unresolved', async () => {
    const adminA = await makeAdmin('a');
    created.push(adminA);
    const intent = await recordRemoval(adminA, {
      kind: 'demote', phase: 'intent', ownerOperationId: 'crash-intent',
    });
    expect(await countOtherReservedUsableAdmins('other')).toBe(0);
    await recordRemoval(adminA, {
      generation: intent.generation, kind: 'demote', phase: 'rpc-issued', ownerOperationId: 'crash-intent',
    });
    expect((await adminAuth.getUser(adminA)).customClaims.role).toBe('admin');
    expect(await countOtherReservedUsableAdmins('other')).toBe(0);
  });

  it('an older or different owner cannot advance a continuity record', async () => {
    const adminA = await makeAdmin('a');
    created.push(adminA);
    const intent = await recordRemoval(adminA, { kind: 'suspend', phase: 'intent', ownerOperationId: 'owner-new' });
    const stale = await recordRemoval(adminA, {
      generation: intent.generation - 1, kind: 'suspend', phase: 'rpc-issued', ownerOperationId: 'owner-new',
    });
    const otherOwner = await recordRemoval(adminA, {
      generation: intent.generation, kind: 'suspend', phase: 'rpc-issued', ownerOperationId: 'owner-old',
    });
    expect(stale).toMatchObject({ committed: false, reason: 'generation' });
    expect(otherOwner).toMatchObject({ committed: false, reason: 'owner' });
    const issued = await recordRemoval(adminA, {
      generation: intent.generation, kind: 'suspend', phase: 'rpc-issued', ownerOperationId: 'owner-new',
    });
    expect(issued).toMatchObject({ committed: true, generation: intent.generation });
    expect((await db.doc(`adminContinuity/${adminA}`).get()).data().ownerOperationId).toBe('owner-new');
    const next = await recordRemoval(adminA, { kind: 'suspend', phase: 'intent', ownerOperationId: 'later' });
    expect(next.generation).toBe(intent.generation + 1);
    expect(await countOtherReservedUsableAdmins('other')).toBe(0);
  });

  it('C-01 modeled late disable: confirmed history must not authorize removing the other administrator', async () => {
    const adminA = await makeAdmin('a');
    const adminB = await makeAdmin('b');
    created.push(adminA, adminB);
    await db.doc(`adminContinuity/${adminB}`).set({
      generation: 1,
      kind: 'suspend',
      phase: 'confirmed',
      ownerOperationId: 'old-suspend',
      roleLockGeneration: 1,
    });
    let applyLateDisable = null;
    defaultAuth.updateUser = async (uid, props) => {
      if (uid === adminB && props && props.disabled === true && !applyLateDisable) {
        applyLateDisable = () => originalUpdate(uid, { disabled: true });
        return { uid };
      }
      return originalUpdate(uid, props);
    };
    const demotion = await capture(() => setStaffRole.run(adminRequest(adminA, {
      uid: adminA, role: null, operationId: `op_${Date.now()}_c01_pre`,
    })));
    expect(demotion.error && demotion.error.code).toBe('failed-precondition');
    expect(demotion.error.message).toContain('last active administrator');
    if (applyLateDisable) await applyLateDisable();
    expect((await adminAuth.getUser(adminA)).customClaims.role).toBe('admin');
  });

  it('a confirmed removal stays excluded after the administrator looks usable again', async () => {
    const adminA = await makeAdmin('a');
    created.push(adminA);
    const intent = await recordRemoval(adminA, { kind: 'suspend', phase: 'intent', ownerOperationId: 'done' });
    await recordRemoval(adminA, {
      generation: intent.generation, kind: 'suspend', phase: 'confirmed', ownerOperationId: 'done',
    });
    expect((await adminAuth.getUser(adminA)).disabled).toBe(false);
    expect(await countOtherReservedUsableAdmins('other')).toBe(0);
  });
});

describe('reserved usable administrator count', () => {
  const created = [];
  afterEach(async () => {
    await cleanup(created.splice(0));
  });

  it('counts only an active enabled unblocked administrator', async () => {
    const adminA = await makeAdmin('ok');
    created.push(adminA);
    expect(await listReservedUsableAdminUids()).toEqual([adminA]);
  });

  it('excludes disabled, missing, tombstoned, suspended, blocked, malformed, and pending administrators', async () => {
    const disabled = await makeAdmin('dis');
    await adminAuth.updateUser(disabled, { disabled: true });
    const tombstoned = await makeAdmin('tomb');
    await db.doc(`accountLifecycle/${tombstoned}`).set({ decision: 'delete' });
    const suspended = await makeAdmin('sus');
    await db.doc(`users/${suspended}`).set({ status: 'Suspended', productAccessBlocked: false });
    const blocked = await makeAdmin('blk');
    await db.doc(`users/${blocked}`).set({ status: 'Active', productAccessBlocked: true });
    const malformed = await makeAdmin('mal');
    await db.doc(`users/${malformed}`).set({ status: 'Active', productAccessBlocked: 'false' });
    const pending = await makeAdmin('pen');
    await db.doc(`adminContinuity/${pending}`).set({
      generation: 60, kind: 'demote', phase: 'intent', ownerOperationId: 'pending',
    });
    const issued = await makeAdmin('iss');
    await db.doc(`adminContinuity/${issued}`).set({
      generation: 61, kind: 'suspend', phase: 'rpc-issued', ownerOperationId: 'issued',
    });
    const intentPending = await makeAdmin('int');
    await db.doc(`users/${intentPending}/private/authIntent`).set({ desiredDisabled: true, phase: 'pending' });
    created.push(disabled, tombstoned, suspended, blocked, malformed, pending, issued, intentPending);
    expect(await listReservedUsableAdminUids()).toEqual([]);
  });

  it('fails closed when Auth pagination throws', async () => {
    defaultAuth.listUsers = async () => {
      throw new Error('listUsers failed');
    };
    await expect(countOtherReservedUsableAdmins('any')).rejects.toThrow('listUsers failed');
  });

  it('fails closed when an eligibility Firestore read throws', async () => {
    const adminA = await makeAdmin('read');
    created.push(adminA);
    const proto = Object.getPrototypeOf(db.doc(`users/${adminA}`));
    const originalGet = proto.get;
    proto.get = function patchedGet(...args) {
      if (String(this.path || '').includes('accountLifecycle/')) {
        return Promise.reject(new Error('firestore eligibility read failed'));
      }
      return originalGet.apply(this, args);
    };
    try {
      await expect(countOtherReservedUsableAdmins('other')).rejects.toThrow('firestore eligibility read failed');
    } finally {
      proto.get = originalGet;
    }
  });
});

describe('legacy administrator reconciliation eligibility', () => {
  const created = [];
  afterEach(async () => {
    await cleanup(created.splice(0));
  });

  async function reconcile(uid) {
    return capture(() => reconcileLegacyAdminSingleton.run(adminRequest(uid, {})));
  }

  it('accepts one reserved usable administrator and does not write a claim', async () => {
    const adminA = await makeAdmin('one');
    created.push(adminA);
    const before = (await adminAuth.getUser(adminA)).customClaims;
    const outcome = await reconcile(adminA);
    expect(outcome.error).toBeUndefined();
    expect((await adminAuth.getUser(adminA)).customClaims).toEqual(before);
    expect((await db.doc('adminBootstrap/singleton').get()).data().bootstrappedBy).toBe(adminA);
  });

  it('does not select a pending sole administrator and does not write a claim', async () => {
    const uid = await makeAdmin('pending');
    created.push(uid);
    await db.doc(`adminContinuity/${uid}`).set({
      generation: 70, kind: 'suspend', phase: 'rpc-issued', ownerOperationId: 'legacy-pending',
    });
    const outcome = await reconcile(uid);
    expect(outcome.error && outcome.error.code).toBe('failed-precondition');
    expect(outcome.error.message).toContain('not unambiguous');
    expect((await db.doc('adminBootstrap/singleton').get()).exists).toBe(false);
    expect((await adminAuth.getUser(uid)).customClaims.role).toBe('admin');
  });

  it('denies a fenced, disabled, suspended, or blocked caller before closing bootstrap', async () => {
    const cases = [
      ['fenced', async (uid) => db.doc(`accountLifecycle/${uid}`).set({ decision: 'delete' })],
      ['disabled', async (uid) => adminAuth.updateUser(uid, { disabled: true })],
      ['suspended', async (uid) => db.doc(`users/${uid}`).set({ status: 'Suspended', productAccessBlocked: false })],
      ['blocked', async (uid) => db.doc(`users/${uid}`).set({ status: 'Active', productAccessBlocked: true })],
    ];
    for (const [label, arrange] of cases) {
      const uid = await makeAdmin(label);
      created.push(uid);
      await arrange(uid);
      const outcome = await reconcile(uid);
      expect(outcome.error).toBeTruthy();
      expect((await db.doc('adminBootstrap/singleton').get()).exists).toBe(false);
      expect((await adminAuth.getUser(uid)).customClaims.role).toBe('admin');
      await adminAuth.deleteUser(uid).catch(() => {});
      await db.doc(`accountLifecycle/${uid}`).delete().catch(() => {});
    }
  });

  it('holds the role lock while a concurrent demotion is attempted', async () => {
    const adminA = await makeAdmin('rec');
    const adminB = await makeAdmin('other');
    created.push(adminA, adminB);
    let demotion = null;
    defaultAuth.listUsers = async (...args) => {
      if (!demotion) {
        demotion = capture(() => setStaffRole.run(adminRequest(adminB, {
          uid: adminA, role: null, operationId: `op_${Date.now()}_legacy_race`,
        })));
        await demotion;
      }
      return originalListUsers(...args);
    };
    const outcome = await reconcile(adminA);
    const demoted = await demotion;
    expect(outcome.error && outcome.error.code).toBe('failed-precondition');
    expect(demoted.error && demoted.error.code).toBe('aborted');
    expect((await db.doc('adminBootstrap/singleton').get()).exists).toBe(false);
    expect((await adminAuth.getUser(adminA)).customClaims.role).toBe('admin');
  });

  it('waits out a held role lock instead of selecting an administrator underneath it', async () => {
    const adminA = await makeAdmin('held');
    created.push(adminA);
    await db.doc('adminRoleLock/singleton').set({
      ownerOperationId: 'other-role-op',
      roleLockGeneration: 80,
      leaseExpiresAt: new Date(Date.now() + 60000),
    });
    const outcome = await reconcile(adminA);
    expect(outcome.error && outcome.error.code).toBe('aborted');
    expect((await db.doc('adminBootstrap/singleton').get()).exists).toBe(false);
    expect((await adminAuth.getUser(adminA)).customClaims.role).toBe('admin');
  });

  it('excludes ineligible non-caller candidates inside the reconciliation scan', async () => {
    const caller = await makeAdmin('caller');
    created.push(caller);
    const cases = [
      ['fenced', async (uid) => db.doc(`accountLifecycle/${uid}`).set({ decision: 'delete' })],
      ['disabled', async (uid) => adminAuth.updateUser(uid, { disabled: true })],
      ['suspended', async (uid) => db.doc(`users/${uid}`).set({ status: 'Suspended', productAccessBlocked: false })],
      ['blocked', async (uid) => db.doc(`users/${uid}`).set({ status: 'Active', productAccessBlocked: true })],
      ['pending', async (uid) => db.doc(`adminContinuity/${uid}`).set({ generation: 3, kind: 'demote', phase: 'rpc-issued', ownerOperationId: 'pending' })],
      ['confirmed', async (uid) => db.doc(`adminContinuity/${uid}`).set({ generation: 4, kind: 'suspend', phase: 'confirmed', ownerOperationId: 'observed' })],
    ];
    for (const [label, arrange] of cases) {
      const other = await makeAdmin(label);
      created.push(other);
      await arrange(other);
      await db.doc('adminBootstrap/singleton').delete().catch(() => {});
      const outcome = await reconcile(caller);
      expect(outcome.error).toBeUndefined();
      expect((await db.doc('adminBootstrap/singleton').get()).data().bootstrappedBy).toBe(caller);
      expect(await listReservedUsableAdminUids()).toEqual([caller]);
      await adminAuth.deleteUser(other).catch(() => {});
      await db.doc(`accountLifecycle/${other}`).delete().catch(() => {});
      await db.doc(`adminContinuity/${other}`).delete().catch(() => {});
      await db.doc('adminBootstrap/singleton').delete().catch(() => {});
    }
  });

  it('fails closed when reconciliation cannot enumerate administrators', async () => {
    const caller = await makeAdmin('scan');
    created.push(caller);
    defaultAuth.listUsers = async () => {
      throw new Error('reconcile listUsers failed');
    };
    const outcome = await reconcile(caller);
    expect(outcome.error).toBeTruthy();
    expect((await db.doc('adminBootstrap/singleton').get()).exists).toBe(false);
    defaultAuth.listUsers = originalListUsers;
    const proto = Object.getPrototypeOf(db.doc(`users/${caller}`));
    const originalGet = proto.get;
    proto.get = function patchedGet(...args) {
      if (String(this.path || '').includes('accountLifecycle/')) {
        return Promise.reject(new Error('reconcile eligibility read failed'));
      }
      return originalGet.apply(this, args);
    };
    try {
      const readFailure = await reconcile(caller);
      expect(readFailure.error).toBeTruthy();
      expect((await db.doc('adminBootstrap/singleton').get()).exists).toBe(false);
    } finally {
      proto.get = originalGet;
    }
  });
});

describe('confirmed removal cannot be the sole survivor', () => {
  const created = [];
  afterEach(async () => {
    await cleanup(created.splice(0));
  });

  async function seedConfirmed(uid, kind) {
    await db.doc(`adminContinuity/${uid}`).set({
      generation: 2, kind, phase: 'confirmed', ownerOperationId: 'observed', roleLockGeneration: null,
    });
  }

  it('does not restore survivor eligibility on unsuspend or a role grant', async () => {
    const adminA = await makeAdmin('keep');
    const restored = await makeAdmin('back');
    created.push(adminA, restored);
    await adminAuth.updateUser(restored, { disabled: true });
    await db.doc(`users/${restored}`).set({ status: 'Suspended', productAccessBlocked: true });
    await seedConfirmed(restored, 'suspend');
    const unsuspend = await capture(() => adminUnsuspendUser.run(adminRequest(adminA, { userId: restored })));
    expect(unsuspend.error && unsuspend.error.code).not.toBe('permission-denied');
    await adminAuth.updateUser(restored, { disabled: false });
    await adminAuth.setCustomUserClaims(restored, { role: 'admin' });
    await db.doc(`users/${restored}`).set({ status: 'Active', productAccessBlocked: false });
    const grant = await capture(() => setStaffRole.run(adminRequest(adminA, {
      uid: restored, role: 'admin', operationId: `op_${Date.now()}_grant`,
    })));
    expect(grant.error).toBeUndefined();
    expect((await db.doc(`adminContinuity/${restored}`).get()).exists).toBe(true);
    expect(await countOtherReservedUsableAdmins(adminA)).toBe(0);
    const demotion = await capture(() => setStaffRole.run(adminRequest(adminA, {
      uid: adminA, role: null, operationId: `op_${Date.now()}_self`,
    })));
    expect(demotion.error && demotion.error.code).toBe('failed-precondition');
    expect((await adminAuth.getUser(adminA)).customClaims.role).toBe('admin');
  });

  it('a modeled late claims removal cannot be authorized by confirmed history', async () => {
    const adminA = await makeAdmin('a');
    const adminB = await makeAdmin('b');
    created.push(adminA, adminB);
    await seedConfirmed(adminB, 'demote');
    const demotion = await capture(() => setStaffRole.run(adminRequest(adminA, {
      uid: adminA, role: null, operationId: `op_${Date.now()}_late_claim`,
    })));
    expect(demotion.error && demotion.error.code).toBe('failed-precondition');
    await originalClaims(adminB, {});
    expect((await adminAuth.getUser(adminA)).customClaims.role).toBe('admin');
    expect((await adminAuth.getUser(adminB)).customClaims.role).toBeUndefined();
  });

  it('a failed continuity write does not remove the administrator claim', async () => {
    const adminA = await makeAdmin('a');
    const adminB = await makeAdmin('b');
    created.push(adminA, adminB);
    const proto = Object.getPrototypeOf(db.doc(`adminContinuity/${adminB}`));
    const originalGet = proto.get;
    proto.get = function patchedGet(...args) {
      if (String(this.path || '').startsWith('adminContinuity/')) {
        return Promise.reject(new Error('continuity persist failed'));
      }
      return originalGet.apply(this, args);
    };
    try {
      const demotion = await capture(() => setStaffRole.run(adminRequest(adminA, {
        uid: adminB, role: null, operationId: `op_${Date.now()}_persist`,
      })));
      expect(demotion.error).toBeTruthy();
      expect((await adminAuth.getUser(adminB)).customClaims.role).toBe('admin');
    } finally {
      proto.get = originalGet;
    }
  });

  it('a normal demotion and suspension still complete when another administrator has no removal history', async () => {
    const adminA = await makeAdmin('a');
    const adminB = await makeAdmin('b');
    const adminC = await makeAdmin('c');
    created.push(adminA, adminB, adminC);
    const demotion = await capture(() => setStaffRole.run(adminRequest(adminA, {
      uid: adminB, role: null, operationId: `op_${Date.now()}_ok_demote`,
    })));
    expect(demotion.error).toBeUndefined();
    expect((await adminAuth.getUser(adminB)).customClaims.role).toBeUndefined();
    const suspension = await capture(() => adminSuspendUser.run(adminRequest(adminA, { userId: adminC, reason: 'ordinary' })));
    expect(suspension.error).toBeUndefined();
    expect((await adminAuth.getUser(adminC)).disabled).toBe(true);
    expect((await adminAuth.getUser(adminA)).customClaims.role).toBe('admin');
    expect(await countOtherReservedUsableAdmins('nobody')).toBe(1);
  });
});

describe('adminContinuity rules denial', () => {
  it('denies client reads and writes of adminContinuity', async () => {
    const { initializeTestEnvironment, assertFails } = require('@firebase/rules-unit-testing');
    const fs = require('fs');
    const host = process.env.FIRESTORE_EMULATOR_HOST || '127.0.0.1:8282';
    const [hostname, portText] = host.split(':');
    const env = await initializeTestEnvironment({
      projectId: PROJECT_ID,
      firestore: {
        host: hostname,
        port: Number(portText),
        rules: fs.readFileSync(require('path').join(__dirname, '..', 'firestore.rules'), 'utf8'),
      },
    });
    const client = env.authenticatedContext('rules-client').firestore();
    const ref = client.doc('adminContinuity/rules-client');
    await assertFails(ref.get());
    await assertFails(ref.set({ phase: 'intent' }));
    await env.cleanup();
  });
});
