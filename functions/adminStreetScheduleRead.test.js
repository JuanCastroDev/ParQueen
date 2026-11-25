import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { ADMIN_READ_VIEWS } = require('./adminReadViews');

function doc(id, data) {
  return { id, exists: true, data: () => data, ref: { id } };
}

function fakeDb(state) {
  const segment = state.segment;
  const rules = state.rules;
  const queryFor = (rows) => ({
    orderBy() { return this; },
    limit() { return this; },
    startAfter() { return this; },
    where() { return this; },
    count() { return { get: async () => ({ data: () => ({ count: rows.length }) }) }; },
    get: async () => ({ size: rows.length, docs: rows, empty: rows.length === 0 }),
  });
  return {
    collection(name) {
      if (name !== 'streetSegments') throw new Error(name);
      return {
        doc(id) {
          return {
            get: async () => (segment && segment.id === id ? doc(id, segment.data) : { exists: false, data: () => undefined }),
            collection(sub) {
              if (sub !== 'streetRules') throw new Error(sub);
              return {
                orderBy() { return queryFor(rules); },
                doc(ruleId) {
                  const found = rules.find(rule => rule.id === ruleId);
                  return { get: async () => (found ? doc(found.id, found.data()) : { exists: false }) };
                },
              };
            },
          };
        },
        where() { return queryFor([segment].filter(Boolean)); },
        count() { return { get: async () => ({ data: () => ({ count: segment ? 1 : 0 }) }) }; },
      };
    },
    collectionGroup(name) {
      if (name !== 'streetRules') throw new Error(name);
      return queryFor(rules);
    },
  };
}

describe('admin street schedule reads', () => {
  it('is dispatched only through the existing adminReadView handler', () => {
    const handler = readFileSync(new URL('./index.js', import.meta.url), 'utf8');
    const views = readFileSync(new URL('./adminReadViews.js', import.meta.url), 'utf8');
    expect(handler).toContain('await requireCurrentAdmin(request);');
    expect(handler.indexOf('await requireCurrentAdmin(request);')).toBeLessThan(handler.indexOf('ADMIN_READ_VIEWS[p.view]'));
    expect(views).toContain('streetScheduleList,');
    expect(views).toContain('streetIntelligenceHealth,');
    expect(views).not.toContain('officialBlockFaceId');
  });

  it('returns schedule windows and drops private canonical identity', async () => {
    const db = fakeDb({
      segment: { id: 'curb2_public', data: { streetName: 'Melville Street' } },
      rules: [doc('rule-1', {
        type: 'streetCleaning',
        schedules: [{ side: 'West', days: ['Mon'], startTime: '08:30', endTime: '10:00' }],
        officialBlockFaceId: '1522611401',
        identity: { physicalId: '98053' },
        geometry: { type: 'LineString' },
        writeAuthority: null,
      })],
    });
    const page = await ADMIN_READ_VIEWS.streetScheduleList(db, { segmentId: 'curb2_public' });
    expect(page.segmentFound).toBe(true);
    expect(page.rules).toEqual([{
      id: 'rule-1',
      type: 'streetCleaning',
      schedules: [{ side: 'West', days: ['Mon'], startTime: '08:30', endTime: '10:00', type: null }],
    }]);
    expect(JSON.stringify(page)).not.toMatch(/1522611401|98053|physicalId|LineString/);
  });

  it('rejects an oversized page and a segment id that could cross collections', async () => {
    const db = fakeDb({ segment: null, rules: [] });
    await expect(ADMIN_READ_VIEWS.streetScheduleList(db, { segmentId: 'curb2_public', limit: 101 }))
      .rejects.toThrow(/limit/);
    await expect(ADMIN_READ_VIEWS.streetScheduleList(db, { segmentId: 'streetSegments/other' }))
      .rejects.toThrow(/segmentId/);
  });

  it('counts active rules without returning rule documents', async () => {
    const db = fakeDb({
      segment: { id: 'seg', data: { status: 'active', source: 'admin' } },
      rules: [doc('rule-1', { supersededAt: null })],
    });
    const health = await ADMIN_READ_VIEWS.streetIntelligenceHealth(db);
    expect(health.activeRules).toBe(1);
    expect(health.totalSegments).toBe(1);
    expect(health.rules).toBeUndefined();
  });
});
