import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { initializeApp, deleteApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { ADMIN_READ_VIEWS } = require('./adminReadViews');

const isolated = process.env.PARQUEEN_REPLAY_EMULATOR === '1'
  && process.env.FIRESTORE_EMULATOR_HOST === '127.0.0.1:8282';

describe.skipIf(!isolated)('admin schedule reads on the Firestore emulator', () => {
  let app;
  let db;

  beforeAll(async () => {
    app = initializeApp({ projectId: 'demo-parkqueen-replay-test' }, 'admin-schedule-emulator');
    db = getFirestore(app);
    const segments = await db.collection('streetSegments').get();
    await Promise.all(segments.docs.map(doc => db.recursiveDelete(doc.ref)));
    await db.doc('streetSegments/curb2_public').set({
      streetName: 'Melville Street',
      status: 'active',
      source: 'admin',
    });
    await db.doc('streetSegments/curb2_public/streetRules/rule-1').set({
      type: 'streetCleaning',
      supersededAt: null,
      schedules: [{ side: 'West', days: ['Mon'], startTime: '08:30', endTime: '10:00' }],
      officialBlockFaceId: '1522611401',
      identity: { physicalId: '98053' },
    });
  });

  afterAll(async () => {
    if (app) await deleteApp(app).catch(() => {});
  });

  it('returns only schedule windows through the Admin SDK view', async () => {
    const page = await ADMIN_READ_VIEWS.streetScheduleList(db, { segmentId: 'curb2_public', limit: 50 });
    expect(page.segmentFound).toBe(true);
    expect(page.rules).toEqual([{
      id: 'rule-1',
      type: 'streetCleaning',
      schedules: [{ side: 'West', days: ['Mon'], startTime: '08:30', endTime: '10:00', type: null }],
    }]);
    expect(JSON.stringify(page)).not.toMatch(/1522611401|98053/);
  });

  it('counts active rules without returning the rule documents', async () => {
    const health = await ADMIN_READ_VIEWS.streetIntelligenceHealth(db);
    expect(health.activeRules).toBeGreaterThanOrEqual(1);
    expect(health.activeSegments).toBeGreaterThanOrEqual(1);
    expect(health.rules).toBeUndefined();
  });
});
