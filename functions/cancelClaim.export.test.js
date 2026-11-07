'use strict';

const fs = require('fs');
const path = require('path');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { getAuth } = require('firebase-admin/auth');
const { assertIsolatedEmulator, emulatorOrigin } = require('./isolatedEmulatorGuard');
const { requireEmulatorProjectId } = require('./emulatorProjectId');

assertIsolatedEmulator();
const PROJECT_ID = requireEmulatorProjectId();
if (PROJECT_ID !== 'demo-parkqueen-s7-fn-iso') {
  throw new Error(`Refusing cancelClaim export tests for project ${PROJECT_ID}`);
}
if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('FIRESTORE_EMULATOR_HOST is required');
}

const index = require('./index.js');
const db = getFirestore();
const CANCEL_SA = 'parqueen-cancel@parkqueen-46475363-ccf36.iam.gserviceaccount.com';
const REGION = 'us-central1';
const FUNCTIONS_BASE = `${emulatorOrigin('functions')}/${PROJECT_ID}/${REGION}`;
const FINGERPRINT = 1_700_000_000_000;

let sequence = 0;
function ids() {
  sequence += 1;
  return { uid: `ccx_${process.pid}_${sequence}`, spotId: `ccx_spot_${process.pid}_${sequence}` };
}

function payload(spotId, extra = {}) {
  return { spotId, claimGenerationId: 'a1'.repeat(32), reason: 'unspecified', ...extra };
}

async function seedLive(uid, spotId, user) {
  if (user) await db.collection('users').doc(uid).set(user);
  await db.collection('spots').doc(spotId).set({
    status: 'interested',
    finderId: 'finder-export',
    interestedUserId: uid,
    claimState: 'heading',
    claimStartedAt: Timestamp.fromMillis(FINGERPRINT),
    claimGenerationId: 'a1'.repeat(32),
    expiresAt: Timestamp.fromMillis(Date.now() + 60 * 60 * 1000),
  });
}

async function callHttp(idToken, data) {
  const response = await fetch(`${FUNCTIONS_BASE}/cancelClaim`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(idToken ? { Authorization: `Bearer ${idToken}` } : {}),
    },
    body: JSON.stringify({ data }),
  });
  return response.json();
}

async function signIn(uid) {
  const adminAuth = getAuth();
  try { await adminAuth.createUser({ uid }); } catch { /* already exists */ }
  const customToken = await adminAuth.createCustomToken(uid);
  const authHost = process.env.FIREBASE_AUTH_EMULATOR_HOST;
  if (!authHost) throw new Error('FIREBASE_AUTH_EMULATOR_HOST is required');
  const response = await fetch(
    `http://${authHost}/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  );
  const body = await response.json();
  if (!body.idToken) throw new Error('Auth emulator did not return an id token');
  return body.idToken;
}

describe('cancelClaim callable export', () => {
  const indexSrc = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');

  it('declares cancelClaim once with the verified runtime identity and App Check', () => {
    const starts = [...indexSrc.matchAll(/exports\.cancelClaim\s*=\s*onCall\(/g)];
    expect(starts).toHaveLength(1);
    const slice = indexSrc.slice(starts[0].index, starts[0].index + 500);
    expect(slice).toMatch(/region:\s*'us-central1'/);
    expect(slice).toMatch(/enforceAppCheck:\s*true/);
    expect(slice).not.toMatch(/enforceAppCheck:\s*false/);
    expect(slice).toContain(`serviceAccount: '${CANCEL_SA}'`);
    expect(slice).toContain('cancelClaimHandler(request)');
    expect(slice).not.toContain('request.data');
    expect(indexSrc.match(/parqueen-cancel@parkqueen-46475363-ccf36\.iam\.gserviceaccount\.com/g)).toHaveLength(1);
  });

  it('leaves sendMessage App Check and its runtime identity unchanged', () => {
    const start = indexSrc.indexOf('exports.sendMessage = onCall(');
    const flag = indexSrc.indexOf('enforceAppCheck: false', start);
    const end = indexSrc.indexOf(');', flag);
    expect(start).toBeGreaterThan(-1);
    expect(flag).toBeGreaterThan(start);
    expect(end).toBeGreaterThan(flag);
    const slice = indexSrc.slice(start, end);
    expect(slice).toMatch(/enforceAppCheck:\s*false/);
    expect(slice).toContain("serviceAccount: 'parqueen-user@parkqueen-46475363-ccf36.iam.gserviceaccount.com'");
    expect(slice).not.toContain(CANCEL_SA);
  });

  it('loads the canonical module and publishes the callable endpoint', () => {
    expect(typeof index.cancelClaim).toBe('function');
    expect(index.cancelClaim.__endpoint.serviceAccountEmail).toBe(CANCEL_SA);
    expect(index.cancelClaim.__trigger.regions).toEqual([REGION]);
    expect(indexSrc.match(/exports\.cancelClaim\s*=\s*onCall\(/g)).toHaveLength(1);
  });

  it('rejects a missing caller and accepts an authenticated cancellation', async () => {
    await expect(index.cancelClaim.run({ data: payload('unused') })).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    const { uid, spotId } = ids();
    await seedLive(uid, spotId, { status: 'Active', productAccessBlocked: false });
    await expect(index.cancelClaim.run({ auth: { uid }, data: payload(spotId) }))
      .resolves.toEqual({ outcome: 'cancelled' });
    const spot = (await db.collection('spots').doc(spotId).get()).data();
    expect(spot.status).toBe('available');
    expect(spot.interestedUserId).toBeNull();
  });

  it('rejects invalid input without echoing it, and denies suspended or blocked callers', async () => {
    const { uid, spotId } = ids();
    await seedLive(uid, spotId, { status: 'Active', productAccessBlocked: false });
    const secret = 'claimant-should-not-echo';
    await expect(index.cancelClaim.run({
      auth: { uid },
      data: { ...payload(spotId), claimantId: secret },
    })).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'Invalid cancellation request.',
    });
    expect((await db.collection('spots').doc(spotId).get()).data().status).toBe('interested');

    const suspended = ids();
    await seedLive(suspended.uid, suspended.spotId, { status: 'Suspended', productAccessBlocked: false });
    await expect(index.cancelClaim.run({
      auth: { uid: suspended.uid },
      data: payload(suspended.spotId),
    })).rejects.toMatchObject({
      code: 'permission-denied',
      message: 'Product access is not available.',
    });
    expect((await db.collection('spots').doc(suspended.spotId).get()).data().interestedUserId).toBe(suspended.uid);

    const blocked = ids();
    await seedLive(blocked.uid, blocked.spotId, { status: 'Active', productAccessBlocked: true });
    await expect(index.cancelClaim.run({
      auth: { uid: blocked.uid },
      data: payload(blocked.spotId),
    })).rejects.toMatchObject({ code: 'permission-denied' });
    expect((await db.collection('spots').doc(blocked.spotId).get()).data().status).toBe('interested');
  });

  it('returns the same already_resolved result for private states and ignores hook fields on the request', async () => {
    const outsider = ids();
    const missing = await index.cancelClaim.run({
      auth: { uid: outsider.uid },
      data: payload(outsider.spotId),
    });
    await seedLive('other-person', outsider.spotId, null);
    await db.collection('spots').doc(outsider.spotId).update({
      status: 'occupied',
      claimState: 'completed_success',
      interestedUserId: 'other-person',
    });
    const occupied = await index.cancelClaim.run({
      auth: { uid: outsider.uid },
      data: payload(outsider.spotId),
    });
    expect(missing).toEqual({ outcome: 'already_resolved' });
    expect(occupied).toEqual(missing);
    expect((await db.collection('spots').doc(outsider.spotId).get()).data().status).toBe('occupied');

    let called = false;
    const { uid, spotId } = ids();
    await seedLive(uid, spotId, { status: 'Active', productAccessBlocked: false });
    await expect(index.cancelClaim.run({
      auth: { uid },
      data: {
        ...payload(spotId),
        allowTestHooks: true,
        afterReads: async () => { called = true; },
      },
    })).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(called).toBe(false);
    expect((await db.collection('spots').doc(spotId).get()).data().status).toBe('interested');
  });

  it('rejects emulator HTTP calls before the handler when App Check is absent', async () => {
    const { uid, spotId } = ids();
    await seedLive(uid, spotId, { status: 'Active', productAccessBlocked: false });
    const anonymous = await callHttp(null, payload(spotId));
    expect(anonymous.result).toBeUndefined();
    expect(anonymous.error).toBeTruthy();
    const idToken = await signIn(uid);
    const authed = await callHttp(idToken, payload(spotId));
    expect(authed.result).toBeUndefined();
    expect(authed.error.status).toBe('UNAUTHENTICATED');
    const spot = (await db.collection('spots').doc(spotId).get()).data();
    expect(spot.status).toBe('interested');
    expect(spot.interestedUserId).toBe(uid);
    const notes = await db.collection('spotNotifications').where('spotId', '==', spotId).get();
    expect(notes.size).toBe(0);
  });
});
