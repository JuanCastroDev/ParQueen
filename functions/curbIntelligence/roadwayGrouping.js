'use strict';

const { normalizeBlockFaceId } = require('./curbIdentity');

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

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function sameText(left, right, field) {
  const first = text(left?.sourceNative?.[field]);
  const second = text(right?.sourceNative?.[field]);
  return Boolean(first && second && first === second);
}

function physicalKey(record) {
  const value = text(record?.sourceNative?.physicalid);
  if (!value || !/^\d+$/.test(value)) return null;
  return value.replace(/^0+/, '');
}

function distinctPhysicalIds(left, right) {
  const first = physicalKey(left);
  const second = physicalKey(right);
  return Boolean(first && second && first !== second);
}

function facePair(record) {
  const left = normalizeBlockFaceId(record?.leftBlockFaceId);
  const right = normalizeBlockFaceId(record?.rightBlockFaceId);
  if (!left || !right || left === right) return null;
  return [left, right];
}

function disjointOfficialFaces(left, right) {
  const first = facePair(left);
  const second = facePair(right);
  return Boolean(first && second && first.every(face => !second.includes(face)));
}

function lineSegments(record) {
  return (record?.geometry?.coordinates || []).flatMap(line => (
    Array.isArray(line) ? line.slice(0, -1).map((point, index) => [point, line[index + 1]]) : []
  )).filter(([start, end]) => Array.isArray(start) && Array.isArray(end));
}

function localPoint(origin, point) {
  const lat = radians(origin[1]);
  return {
    x: radians(point[0] - origin[0]) * Math.cos(lat) * EARTH_RADIUS_METERS,
    y: radians(point[1] - origin[1]) * EARTH_RADIUS_METERS,
  };
}

const COLLINEAR_TOLERANCE_METERS = 0.05;
const OVERLAP_TOLERANCE_METERS = 0.05;
const INTERIOR_MARGIN_METERS = 0.05;

function finitePoint(point) {
  return Array.isArray(point) && point.length >= 2
    && Number.isFinite(point[0]) && Number.isFinite(point[1]);
}

function segmentFrame(start, end) {
  if (!finitePoint(start) || !finitePoint(end)) return null;
  const vector = localPoint(start, end);
  const length = Math.hypot(vector.x, vector.y);
  if (!(length > 0)) return null;
  return {
    start,
    end,
    length,
    unit: { x: vector.x / length, y: vector.y / length },
  };
}

function along(frame, point) {
  const local = localPoint(frame.start, point);
  return local.x * frame.unit.x + local.y * frame.unit.y;
}

function lateral(frame, point) {
  const local = localPoint(frame.start, point);
  return Math.abs(local.x * -frame.unit.y + local.y * frame.unit.x);
}

function intersectionFractions(left, right) {
  const origin = localPoint(left.start, left.start);
  const start = { x: origin.x, y: origin.y };
  const direction = { x: left.unit.x * left.length, y: left.unit.y * left.length };
  const otherStart = localPoint(left.start, right.start);
  const otherEnd = localPoint(left.start, right.end);
  const other = { x: otherEnd.x - otherStart.x, y: otherEnd.y - otherStart.y };
  const denom = direction.x * other.y - direction.y * other.x;
  if (Math.abs(denom) <= 1e-8) return null;
  const offset = { x: otherStart.x - start.x, y: otherStart.y - start.y };
  const t = (offset.x * other.y - offset.y * other.x) / denom;
  const u = (offset.x * direction.y - offset.y * direction.x) / denom;
  if (t < -1e-8 || t > 1 + 1e-8 || u < -1e-8 || u > 1 + 1e-8) return null;
  return {
    t: Math.min(1, Math.max(0, t)),
    u: Math.min(1, Math.max(0, u)),
  };
}

function interior(length, fraction) {
  const position = fraction * length;
  return position > INTERIOR_MARGIN_METERS && length - position > INTERIOR_MARGIN_METERS;
}

function projectsInside(frame, point) {
  if (!finitePoint(point) || lateral(frame, point) > COLLINEAR_TOLERANCE_METERS) return false;
  const position = along(frame, point);
  return position > INTERIOR_MARGIN_METERS && position < frame.length - INTERIOR_MARGIN_METERS;
}

function classifySegments(left, right) {
  const leftFrame = segmentFrame(left[0], left[1]);
  const rightFrame = segmentFrame(right[0], right[1]);
  if (!leftFrame || !rightFrame) return 'invalid';
  const collinear = [right[0], right[1]].every(point => (
    lateral(leftFrame, point) <= COLLINEAR_TOLERANCE_METERS
  ));
  if (collinear) {
    const positions = [right[0], right[1]].map(point => along(leftFrame, point));
    const overlap = Math.min(leftFrame.length, Math.max(...positions))
      - Math.max(0, Math.min(...positions));
    return overlap > OVERLAP_TOLERANCE_METERS ? 'overlap' : 'clear';
  }
  const hit = intersectionFractions(leftFrame, rightFrame);
  if (hit) {
    const leftInterior = interior(leftFrame.length, hit.t);
    const rightInterior = interior(rightFrame.length, hit.u);
    if (leftInterior && rightInterior) return 'cross';
    if (leftInterior || rightInterior) return 'branch';
    return 'clear';
  }
  if (projectsInside(leftFrame, right[0]) || projectsInside(leftFrame, right[1])
    || projectsInside(rightFrame, left[0]) || projectsInside(rightFrame, left[1])) {
    return 'branch';
  }
  return 'clear';
}

function endpointGap(left, right) {
  const gaps = [left[0], left[1]].flatMap(start => (
    [right[0], right[1]].map(end => distanceMeters(start, end))
  ));
  if (gaps.some(gap => !Number.isFinite(gap))) return Infinity;
  return Math.min(...gaps);
}

function geometriesOverlap(left, right) {
  const leftSegments = lineSegments(left);
  const rightSegments = lineSegments(right);
  if (!leftSegments.length || !rightSegments.length) return true;
  if ([...leftSegments, ...rightSegments].some(segment => !finitePoint(segment[0]) || !finitePoint(segment[1]))) {
    return true;
  }
  let connections = 0;
  for (const leftSegment of leftSegments) {
    for (const rightSegment of rightSegments) {
      const relation = classifySegments(leftSegment, rightSegment);
      if (relation !== 'clear') return true;
      if (endpointGap(leftSegment, rightSegment) <= 2) connections += 1;
    }
  }
  return connections !== 1;
}

function ordinaryContinuation(left, right) {
  return sameText(left, right, 'b5sc')
    && /^\d+$/.test(text(left?.sourceNative?.b5sc) || '')
    && sameText(left, right, 'rw_type')
    && sameText(left, right, 'from_level_code')
    && sameText(left, right, 'to_level_code')
    && sameText(left, right, 'full_street_name')
    && distinctPhysicalIds(left, right)
    && disjointOfficialFaces(left, right)
    && connected(left, right)
    && !geometriesOverlap(left, right);
}

function suspiciouslyRelated(left, right) {
  if (ordinaryContinuation(left, right)) return false;
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
