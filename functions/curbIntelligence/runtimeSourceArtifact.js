'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const {
  ENRICHMENT_MODE,
  SHADOW_EVALUATION,
  bindServerSourceEvidence,
  readServerSourceEvidence,
  sealServerSourceFailure,
  coverServerSourceEvidence,
} = require('./privateSourceContextRetention');
const {
  FROZEN_READINESS_POLICY,
  SUCCESSOR_POLICY_VERSION,
  evaluateSuccessorRelease,
  recordedSuccessorObservation,
} = require('./successorReleasePolicy');
const {
  deploymentPilotEnabled,
  readDeploymentPilotPrincipal,
  ownerPilotAllows,
  readPilotAllowlistDocument,
  validatePilotAllowlist,
  applyPilotAllowlist,
} = require('./pilotSourceLoading');
const { expandCoverageRecords } = require('./pilotArtifactRecords');

const PACKAGED_ARTIFACT_PATH = path.join(__dirname, 'pilot-runtime', 'runtime-source-artifact.json');
const ARTIFACT_PATH = path.join(__dirname, '..', '..', 'data', 'runtime-source', 'runtime-source-artifact.json');
const MAX_ARTIFACT_BYTES = 80 * 1024 * 1024;
const MAX_RECORD_SEGMENTS = 64;
const MAX_RECORD_SND_ROWS = 64;
const PINNED_ARTIFACT_SHA256 = '3f94b76f9ac710526ee035edb2a5c186451bac31073e4f5a29271dbc1109b6a7';
const PINNED_ARTIFACT_RECORD_COUNT = 42124;
const EXCLUSION_BUCKETS = Object.freeze([
  'missing_node', 'missing_snd', 'conflicting_code', 'geometry_direction', 'blockface_mismatch', 'other',
]);
const PINNED_SOURCES = Object.freeze({
  lion: Object.freeze({
    sha256: '14a2514303f0c53419cdc370bfd851db41dec038450b88b19d0897a35dad0660',
    byteLength: 45981902,
    edition: '26B',
  }),
  snd: Object.freeze({
    sha256: '545e3d7145f397f92cf251a63505ae668658a72ef68f8c0465b0a8e6d599f470',
    byteLength: 2966071,
    edition: '26B',
  }),
  cscl: Object.freeze({
    sha256: 'c268891fb36135e99577f4d2b428eae6d664641ffe64bf5d0b2c4c4af40cc0af',
    byteLength: 196959978,
  }),
});

const sameJson = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function sourceMatches(actual, pinned) {
  return Boolean(actual)
    && actual.sha256 === pinned.sha256
    && actual.byteLength === pinned.byteLength
    && (pinned.edition === undefined || actual.edition === pinned.edition);
}

function exclusionTotal(manifest) {
  if (!manifest?.exclusions) return null;
  let total = 0;
  for (const bucket of EXCLUSION_BUCKETS) {
    const count = manifest.exclusions[bucket];
    if (!Number.isInteger(count) || count < 0) return null;
    total += count;
  }
  return total;
}

function coverageComplete(manifest) {
  const excluded = exclusionTotal(manifest);
  return excluded === 0
    && Number.isInteger(manifest?.examined)
    && manifest.examined > 0
    && manifest.unambiguousPairs === manifest.examined;
}

function buildSuccessorRelease(manifest) {
  const evaluated = evaluateSuccessorRelease(recordedSuccessorObservation());
  const eligible = evaluated.sourceEditionReconciled === true && evaluated.publishedLionEdition === '26B';
  return {
    policyVersion: SUCCESSOR_POLICY_VERSION,
    frozenReadinessPolicy: FROZEN_READINESS_POLICY,
    active: false,
    ownerApproval: 'PENDING',
    coverage: 'IDENTIFIED_CROSS_STREET_PAIRS',
    citywide: coverageComplete(manifest),
    observation: recordedSuccessorObservation(),
    csclAssociation: {
      sha256: PINNED_SOURCES.cscl.sha256,
      byteLength: PINNED_SOURCES.cscl.byteLength,
    },
    decision: {
      policyVersion: SUCCESSOR_POLICY_VERSION,
      editionReconciled: eligible,
      publishedLionEdition: evaluated.publishedLionEdition,
      pdfTitle: evaluated.pdfTitle,
      pdfTitleConflictPreserved: evaluated.pdfTitleConflictPreserved === true,
      releaseCandidate: eligible ? 'ELIGIBLE_PENDING_OWNER_APPROVAL' : 'NOT_ELIGIBLE',
      sourceCertification: 'NOT_CERTIFIED',
      topologyAuthority: 'UNRESOLVED',
      driverSideAuthority: 'ABSENT',
      nativeBlockfaceProof: 'NOT_INVOKED',
      active: false,
      ownerApproval: 'PENDING',
      unresolvedDependencies: [
        'OWNER_APPROVAL',
        'SOURCE_CERTIFICATION',
        'GEOSUPPORT_COMPATIBILITY',
        'TOPOLOGY_AUTHORITY',
        'DRIVER_SIDE_AUTHORITY',
        'NATIVE_BLOCKFACE_PROOF',
      ],
    },
    generation: { method: 'citywide-cross-street-coverage-1' },
  };
}

function manifestAgrees(document) {
  const manifest = document.coverageManifest;
  const excluded = exclusionTotal(manifest);
  if (!manifest || excluded == null || !Number.isInteger(manifest.examined) || manifest.examined < 1
    || !Number.isInteger(manifest.matchedPhysicalIds) || manifest.matchedPhysicalIds < 0
    || !Number.isInteger(manifest.unambiguousPairs)
    || manifest.unambiguousPairs !== document.records.length
    || excluded + manifest.unambiguousPairs !== manifest.examined
    || manifest.eligibleCoverageBasisPoints !== Math.round(manifest.unambiguousPairs * 1000000 / manifest.examined)
    || manifest.coverage !== 'IDENTIFIED_CROSS_STREET_PAIRS'
    || manifest.citywide !== coverageComplete(manifest)
    || document.coverage !== manifest.coverage
    || document.citywide !== manifest.citywide
    || !manifest.exclusionDetails || typeof manifest.exclusionDetails !== 'object'
    || !Array.isArray(manifest.rejectionSamples)) {
    return false;
  }
  const detailTotal = Object.values(manifest.exclusionDetails)
    .reduce((sum, count) => sum + (Number.isInteger(count) ? count : Number.NaN), 0);
  if (detailTotal !== excluded) return false;
  const covered = new Set(document.records.map(record => String(record?.onStreet?.physicalId ?? record?.physicalId)));
  return manifest.rejectionSamples.every(sample => sample
    && EXCLUSION_BUCKETS.includes(sample.bucket)
    && typeof sample.reason === 'string'
    && manifest.exclusionDetails[sample.reason] > 0
    && !covered.has(String(sample.physicalId)));
}

function relationshipsAgree(record, context) {
  const incidentIds = [...(context?.fromNode?.segmentIds || []), ...(context?.toNode?.segmentIds || [])].sort();
  const declaredIds = [...(record.incidentSegmentIds || [])].sort();
  return Boolean(context?.ok)
    && context.fromStreet === record.primaryNames?.fromStreet
    && context.toStreet === record.primaryNames?.toStreet
    && context.segmentId === record.onStreet?.segmentId
    && context.certificationStatus === 'NOT_CERTIFIED'
    && context.side === null
    && sameJson(context.fromNode.secondaryNames, record.ambiguities?.secondaryNames?.from)
    && sameJson(context.toNode.secondaryNames, record.ambiguities?.secondaryNames?.to)
    && sameJson(context.fromNode.nodeNames, record.originalNames?.from)
    && sameJson(context.toNode.nodeNames, record.originalNames?.to)
    && sameJson(incidentIds, declaredIds);
}

function freezeValue(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  for (const child of Object.values(value)) freezeValue(child, seen);
  Object.freeze(value);
}

function grantLegacyLookup(evidence) {
  const trusted = readServerSourceEvidence(evidence);
  if (!trusted || trusted.ok !== true || trusted.authoritativeOutcomes !== 'absent') return evidence;
  return Object.freeze({
    ok: true,
    owner: trusted.owner,
    reason: trusted.reason,
    sourceAdmission: trusted.sourceAdmission,
    authoritativeOutcomes: 'legacy',
    streetContextFor(record) {
      const inner = trusted.streetContextFor(record);
      if (inner && inner.reason === 'unverified_legacy_provenance') return null;
      return inner;
    },
  });
}

function reviewRuntimeArtifactDocument(document) {
  return reviewParsedArtifact(document, false);
}

function reviewParsedArtifact(document, trustedArtifact) {
  if (!document || typeof document !== 'object' || Array.isArray(document)
    || document.schemaVersion !== 2 || !Array.isArray(document.records) || document.records.length === 0) {
    return sealServerSourceFailure('artifact_corrupt');
  }
  const records = expandCoverageRecords(document);
  if (!records) return sealServerSourceFailure('artifact_corrupt');
  const battery = records.find(record => String(record?.onStreet?.physicalId) === '5');
  const versionsConflict = document.certificationStatus !== 'NOT_CERTIFIED'
    || document.releaseCertification !== 'BLOCKED'
    || document.productionAuthoritative !== false
    || document.topologyApproved !== false
    || document.canonicalSupported !== false
    || document.editions?.lionPackage !== PINNED_SOURCES.lion.edition
    || document.editions?.sndPackage !== PINNED_SOURCES.snd.edition
    || document.editions?.pdfPageCitation !== '26B'
    || document.editions?.pdfTitle !== '26C'
    || document.editions?.pageCitationIsReadinessAuthority !== false
    || document.editions?.readinessMetadataAuthority !== 'PDF_INFO_XMP_TITLE'
    || !sourceMatches(document.sources?.lion, PINNED_SOURCES.lion)
    || !sourceMatches(document.sources?.snd, PINNED_SOURCES.snd)
    || !sourceMatches(document.sources?.cscl, PINNED_SOURCES.cscl)
    || !manifestAgrees(document)
    || !sameJson(document.successorRelease, buildSuccessorRelease(document.coverageManifest))
    || battery?.lionRelease !== PINNED_SOURCES.lion.edition
    || battery?.sndRelease !== PINNED_SOURCES.snd.edition
    || battery?.onStreet?.segmentId !== '0018126'
    || battery?.leftBlockFaceId !== '1222600642'
    || battery?.rightBlockFaceId !== '1222604562';
  if (versionsConflict) return sealServerSourceFailure('conflicting_source_version');
  for (const record of records) {
    if (record?.lionRelease !== PINNED_SOURCES.lion.edition || record?.sndRelease !== PINNED_SOURCES.snd.edition
      || !Array.isArray(record.segments) || record.segments.length === 0 || record.segments.length > MAX_RECORD_SEGMENTS
      || !Array.isArray(record.sndRows) || record.sndRows.length === 0 || record.sndRows.length > MAX_RECORD_SND_ROWS) {
      return sealServerSourceFailure('artifact_corrupt');
    }
  }

  const bound = bindServerSourceEvidence(records);
  if (bound.ok !== true) return bound;
  for (const record of records) {
    const context = bound.streetContextFor({
      sourceNative: { physicalid: record.onStreet.physicalId },
      leftBlockFaceId: record.leftBlockFaceId,
      rightBlockFaceId: record.rightBlockFaceId,
    });
    if (!relationshipsAgree(record, context)) return sealServerSourceFailure('ambiguous_source_relationship');
  }
  const batteryContext = bound.streetContextFor({
    sourceNative: { physicalid: '5' },
    leftBlockFaceId: battery.leftBlockFaceId,
    rightBlockFaceId: battery.rightBlockFaceId,
  });
  if (batteryContext?.fromStreet !== '2 PLACE' || batteryContext?.toStreet !== '3 PLACE'
    || batteryContext?.segmentId !== '0018126') {
    return sealServerSourceFailure('ambiguous_source_relationship');
  }
  if (trustedArtifact !== true) return sealServerSourceFailure('unverified_artifact_provenance');
  const covered = coverServerSourceEvidence(
    bound,
    records.map(record => record.onStreet.physicalId),
    document.successorRelease.decision,
    document.coverageManifest?.authoritativeOutcomes,
  );
  if (covered.ok !== true) return covered;
  if (document.coverageManifest?.authoritativeOutcomes == null) return grantLegacyLookup(covered);
  return covered;
}

function openRuntimeSourceArtifact(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_ARTIFACT_BYTES) {
    return sealServerSourceFailure('artifact_corrupt');
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== PINNED_ARTIFACT_SHA256) return sealServerSourceFailure('artifact_digest_mismatch');
  let document;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch {
    return sealServerSourceFailure('artifact_corrupt');
  }
  freezeValue(document);
  return reviewParsedArtifact(document, true);
}

function resolveRuntimeArtifactPath() {
  if (fs.existsSync(PACKAGED_ARTIFACT_PATH)) return PACKAGED_ARTIFACT_PATH;
  return ARTIFACT_PATH;
}

function loadPinnedRuntimeArtifact() {
  let bytes;
  try {
    bytes = fs.readFileSync(resolveRuntimeArtifactPath());
  } catch {
    return sealServerSourceFailure('artifact_missing');
  }
  return openRuntimeSourceArtifact(bytes);
}

let deploymentPilotLoad = null;

function loadDeploymentPilot(document) {
  const validation = validatePilotAllowlist(document);
  if (!validation.ok || validation.document.restrictPhysicalIds !== true) {
    return sealServerSourceFailure('pilot_allowlist_closed');
  }
  const key = `restricted:${validation.document.physicalIds.join(',')}`;
  if (deploymentPilotLoad) {
    if (deploymentPilotLoad.key !== key) return sealServerSourceFailure('pilot_configuration_conflict');
    return deploymentPilotLoad.evidence;
  }
  const evidence = applyPilotAllowlist(loadPinnedRuntimeArtifact(), validation.document);
  if (evidence?.ok !== true) return evidence;
  deploymentPilotLoad = { key, evidence };
  return evidence;
}

function sourceDependencies(evidence) {
  return {
    privateSourceContextEnrichment: ENRICHMENT_MODE,
    evaluationScope: SHADOW_EVALUATION,
    privateSourceEvidence: evidence,
  };
}

function localRuntimeDependencies() {
  if (process.env.FUNCTIONS_EMULATOR !== 'true') return {};
  return sourceDependencies(loadPinnedRuntimeArtifact());
}

function pilotRuntimeDependencies(verifiedUid) {
  if (!deploymentPilotEnabled() || typeof verifiedUid !== 'string') return {};
  const allowlist = readPilotAllowlistDocument();
  if (!allowlist.ok || !ownerPilotAllows({
    enabled: true,
    verifiedUid,
    principal: readDeploymentPilotPrincipal(process.env),
    coverage: allowlist.document,
  })) return {};
  const evidence = loadDeploymentPilot(allowlist.document);
  if (evidence?.ok !== true) return {};
  return sourceDependencies(evidence);
}

function attachOwnerPilot(dependencies, verifiedUid) {
  const pilot = pilotRuntimeDependencies(verifiedUid);
  if (pilot.privateSourceEvidence?.ok === true) {
    Object.assign(dependencies, pilot);
    return pilot;
  }
  try {
    dependencies?.telemetry?.emit?.('curb_pilot_diagnostic', {
      protocolVersion: 2,
      pilotStage: 'pilot_closed',
    });
  } catch { /* diagnostic logging is fail-soft */ }
  return {};
}

const SIMULATION_OWNER = 'parqueen-server-pilot';
const REJECTED_SIMULATION_FIELDS = Object.freeze([
  'artifactPath', 'mode', 'ownerApproval', 'certificationStatus',
  'sourceCertification', 'successorPolicy', 'sourcePath', 'uid', 'auth', 'appCheckToken',
]);

function simulateDeploymentPilot(authorization) {
  if (arguments.length !== 1 || !authorization || typeof authorization !== 'object' || Array.isArray(authorization)) {
    return {};
  }
  if (authorization.deploymentOwner !== SIMULATION_OWNER || authorization.enabled !== true) return {};
  if (REJECTED_SIMULATION_FIELDS.some(field => Object.prototype.hasOwnProperty.call(authorization, field))) {
    return {};
  }
  const coverage = validatePilotAllowlist({
    restrictPhysicalIds: authorization.restrictPhysicalIds === true,
    physicalIds: authorization.physicalIds,
  });
  if (!coverage.ok || !ownerPilotAllows({
    enabled: true,
    verifiedUid: authorization.verifiedUid,
    principal: authorization.principal,
    coverage: coverage.document,
  })) return {};
  const evidence = loadDeploymentPilot(coverage.document);
  if (evidence?.ok !== true) return {};
  return sourceDependencies(evidence);
}

module.exports = {
  ARTIFACT_PATH,
  PACKAGED_ARTIFACT_PATH,
  resolveRuntimeArtifactPath,
  MAX_ARTIFACT_BYTES,
  PINNED_ARTIFACT_SHA256,
  PINNED_ARTIFACT_RECORD_COUNT,
  PINNED_SOURCES,
  loadPinnedRuntimeArtifact,
  openRuntimeSourceArtifact,
  reviewRuntimeArtifactDocument,
  buildSuccessorRelease,
  localRuntimeDependencies,
  pilotRuntimeDependencies,
  attachOwnerPilot,
  simulateDeploymentPilot,
};
