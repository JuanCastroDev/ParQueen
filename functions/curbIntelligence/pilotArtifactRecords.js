'use strict';

// Expands the compact runtime artifact. This module does not read LION,
// SND, or the retained CSCL snapshot.

const RECORDED_SOURCE_VERSION = '1792226103:1744725948';
const LION_RELEASE = '26B';
const SND_RELEASE = '26B';

function tupleSegment(tuple) {
  const [
    segmentId, physicalId, street, streetCode, nodeIdFrom, nodeIdTo,
    nodeLevelFrom, nodeLevelTo, lgc1, lgc2, lgc3, lgc4, lgc5, featureType, segmentType,
  ] = tuple;
  return {
    segmentId, physicalId, street, streetCode, nodeIdFrom, nodeIdTo,
    nodeLevelFrom, nodeLevelTo, lgc1, lgc2, lgc3, lgc4, lgc5, featureType, segmentType,
  };
}

function tupleSnd(tuple) {
  const [name, b5sc, b7sc, b10sc, localGroup, primaryFlag, principalFlag] = tuple;
  return { name, b5sc, b7sc, b10sc, localGroup, primaryFlag, principalFlag };
}

function expandCoverageRecords(document) {
  const dictionaries = document?.dictionaries;
  if (!dictionaries || !Array.isArray(dictionaries.segments) || !Array.isArray(dictionaries.snd)
    || !dictionaries.nodes || typeof dictionaries.nodes !== 'object') return null;
  const records = [];
  for (const record of document.records || []) {
    if (!Array.isArray(record?.segments) || !Array.isArray(record?.sndRows)) return null;
    const segments = [];
    const sndRows = [];
    for (const index of record.segments) {
      const tuple = dictionaries.segments[index];
      if (!Array.isArray(tuple)) return null;
      segments.push(tupleSegment(tuple));
    }
    for (const index of record.sndRows) {
      const tuple = dictionaries.snd[index];
      if (!Array.isArray(tuple)) return null;
      sndRows.push(tupleSnd(tuple));
    }
    const fromNames = dictionaries.nodes[record.nodeIdFrom] || [];
    const toNames = dictionaries.nodes[record.nodeIdTo] || [];
    records.push({
      provenance: {
        certificationStatus: 'NOT_CERTIFIED',
        source: 'citywide-cross-street-coverage-1',
        csclSourceVersion: RECORDED_SOURCE_VERSION,
      },
      leftBlockFaceId: record.leftBlockFaceId,
      rightBlockFaceId: record.rightBlockFaceId,
      lionRelease: LION_RELEASE,
      sndRelease: SND_RELEASE,
      onStreet: {
        segmentId: record.segmentId,
        physicalId: record.physicalId,
        street: record.street,
        streetCode: record.streetCode,
        nodeIdFrom: record.nodeIdFrom,
        nodeIdTo: record.nodeIdTo,
      },
      originalNames: { from: fromNames, to: toNames },
      primaryNames: record.primaryNames,
      streetCodes: record.streetCodes,
      localGroups: record.localGroups,
      incidentSegmentIds: record.incidentSegmentIds,
      ambiguities: {
        secondaryNames: record.secondaryNames,
        nodeAbbreviationsAreNotPrimaryNames: true,
        driverSide: null,
        gradeSeparation: record.gradeSeparation,
      },
      fromNodeNames: fromNames,
      toNodeNames: toNames,
      segments,
      sndRows,
    });
  }
  return records;
}

module.exports = { expandCoverageRecords };
