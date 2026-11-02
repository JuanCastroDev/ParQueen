import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { groupRoadwayCandidates } = require('./roadwayGrouping');

const EARTH_RADIUS_METERS = 6371008.8;
const PLAN_ORIGIN = [-74, 40.71];
const meters = (east, north) => {
  const lat = PLAN_ORIGIN[1] * Math.PI / 180;
  return [
    PLAN_ORIGIN[0] + east / (EARTH_RADIUS_METERS * Math.cos(lat) * Math.PI / 180),
    PLAN_ORIGIN[1] + north / (EARTH_RADIUS_METERS * Math.PI / 180),
  ];
};

const row = ({ id, physicalid, start, end, lines, left = '0000000001', right = '0000000002',
  b5sc = '100001', type = '1', fromLevel = 'M', toLevel = 'M', name = 'GOLD STREET' }) => ({
  globalId: id,
  geometry: { type: 'MultiLineString', coordinates: lines || [[start, end]] },
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
    expect(groups[0].reasonCodes).toEqual([]);
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

  const continuation = (overrides = {}) => row({
    id: 'west', physicalid: '501', start: [-74.002, 40.71], end: [-74.001, 40.71],
    left: '4000000001', right: '4000000002', ...overrides,
  });
  const neighbor = (overrides = {}) => row({
    id: 'east', physicalid: '502', start: [-74.001, 40.71], end: [-74, 40.71],
    left: '4000000003', right: '4000000004', ...overrides,
  });
  const separate = records => {
    const groups = groupRoadwayCandidates(records);
    expect(groups).toHaveLength(2);
    expect(groups.every(group => group.records.length === 1)).toBe(true);
    return groups;
  };

  it('keeps an ordinary same-street continuation separate without an unresolved flag', () => {
    const groups = separate([continuation(), neighbor()]);
    expect(groups.map(group => group.reasonCodes)).toEqual([[], []]);
  });

  it('still marks different roadway levels unresolved', () => {
    const groups = separate([
      continuation(),
      neighbor({ fromLevel: '1', toLevel: '1' }),
    ]);
    expect(groups.every(group => group.reasonCodes.includes('roadway_grouping_unresolved'))).toBe(true);
  });

  it('still marks conflicting roadway types unresolved', () => {
    const groups = separate([continuation(), neighbor({ type: '9' })]);
    expect(groups.every(group => group.reasonCodes.includes('roadway_grouping_unresolved'))).toBe(true);
  });

  it('still marks conflicting official street codes unresolved', () => {
    const groups = separate([continuation(), neighbor({ b5sc: '100002' })]);
    expect(groups.every(group => group.reasonCodes.includes('roadway_grouping_unresolved'))).toBe(true);
  });

  it('still marks a shared official block face unresolved when the records cannot group', () => {
    const groups = separate([
      continuation({ left: '4000000001', right: '4000000002' }),
      neighbor({ left: '4000000001', right: '4000000002', b5sc: '100002' }),
    ]);
    expect(groups.every(group => group.reasonCodes.includes('roadway_grouping_unresolved'))).toBe(true);
  });

  it('still marks the same physical roadway unresolved when it is not one group', () => {
    const groups = separate([continuation({ physicalid: '501' }), neighbor({ physicalid: '501' })]);
    expect(groups.every(group => group.reasonCodes.includes('roadway_grouping_unresolved'))).toBe(true);
  });

  it('still marks overlapping same-name roadways unresolved', () => {
    const groups = separate([
      continuation(),
      neighbor({ start: [-74.002, 40.71], end: [-74.0015, 40.71] }),
    ]);
    expect(groups.every(group => group.reasonCodes.includes('roadway_grouping_unresolved'))).toBe(true);
  });

  it('does not treat incomplete source evidence as an ordinary continuation', () => {
    const gaps = [
      neighbor({ b5sc: null }),
      neighbor({ type: ' ' }),
      neighbor({ fromLevel: null }),
      neighbor({ toLevel: '' }),
      neighbor({ physicalid: '0501' }),
      neighbor({ physicalid: null }),
      neighbor({ left: null }),
      neighbor({ left: 'not-a-face' }),
      neighbor({ left: '4000000003', right: '4000000003' }),
    ];
    for (const other of gaps) {
      const groups = separate([continuation(), other]);
      expect(groups.some(group => group.reasonCodes.includes('roadway_grouping_unresolved'))).toBe(true);
    }
    const unnamed = separate([continuation(), neighbor({ name: '' })]);
    expect(unnamed.map(group => group.reasonCodes)).toEqual([[], []]);
  });

  it('keeps unrelated nearby segments separate and resolved', () => {
    const groups = separate([
      continuation(),
      row({
        id: 'cross', physicalid: '700', start: [-73.998, 40.711], end: [-73.997, 40.711],
        left: '5000000001', right: '5000000002', b5sc: '300003', name: 'CROSS PLACE',
      }),
    ]);
    expect(groups.map(group => group.reasonCodes)).toEqual([[], []]);
  });

  const measured = (id, physicalid, left, right, start, end, lines) => row({
    id, physicalid, left, right, start, end, lines,
  });
  const westFace = ['4000000001', '4000000002'];
  const eastFace = ['4000000003', '4000000004'];

  it('accepts an exact endpoint-only continuation', () => {
    const groups = separate([
      measured('west', '501', ...westFace, meters(0, 0), meters(100, 0)),
      measured('east', '502', ...eastFace, meters(100, 0), meters(200, 0)),
    ]);
    expect(groups.map(group => group.reasonCodes)).toEqual([[], []]);
  });

  it('accepts a non-overlapping endpoint gap inside the 2-meter connection tolerance', () => {
    const groups = separate([
      measured('west', '501', ...westFace, meters(0, 0), meters(100, 0)),
      measured('east', '502', ...eastFace, meters(101.5, 0), meters(201.5, 0)),
    ]);
    expect(groups.map(group => group.reasonCodes)).toEqual([[], []]);
  });

  it('does not treat a 0.5-meter collinear overlap as an ordinary continuation', () => {
    const groups = separate([
      measured('west', '501', ...westFace, meters(0, 0), meters(100, 0)),
      measured('east', '502', ...eastFace, meters(99.5, 0), meters(199.5, 0)),
    ]);
    expect(groups.every(group => group.reasonCodes.includes('roadway_grouping_unresolved'))).toBe(true);
  });

  it('does not treat a 1-meter collinear overlap as an ordinary continuation', () => {
    const groups = separate([
      measured('west', '501', ...westFace, meters(0, 0), meters(100, 0)),
      measured('east', '502', ...eastFace, meters(99, 0), meters(199, 0)),
    ]);
    expect(groups.every(group => group.reasonCodes.includes('roadway_grouping_unresolved'))).toBe(true);
  });

  it('does not treat a nested collinear overlap as an ordinary continuation', () => {
    const groups = separate([
      measured('west', '501', ...westFace, meters(0, 0), meters(100, 0)),
      measured('east', '502', ...eastFace, meters(0, 0), meters(40, 0)),
    ]);
    expect(groups.every(group => group.reasonCodes.includes('roadway_grouping_unresolved'))).toBe(true);
  });

  it('does not treat reversed overlapping segments as an ordinary continuation', () => {
    const groups = separate([
      measured('west', '501', ...westFace, meters(0, 0), meters(100, 0)),
      measured('east', '502', ...eastFace, meters(100, 0), meters(40, 0)),
    ]);
    expect(groups.every(group => group.reasonCodes.includes('roadway_grouping_unresolved'))).toBe(true);
  });

  it('accepts a reversed ordinary continuation', () => {
    const groups = separate([
      measured('west', '501', ...westFace, meters(0, 0), meters(100, 0)),
      measured('east', '502', ...eastFace, meters(200, 0), meters(100, 0)),
    ]);
    expect(groups.map(group => group.reasonCodes)).toEqual([[], []]);
  });

  it('does not treat a multipart overlap as an ordinary continuation', () => {
    const groups = separate([
      measured('west', '501', ...westFace, null, null, [
        [meters(0, 0), meters(100, 0)],
        [meters(300, 0), meters(400, 0)],
      ]),
      measured('east', '502', ...eastFace, meters(99, 0), meters(199, 0)),
    ]);
    expect(groups.every(group => group.reasonCodes.includes('roadway_grouping_unresolved'))).toBe(true);
  });

  it('keeps ambiguous multipart adjacency unresolved', () => {
    const groups = separate([
      measured('west', '501', ...westFace, null, null, [
        [meters(0, 0), meters(100, 0)],
        [meters(0, 1), meters(100, 1)],
      ]),
      measured('east', '502', ...eastFace, meters(100, 0), meters(200, 0)),
    ]);
    expect(groups.every(group => group.reasonCodes.includes('roadway_grouping_unresolved'))).toBe(true);
  });

  it('does not treat a crossing or interior branch as an ordinary continuation', () => {
    const crossing = separate([
      measured('west', '501', ...westFace, meters(0, 0), meters(3, 0)),
      measured('east', '502', ...eastFace, meters(1.5, -1), meters(1.5, 1)),
    ]);
    const branch = separate([
      measured('west', '501', ...westFace, meters(0, 0), meters(3, 0)),
      measured('east', '502', ...eastFace, meters(1.5, 0), meters(1.5, 40)),
    ]);
    expect(crossing.every(group => group.reasonCodes.includes('roadway_grouping_unresolved'))).toBe(true);
    expect(branch.every(group => group.reasonCodes.includes('roadway_grouping_unresolved'))).toBe(true);
  });

  it('does not let degenerate or non-finite geometry qualify', () => {
    const degenerate = separate([
      measured('west', '501', ...westFace, meters(0, 0), meters(100, 0)),
      measured('east', '502', ...eastFace, meters(100, 0), meters(100, 0)),
    ]);
    const nonFinite = separate([
      measured('west', '501', ...westFace, meters(0, 0), meters(100, 0)),
      measured('east', '502', ...eastFace, null, null, [[meters(100, 0), [Number.NaN, 40.71]]]),
    ]);
    expect(degenerate.every(group => group.reasonCodes.includes('roadway_grouping_unresolved'))).toBe(true);
    expect(nonFinite.every(group => group.reasonCodes.includes('roadway_grouping_unresolved'))).toBe(true);
  });
});
