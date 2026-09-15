'use strict';

const STATES = new Set(['SUPPORTED', 'CAUTION', 'UNKNOWN']);
const APPLICABILITY = new Set(['WHOLE_FACE', 'PARTIAL_FACE', 'UNKNOWN']);
const norm = value => typeof value === 'string' ? value.toUpperCase().replace(/\s+/g, ' ').trim() : '';
const names = values => Array.isArray(values) ? [...new Set(values.map(norm).filter(Boolean))] : [];

function createFaceAssociationContext(input = {}) {
  const relationship = input.officialRelationship;
  const context = {
    curbIdentityState: STATES.has(input.curbIdentityState) ? input.curbIdentityState : 'UNKNOWN',
    borough: norm(input.borough),
    streetNames: names(input.streetNames),
    fromNames: names(input.fromNames),
    toNames: names(input.toNames),
    side: norm(input.side),
    officialRelationship: relationship && typeof relationship.providerId === 'string'
      && relationship.providerId.trim() && typeof relationship.version === 'string'
      && relationship.version.trim() && relationship.orderApplicability
      && typeof relationship.orderApplicability === 'object'
      && !Array.isArray(relationship.orderApplicability) ? {
        providerId: relationship.providerId.trim(),
        version: relationship.version.trim(),
        orderApplicability: { ...relationship.orderApplicability },
      } : null,
  };
  context.complete = Boolean(context.borough && context.streetNames.length
    && context.fromNames.length && context.toNames.length
    && ['N', 'S', 'E', 'W'].includes(context.side) && context.officialRelationship);
  return context;
}

function sameVersion(left, right) {
  return left?.resourceId === right?.resourceId
    && left?.rowsUpdatedAt === right?.rowsUpdatedAt
    && left?.viewLastModified === right?.viewLastModified;
}

function endpointMatch(candidate, context) {
  const from = norm(candidate.fromStreet);
  const to = norm(candidate.toStreet);
  return (context.fromNames.includes(from) && context.toNames.includes(to))
    || (context.fromNames.includes(to) && context.toNames.includes(from));
}

function reasonForMismatch(candidate, context) {
  if (norm(candidate.borough) !== context.borough) return 'borough_mismatch';
  if (!context.streetNames.includes(norm(candidate.onStreet))) return 'street_identity_mismatch';
  if (norm(candidate.side) !== context.side) return 'side_mismatch';
  if (!endpointMatch(candidate, context)) return 'bounds_mismatch';
  return null;
}

function associateDotCandidates(context, snapshot) {
  if (!context?.complete) {
    return { state: 'UNKNOWN', reasons: ['official_face_context_incomplete'], applicability: 'UNKNOWN', candidates: [] };
  }
  if (snapshot?.completeness?.state !== 'COMPLETE') {
    return { state: 'UNKNOWN', reasons: ['candidate_source_incomplete'], applicability: 'UNKNOWN', candidates: [] };
  }
  if (snapshot?.sourceVersion?.resourceId !== 'nfid-uabd') {
    return { state: 'UNKNOWN', reasons: ['source_version_mismatch'], applicability: 'UNKNOWN', candidates: [] };
  }
  const candidates = Array.isArray(snapshot.candidates) ? snapshot.candidates : [];
  if (!candidates.length) return { state: 'UNKNOWN', reasons: ['official_sign_candidate_missing'], applicability: 'UNKNOWN', candidates: [] };
  if (candidates.some(candidate => !sameVersion(candidate.sourceVersion, snapshot.sourceVersion))) {
    return { state: 'UNKNOWN', reasons: ['source_version_mismatch'], applicability: 'UNKNOWN', candidates: [] };
  }
  const fieldMatches = candidates.filter(candidate => !reasonForMismatch(candidate, context));
  if (!fieldMatches.length) {
    return {
      state: 'UNKNOWN',
      reasons: [reasonForMismatch(candidates[0], context) || 'official_face_association_unresolved'],
      applicability: 'UNKNOWN',
      candidates: [],
    };
  }
  const mapped = fieldMatches.map(candidate => ({
    candidate,
    applicability: context.officialRelationship.orderApplicability[candidate.orderNumber],
  })).filter(item => APPLICABILITY.has(item.applicability));
  if (!mapped.length) {
    return { state: 'UNKNOWN', reasons: ['official_order_relationship_missing'], applicability: 'UNKNOWN', candidates: [] };
  }
  const applications = new Set(mapped.map(item => item.applicability));
  if (applications.has('UNKNOWN') || applications.size > 1) {
    return { state: 'UNKNOWN', reasons: ['face_applicability_unknown'], applicability: 'UNKNOWN', candidates: mapped.map(item => item.candidate) };
  }
  const applicability = mapped[0].applicability;
  if (applicability === 'PARTIAL_FACE') {
    return { state: 'CAUTION', reasons: ['partial_face_detected'], applicability, candidates: mapped.map(item => item.candidate) };
  }
  return { state: 'SUPPORTED', reasons: [], applicability, candidates: mapped.map(item => item.candidate) };
}

module.exports = { associateDotCandidates, createFaceAssociationContext };
