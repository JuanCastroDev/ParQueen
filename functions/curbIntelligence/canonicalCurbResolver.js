'use strict';

const { classifyCanonicalCurb, CURB_RESOLUTION_POLICY } = require('./curbResolutionPolicy');
const {
  createCanonicalCurbIdentity,
  createCandidateToken,
  publicCurbKey,
  toPublicCurb,
} = require('./canonicalCurbIdentity');
const { projectPointToMultiLineString, rankRoadwayCandidates } = require('./geometry');
const { groupRoadwayCandidates } = require('./roadwayGrouping');
const { resolveOfficialCurbRuntime } = require('./runtimeCurbResolution');

const NYC = Object.freeze({ minLat: 40.4, maxLat: 40.95, minLng: -74.3, maxLng: -73.65 });
const BOROUGHS = Object.freeze({
  1: 'Manhattan', 2: 'Bronx', 3: 'Brooklyn', 4: 'Queens', 5: 'Staten Island',
});
const privateCandidateSets = new WeakMap();

const unsupported = reasons => ({ state: 'UNSUPPORTED', reasons: [...new Set(reasons)] });

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

function buildCandidate(rankedGroup) {
  const record = rankedGroup.best;
  const projection = record.projection;
  if (projection.csclSide !== 'LEFT' && projection.csclSide !== 'RIGHT') return null;
  const native = record.sourceNative || {};
  const identityResult = createCanonicalCurbIdentity({
    csclRows: identityRows(rankedGroup.group.records),
    csclSide: projection.csclSide,
    sourceVersion: record.sourceVersion,
    selectedGlobalId: record.globalId,
    geometry: record.geometry,
    streetWidthFeet: Number(native.streetwidth),
    borough: BOROUGHS[native.boroughcode] || String(native.boroughcode || '').trim(),
    onStreet: native.full_street_name || native.street_name || native.stname_label,
    fromStreet: native.from_street,
    toStreet: native.to_street,
    aliases: [native.street_name, native.stname_label],
    cardinalSide: cardinalSide(projection),
    resolutionMethod: 'automatic',
  });
  if (!identityResult.ok) return null;
  return {
    identity: identityResult.identity,
    projection,
    record,
    group: rankedGroup.group,
    streetName: identityResult.identity.names.onStreet,
    stroke: record.geometry,
  };
}

function tangentSimilarity(left, right) {
  const leftLength = Math.hypot(left.eastMeters, left.northMeters);
  const rightLength = Math.hypot(right.eastMeters, right.northMeters);
  if (!leftLength || !rightLength) return 0;
  return Math.abs((left.eastMeters * right.eastMeters + left.northMeters * right.northMeters)
    / (leftLength * rightLength));
}

function planimetricChoice(location, candidates, evidence) {
  if (evidence?.completeness?.state !== 'COMPLETE'
    || !Array.isArray(evidence.candidates) || evidence.candidates.length === 0) return null;
  const uncertainty = location.accuracyMeters + CURB_RESOLUTION_POLICY.modelErrorMeters;
  const maximumDistance = Math.max(12, uncertainty + 3);
  const scores = candidates.map(candidate => {
    const compatibleDistances = evidence.candidates.map(curb => {
      const curbProjection = projectPointToMultiLineString(location, curb?.geometry?.coordinates);
      if (!curbProjection || curbProjection.distanceMeters > maximumDistance
        || tangentSimilarity(candidate.projection.tangent, curbProjection.tangent) < 0.9) return null;
      const roadwayProjection = projectPointToMultiLineString(
        curbProjection.projectedPoint,
        candidate.record.geometry?.coordinates,
      );
      const expectedOffset = Number(candidate.record.sourceNative?.streetwidth) * 0.3048 / 2;
      if (!roadwayProjection
        || roadwayProjection.csclSide !== candidate.identity.csclSide
        || !Number.isFinite(expectedOffset)
        || Math.abs(roadwayProjection.distanceMeters - expectedOffset) > uncertainty + 3) return null;
      return curbProjection.distanceMeters;
    }).filter(value => value !== null);
    return compatibleDistances.length ? Math.min(...compatibleDistances) : Number.POSITIVE_INFINITY;
  });
  const finite = scores.map((score, index) => ({ score, index }))
    .filter(value => Number.isFinite(value.score)).sort((a, b) => a.score - b.score);
  if (finite.length === 0) return null;
  if (finite.length > 1 && finite[0].score + uncertainty >= finite[1].score - uncertainty) return null;
  return candidates[finite[0].index];
}

function visuallyDistinct(left, right) {
  return left.streetName !== right.streetName
    || JSON.stringify(left.stroke) !== JSON.stringify(right.stroke);
}

function publicCandidate(candidate, tokenContext, rank) {
  const key = publicCurbKey(candidate.identity);
  return {
    token: createCandidateToken({ publicCurbKey: key, ...tokenContext, rank }),
    streetName: candidate.streetName,
    stroke: candidate.stroke,
  };
}

async function resolveCanonicalCurb(location, options = {}) {
  if (!validLocation(location)) return unsupported(['unsupported_off_network_location']);
  const quality = locationQuality(location);
  if (quality.state !== 'SUPPORTED') return unsupported(quality.reasons);
  if (!options.candidateStore || typeof options.candidateStore.queryCandidates !== 'function') {
    return unsupported(['candidate_coverage_incomplete']);
  }

  let retrieved = null;
  const candidateStore = {
    async queryCandidates(query) {
      retrieved = await options.candidateStore.queryCandidates({ ...query, signal: options.signal });
      return retrieved;
    },
  };
  const planimetricPromise = options.planimetricStore?.queryCurbs
    ? options.planimetricStore.queryCurbs({
      lat: location.lat,
      lng: location.lng,
      radiusMeters: Math.min(100, Math.max(30, location.accuracyMeters + 15)),
      signal: options.signal,
    })
    : Promise.resolve({ candidates: [], completeness: { state: 'INCOMPLETE', reason: 'source_unavailable' } });
  const [runtime, planimetricEvidence] = await Promise.all([
    resolveOfficialCurbRuntime(location, {
      candidateStore,
      signal: options.signal,
      modelErrorMeters: CURB_RESOLUTION_POLICY.modelErrorMeters,
      maxCandidates: CURB_RESOLUTION_POLICY.maximumCsclCandidates,
    }),
    planimetricPromise,
  ]);

  const rawRecords = Array.isArray(retrieved?.candidates) ? retrieved.candidates : [];
  const records = rawRecords.slice(0, CURB_RESOLUTION_POLICY.maximumCsclCandidates);
  const candidateSetComplete = retrieved?.completeness?.state === 'COMPLETE'
    && rawRecords.length <= CURB_RESOLUTION_POLICY.maximumCsclCandidates
    && runtime?.resolution?.candidateCompleteness?.state === 'COMPLETE'
    && runtime?.resolution?.searchEnvelopeComplete === true;
  if (!candidateSetComplete) return unsupported(['candidate_coverage_incomplete']);
  if (!records.length) return unsupported(['canonical_candidate_missing']);
  const sourceVersionConsistent = new Set(records.map(sourceVersionKey)).size === 1
    && !records.some(record => !record?.sourceVersion?.version);
  if (!sourceVersionConsistent) return unsupported(['source_version_problem']);
  if (records.some(record => !roadwaySupported(record))) {
    return unsupported(['unsupported_roadway_status']);
  }

  const ranked = rankGroups({ lat: location.lat, lng: location.lng }, records);
  if (!ranked.length) return unsupported(['implausible_geometry']);
  const uncertainty = location.accuracyMeters + CURB_RESOLUTION_POLICY.modelErrorMeters;
  const bestDistance = ranked[0].best.projection.distanceMeters;
  const materialRanked = ranked.filter(value => (
    value.best.projection.distanceMeters - uncertainty <= bestDistance + uncertainty
  ));
  if (materialRanked.length > 2) return unsupported(['intersection_complex']);
  const candidates = materialRanked.map(buildCandidate).filter(Boolean);
  if (candidates.length !== materialRanked.length || candidates.length === 0) {
    return unsupported(['candidate_incomplete']);
  }

  const levelOrRoadbedAmbiguous = new Set(materialRanked.map(value => (
    levelSignature(value.best)
  ))).size > 1 || materialRanked.some(value => value.group.reasonCodes.length > 0);
  const planChoice = candidates.length > 1
    ? planimetricChoice(location, candidates, planimetricEvidence) : null;
  const considered = planChoice ? [planChoice] : candidates;
  const selected = considered[0];
  const endpointDistance = Math.min(
    selected.projection.distanceToComponentStartMeters,
    selected.projection.distanceToComponentEndMeters,
  );
  const widthMeters = Number(selected.record.sourceNative?.streetwidth) * 0.3048 / 2;
  const pairDistinct = considered.length === 2 && visuallyDistinct(considered[0], considered[1]);
  const policyCandidates = considered.map((candidate, index) => ({
    rank: index,
    visuallyDistinct: considered.length === 1 || pairDistinct,
  }));
  const decision = classifyCanonicalCurb({
    reportedAccuracyMeters: location.accuracyMeters,
    sampleCount: location.sampleCount,
    consistencyMeters: location.consistencyMeters,
    selectedBlockFaceId: selected.identity.officialBlockFaceId,
    candidateSetComplete,
    sourceVersionConsistent,
    roadwaySupported: true,
    geometryPlausible: selected.projection.distanceMeters <= widthMeters + uncertainty,
    projectedWithinBounds: selected.projection.segmentFraction >= 0
      && selected.projection.segmentFraction <= 1,
    levelOrRoadbedAmbiguous,
    streetIdentityConflict: false,
    sideCrossesCenterline: !planChoice
      && Math.abs(selected.projection.signedOffsetMeters) <= uncertainty,
    roadwayIntervalsOverlap: !planChoice && considered.length > 1,
    endpointAmbiguous: !planChoice && endpointDistance <= uncertainty,
    actionableCandidates: policyCandidates,
  });

  if (decision.state === 'SUPPORTED') {
    return {
      state: 'SUPPORTED',
      reasons: [],
      identity: selected.identity,
      publicCurb: toPublicCurb(selected.identity),
    };
  }
  if (decision.state !== 'AMBIGUOUS') return unsupported(decision.reasons);
  const tokenContext = typeof options.requestNonceDigest === 'string'
    ? { requestNonceDigest: options.requestNonceDigest }
    : { requestNonce: options.requestNonce };
  const publicCandidates = considered.map((candidate, index) => (
    publicCandidate(candidate, tokenContext, index)
  ));
  if (publicCandidates.some(candidate => !candidate.token)) {
    return unsupported(['candidate_token_unavailable']);
  }
  const result = {
    state: 'AMBIGUOUS',
    reasons: decision.reasons,
    center: { lat: location.lat, lng: location.lng },
    candidates: publicCandidates,
  };
  privateCandidateSets.set(result, considered.map((candidate, index) => ({
    token: publicCandidates[index].token,
    identity: candidate.identity,
  })));
  return result;
}

function getPrivateCanonicalCandidateSet(resolution) {
  const candidates = privateCandidateSets.get(resolution);
  return candidates ? [...candidates] : [];
}

module.exports = { resolveCanonicalCurb, getPrivateCanonicalCandidateSet };
