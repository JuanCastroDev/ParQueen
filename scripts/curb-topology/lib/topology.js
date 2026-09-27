'use strict';

const coordinateKey = coordinate => coordinate.map(value => Number(value).toFixed(7)).join(',');
const unique = values => [...new Set(values)];
const stable = values => [...values].sort((a, b) => String(a).localeCompare(String(b), 'en', { numeric: true }));

const geometryEndpoints = row => {
  const parts = row.geometry && row.geometry.coordinates;
  if (!Array.isArray(parts) || parts.length !== 1 || parts[0].length < 2) return null;
  return [parts[0][0], parts[0][parts[0].length - 1]];
};

const buildEndpointResolver = ({ nodes, segmentNodeRelations = [] }) => {
  const nodesById = new Map(nodes.map(item => [item.nodeId, item]));
  const nodesByCoordinate = new Map();
  for (const item of nodes) {
    const key = coordinateKey(item.geometry.coordinates);
    if (nodesByCoordinate.has(key)) nodesByCoordinate.set(key, null);
    else nodesByCoordinate.set(key, item.nodeId);
  }
  const relationBySegment = new Map(segmentNodeRelations.map(item => [String(item.physicalId), item]));

  return row => {
    const relation = relationBySegment.get(row.physicalId);
    if (relation) {
      const fromNodeId = String(relation.fromNodeId);
      const toNodeId = String(relation.toNodeId);
      if (!nodesById.has(fromNodeId) || !nodesById.has(toNodeId)) return null;
      return { fromNodeId, toNodeId, method: 'explicit_relation' };
    }
    const endpoints = geometryEndpoints(row);
    if (!endpoints) return null;
    const fromNodeId = nodesByCoordinate.get(coordinateKey(endpoints[0]));
    const toNodeId = nodesByCoordinate.get(coordinateKey(endpoints[1]));
    if (!fromNodeId || !toNodeId) return null;
    return { fromNodeId, toNodeId, method: 'geometry_node_fallback' };
  };
};

const chainEndpoints = edges => {
  const incoming = new Map();
  const outgoing = new Map();
  for (const edge of edges) {
    incoming.set(edge.toNodeId, (incoming.get(edge.toNodeId) || 0) + 1);
    outgoing.set(edge.fromNodeId, (outgoing.get(edge.fromNodeId) || 0) + 1);
  }
  const nodeIds = unique(edges.flatMap(edge => [edge.fromNodeId, edge.toNodeId]));
  if (nodeIds.some(id => (incoming.get(id) || 0) > 1 || (outgoing.get(id) || 0) > 1)) return null;
  const starts = nodeIds.filter(id => !incoming.get(id) && outgoing.get(id) === 1);
  const ends = nodeIds.filter(id => incoming.get(id) === 1 && !outgoing.get(id));
  const interiors = nodeIds.filter(id => incoming.get(id) === 1 && outgoing.get(id) === 1);
  if (starts.length !== 1 || ends.length !== 1 || interiors.length !== Math.max(0, edges.length - 1)) return null;

  const nextByNode = new Map(edges.map(edge => [edge.fromNodeId, edge.toNodeId]));
  const visited = new Set();
  let cursor = starts[0];
  while (nextByNode.has(cursor) && !visited.has(cursor)) {
    visited.add(cursor);
    cursor = nextByNode.get(cursor);
  }
  if (cursor !== ends[0] || visited.size !== edges.length) return null;
  return { fromNodeId: starts[0], toNodeId: ends[0] };
};

const contextCandidates = ({ nodeId, incident, supportingIds, onB5sc }) => {
  const candidates = new Map();
  for (const row of incident.get(nodeId) || []) {
    if (supportingIds.has(row.physicalId) || row.b5sc === onB5sc) continue;
    const key = `${row.b5sc || ''}\u0000${row.displayName}`;
    candidates.set(key, { b5sc: row.b5sc, displayName: row.displayName });
  }
  return [...candidates.values()].sort((a, b) => `${a.b5sc}:${a.displayName}`.localeCompare(`${b.b5sc}:${b.displayName}`));
};

const buildTopology = input => {
  if (!input || !Array.isArray(input.centerlines) || !Array.isArray(input.nodes)) {
    throw new TypeError('centerlines and nodes are required');
  }
  const resolveEndpoints = buildEndpointResolver(input);
  const endpointsBySegment = new Map();
  const incident = new Map();
  for (const row of input.centerlines) {
    const endpoints = resolveEndpoints(row);
    endpointsBySegment.set(row.physicalId, endpoints);
    if (!endpoints) continue;
    for (const nodeId of [endpoints.fromNodeId, endpoints.toNodeId]) {
      if (!incident.has(nodeId)) incident.set(nodeId, []);
      incident.get(nodeId).push(row);
    }
  }

  const occurrences = new Map();
  for (const row of input.centerlines) {
    if (row.leftBfi) {
      if (!occurrences.has(row.leftBfi)) occurrences.set(row.leftBfi, []);
      occurrences.get(row.leftBfi).push({ row, side: 'LEFT' });
    }
    if (row.rightBfi) {
      if (!occurrences.has(row.rightBfi)) occurrences.set(row.rightBfi, []);
      occurrences.get(row.rightBfi).push({ row, side: 'RIGHT' });
    }
  }

  const counts = { complete: 0, incomplete: 0, ambiguous: 0, conflict: 0, geometryFallback: 0 };
  const records = [];
  for (const bfi of stable(occurrences.keys())) {
    const found = occurrences.get(bfi);
    const rows = [...new Map(found.map(item => [item.row.physicalId, item.row])).values()];
    const sides = unique(found.map(item => item.side));
    const names = unique(rows.map(row => `${row.b5sc || ''}\u0000${row.displayName}`));
    const boroughs = unique(rows.map(row => `${row.boroughCode}\u0000${row.borough}`));
    const levels = unique(rows.flatMap(row => [row.fromLevel, row.toLevel]).filter(value => value !== null));
    const roadbeds = unique(rows.map(row => row.roadbedEvidence).filter(Boolean));
    const sourceVersions = unique(rows.map(row => row.sourceVersion));
    const supportingSegments = stable(rows.map(row => row.physicalId));
    const first = rows[0];
    const record = {
      topologySchemaVersion: 1,
      sourceManifestDigest: input.sourceManifestDigest,
      sourceRelease: input.sourceRelease,
      bfi,
      borough: first.borough,
      boroughCode: first.boroughCode,
      csclSide: sides.length === 1 ? sides[0] : null,
      onStreet: first.displayName,
      onStreetB5sc: first.b5sc,
      onStreetB7sc: first.b7sc,
      supportingSegments,
      roadwayStatus: stable(unique(rows.map(row => row.status))),
      roadwayType: stable(unique(rows.map(row => row.roadwayType))),
      levelEvidence: stable(levels),
      roadbedEvidence: stable(roadbeds),
      provenance: {
        sourceManifestDigest: input.sourceManifestDigest,
        sourceRelease: input.sourceRelease,
        sourceVersions: stable(sourceVersions),
      },
    };

    const hardConflict = sides.length !== 1
      || found.length !== rows.length
      || names.length !== 1
      || boroughs.length !== 1
      || levels.length > 1
      || roadbeds.length > 1
      || sourceVersions.length !== 1;
    if (hardConflict) {
      record.topologyState = 'conflict';
      counts.conflict += 1;
      records.push(record);
      continue;
    }

    const edges = rows.map(row => endpointsBySegment.get(row.physicalId));
    if (edges.some(value => !value)) {
      record.topologyState = 'incomplete';
      counts.incomplete += 1;
      records.push(record);
      continue;
    }
    const endpoints = chainEndpoints(edges);
    if (!endpoints) {
      record.topologyState = 'conflict';
      counts.conflict += 1;
      records.push(record);
      continue;
    }

    record.fromNode = endpoints.fromNodeId;
    record.toNode = endpoints.toNodeId;
    record.endpointMethod = edges.every(edge => edge.method === 'explicit_relation')
      ? 'explicit_relation'
      : 'geometry_node_fallback';
    if (record.endpointMethod === 'geometry_node_fallback') counts.geometryFallback += 1;
    record.directionEvidence = rows.map(row => ({
      physicalId: row.physicalId,
      csclSide: record.csclSide,
      fromNode: endpointsBySegment.get(row.physicalId).fromNodeId,
      toNode: endpointsBySegment.get(row.physicalId).toNodeId,
      geometry: row.geometry,
    })).sort((a, b) => a.physicalId.localeCompare(b.physicalId, 'en', { numeric: true }));

    const supportingIds = new Set(supportingSegments);
    record.fromStreetCandidates = contextCandidates({
      nodeId: record.fromNode, incident, supportingIds, onB5sc: record.onStreetB5sc,
    });
    record.toStreetCandidates = contextCandidates({
      nodeId: record.toNode, incident, supportingIds, onB5sc: record.onStreetB5sc,
    });

    if (record.fromStreetCandidates.length === 0 || record.toStreetCandidates.length === 0) {
      record.topologyState = 'incomplete';
      counts.incomplete += 1;
    } else if (record.fromStreetCandidates.length > 1 || record.toStreetCandidates.length > 1) {
      record.topologyState = 'ambiguous';
      counts.ambiguous += 1;
    } else {
      record.fromStreet = record.fromStreetCandidates[0].displayName;
      record.toStreet = record.toStreetCandidates[0].displayName;
      record.topologyState = 'complete';
      counts.complete += 1;
    }
    records.push(record);
  }

  return { records, counts };
};

module.exports = { buildTopology };
