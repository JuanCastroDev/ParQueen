import { createRequire } from 'node:module';
import { beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const isolated = process.env.PARQUEEN_ADMIN_EMULATOR === '1'
  && process.env.FIRESTORE_EMULATOR_HOST === '127.0.0.1:8282'
  && process.env.FIREBASE_AUTH_EMULATOR_HOST === '127.0.0.1:9199'
  && process.env.GCLOUD_PROJECT === 'demo-parkqueen-replay-test';

function decode(idToken) {
  const payload = JSON.parse(Buffer.from(String(idToken).split('.')[1], 'base64url').toString('utf8'));
  payload.uid = payload.sub || payload.user_id;
  return payload;
}

describe.skipIf(!isolated)('admin schedule authorization on the callable path', () => {
  let handler;
  let auth;

  beforeAll(async () => {
    const { getAuth } = require('firebase-admin/auth');
    const { getFirestore } = require('firebase-admin/firestore');
    handler = require('./index.js')._adminReadViewHandler;
    auth = getAuth();
    const db = getFirestore();
    await db.doc('streetSegments/curb-auth').set({ streetName: 'Auth Street', status: 'active', source: 'admin' });
    await db.doc('streetSegments/curb-auth/streetRules/rule-1').set({
      type: 'streetCleaning',
      supersededAt: null,
      schedules: [{ side: 'West', days: ['Mon'], startTime: '08:00', endTime: '09:00' }],
      officialBlockFaceId: '1522611401',
      provenance: { importedBy: 'private-job' },
    });
  });

  async function signIn(uid, claims) {
    await auth.createUser({ uid }).catch(() => {});
    if (claims) await auth.setCustomUserClaims(uid, claims);
    const custom = await auth.createCustomToken(uid);
    const response = await fetch(
      'http://127.0.0.1:9199/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-key',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: custom, returnSecureToken: true }),
      },
    );
    const body = await response.json();
    if (!body.idToken) throw new Error(JSON.stringify(body));
    return body.idToken;
  }

  async function call(idToken, view, params) {
    const request = { data: { view, params } };
    if (idToken) {
      const token = decode(idToken);
      request.auth = { uid: token.uid, token };
    }
    try {
      return { result: await handler(request) };
    } catch (err) {
      return { code: err.code, message: err.message };
    }
  }

  it('rejects a signed-out caller, an ordinary user, and a stale admin claim', async () => {
    expect((await call(null, 'streetScheduleList', { segmentId: 'curb-auth' })).code).toBe('unauthenticated');
    const ordinary = await signIn('ordinary-user');
    expect((await call(ordinary, 'streetScheduleList', { segmentId: 'curb-auth' })).code).toBe('permission-denied');
    const staleToken = await signIn('stale-admin', { role: 'admin' });
    await auth.setCustomUserClaims('stale-admin', {});
    expect((await call(staleToken, 'streetIntelligenceHealth', {})).code).toBe('permission-denied');
  });

  it('lets a current admin read a schedule without private identity', async () => {
    const token = await signIn('current-admin', { role: 'admin' });
    const schedule = await call(token, 'streetScheduleList', { segmentId: 'curb-auth', limit: 20 });
    expect(schedule.result.rules.map(rule => rule.id)).toEqual(['rule-1']);
    expect(JSON.stringify(schedule.result)).not.toMatch(/1522611401|private-job/);
    const health = await call(token, 'streetIntelligenceHealth', {});
    expect(health.result.activeRules).toBeGreaterThanOrEqual(1);
    expect(health.result.rules).toBeUndefined();
  });
});
