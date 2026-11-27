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
    const generation = 'a'.repeat(32);
    const other = 'b'.repeat(32);
    const stamp = (generationId) => ({
      scheme: 1, generationId, deadlineAtMs: 2_000_000_000_000, committedAt: 1_000, promotedAt: 1_500,
    });
    await db.doc('streetSegments/curb-filter').set({ streetName: 'Filter Street', writeAuthority: stamp(generation) });
    await db.doc('streetSegments/curb-filter/streetRules/rule-active').set({
      type: 'streetCleaning', supersededAt: null, writeAuthority: stamp(generation),
      schedules: [{ side: 'West', days: ['Mon'], startTime: '08:00', endTime: '09:30' }],
      officialBlockFaceId: '1522611401', provenance: { importedBy: 'private-job' },
    });
    await db.doc('streetSegments/curb-filter/streetRules/rule-superseded').set({
      type: 'streetCleaning', supersededAt: new Date(), writeAuthority: stamp(generation), schedules: [],
    });
    await db.doc('streetSegments/curb-filter/streetRules/rule-mismatched').set({
      type: 'streetCleaning', supersededAt: null, writeAuthority: stamp(other), schedules: [],
    });
    await db.doc('streetSegments/curb-filter/streetRules/rule-legacy').set({
      type: 'streetCleaning', supersededAt: null, schedules: [],
    });
    await db.doc('streetSegments/curb-legacy').set({ streetName: 'Legacy Street' });
    await db.doc('streetSegments/curb-legacy/streetRules/rule-legacy-current').set({
      type: 'streetCleaning', supersededAt: null,
      schedules: [{ side: 'East', days: ['Thu'], startTime: '11:00', endTime: '12:30' }],
    });
    await db.doc('streetSegments/curb-legacy/streetRules/rule-legacy-old').set({
      type: 'streetCleaning', supersededAt: new Date(), schedules: [],
    });
    await db.doc('streetSegments/curb-legacy/streetRules/rule-legacy-mismatch').set({
      type: 'streetCleaning', supersededAt: null, writeAuthority: stamp(generation), schedules: [],
    });
    await db.doc('streetSegments/curb-pages').set({
      streetName: 'Page Street', status: 'active', source: 'admin', writeAuthority: stamp(generation),
    });
    const batch = db.batch();
    for (let index = 0; index < 105; index += 1) {
      const id = `rule-${String(index).padStart(4, '0')}`;
      batch.set(db.doc(`streetSegments/curb-pages/streetRules/${id}`), {
        type: 'streetCleaning',
        supersededAt: null,
        writeAuthority: stamp(generation),
        schedules: [{ side: 'West', days: ['Mon'], startTime: '08:00', endTime: '09:00' }],
      });
    }
    await batch.commit();
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

  it('keeps the active authoritative rule and drops superseded, mismatched, and legacy rules', async () => {
    const page = await ADMIN_READ_VIEWS.streetScheduleList(db, { segmentId: 'curb-filter', limit: 100 });
    expect(page.done).toBe(true);
    expect(page.rules.map(rule => rule.id)).toEqual(['rule-active']);
    expect(JSON.stringify(page)).not.toMatch(/1522611401|private-job|provenance|writeAuthority/);
    const legacy = await ADMIN_READ_VIEWS.streetScheduleList(db, { segmentId: 'curb-legacy', limit: 100 });
    expect(legacy.rules.map(rule => rule.id)).toEqual(['rule-legacy-current']);
  });

  async function readAll(segmentId) {
    const ids = [];
    let cursor = null;
    let guard = 0;
    for (;;) {
      const page = await ADMIN_READ_VIEWS.streetScheduleList(db, { segmentId, limit: 100, cursor });
      ids.push(...page.rules.map(rule => rule.id));
      if (page.done) return ids;
      cursor = page.nextCursor;
      guard += 1;
      if (guard > 5) throw new Error('pagination did not finish');
    }
  }

  it('pages past 100 rules without duplicates and drops a rule after it is superseded', async () => {
    const first = await readAll('curb-pages');
    expect(first).toHaveLength(105);
    expect(new Set(first).size).toBe(105);
    expect(first).toEqual([...first].slice().sort());
    await db.doc('streetSegments/curb-pages/streetRules/rule-0000').update({ supersededAt: new Date() });
    const after = await readAll('curb-pages');
    expect(after).toHaveLength(104);
    expect(after).not.toContain('rule-0000');
    expect(new Set(after).size).toBe(104);
  });

  it('counts active rules without returning the rule documents', async () => {
    const health = await ADMIN_READ_VIEWS.streetIntelligenceHealth(db);
    expect(health.activeRules).toBeGreaterThanOrEqual(1);
    expect(health.activeSegments).toBeGreaterThanOrEqual(1);
    expect(health.rules).toBeUndefined();
  });
});
