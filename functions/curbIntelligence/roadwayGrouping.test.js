import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { groupRoadwayCandidates } = require('./roadwayGrouping');

const row = ({ id, physicalid, start, end, left = '0000000001', right = '0000000002',
  b5sc = '100001', type = '1', fromLevel = 'M', toLevel = 'M', name = 'GOLD STREET' }) => ({
  globalId: id,
  geometry: { type: 'MultiLineString', coordinates: [[start, end]] },
  leftBlockFaceId: left,
  rightBlockFaceId: right,
  sourceNative: {
    physicalid, b5sc, rw_type: type, from_level_code: fromLevel, to_level_code: toLevel,
    full_street_name: name,
  },
});

describe('physical roadway grouping', () => {
  it('groups connected official-face records across different physical IDs', () => {
    const rows = [
      row({ id: 'a', physicalid: '10', start: [-74, 40.71], end: [-74, 40.711] }),
      row({ id: 'b', physicalid: '11', start: [-74, 40.711], end: [-74, 40.712] }),
    ];
    const groups = groupRoadwayCandidates(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0].records.map(item => item.globalId)).toEqual(['a', 'b']);
    expect(groups[0].supportingPhysicalIds).toEqual(['10', '11']);
  });

  it('does not group by physicalid, name, or proximity alone', () => {
    const rows = [
      row({ id: 'main', physicalid: '20', start: [-74, 40.71], end: [-74, 40.711], left: '0000000001' }),
      row({ id: 'service', physicalid: '20', start: [-73.99999, 40.711], end: [-73.99999, 40.712], left: '0000000003', b5sc: '100002', name: 'GOLD STREET SERVICE ROAD' }),
    ];
    const groups = groupRoadwayCandidates(rows);
    expect(groups).toHaveLength(2);
    expect(groups.every(group => group.reasonCodes.includes('roadway_grouping_unresolved'))).toBe(true);
  });

  it('keeps shared-face records separate when level or roadway type conflicts', () => {
    const rows = [
      row({ id: 'surface', physicalid: '30', start: [-74, 40.71], end: [-74, 40.711] }),
      row({ id: 'bridge', physicalid: '31', start: [-74, 40.711], end: [-74, 40.712], fromLevel: '1', toLevel: '1' }),
      row({ id: 'ramp', physicalid: '32', start: [-74, 40.712], end: [-74, 40.713], type: '9' }),
    ];
    expect(groupRoadwayCandidates(rows)).toHaveLength(3);
  });

  it('does not treat two missing roadbed or level values as compatible evidence', () => {
    const first = row({ id: 'a', physicalid: '40', start: [-74, 40.71], end: [-74, 40.711] });
    const second = row({ id: 'b', physicalid: '41', start: [-74, 40.711], end: [-74, 40.712] });
    for (const field of ['rw_type', 'from_level_code', 'to_level_code']) {
      const records = [first, second].map(record => ({
        ...record, sourceNative: { ...record.sourceNative, [field]: null },
      }));
      expect(groupRoadwayCandidates(records)).toHaveLength(2);
    }
  });
});
