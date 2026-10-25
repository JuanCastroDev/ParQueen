'use strict';

// Offline diagnostic for a retained LION street-code join.
// It does not write production cross-street fields or certify a candidate.

function closed(reason) {
  return Object.freeze({
    status: 'NON_AUTHORITATIVE',
    reason,
    certificationStatus: 'NOT_CERTIFIED',
    productionAuthoritative: false,
    canonicalSupported: false,
    fromStreetCandidate: null,
    toStreetCandidate: null,
    onStreet: null,
    fromNode: null,
    toNode: null,
    gradeSeparation: Object.freeze([]),
    side: null,
  });
}

function sharesNode(segment, nodeId) {
  return segment.nodeIdFrom === nodeId || segment.nodeIdTo === nodeId;
}

function sameStreet(segments) {
  const names = new Set(segments.map(segment => segment.street));
  return names.size === 1 ? segments[0].street : null;
}

function isPrimary(row) {
  return row.primaryFlag === 'P' && row.principalFlag === 'F';
}

function wellFormedSnd(row) {
  return row.b7sc === `${row.b5sc}${row.localGroup}`
    && typeof row.b10sc === 'string'
    && row.b10sc.startsWith(row.b7sc);
}

function recordedLocalGroups(segment) {
  const fields = ['lgc1', 'lgc2', 'lgc3', 'lgc4', 'lgc5'];
  if (fields.some(field => typeof segment[field] !== 'string')) {
    return { ok: false, reason: 'incomplete_incident_segment' };
  }
  const groups = [];
  for (const field of fields) {
    const value = segment[field].trim();
    if (value !== '' && !groups.includes(value)) groups.push(value);
  }
  if (groups.length === 0) return { ok: false, reason: 'incomplete_incident_segment' };
  return { ok: true, groups };
}

function nameDisagreement(coded, recordedGroups, street) {
  const named = coded.some(row => recordedGroups.has(row.localGroup) && row.name === street);
  return named ? 'secondary_name_not_primary' : 'snd_primary_name_disagreement';
}

function terminalCandidate(nodeId, segments, onStreetCode, sndRows, nodeNames) {
  const foreign = segments.filter(segment => segment.streetCode && segment.streetCode !== onStreetCode);
  const cross = foreign.filter(segment => sharesNode(segment, nodeId));
  if (cross.length === 0) {
    return { ok: false, reason: foreign.length ? 'wrong_incident_node' : 'missing_cross_street_segment' };
  }
  if (cross.some(segment => !segment.street || !segment.streetCode || !segment.nodeIdFrom || !segment.nodeIdTo)) {
    return { ok: false, reason: 'incomplete_incident_segment' };
  }
  const codes = [...new Set(cross.map(segment => segment.streetCode))];
  if (codes.length !== 1) return { ok: false, reason: 'ambiguous_street_code' };
  const street = sameStreet(cross);
  if (!street) return { ok: false, reason: 'conflicting_segment_street' };

  const recorded = cross.map(recordedLocalGroups);
  const failed = recorded.find(group => !group.ok);
  if (failed) return failed;

  const code = codes[0];
  const coded = sndRows.filter(row => row.b5sc === code);
  if (coded.length === 0) return { ok: false, reason: 'street_code_snd_mismatch' };
  if (coded.some(row => typeof row.localGroup !== 'string' || row.localGroup.trim() === '')) {
    return { ok: false, reason: 'missing_snd_local_group' };
  }

  const recordedGroups = new Set(recorded.flatMap(group => group.groups));
  let localGroup;
  let primary;
  let secondary;
  if (recorded.some(group => group.groups.length > 1)) {
    const primaries = coded.filter(isPrimary);
    if (primaries.length !== 1) return { ok: false, reason: 'unresolved_source_identity' };
    primary = primaries[0];
    if (primary.name !== street) {
      return { ok: false, reason: nameDisagreement(coded, recordedGroups, street) };
    }
    if (recorded.some(group => !group.groups.includes(primary.localGroup))) {
      return { ok: false, reason: 'incompatible_local_group' };
    }
    for (const group of recordedGroups) {
      const rows = coded.filter(row => row.localGroup === group);
      if (rows.length === 0) return { ok: false, reason: 'incompatible_local_group' };
      if (rows.some(row => !wellFormedSnd(row))) return { ok: false, reason: 'unresolved_source_identity' };
    }
    localGroup = primary.localGroup;
    secondary = coded.filter(row => recordedGroups.has(row.localGroup) && !isPrimary(row));
  } else {
    if (recordedGroups.size !== 1) return { ok: false, reason: 'incompatible_local_group' };
    localGroup = recorded[0].groups[0];
    const grouped = coded.filter(row => row.localGroup === localGroup);
    if (grouped.length === 0) return { ok: false, reason: 'incompatible_local_group' };
    if (grouped.some(row => !wellFormedSnd(row))) return { ok: false, reason: 'unresolved_source_identity' };
    const primaries = grouped.filter(isPrimary);
    if (primaries.length !== 1) return { ok: false, reason: 'unresolved_source_identity' };
    primary = primaries[0];
    secondary = grouped.filter(row => !isPrimary(row));
    if (primary.name !== street) {
      return {
        ok: false,
        reason: secondary.some(row => row.name === street) ? 'secondary_name_not_primary' : 'snd_primary_name_disagreement',
      };
    }
  }

  return {
    ok: true,
    value: Object.freeze({
      nodeId,
      candidateStreet: street,
      streetCode: code,
      b5sc: code,
      b7sc: primary.b7sc,
      b10sc: primary.b10sc,
      localGroup,
      lgc: Object.freeze(cross.map(segment => Object.freeze({
        segmentId: segment.segmentId,
        lgc1: segment.lgc1,
        lgc2: segment.lgc2,
        lgc3: segment.lgc3,
        lgc4: segment.lgc4,
        lgc5: segment.lgc5,
      }))),
      segmentIds: Object.freeze(cross.map(segment => segment.segmentId)),
      physicalIds: Object.freeze(cross.map(segment => segment.physicalId)),
      secondaryNames: Object.freeze(secondary.map(row => row.name)),
      nodeNames: Object.freeze(nodeNames.slice()),
      nodeLevels: Object.freeze(cross.map(segment => Object.freeze({
        segmentId: segment.segmentId,
        from: segment.nodeLevelFrom,
        to: segment.nodeLevelTo,
      }))),
    }),
  };
}

function diagnoseIncidentCrossStreets(input) {
  if (!input || input.lionRelease !== input.sndRelease || typeof input.lionRelease !== 'string' || input.lionRelease === '') {
    return closed('source_release_mismatch');
  }
  const onStreet = input.onStreet;
  if (!onStreet?.segmentId || !onStreet.street || !onStreet.streetCode || !onStreet.nodeIdFrom || !onStreet.nodeIdTo) {
    return closed('on_street_incomplete');
  }
  const fromNode = terminalCandidate(
    onStreet.nodeIdFrom,
    input.segments || [],
    onStreet.streetCode,
    input.sndRows || [],
    input.fromNodeNames || [],
  );
  if (!fromNode.ok) return closed(fromNode.reason);
  const toNode = terminalCandidate(
    onStreet.nodeIdTo,
    input.segments || [],
    onStreet.streetCode,
    input.sndRows || [],
    input.toNodeNames || [],
  );
  if (!toNode.ok) return closed(toNode.reason);
  const gradeSeparation = Object.freeze([
    ...fromNode.value.nodeLevels,
    ...toNode.value.nodeLevels,
  ].filter(level => level.from !== 'M' || level.to !== 'M'));
  return Object.freeze({
    status: 'NON_AUTHORITATIVE',
    reason: null,
    certificationStatus: 'NOT_CERTIFIED',
    productionAuthoritative: false,
    canonicalSupported: false,
    fromStreetCandidate: fromNode.value.candidateStreet,
    toStreetCandidate: toNode.value.candidateStreet,
    onStreet: Object.freeze({
      street: onStreet.street,
      streetCode: onStreet.streetCode,
      segmentId: onStreet.segmentId,
      physicalId: onStreet.physicalId,
    }),
    fromNode: fromNode.value,
    toNode: toNode.value,
    gradeSeparation,
    side: null,
    provenance: Object.freeze({
      lionRelease: input.lionRelease,
      sndRelease: input.sndRelease,
      certificationStatus: 'NOT_CERTIFIED',
    }),
  });
}

module.exports = { diagnoseIncidentCrossStreets };
