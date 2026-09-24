'use strict';

const { persistPublicRestrictionRules } = require('./persistPublicRestrictionRules');

describe('persistPublicRestrictionRules', () => {
  it('writes an evaluated_empty restriction set when lookup finds nothing', async () => {
    const writes = [];
    const db = {
      doc: path => ({
        set: async payload => { writes.push({ path, payload }); },
      }),
    };
    const Timestamp = { now: () => ({ seconds: 1 }) };
    await persistPublicRestrictionRules({
      db,
      Timestamp,
      segmentId: 'seg1',
      lookup: { state: 'omitted', rules: [] },
    });
    expect(writes[0].path).toBe('streetSegments/seg1/streetRules/dot_restrictions_v1');
    expect(writes[0].payload.type).toBe('curbRestrictionSet');
    expect(writes[0].payload.status).toBe('evaluated_empty');
    expect(writes[0].payload.restrictionSchemaVersion).toBe(1);
    expect(writes[0].payload.rules).toEqual([]);
    expect(JSON.stringify(writes[0].payload)).not.toMatch(/order_number|BFI|officialBlockFaceId/);
  });

  it('stores public prohibition schedules without source IDs', async () => {
    const writes = [];
    const db = {
      doc: path => ({
        set: async payload => { writes.push({ path, payload }); },
      }),
    };
    const Timestamp = { now: () => ({ seconds: 1 }) };
    await persistPublicRestrictionRules({
      db,
      Timestamp,
      segmentId: 'seg1',
      lookup: {
        state: 'supported',
        rules: [{
          type: 'noStanding',
          source: 'nyc_open_data',
          restrictionLevel: 2,
          schedules: [{ side: 'West', days: ['Mon'], startTime: '16:00', endTime: '19:00', anytime: false }],
        }],
      },
    });
    expect(writes[0].payload.status).toBe('active');
    expect(writes[0].payload.schedules[0].type).toBe('noStanding');
  });
});
