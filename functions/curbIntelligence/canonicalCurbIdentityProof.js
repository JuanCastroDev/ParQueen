'use strict';

const { hasPrimaryTopologyAuthority } = require('./canonicalCurbResolver');
const { hasValidatedPrivateBlockfaceResult } = require('./privateBlockfaceResolver');

const BFI = /^\d{10}$/;
const BOROUGHS = new Set(['MANHATTAN', 'BRONX', 'BROOKLYN', 'QUEENS', 'STATEN ISLAND']);
const DIRECTIONS = Object.freeze({ North: 'N', South: 'S', East: 'E', West: 'W' });
const DISPLAY_CARDINALS = new Set(['Northeast', 'Southeast', 'Southwest', 'Northwest']);
const OFFICIAL_COMPASS = Object.freeze(['N', 'S', 'E', 'W']);
const proofBindings = new WeakMap();

const notProven = reason => Object.freeze({ state: 'IDENTITY_NOT_PROVEN', reason });

function validStreet(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()
    || Buffer.byteLength(value, 'utf8') > 32) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function streetContext(identity) {
  const borough = typeof identity?.names?.borough === 'string'
    ? identity.names.borough.toUpperCase() : null;
  const context = {
    borough,
    onStreet: identity?.names?.onStreet,
    crossStreetOne: identity?.names?.fromStreet,
    crossStreetTwo: identity?.names?.toStreet,
  };
  if (!BOROUGHS.has(context.borough)
    || [context.onStreet, context.crossStreetOne, context.crossStreetTwo]
      .some(value => !validStreet(value))) return null;
  return context;
}

function tupleFor(topologyResult) {
  const context = streetContext(topologyResult?.identity);
  const compassDirection = DIRECTIONS[topologyResult?.identity?.side?.cardinal];
  if (!context || !compassDirection) return null;
  return Object.freeze({ ...context, compassDirection });
}

function officialBlockFaceId(identity) {
  const value = identity?.officialBlockFaceId;
  if (typeof value !== 'string' || !BFI.test(value) || value === '0000000000') return null;
  return value;
}

function proven(topologyResult) {
  const proof = Object.freeze({ state: 'IDENTITY_PROVEN' });
  proofBindings.set(proof, topologyResult);
  return proof;
}

function mapResolverFailure(value) {
  switch (value?.failureClass) {
    case 'BFI_BLANK': return 'function3c_bfi_blank';
    case 'BFI_MALFORMED': return 'function3c_bfi_malformed';
    case 'SOURCE_VERSION_INVALID': return 'function3c_source_version_invalid';
    case 'INVALID_RESPONSE':
    case 'INVALID_REQUEST':
    case 'NOT_AUTHORITATIVE': return 'function3c_contract_invalid';
    case 'DISABLED':
    case 'CONFIGURATION_FAILURE':
    case 'AUTHENTICATION_FAILURE':
    case 'ROUTING_FAILURE':
    case 'SATURATED':
    case 'UPSTREAM_UNAVAILABLE':
    case 'ABORTED':
    case 'TIMEOUT': return 'function3c_unavailable';
    default: return 'function3c_contract_invalid';
  }
}

const OFFICIAL_INVALID_DIRECTION = '40';

async function lookupOfficialFace(tuple, options) {
  const blockfaceResolver = options.blockfaceResolver;
  let result;
  try {
    result = await blockfaceResolver.resolve({ ...tuple, signal: options.signal });
  } catch {
    return { state: 'exception' };
  }
  if (result?.ok === true) {
    if (!hasValidatedPrivateBlockfaceResult(result, tuple, blockfaceResolver)) {
      return { state: 'unattested' };
    }
    return { state: 'face', officialBlockFaceId: result.officialBlockFaceId };
  }
  if (result?.failureClass === 'NOT_AUTHORITATIVE' && result.returnCode === OFFICIAL_INVALID_DIRECTION) {
    return { state: 'invalid-direction' };
  }
  const reason = mapResolverFailure(result);
  return { state: reason === 'function3c_unavailable' ? 'unavailable' : 'rejected', reason };
}

async function proveOfficialCompass(topologyResult, options) {
  const tuple = tupleFor(topologyResult);
  if (!tuple) return notProven('function3c_context_invalid');
  const topologyBfi = officialBlockFaceId(topologyResult.identity);
  if (!topologyBfi) return notProven('unexpected_identity_proof_failure');
  const answer = await lookupOfficialFace(tuple, options);
  if (answer.state === 'exception') return notProven('unexpected_identity_proof_failure');
  if (answer.state === 'unavailable') return notProven('function3c_unavailable');
  if (answer.state === 'rejected' || answer.state === 'invalid-direction') return notProven(answer.reason || 'function3c_contract_invalid');
  if (answer.state === 'unattested') return notProven('function3c_contract_invalid');
  if (answer.state !== 'face' || answer.officialBlockFaceId !== topologyBfi) {
    return notProven('function3c_bfi_mismatch');
  }
  return proven(topologyResult);
}

function expectedOfficialFaces(topologyResult, selectedFace) {
  const ids = topologyResult?.expectedOfficialBlockFaceIds;
  if (!Array.isArray(ids)) return null;
  const faces = new Set();
  for (const id of ids) {
    const face = officialBlockFaceId({ officialBlockFaceId: id });
    if (!face) return null;
    faces.add(face);
  }
  if (faces.size !== 2 || !faces.has(selectedFace)) return null;
  return faces;
}

function consistentOfficialFaces(selectedFace, facesById, expected) {
  if (!expected) return false;
  const ids = [...facesById.keys()];
  return ids.length === expected.size && ids.every(id => expected.has(id)) && facesById.has(selectedFace);
}

async function proveDisplayedDiagonal(topologyResult, options) {
  const context = streetContext(topologyResult.identity);
  const selectedFace = officialBlockFaceId(topologyResult.identity);
  const expected = expectedOfficialFaces(topologyResult, selectedFace);
  if (!context || !selectedFace || !expected) return notProven('function3c_context_invalid');
  // At most four sequential Function 3C lookups. Compass letters are not chosen
  // from the display bearing: Geosupport, including Manhattan's 30-degree
  // convention, decides which letters name the same physical face.
  const facesById = new Map();
  for (const compassDirection of OFFICIAL_COMPASS) {
    if (options.signal?.aborted) return notProven('function3c_unavailable');
    const answer = await lookupOfficialFace(Object.freeze({ ...context, compassDirection }), options);
    if (answer.state === 'exception') return notProven('unexpected_identity_proof_failure');
    if (answer.state === 'unavailable') return notProven('function3c_unavailable');
    if (answer.state === 'rejected') return notProven(answer.reason);
    if (answer.state === 'unattested') return notProven('function3c_contract_invalid');
    if (answer.state === 'invalid-direction') continue;
    const grouped = facesById.get(answer.officialBlockFaceId) || [];
    grouped.push(compassDirection);
    facesById.set(answer.officialBlockFaceId, grouped);
  }
  if (!consistentOfficialFaces(selectedFace, facesById, expected)) return notProven('function3c_bfi_mismatch');
  return proven(topologyResult);
}

async function proveCanonicalCurbIdentity(topologyResult, options = {}) {
  if (!hasPrimaryTopologyAuthority(topologyResult)) {
    return notProven('topology_primary_required');
  }
  const blockfaceResolver = options.blockfaceResolver;
  if (!blockfaceResolver || typeof blockfaceResolver.resolve !== 'function') {
    return notProven('function3c_unavailable');
  }
  const cardinal = topologyResult.identity?.side?.cardinal;
  if (DISPLAY_CARDINALS.has(cardinal)) return proveDisplayedDiagonal(topologyResult, options);
  return proveOfficialCompass(topologyResult, options);
}

function hasCanonicalCurbIdentityProof(proof, topologyResult) {
  return Boolean(proof && topologyResult
    && hasPrimaryTopologyAuthority(topologyResult)
    && proofBindings.get(proof) === topologyResult);
}

module.exports = { proveCanonicalCurbIdentity, hasCanonicalCurbIdentityProof };
