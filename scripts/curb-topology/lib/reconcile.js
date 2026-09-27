'use strict';

const reconcilePavementBfi = (edge, topologyRecords) => {
  if (!edge || edge.conflated !== true) return { ok: false, reason: 'non_conflated' };
  if (!edge.blockFaceId) return { ok: false, reason: 'invalid_bfi' };
  const matches = (topologyRecords || []).filter(record => record.bfi === edge.blockFaceId);
  if (matches.length === 0) return { ok: false, reason: 'bfi_not_found' };
  if (matches.some(record => record.topologyState !== 'complete')) {
    return { ok: false, reason: 'topology_incomplete' };
  }
  if (matches.some(record => !['LEFT', 'RIGHT'].includes(record.csclSide))
    || new Set(matches.map(record => record.csclSide)).size !== 1) {
    return { ok: false, reason: 'side_conflict' };
  }
  const materialRoadways = new Set(matches.map(record => `${record.onStreetB5sc}\u0000${record.onStreet}`));
  if (matches.length !== 1 || materialRoadways.size !== 1) {
    return { ok: false, reason: 'multiple_material_roadways' };
  }
  const topology = matches[0];
  return {
    ok: true,
    bfi: edge.blockFaceId,
    csclSide: topology.csclSide,
    materialRoadway: { b5sc: topology.onStreetB5sc, displayName: topology.onStreet },
    topology,
  };
};

const assessB5scB7scCoverage = records => {
  const eligibleRecords = (records || []).filter(record => record.topologyState === 'complete' && record.onStreetB5sc);
  const eligible = eligibleRecords.length;
  const withDirectB7sc = eligibleRecords.filter(record => /^[0-9]{8}$/.test(record.onStreetB7sc || '')).length;
  const coveragePercent = eligible === 0 ? 0 : Number(((withDirectB7sc / eligible) * 100).toFixed(4));
  const finding = withDirectB7sc === 0 ? 'NO' : withDirectB7sc === eligible ? 'YES' : 'PARTIAL';
  return {
    finding,
    eligible,
    withDirectB7sc,
    coveragePercent,
    aliasAuthorityEnabled: finding === 'YES',
  };
};

module.exports = { reconcilePavementBfi, assessB5scB7scCoverage };
