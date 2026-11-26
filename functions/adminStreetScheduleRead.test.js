import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { ADMIN_READ_VIEWS } = require('./adminReadViews');

function doc(id, data) {
  return { id, exists: true, data: () => data, ref: { id } };
}

function queryFor(rows) {
  let filtered = rows.slice();
  let limitN = filtered.length;
  let startAfterId = null;
  const api = {
    where(field, op, value) {
      if (field === 'supersededAt' && op === '==') {
        filtered = filtered.filter(row => row.data().supersededAt === value);
      }
      return api;
    },
    orderBy() {
      filtered = filtered.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      return api;
    },
    limit(n) { limitN = n; return api; },
    startAfter(snap) { startAfterId = snap.id; return api; },
    count() { return { get: async () => ({ data: () => ({ count: filtered.length }) }) }; },
    get: async () => {
      let page = filtered;
      if (startAfterId) {
        const index = page.findIndex(row => row.id === startAfterId);
        page = index >= 0 ? page.slice(index + 1) : [];
      }
      page = page.slice(0, limitN);
      return { size: page.length, docs: page, empty: page.length === 0 };
    },
    doc(ruleId) {
      const found = rows.find(rule => rule.id === ruleId);
      return { get: async () => (found ? doc(found.id, found.data()) : { exists: false }) };
    },
  };
  return api;
}

function fakeDb(state) {
  const segment = state.segment;
  const rules = state.rules;
  return {
    collection(name) {
      if (name !== 'streetSegments') throw new Error(name);
      return {
        doc(id) {
          return {
            get: async () => (segment && segment.id === id ? doc(id, segment.data) : { exists: false, data: () => undefined }),
            collection(sub) {
              if (sub !== 'streetRules') throw new Error(sub);
              return queryFor(rules);
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

const GENERATION = 'a'.repeat(32);
const OTHER_GENERATION = 'b'.repeat(32);
function authority(generationId) {
  return {
    scheme: 1,
    generationId,
    deadlineAtMs: 2_000_000_000_000,
    committedAt: 1_000,
    promotedAt: 1_500,
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
        provenance: { importedBy: 'private-job' },
        source: 'nyc_open_data',
        writeAuthority: null,
        supersededAt: null,
      })],
    });
    const page = await ADMIN_READ_VIEWS.streetScheduleList(db, { segmentId: 'curb2_public' });
    expect(page.segmentFound).toBe(true);
    expect(page.rules).toEqual([{
      id: 'rule-1',
      type: 'streetCleaning',
      schedules: [{ side: 'West', days: ['Mon'], startTime: '08:30', endTime: '10:00', type: null }],
    }]);
    expect(JSON.stringify(page)).not.toMatch(/1522611401|98053|physicalId|LineString|private-job|nyc_open_data|writeAuthority/);
  });

  it('returns only the current authoritative rule and continues past filtered pages', async () => {
    const rules = [
      doc('rule-active', {
        type: 'streetCleaning', supersededAt: null, writeAuthority: authority(GENERATION),
        schedules: [{ side: 'West', days: ['Mon'], startTime: '08:00', endTime: '09:30' }],
      }),
      doc('rule-legacy', { type: 'streetCleaning', supersededAt: null, writeAuthority: null, schedules: [] }),
      doc('rule-mismatched', { type: 'streetCleaning', supersededAt: null, writeAuthority: authority(OTHER_GENERATION), schedules: [] }),
      doc('rule-superseded', { type: 'streetCleaning', supersededAt: 10, writeAuthority: authority(GENERATION), schedules: [] }),
    ];
    const db = fakeDb({
      segment: { id: 'curb2_public', data: { writeAuthority: authority(GENERATION) } },
      rules,
    });
    const first = await ADMIN_READ_VIEWS.streetScheduleList(db, { segmentId: 'curb2_public', limit: 2 });
    const second = await ADMIN_READ_VIEWS.streetScheduleList(db, {
      segmentId: 'curb2_public', limit: 2, cursor: first.nextCursor,
    });
    expect(first.rules.map(rule => rule.id)).toEqual(['rule-active']);
    expect(first.done).toBe(false);
    expect(second.rules.map(rule => rule.id)).toEqual([]);
    expect(second.done).toBe(true);
    expect([...first.rules, ...second.rules].map(rule => rule.id)).toEqual(['rule-active']);
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
