'use strict';

// Default-disabled source context.
// Retention does not select a cross street.
// Shadow enrichment can supply a validated diagnostic pair to buildCandidate.
// It does not read the environment or grant certification or topology authority.

const { diagnoseIncidentCrossStreets } = require('./incidentCrossStreetDiagnostic');

const RETENTION_MODE = 'retain-uncertified';
const ENRICHMENT_MODE = 'shadow-uncertified-context';
const SHADOW_EVALUATION = 'offline-shadow';
const SERVER_OWNER = Symbol('parqueen-server-source-evidence');
const retainedContexts = new WeakMap();
const SELECTION_FIELDS = Object.freeze([
  'from_street',
  'to_street',
  'selectedFromStreet',
  'selectedToStreet',
  'preferredName',
  'aliasSelection',
]);

function population(values) {
  if (!Array.isArray(values) || values.length === 0) return null;
  if (values.some(value => typeof value !== 'string' || value.length === 0)) return null;
  return Object.freeze(values.slice());
}

function closed(reason, certificationStatus) {
  return Object.freeze({
    retained: false,
    selectedCrossStreet: null,
    certificationStatus,
    identities: null,
    fromNodeNames: null,
    toNodeNames: null,
    csclFromStreet: null,
    csclToStreet: null,
    reason,
  });
}

function evaluate(materialRanked, packet) {
  const certificationStatus = packet?.provenance?.certificationStatus ?? null;
  if (!packet || certificationStatus !== 'NOT_CERTIFIED' || typeof packet?.provenance?.source !== 'string'
    || packet.provenance.source.length === 0) {
    return closed('source_certification_refused', certificationStatus);
  }
  if (SELECTION_FIELDS.some(field => packet[field] != null)) {
    return closed('cross_street_selection_refused', 'NOT_CERTIFIED');
  }

  const segment = packet.segment;
  const ranked = materialRanked.length === 1 ? materialRanked[0] : null;
  const record = ranked?.best;
  const native = record?.sourceNative || {};
  const segmentConsistent = segment
    && segment.physicalId != null
    && segment.segmentId != null
    && segment.nodeIdFrom != null
    && segment.nodeIdTo != null
    && String(native.physicalid) === String(segment.physicalId)
    && String(record.leftBlockFaceId) === String(segment.leftBlockFaceId)
    && String(record.rightBlockFaceId) === String(segment.rightBlockFaceId)
    && (!Array.isArray(packet.segments)
      || (packet.segments.length === 1
        && String(packet.segments[0]?.segmentId) === String(segment.segmentId)
        && String(packet.segments[0]?.physicalId) === String(segment.physicalId)));
  if (!segmentConsistent) return closed('conflicting_segment_evidence', 'NOT_CERTIFIED');

  const fromNodeNames = population(packet.fromNodeNames);
  const toNodeNames = population(packet.toNodeNames);
  if (!fromNodeNames || !toNodeNames) return closed('missing_cross_street_evidence', 'NOT_CERTIFIED');

  const identities = Object.freeze({
    physicalId: String(segment.physicalId),
    segmentId: String(segment.segmentId),
    nodeIdFrom: String(segment.nodeIdFrom),
    nodeIdTo: String(segment.nodeIdTo),
    leftBlockFaceId: String(segment.leftBlockFaceId),
    rightBlockFaceId: String(segment.rightBlockFaceId),
    provenance: Object.freeze({
      certificationStatus: 'NOT_CERTIFIED',
      source: packet.provenance.source,
    }),
  });
  const context = Object.freeze({
    retained: true,
    selectedCrossStreet: null,
    certificationStatus: 'NOT_CERTIFIED',
    identities,
    fromNodeNames,
    toNodeNames,
    csclFromStreet: native.from_street ?? null,
    csclToStreet: native.to_street ?? null,
    reason: fromNodeNames.length === 1 && toNodeNames.length === 1
      ? 'cross_street_not_authoritative'
      : 'ambiguous_source_names',
  });
  retainedContexts.set(record, context);
  return context;
}

function observePrivateSourceContext(materialRanked, options, identityReason) {
  const report = Object.freeze({
    ...evaluate(materialRanked, options.privateSourceContext),
    identityReason: identityReason || null,
  });
  if (typeof options.privateSourceContextObserver === 'function') {
    options.privateSourceContextObserver(report);
  }
  return report;
}

function readRetainedSourceContext(record) {
  return retainedContexts.get(record) || null;
}

const INJECTED_STREETS = Object.freeze([
  'from_street', 'to_street', 'fromStreet', 'toStreet',
  'fromStreetCandidate', 'toStreetCandidate', 'selectedFromStreet', 'selectedToStreet',
]);

function evidenceFailure(reason) {
  return Object.freeze({
    ok: false,
    reason,
    owner: SERVER_OWNER,
    streetContextFor() {
      return Object.freeze({ ok: false, reason });
    },
  });
}

function canonicalPhysicalIdentity(value) {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!text) return '';
  if (!/^\d{1,10}$/.test(text)) return text;
  return text.replace(/^0+/, '') || '0';
}

function bindServerSourceEvidence(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return evidenceFailure('missing_provenance');
  const byPhysical = new Map();
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return evidenceFailure('missing_provenance');
    if (entry.provenance?.certificationStatus !== 'NOT_CERTIFIED'
      || typeof entry.provenance?.source !== 'string' || entry.provenance.source.length === 0
      || typeof entry.leftBlockFaceId !== 'string' || typeof entry.rightBlockFaceId !== 'string') {
      return evidenceFailure(entry?.provenance?.certificationStatus === 'CERTIFIED'
        ? 'source_certification_refused' : 'missing_provenance');
    }
    if (entry.topologyApproved === true || entry.productionAuthoritative === true
      || entry.canonicalSupported === true) {
      return evidenceFailure('unverified_source_ownership');
    }
    if (INJECTED_STREETS.some(field => entry[field] != null)) {
      return evidenceFailure('cross_street_selection_refused');
    }
    const diagnostic = diagnoseIncidentCrossStreets(entry);
    const physicalId = diagnostic.onStreet?.physicalId;
    if (!diagnostic.fromStreetCandidate || !diagnostic.toStreetCandidate || physicalId == null
      || diagnostic.certificationStatus !== 'NOT_CERTIFIED' || diagnostic.canonicalSupported !== false
      || diagnostic.productionAuthoritative !== false || diagnostic.side !== null) {
      return evidenceFailure(diagnostic.reason || 'unverified_source_ownership');
    }
    const key = canonicalPhysicalIdentity(physicalId);
    if (!key || byPhysical.has(key)) return evidenceFailure('incompatible_source_pairs');
    byPhysical.set(key, Object.freeze({
      leftBlockFaceId: entry.leftBlockFaceId,
      rightBlockFaceId: entry.rightBlockFaceId,
      context: Object.freeze({
        ok: true,
        fromStreet: diagnostic.fromStreetCandidate,
        toStreet: diagnostic.toStreetCandidate,
        physicalId: key,
        segmentId: diagnostic.onStreet.segmentId,
        certificationStatus: 'NOT_CERTIFIED',
        canonicalSupported: false,
        productionAuthoritative: false,
        topologyApproved: false,
        side: null,
        provenance: diagnostic.provenance,
        fromNode: diagnostic.fromNode,
        toNode: diagnostic.toNode,
        gradeSeparation: diagnostic.gradeSeparation,
      }),
    }));
  }
  return Object.freeze({
    ok: true,
    owner: SERVER_OWNER,
    streetContextFor(record) {
      const key = canonicalPhysicalIdentity(record?.sourceNative?.physicalid);
      const entry = byPhysical.get(key);
      if (!entry) return Object.freeze({ ok: false, reason: 'missing_provenance' });
      if (String(record.leftBlockFaceId) !== entry.leftBlockFaceId
        || String(record.rightBlockFaceId) !== entry.rightBlockFaceId) {
        return Object.freeze({ ok: false, reason: 'conflicting_segment_evidence' });
      }
      return entry.context;
    },
  });
}

function readServerSourceEvidence(value) {
  return value?.owner === SERVER_OWNER ? value : null;
}

function sealServerSourceFailure(reason) {
  return evidenceFailure(reason);
}

function pendingReleaseAdmission(value) {
  return Boolean(value)
    && value.policyVersion === 'successor-release-candidate-1'
    && value.editionReconciled === true
    && value.releaseCandidate === 'ELIGIBLE_PENDING_OWNER_APPROVAL'
    && value.sourceCertification === 'NOT_CERTIFIED'
    && value.topologyAuthority === 'UNRESOLVED'
    && value.driverSideAuthority === 'ABSENT'
    && value.nativeBlockfaceProof === 'NOT_INVOKED'
    && value.active === false
    && value.ownerApproval === 'PENDING';
}

const AMBIGUOUS_IDENTITY_REASONS = new Set([
  'ambiguous_street_code',
  'conflicting_segment_street',
  'contradictory_node_order',
  'duplicate_cscl_physical_id',
  'duplicate_lion_segment',
  'unresolved_source_identity',
]);

function authoritativeOutcomeIndex(outcomes) {
  if (outcomes == null) return { mode: 'absent' };
  if (outcomes.representation !== 'physical-id-reason-v1'
    || !Array.isArray(outcomes.entries)
    || outcomes.rejectedIdentityCount !== outcomes.entries.length) {
    return { mode: 'invalid' };
  }
  const byId = new Map();
  for (const entry of outcomes.entries) {
    if (!Array.isArray(entry) || entry.length !== 2
      || typeof entry[1] !== 'string' || entry[1].length === 0) {
      return { mode: 'invalid' };
    }
    const id = canonicalPhysicalIdentity(entry[0]);
    if (!id || byId.has(id)) return { mode: 'invalid' };
    byId.set(id, entry[1]);
  }
  return { mode: 'closed', byId };
}

function closedContext(reason, disposition) {
  return Object.freeze({ ok: false, disposition, reason });
}

function uncoveredContext(index, key) {
  if (index.mode === 'absent') return closedContext('unverified_legacy_provenance', 'missing');
  if (index.mode !== 'closed') return closedContext('incomplete_authoritative_outcomes', 'missing');
  const reason = index.byId.get(key);
  if (!reason) return closedContext('identity_not_in_authoritative_source', 'missing');
  return closedContext(reason, AMBIGUOUS_IDENTITY_REASONS.has(reason) ? 'ambiguous' : 'rejected');
}

function coverServerSourceEvidence(bound, physicalIds, admission, outcomes) {
  if (bound?.owner !== SERVER_OWNER || !Array.isArray(physicalIds) || physicalIds.length === 0) {
    return evidenceFailure('unverified_source_ownership');
  }
  if (arguments.length > 2 && !pendingReleaseAdmission(admission)) {
    return evidenceFailure('conflicting_source_version');
  }
  const index = authoritativeOutcomeIndex(outcomes);
  if (outcomes != null && index.mode !== 'closed') {
    return evidenceFailure('incomplete_authoritative_outcomes');
  }
  const covered = new Set();
  for (const value of physicalIds) {
    const key = canonicalPhysicalIdentity(value);
    if (!key || covered.has(key)) return evidenceFailure('contradictory_authoritative_outcomes');
    if (index.mode === 'closed' && index.byId.has(key)) {
      return evidenceFailure('contradictory_authoritative_outcomes');
    }
    covered.add(key);
  }
  return Object.freeze({
    ok: bound.ok === true,
    owner: SERVER_OWNER,
    reason: bound.reason || null,
    authoritativeOutcomes: index.mode,
    ...(arguments.length > 2 ? { sourceAdmission: Object.freeze({ ...admission }) } : {}),
    streetContextFor(record) {
      if (bound.ok !== true) return Object.freeze({ ok: false, reason: bound.reason || 'artifact_corrupt' });
      const key = canonicalPhysicalIdentity(record?.sourceNative?.physicalid);
      if (!key || !covered.has(key)) return uncoveredContext(index, key);
      return bound.streetContextFor(record);
    },
  });
}

module.exports = {
  RETENTION_MODE,
  ENRICHMENT_MODE,
  SHADOW_EVALUATION,
  observePrivateSourceContext,
  readRetainedSourceContext,
  bindServerSourceEvidence,
  readServerSourceEvidence,
  sealServerSourceFailure,
  coverServerSourceEvidence,
};
