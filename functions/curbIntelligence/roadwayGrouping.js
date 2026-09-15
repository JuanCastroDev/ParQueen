'use strict';

const EARTH_RADIUS_METERS = 6371008.8;
const radians = value => value * Math.PI / 180;

function distanceMeters(a, b) {
  const dLat = radians(b[1] - a[1]);
  const dLng = radians(b[0] - a[0]);
  const lat1 = radians(a[1]);
  const lat2 = radians(b[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.sqrt(h));
}

function endpoints(record) {
  return (record?.geometry?.coordinates || []).flatMap(line => line?.length ? [line[0], line[line.length - 1]] : []);
}

function connected(left, right) {
  return endpoints(left).some(a => endpoints(right).some(b => distanceMeters(a, b) <= 2));
}

function faces(record) {
  return new Set([record?.leftBlockFaceId, record?.rightBlockFaceId].filter(Boolean));
}

function sharedFace(left, right) {
  const rightFaces = faces(right);
  return [...faces(left)].some(face => rightFaces.has(face));
}

const same = (left, right, field) => Boolean(left?.sourceNative?.[field]
  && right?.sourceNative?.[field]
  && left.sourceNative[field] === right.sourceNative[field]);

function compatibleRoadbed(left, right) {
  return same(left, right, 'rw_type')
    && same(left, right, 'from_level_code')
    && same(left, right, 'to_level_code');
}

function officialRelationship(left, right) {
  const leftGroup = left?.officialRoadwayGroupId;
  const rightGroup = right?.officialRoadwayGroupId;
  return Boolean(leftGroup && leftGroup === rightGroup)
    || Boolean(left?.sourceNative?.b5sc && left.sourceNative.b5sc === right?.sourceNative?.b5sc);
}

function shouldGroup(left, right) {
  return sharedFace(left, right) && compatibleRoadbed(left, right)
    && officialRelationship(left, right) && connected(left, right);
}

function suspiciouslyRelated(left, right) {
  const samePhysical = Boolean(left?.sourceNative?.physicalid
    && left.sourceNative.physicalid === right?.sourceNative?.physicalid);
  const sameName = Boolean(left?.sourceNative?.full_street_name
    && left.sourceNative.full_street_name === right?.sourceNative?.full_street_name);
  return sharedFace(left, right) || samePhysical || (sameName && connected(left, right));
}

function groupRoadwayCandidates(records) {
  if (!Array.isArray(records)) return [];
  const parent = records.map((_, index) => index);
  const find = index => parent[index] === index ? index : (parent[index] = find(parent[index]));
  const union = (a, b) => { parent[find(b)] = find(a); };
  const unresolved = new Set();
  for (let left = 0; left < records.length; left += 1) {
    for (let right = left + 1; right < records.length; right += 1) {
      if (shouldGroup(records[left], records[right])) union(left, right);
      else if (suspiciouslyRelated(records[left], records[right])) {
        unresolved.add(left);
        unresolved.add(right);
      }
    }
  }
  const groups = new Map();
  records.forEach((record, index) => {
    const root = find(index);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push({ record, index });
  });
  return [...groups.values()].map(entries => {
    entries.sort((a, b) => String(a.record?.globalId).localeCompare(String(b.record?.globalId)));
    return ({
      records: entries.map(entry => entry.record),
      supportingPhysicalIds: [...new Set(entries.map(entry => entry.record?.sourceNative?.physicalid).filter(Boolean))].sort(),
      reasonCodes: entries.some(entry => unresolved.has(entry.index)) ? ['roadway_grouping_unresolved'] : [],
    });
  }).sort((a, b) => String(a.records[0]?.globalId).localeCompare(String(b.records[0]?.globalId)));
}

module.exports = { groupRoadwayCandidates };
