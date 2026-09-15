'use strict';

const { classifyStreetCleaningSign } = require('./cleaningClassifier');
const { createCleaningFingerprint } = require('./cleaningFingerprint');
const { associateDotCandidates } = require('./dotFaceAssociation');
const { capAssociationState } = require('./ruleConfidence');

function associateCleaningRules(input = {}) {
  const curbState = input.curbIdentity?.state || 'UNKNOWN';
  const face = associateDotCandidates(input.faceContext, input.candidateSnapshot);
  if (!face.candidates.length) {
    return { rules: [], fingerprint: null, confidence: 'UNKNOWN', reasons: [...face.reasons] };
  }

  const evaluated = face.candidates.map(candidate => ({
    candidate,
    result: classifyStreetCleaningSign(candidate.sourceNative, {
      street: candidate.onStreet,
      fromCross: candidate.fromStreet,
      toCross: candidate.toStreet,
      side: candidate.side,
    }),
  }));
  if (evaluated.some(item => item.result.reason === 'incomplete_schedule')) {
    return { rules: [], fingerprint: null, confidence: 'UNKNOWN', reasons: ['incomplete_cleaning_rule'] };
  }
  const classified = evaluated.filter(item => item.result.classified);
  if (!classified.length) {
    return { rules: [], fingerprint: null, confidence: 'UNKNOWN', reasons: ['no_reviewed_cleaning_rule'] };
  }

  const byIdentity = new Map();
  for (const item of classified) {
    const fingerprint = createCleaningFingerprint([item.result.schedule]).fingerprint;
    const identity = `${item.candidate.orderNumber}|${item.candidate.signCode}`;
    if (!byIdentity.has(identity)) byIdentity.set(identity, new Set());
    byIdentity.get(identity).add(fingerprint);
    item.fingerprint = fingerprint;
  }
  const conflict = [...byIdentity.values()].some(values => values.size > 1);
  const capReasons = curbState === 'SUPPORTED' ? [] : [`curb_identity_${String(curbState).toLowerCase()}`];
  const associationReasons = conflict
    ? ['conflicting_cleaning_rules', ...capReasons]
    : [...face.reasons, ...capReasons];

  const grouped = new Map();
  for (const item of classified) {
    if (!grouped.has(item.fingerprint)) grouped.set(item.fingerprint, []);
    grouped.get(item.fingerprint).push(item);
  }
  const associationState = capAssociationState(face.state, curbState);
  const rules = [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([fingerprint, items]) => ({
    regulationId: `dot-cleaning:${fingerprint}`,
    type: 'CLEANING',
    source: 'nyc_dot_signs',
    sourceVersion: { ...input.candidateSnapshot.sourceVersion },
    associationState: conflict ? 'UNKNOWN' : associationState,
    reasonCodes: [...associationReasons],
    applicability: face.applicability,
    schedules: [items[0].result.schedule],
    fingerprint,
    vehicleApplicability: null,
    meterTerms: null,
    provenance: items.map(item => ({
      orderNumber: item.candidate.orderNumber,
      signCode: item.candidate.signCode,
      identityKind: item.result.evidence.identityKind,
      exceptionTableVersion: item.result.evidence.exceptionTableVersion,
    })),
    rawEvidence: { ...items[0].result.evidence },
  }));
  const combined = createCleaningFingerprint(rules.flatMap(rule => rule.schedules));
  return {
    rules,
    fingerprint: combined.ok ? combined.fingerprint : null,
    confidence: conflict ? 'UNKNOWN' : associationState,
    reasons: [...associationReasons],
  };
}

module.exports = { associateCleaningRules };
