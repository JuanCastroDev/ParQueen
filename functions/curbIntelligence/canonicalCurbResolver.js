'use strict';

const { createHash } = require('node:crypto');
const { classifyCanonicalCurb, CURB_RESOLUTION_POLICY } = require('./curbResolutionPolicy');
const {
  createCanonicalCurbIdentity,
  createCandidateToken,
  publicCurbKey,
  toPublicCurb,
} = require('./canonicalCurbIdentity');
const { rankRoadwayCandidates } = require('./geometry');
const { groupRoadwayCandidates } = require('./roadwayGrouping');
const { resolveOfficialCurbRuntime } = require('./runtimeCurbResolution');
const { searchPolicy } = require('./curbResolver');
const { createCsclCandidateStore } = require('./csclSocrataAdapter');
const { buildCanonicalCsclPopulation } = require('./csclPopulationIdentity');
const { deepFreeze } = require('./canonicalSearchEnvelope');
const {
  RETENTION_MODE,
  ENRICHMENT_MODE,
  SHADOW_EVALUATION,
  observePrivateSourceContext,
  readServerSourceEvidence,
} = require('./privateSourceContextRetention');
const { readOfficialLionPrimary } = require('./officialLionPrimaryTopology');
const {
  consistentOfficialFaces,
  firstSideConfirmationEligibilityFailure,
  drivingChoices,
  orientationForTangent,
  stableSideAuthorityDigest,
} = require('./sideConfirmation');
const { issueSideConfirmationToken } = require('./sideConfirmationToken');
const { createDemoResolutionTrace } = require('./demoResolutionDiagnostic');
const { OVERALL_DEADLINE_MS, childBudgetMs } = require('./requestDeadline');

const NYC = Object.freeze({ minLat: 40.4, maxLat: 40.95, minLng: -74.3, maxLng: -73.65 });
const BOROUGHS = Object.freeze({
  1: 'Manhattan', 2: 'Bronx', 3: 'Brooklyn', 4: 'Queens', 5: 'Staten Island',
});
const privateCandidateSets = new WeakMap();
const authoritativeRetrievals = new WeakSet();
const retrievalBindings = new WeakMap();
// Independent 15s CSCL budget removed. Acquisition shares the 8s end-to-end deadline.
const CSCL_SOURCE_BUDGET_MS = OVERALL_DEADLINE_MS;
const primaryTopologyResults = new WeakSet();
const ambiguousTopologyResults = new WeakSet();
const sideConfirmationResults = new WeakSet();
const sideConfirmationAuthorities = new WeakMap();

const unsupported = (reasons, diagnostics = {}) => ({
  state: 'UNSUPPORTED',
  reasons: [...new Set(reasons)],
  ...diagnostics,
});

function emitPilotStage(telemetry, pilotStage) {
  try {
    telemetry?.emit?.('curb_pilot_diagnostic', { protocolVersion: 2, pilotStage });
  } catch { /* diagnostic logging is fail-soft */ }
}

function locationQuality(location) {
  return classifyCanonicalCurb({
    reportedAccuracyMeters: location?.accuracyMeters,
    sampleCount: location?.sampleCount,
    consistencyMeters: location?.consistencyMeters,
    selectedBlockFaceId: '0000000001',
    candidateSetComplete: true,
    sourceVersionConsistent: true,
    roadwaySupported: true,
    geometryPlausible: true,
    projectedWithinBounds: true,
    levelOrRoadbedAmbiguous: false,
    streetIdentityConflict: false,
    sideCrossesCenterline: false,
    roadwayIntervalsOverlap: false,
    endpointAmbiguous: false,
    actionableCandidates: [{ visuallyDistinct: true }],
  });
}

function validLocation(location) {
  return Number.isFinite(location?.lat) && location.lat >= NYC.minLat && location.lat <= NYC.maxLat
    && Number.isFinite(location?.lng) && location.lng >= NYC.minLng && location.lng <= NYC.maxLng;
}

function rankGroups(location, records) {
  return groupRoadwayCandidates(records).map(group => {
    const ranked = rankRoadwayCandidates(location, group.records.map(record => ({
      ...record,
      coordinates: record.geometry?.coordinates,
    })));
    return ranked.length ? { group, best: ranked[0] } : null;
  }).filter(Boolean).sort((left, right) => (
    left.best.projection.distanceMeters - right.best.projection.distanceMeters
  ));
}

const sourceVersionKey = record => `${record?.sourceVersion?.resourceId || ''}:${record?.sourceVersion?.version || ''}`;
const levelSignature = record => `${record?.sourceNative?.from_level_code || ''}|${record?.sourceNative?.to_level_code || ''}`;

function roadwaySupported(record) {
  const status = String(record?.sourceNative?.status ?? '').trim();
  const nonped = String(record?.sourceNative?.nonped ?? '').trim().toUpperCase();
  const accessible = String(record?.sourceNative?.accessible ?? '').trim().toUpperCase();
  return status === '2'
    && (!nonped || nonped === 'D')
    && !['N', 'NO', '0', 'FALSE'].includes(accessible);
}

function cardinalSide(projection) {
  const { eastMeters, northMeters } = projection.tangent;
  const left = { east: -northMeters, north: eastMeters };
  const vector = projection.csclSide === 'LEFT'
    ? left : { east: -left.east, north: -left.north };
  if (Math.abs(vector.north) >= Math.abs(vector.east)) return vector.north >= 0 ? 'North' : 'South';
  return vector.east >= 0 ? 'East' : 'West';
}

function identityRows(records) {
  return records.map(record => ({
    ...(record.sourceNative || {}),
    globalid: record.sourceNative?.globalid || record.globalId,
    physicalid: record.sourceNative?.physicalid || null,
    b5sc: record.sourceNative?.b5sc || null,
    l_blockfaceid: record.leftBlockFaceId,
    r_blockfaceid: record.rightBlockFaceId,
    sourceVersion: record.sourceVersion,
  }));
}

function shadowSourceEvidence(options) {
  if (options.privateSourceContextEnrichment !== ENRICHMENT_MODE) return null;
  if (options.evaluationScope !== SHADOW_EVALUATION) {
    return { streetContextFor: () => ({ ok: false, reason: 'unverified_source_ownership' }) };
  }
  const bound = readServerSourceEvidence(options.privateSourceEvidence);
  if (!bound) return { streetContextFor: () => ({ ok: false, reason: 'unverified_source_ownership' }) };
  if (bound.ok === false) {
    return { streetContextFor: () => ({ ok: false, reason: bound.reason || 'unverified_source_ownership' }) };
  }
  return bound;
}

function buildCandidate(rankedGroup, context) {
  const identityFailure = context?.identityFailure;
  const record = rankedGroup.best;
  const projection = record.projection;
  if (projection.csclSide !== 'LEFT' && projection.csclSide !== 'RIGHT') {
    if (identityFailure && identityFailure.reason == null) identityFailure.reason = 'invalid_cscl_side';
    return null;
  }
  const native = record.sourceNative || {};
  const primary = context?.officialRelationships?.get(record) || null;
  if (primary && primary.ok !== true) {
    if (identityFailure && identityFailure.reason == null) identityFailure.reason = primary.reason;
    return null;
  }
  const supplied = !primary?.ok && context?.evidence ? context.evidence.streetContextFor(record) : null;
  if (supplied && supplied.ok !== true) {
    if (identityFailure && identityFailure.reason == null) identityFailure.reason = supplied.reason;
    return null;
  }
  if (supplied?.ok && identityFailure && identityFailure.enrichment == null) {
    identityFailure.enrichment = supplied;
  }
  const identityResult = createCanonicalCurbIdentity({
    csclRows: identityRows(rankedGroup.group.records),
    csclSide: projection.csclSide,
    sourceVersion: record.sourceVersion,
    selectedGlobalId: record.globalId,
    geometry: record.geometry,
    streetWidthFeet: Number(native.streetwidth),
    borough: BOROUGHS[native.boroughcode] || String(native.boroughcode || '').trim(),
    onStreet: primary?.ok
      ? primary.onStreet
      : (native.full_street_name || native.street_name || native.stname_label),
    fromStreet: primary?.ok ? primary.fromStreet : (supplied?.ok ? supplied.fromStreet : native.from_street),
    toStreet: primary?.ok ? primary.toStreet : (supplied?.ok ? supplied.toStreet : native.to_street),
    aliases: [native.street_name, native.stname_label],
    cardinalSide: cardinalSide(projection),
    resolutionMethod: 'automatic',
  });
  if (!identityResult.ok) {
    if (identityFailure && identityFailure.reason == null) identityFailure.reason = identityResult.reason;
    return null;
  }
  return {
    identity: identityResult.identity,
    projection,
    record,
    group: rankedGroup.group,
    streetName: identityResult.identity.names.onStreet,
    stroke: record.geometry,
    sourceEnrichment: supplied?.ok === true && primary?.ok !== true,
  };
}

function visuallyDistinct(left, right) {
  return left.streetName !== right.streetName
    || JSON.stringify(left.stroke) !== JSON.stringify(right.stroke);
}

function sideIdentity(selected, csclSide, cardinal) {
  const current = selected.identity;
  return createCanonicalCurbIdentity({
    csclRows: identityRows(selected.group.records),
    csclSide,
    sourceVersion: current.sourceVersion,
    selectedGlobalId: current.roadway.selectedGlobalId,
    geometry: current.roadway.geometry,
    streetWidthFeet: current.roadway.streetWidthFeet,
    borough: current.names.borough,
    onStreet: current.names.onStreet,
    fromStreet: current.names.fromStreet,
    toStreet: current.names.toStreet,
    aliases: current.names.aliases,
    cardinalSide: cardinal,
    resolutionMethod: 'automatic',
  });
}

function notifyDemo(input, detail) {
  if (typeof input?.onDemoDiagnostic !== 'function') return;
  try { input.onDemoDiagnostic(detail); } catch { /* diagnostics never change resolution */ }
}

function sideConfirmationResult(input) {
  const orientation = orientationForTangent(input.selected.projection.tangent);
  const faces = consistentOfficialFaces(input.selected.group.records);
  const eligibility = firstSideConfirmationEligibilityFailure({
    enabled: input.enabled,
    consideredCount: input.consideredCount,
    sideCrossesCenterline: input.sideCrossesCenterline,
    endpointAmbiguous: input.endpointAmbiguous,
    levelOrRoadbedAmbiguous: input.levelOrRoadbedAmbiguous,
    topologySelectable: input.topologySelectable,
    sourceEnrichment: input.sourceEnrichment,
    decisionState: input.decision.state,
    decisionReasons: input.decision.reasons,
    faces,
    orientation,
  });
  if (eligibility) {
    const classifier = eligibility === 'classifier_state' || eligibility === 'classifier_reason';
    notifyDemo(input, {
      stage: classifier ? 'classification' : 'side_confirmation_eligibility',
      sideConfirmationEligibility: eligibility,
      internalReason: classifier
        ? (Array.isArray(input.decision?.reasons) ? input.decision.reasons[0] : eligibility)
        : eligibility,
    });
    return null;
  }
  const authorityContextDigest = stableSideAuthorityDigest({
    sourceVersion: input.selected.identity.sourceVersion,
    records: input.selected.group.records,
    faces,
  });
  if (!authorityContextDigest) {
    notifyDemo(input, {
      stage: 'side_confirmation_signing',
      sideConfirmationEligibility: null,
      internalReason: 'signing_authority',
    });
    return null;
  }
  const issuedAt = Number.isSafeInteger(input.nowMs) ? input.nowMs : Date.now();
  let signingFailure = null;
  const built = ['LEFT', 'RIGHT'].map((csclSide, rank) => {
    if (signingFailure) return null;
    const created = sideIdentity(input.selected, csclSide, orientation.sides[csclSide]);
    if (!created.ok || created.identity.officialBlockFaceId !== faces[csclSide]) {
      signingFailure = 'official_face_mismatch';
      return null;
    }
    const key = publicCurbKey(created.identity);
    const token = issueSideConfirmationToken({
      uid: input.callerUid,
      authorityDigest: authorityContextDigest,
      officialBlockFaceId: faces[csclSide],
      publicCurbKey: key,
      csclSide,
      rank,
    }, {
      key: input.hmacKey,
      now: issuedAt,
      nonce: typeof input.nonceForRank === 'function' ? input.nonceForRank(rank) : undefined,
    });
    if (!token) {
      signingFailure = 'signing_authority';
      return null;
    }
    return {
      token,
      cardinal: orientation.sides[csclSide],
      identity: created.identity,
      rank,
      csclSide,
      authorityDigest: authorityContextDigest,
      officialBlockFaceId: faces[csclSide],
      publicCurbKey: key,
    };
  });
  if (built.some(side => !side) || built[0].cardinal === built[1].cardinal || built[0].token === built[1].token) {
    notifyDemo(input, {
      stage: 'side_confirmation_signing',
      sideConfirmationEligibility: null,
      internalReason: signingFailure || 'street_orientation',
    });
    return null;
  }
  const result = deepFreeze({
    state: 'SIDE_CONFIRMATION_REQUIRED',
    reasons: ['side_uncertain'],
    confirmation: {
      streetName: input.selected.streetName,
      orientation: orientation.axis === 'oblique'
        ? { north: 'up', axis: 'oblique', bearingDegrees: orientation.bearingDegrees }
        : { north: 'up', axis: orientation.axis },
      curbs: built.map(side => {
        const curb = { token: side.token, cardinal: side.cardinal };
        const drivingSide = drivingChoices(input.selected.group.records)?.[side.csclSide];
        return drivingSide ? { ...curb, drivingSide } : curb;
      }),
    },
  });
  sideConfirmationResults.add(result);
  sideConfirmationAuthorities.set(result, authorityContextDigest);
  privateCandidateSets.set(result, deepFreeze(built.map(side => ({
    token: side.token,
    identity: side.identity,
    topologySelectable: true,
    rank: side.rank,
    csclSide: side.csclSide,
    authorityDigest: side.authorityDigest,
    officialBlockFaceId: side.officialBlockFaceId,
    publicCurbKey: side.publicCurbKey,
  }))));
  return result;
}

function publicCandidate(candidate, tokenContext, rank, authorityContextDigest) {
  const key = publicCurbKey(candidate.identity);
  return {
    token: createCandidateToken({ publicCurbKey: key, ...tokenContext, rank, authorityContextDigest }),
    streetName: candidate.streetName,
    stroke: candidate.stroke,
  };
}

function attestCompleteRetrieval(retrieved, policy) {
  if (!(retrieved?.completeness?.state === 'COMPLETE'
    && retrieved.envelope === policy.canonicalEnvelope
    && retrieved.envelopeDigest === policy.canonicalEnvelope.digest
    && retrieved.retrievalContractVersion === 'canonical-cscl-intersects-1')) {
    return {
      ok: false,
      reason: retrieved?.completeness?.reason || 'authority_attestation_invalid',
    };
  }
  const population = buildCanonicalCsclPopulation(retrieved.candidates);
  if (!population.ok) return { ok: false, reason: population.reason };
  const attested = deepFreeze({
    ...retrieved,
    candidates: population.candidates,
    populationIdentity: population.populationIdentity,
    populationSchema: population.schema,
  });
  authoritativeRetrievals.add(attested);
  return { ok: true, retrieved: attested };
}

function bindRetrieval(retrieved, nonce) {
  retrievalBindings.set(retrieved, {
    nonce,
    consumed: false,
    envelopeDigest: retrieved.envelopeDigest,
    version: retrieved.sourceVersion?.version ?? null,
    resourceId: retrieved.sourceVersion?.resourceId ?? null,
    populationIdentity: retrieved.populationIdentity,
  });
}

function claimAuthoritativeRetrieval(retrieved, policy, nonce) {
  const binding = retrievalBindings.get(retrieved);
  if (!authoritativeRetrievals.has(retrieved) || !binding || binding.consumed) return false;
  if (typeof nonce !== 'string' || binding.nonce !== nonce) return false;
  if (binding.envelopeDigest !== policy.canonicalEnvelope?.digest) return false;
  if (retrieved.envelopeDigest !== policy.canonicalEnvelope.digest) return false;
  if (binding.populationIdentity !== retrieved.populationIdentity) return false;
  if (binding.version !== (retrieved.sourceVersion?.version ?? null)) return false;
  if (binding.resourceId !== (retrieved.sourceVersion?.resourceId ?? null)) return false;
  binding.consumed = true;
  return true;
}

async function acquireAuthoritativeCscl(location, options = {}) {
  const nonce = options.acquisitionNonce;
  if (typeof nonce !== 'string' || nonce.length < 16 || options.candidateStore) {
    return { ok: false, reasons: ['authority_attestation_invalid'] };
  }
  const controller = new AbortController();
  let settled = false;
  const abortResult = new Promise(resolve => {
    controller.signal.addEventListener('abort', () => {
      if (!settled) resolve({ aborted: true });
    }, { once: true });
  });
  const sourceBudgetMs = childBudgetMs(
    Number.isFinite(options.sourceBudgetMs) ? options.sourceBudgetMs : OVERALL_DEADLINE_MS,
    { deadlineAt: options.deadlineAt, signal: options.signal },
  );
  const timer = setTimeout(() => controller.abort(), sourceBudgetMs);
  const onOuter = () => controller.abort();
  if (options.signal?.aborted || sourceBudgetMs === 0) controller.abort();
  else options.signal?.addEventListener('abort', onOuter, { once: true });
  try {
    if (controller.signal.aborted) return { ok: false, reasons: ['request_aborted'] };
    if (typeof options.fetchFn !== 'function') {
      return { ok: false, reasons: ['candidate_coverage_incomplete'] };
    }
    if (!validLocation(location)) return { ok: false, reasons: ['unsupported_off_network_location'] };
    const quality = locationQuality(location);
    if (quality.state !== 'SUPPORTED') return { ok: false, reasons: quality.reasons };
    const policy = searchPolicy(location, {
      modelErrorMeters: CURB_RESOLUTION_POLICY.modelErrorMeters,
      maxSearchRadiusMeters: 500,
    });
    const productionStore = createCsclCandidateStore({
      fetchFn: options.fetchFn,
      getSocrataToken: options.getSocrataToken,
    });
    const raced = await Promise.race([
      productionStore.queryCandidates({
        lat: location.lat,
        lng: location.lng,
        ...policy,
        signal: controller.signal,
      }).then(retrieved => ({ retrieved })),
      abortResult,
    ]);
    const stageTiming = raced?.retrieved?.stageTiming ?? null;
    if (raced?.retrieved) delete raced.retrieved.stageTiming;
    if (controller.signal.aborted || raced?.aborted) {
      return { ok: false, reasons: ['request_aborted'], stageTiming };
    }
    const attested = attestCompleteRetrieval(raced.retrieved, policy);
    if (controller.signal.aborted) return { ok: false, reasons: ['request_aborted'], stageTiming };
    if (!attested.ok) {
      const count = Array.isArray(raced.retrieved?.candidates) ? raced.retrieved.candidates.length : 0;
      return { ok: false, reasons: [attested.reason], candidateCount: count, stageTiming };
    }
    bindRetrieval(attested.retrieved, nonce);
    return {
      ok: true,
      retrieval: attested.retrieved,
      candidateCount: attested.retrieved.candidates.length,
      stageTiming,
    };
  } catch {
    return { ok: false, reasons: [controller.signal.aborted ? 'request_aborted' : 'source_unavailable'] };
  } finally {
    settled = true;
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onOuter);
  }
}

async function resolveCanonicalCurb(location, options = {}) {
  const trace = createDemoResolutionTrace(options.env);
  const fail = (reasons, diagnostics, stage, extra) => {
    const result = unsupported(reasons, diagnostics);
    trace?.record(result, stage, extra);
    return result;
  };
  if (!validLocation(location)) {
    return fail(['unsupported_off_network_location'], undefined, 'classification', {
      internalReason: 'unsupported_off_network_location',
      classifierState: 'UNSUPPORTED',
      classifierReason: 'unsupported_off_network_location',
    });
  }
  const quality = locationQuality(location);
  if (quality.state !== 'SUPPORTED') {
    return fail(quality.reasons, undefined, 'classification', {
      internalReason: quality.reasons[0],
      classifierState: quality.state,
      classifierReason: quality.reasons[0],
    });
  }
  trace?.mark();
  const policy = searchPolicy(location, {
    modelErrorMeters: CURB_RESOLUTION_POLICY.modelErrorMeters,
    maxSearchRadiusMeters: 500,
  });
  let retrieved;
  if (options.attestedRetrieval) {
    if (!claimAuthoritativeRetrieval(options.attestedRetrieval, policy, options.acquisitionNonce)) {
      return fail(['authority_attestation_invalid'], undefined, 'cscl_retrieval', {
        internalReason: 'authority_attestation_invalid',
      });
    }
    retrieved = options.attestedRetrieval;
  } else {
    const productionStore = typeof options.fetchFn === 'function'
      ? createCsclCandidateStore({ fetchFn: options.fetchFn, getSocrataToken: options.getSocrataToken })
      : null;
    const sourceStore = productionStore || options.candidateStore;
    if (!sourceStore || typeof sourceStore.queryCandidates !== 'function') {
      return fail(['candidate_coverage_incomplete'], undefined, 'cscl_retrieval', {
        internalReason: 'candidate_coverage_incomplete',
      });
    }
    retrieved = await sourceStore.queryCandidates({
      lat: location.lat,
      lng: location.lng,
      ...policy,
      signal: options.signal,
    });
    if (productionStore) {
      const attested = attestCompleteRetrieval(retrieved, policy);
      if (!attested.ok) {
        const retrievedCount = Array.isArray(retrieved?.candidates) ? retrieved.candidates.length : null;
        trace?.setCounts({ rawCsclCandidateCount: retrievedCount });
        return fail([attested.reason], {
          candidateCount: retrievedCount || 0,
        }, 'cscl_retrieval', { internalReason: attested.reason });
      }
      retrieved = attested.retrieved;
    }
  }
  if (!authoritativeRetrievals.has(retrieved)) {
    const retrievalReason = 'authority_attestation_invalid';
    const retrievedCount = Array.isArray(retrieved?.candidates) ? retrieved.candidates.length : null;
    trace?.setCounts({ rawCsclCandidateCount: retrievedCount });
    return fail([retrievalReason], {
      candidateCount: retrievedCount || 0,
    }, 'cscl_retrieval', { internalReason: retrievalReason });
  }
  const candidateStore = {
    async queryCandidates() { return retrieved; },
  };
  const runtime = await resolveOfficialCurbRuntime(location, {
    candidateStore,
    signal: options.signal,
    precomputedSearchPolicy: policy,
    modelErrorMeters: CURB_RESOLUTION_POLICY.modelErrorMeters,
    maxCandidates: CURB_RESOLUTION_POLICY.maximumCsclCandidates,
  });

  const rawRecords = Array.isArray(retrieved?.candidates) ? retrieved.candidates : [];
  trace?.setCounts({ rawCsclCandidateCount: rawRecords.length });
  trace?.mark();
  const records = rawRecords.slice(0, CURB_RESOLUTION_POLICY.maximumCsclCandidates);
  const sourceCandidateSetComplete = retrieved?.completeness?.state === 'COMPLETE'
    && rawRecords.length <= CURB_RESOLUTION_POLICY.maximumCsclCandidates
    && authoritativeRetrievals.has(retrieved);
  if (!sourceCandidateSetComplete) {
    return fail(['candidate_coverage_incomplete'], { candidateCount: rawRecords.length }, 'candidate_coverage', {
      internalReason: 'candidate_coverage_incomplete',
    });
  }
  if (!records.length) {
    return fail(['canonical_candidate_missing'], { candidateCount: 0 }, 'candidate_coverage', {
      internalReason: 'canonical_candidate_missing',
    });
  }
  const candidateSetComplete = sourceCandidateSetComplete
    && runtime?.resolution?.candidateCompleteness?.state === 'COMPLETE'
    && runtime?.resolution?.searchEnvelopeComplete === true;
  if (!candidateSetComplete) {
    return fail(['candidate_coverage_incomplete'], { candidateCount: records.length }, 'candidate_coverage', {
      internalReason: 'candidate_coverage_incomplete',
    });
  }
  const sourceVersionConsistent = new Set(records.map(sourceVersionKey)).size === 1
    && !records.some(record => !record?.sourceVersion?.version);
  if (!sourceVersionConsistent) {
    return fail(['source_version_problem'], { candidateCount: records.length }, 'cscl_retrieval', {
      internalReason: 'source_version_problem',
    });
  }
  if (records.some(record => !roadwaySupported(record))) {
    return fail(['unsupported_roadway_status'], { candidateCount: records.length }, 'cscl_retrieval', {
      internalReason: 'unsupported_roadway_status',
    });
  }

  trace?.mark();
  const ranked = rankGroups({ lat: location.lat, lng: location.lng }, records);
  if (!ranked.length) {
    return fail(['implausible_geometry'], { candidateCount: 0 }, 'geometric_ranking', {
      internalReason: 'implausible_geometry',
    });
  }
  const uncertainty = location.accuracyMeters + CURB_RESOLUTION_POLICY.modelErrorMeters;
  const bestDistance = ranked[0].best.projection.distanceMeters;
  const materialRanked = ranked.filter(value => (
    value.best.projection.distanceMeters - uncertainty <= bestDistance + uncertainty
  ));
  trace?.setCounts({ materialRoadwayCandidateCount: materialRanked.length });
  if (materialRanked.length > 2) {
    return fail(['intersection_complex'], { candidateCount: materialRanked.length }, 'material_selection', {
      internalReason: 'intersection_complex',
    });
  }
  const retainPrivateSourceContext = options.privateSourceContextRetention === RETENTION_MODE;
  const evidence = shadowSourceEvidence(options);
  if (evidence?.ok === true) emitPilotStage(options.telemetry, 'cscl_admitted');
  const officialPrimary = readOfficialLionPrimary(options.officialLionPrimary);
  let officialRelationships = null;
  if (officialPrimary) {
    try {
      officialRelationships = await officialPrimary.relationshipsFor(materialRanked.map(group => group.best));
    } catch {
      return fail(['lion_primary_unavailable'], { candidateCount: materialRanked.length }, 'lion_relationships', {
        internalReason: 'lion_primary_unavailable',
      });
    }
  }
  const identityFailure = { reason: null, enrichment: null };
  trace?.mark();
  const candidates = materialRanked.map(rankedGroup => (
    buildCandidate(rankedGroup, { identityFailure, evidence, officialRelationships })
  )).filter(Boolean);
  trace?.setCounts({ constructedCanonicalCandidateCount: candidates.length });
  if (retainPrivateSourceContext) {
    observePrivateSourceContext(materialRanked, options, identityFailure.reason);
  }
  if (evidence && typeof options.privateSourceContextObserver === 'function') {
    options.privateSourceContextObserver(Object.freeze({
      identityReason: identityFailure.reason,
      enrichment: identityFailure.enrichment,
    }));
  }
  if (candidates.length !== materialRanked.length || candidates.length === 0) {
    const lionReason = identityFailure?.reason;
    const reasons = typeof lionReason === 'string' && lionReason.startsWith('lion_')
      ? [lionReason]
      : ['candidate_incomplete'];
    return fail(reasons, { candidateCount: materialRanked.length }, 'candidate_construction', {
      internalReason: typeof lionReason === 'string' ? lionReason : reasons[0],
    });
  }
  if (identityFailure?.enrichment?.fromStreet && identityFailure.enrichment.toStreet) {
    emitPilotStage(options.telemetry, 'enrichment_accepted');
  }
  if (identityFailure?.enrichment?.certificationStatus === 'NOT_CERTIFIED') {
    emitPilotStage(options.telemetry, 'source_not_certified');
  }

  const levelOrRoadbedAmbiguous = new Set(materialRanked.map(value => (
    levelSignature(value.best)
  ))).size > 1 || materialRanked.some(value => value.group.reasonCodes.length > 0);
  const considered = candidates;
  const selected = considered[0];
  const topologySelectable = candidate => {
    const halfWidthMeters = Number(candidate.record.sourceNative?.streetwidth) * 0.3048 / 2;
    return Number.isFinite(halfWidthMeters) && halfWidthMeters > 0
      && candidate.projection.distanceMeters <= halfWidthMeters + uncertainty
      && candidate.projection.segmentFraction >= 0
      && candidate.projection.segmentFraction <= 1;
  };
  const endpointDistance = Math.min(
    selected.projection.distanceToComponentStartMeters,
    selected.projection.distanceToComponentEndMeters,
  );
  const pairDistinct = considered.length === 2 && visuallyDistinct(considered[0], considered[1]);
  const policyCandidates = considered.map((candidate, index) => ({
    rank: index,
    visuallyDistinct: considered.length === 1 || pairDistinct,
  }));
  trace?.mark();
  const decision = classifyCanonicalCurb({
    reportedAccuracyMeters: location.accuracyMeters,
    sampleCount: location.sampleCount,
    consistencyMeters: location.consistencyMeters,
    selectedBlockFaceId: selected.identity.officialBlockFaceId,
    candidateSetComplete,
    sourceVersionConsistent,
    roadwaySupported: true,
    geometryPlausible: topologySelectable(selected),
    projectedWithinBounds: selected.projection.segmentFraction >= 0
      && selected.projection.segmentFraction <= 1,
    levelOrRoadbedAmbiguous,
    streetIdentityConflict: false,
    sideCrossesCenterline: Math.abs(selected.projection.signedOffsetMeters) <= uncertainty,
    roadwayIntervalsOverlap: considered.length > 1,
    endpointAmbiguous: endpointDistance <= uncertainty,
    actionableCandidates: policyCandidates,
  });

  if (considered.some(candidate => candidate.sourceEnrichment === true)
    && (decision.state === 'SUPPORTED' || decision.state === 'AMBIGUOUS')) {
    const diagnostics = {
      candidateCount: considered.length,
      classifierState: decision.state,
      classifierReasons: decision.reasons,
    };
    if (evidence?.sourceAdmission) diagnostics.sourceAdmission = evidence.sourceAdmission;
    emitPilotStage(options.telemetry, 'topology_primary_rejected');
    emitPilotStage(options.telemetry, 'native_proof_not_invoked');
    return fail(['topology_primary_required'], diagnostics, 'classification', {
      internalReason: 'topology_primary_required',
      classifierState: decision.state,
      classifierReason: decision.reasons[0] || null,
    });
  }

  if (decision.state === 'SUPPORTED') {
    const result = deepFreeze({
      state: 'SUPPORTED',
      reasons: [],
      identity: selected.identity,
      publicCurb: toPublicCurb(selected.identity),
    });
    primaryTopologyResults.add(result);
    return result;
  }
  const tokenContext = typeof options.requestNonceDigest === 'string'
    ? { requestNonceDigest: options.requestNonceDigest }
    : { requestNonce: options.requestNonce };
  const authorityContextDigest = createHash('sha256').update(JSON.stringify({
    envelopeDigest: retrieved.envelopeDigest,
    populationIdentity: retrieved.populationIdentity,
    sourceVersion: retrieved.sourceVersion,
  })).digest('hex');
  if (decision.state !== 'AMBIGUOUS') {
    trace?.mark();
    let sideDiagnostic = null;
    const sideConfirmation = sideConfirmationResult({
      enabled: options.sideConfirmationEnabled === true,
      selected,
      consideredCount: considered.length,
      sideCrossesCenterline: Math.abs(selected.projection.signedOffsetMeters) <= uncertainty,
      endpointAmbiguous: endpointDistance <= uncertainty,
      levelOrRoadbedAmbiguous,
      topologySelectable: topologySelectable(selected),
      sourceEnrichment: selected.sourceEnrichment === true,
      decision,
      tokenContext,
      authorityContextDigest,
      callerUid: options.callerUid,
      hmacKey: options.sideConfirmationHmacKey,
      nowMs: Number.isSafeInteger(options.sideConfirmationNow) ? options.sideConfirmationNow : Date.now(),
      nonceForRank: options.sideConfirmationNonceForRank,
      onDemoDiagnostic: trace ? (detail) => { sideDiagnostic = detail; } : undefined,
    });
    if (sideConfirmation) return sideConfirmation;
    return fail(decision.reasons, { candidateCount: considered.length }, sideDiagnostic?.stage || 'classification', {
      internalReason: sideDiagnostic?.internalReason || decision.reasons[0],
      classifierState: decision.state,
      classifierReason: decision.reasons[0] || null,
      sideConfirmationEligibility: sideDiagnostic?.sideConfirmationEligibility ?? null,
    });
  }
  const publicCandidates = considered.map((candidate, index) => (
    publicCandidate(candidate, tokenContext, index, authorityContextDigest)
  ));
  if (publicCandidates.some(candidate => !candidate.token)) {
    return fail(['candidate_token_unavailable'], { candidateCount: considered.length }, 'candidate_token', {
      internalReason: 'candidate_token_unavailable',
      classifierState: decision.state,
      classifierReason: decision.reasons[0] || null,
    });
  }
  const result = deepFreeze({
    state: 'AMBIGUOUS',
    reasons: decision.reasons,
    center: { lat: location.lat, lng: location.lng },
    candidates: publicCandidates,
  });
  ambiguousTopologyResults.add(result);
  const privateCandidates = deepFreeze(considered.map((candidate, index) => ({
    token: publicCandidates[index].token,
    identity: candidate.identity,
    topologySelectable: topologySelectable(candidate),
  })));
  privateCandidateSets.set(result, privateCandidates);
  return result;
}

function hasPrimaryTopologyAuthority(result) {
  return Boolean(result && primaryTopologyResults.has(result));
}

function hasAmbiguousTopologyAuthority(result) {
  return Boolean(result && ambiguousTopologyResults.has(result));
}

function hasSideConfirmationAuthority(result) {
  return Boolean(result && sideConfirmationResults.has(result));
}

function attestedSideConfirmationMatch(resolution, visible) {
  if (!hasSideConfirmationAuthority(resolution) || !visible) return null;
  if (sideConfirmationAuthorities.get(resolution) !== visible.authorityDigest) return null;
  const selected = privateCandidateSets.get(resolution)?.find(candidate => (
    candidate.rank === visible.rank
    && candidate.csclSide === visible.csclSide
    && candidate.publicCurbKey === visible.publicCurbKey
    && candidate.authorityDigest === visible.authorityDigest
  ));
  if (!selected || selected.topologySelectable !== true) return null;
  return selected;
}

function promoteAttestedSideConfirmation(resolution, candidateToken) {
  if (!hasSideConfirmationAuthority(resolution) || typeof candidateToken !== 'string') {
    return unsupported(['candidate_selection_stale']);
  }
  const privateSet = privateCandidateSets.get(resolution);
  const selected = privateSet?.find(candidate => candidate.token === candidateToken);
  if (!selected || selected.topologySelectable !== true) {
    return unsupported(['candidate_selection_stale']);
  }
  const identity = deepFreeze({
    ...selected.identity,
    resolution: { ...selected.identity.resolution, method: 'visual_selection' },
  });
  const expectedOfficialBlockFaceIds = [...new Set(privateSet.map(candidate => candidate.officialBlockFaceId))];
  const result = deepFreeze({
    state: 'SUPPORTED', reasons: [], identity, publicCurb: toPublicCurb(identity),
    expectedOfficialBlockFaceIds,
  });
  primaryTopologyResults.add(result);
  return result;
}

function promoteAttestedVisualSelection(resolution, candidateToken) {
  if (!hasAmbiguousTopologyAuthority(resolution) || typeof candidateToken !== 'string') {
    return unsupported(['candidate_selection_stale']);
  }
  const privateSet = privateCandidateSets.get(resolution);
  const selected = privateSet?.find(candidate => candidate.token === candidateToken);
  if (!selected || selected.topologySelectable !== true) {
    return unsupported(['candidate_selection_stale']);
  }
  const identity = deepFreeze({
    ...selected.identity,
    resolution: { ...selected.identity.resolution, method: 'visual_selection' },
  });
  const result = deepFreeze({
    state: 'SUPPORTED', reasons: [], identity, publicCurb: toPublicCurb(identity),
  });
  primaryTopologyResults.add(result);
  return result;
}

module.exports = {
  CSCL_SOURCE_BUDGET_MS,
  acquireAuthoritativeCscl,
  resolveCanonicalCurb,
  buildCandidate,
  hasPrimaryTopologyAuthority,
  hasAmbiguousTopologyAuthority,
  hasSideConfirmationAuthority,
  attestedSideConfirmationMatch,
  promoteAttestedVisualSelection,
  promoteAttestedSideConfirmation,
};
