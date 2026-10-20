'use strict';

const { hasPrimaryTopologyAuthority } = require('./canonicalCurbResolver');
const { hasValidatedPrivateBlockfaceResult } = require('./privateBlockfaceResolver');

const BFI = /^\d{10}$/;
const BOROUGHS = new Set(['MANHATTAN', 'BRONX', 'BROOKLYN', 'QUEENS', 'STATEN ISLAND']);
const DIRECTIONS = Object.freeze({ North: 'N', South: 'S', East: 'E', West: 'W' });
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

function tupleFor(topologyResult) {
  const identity = topologyResult?.identity;
  const borough = typeof identity?.names?.borough === 'string'
    ? identity.names.borough.toUpperCase() : null;
  const compassDirection = DIRECTIONS[identity?.side?.cardinal];
  const tuple = {
    borough,
    onStreet: identity?.names?.onStreet,
    crossStreetOne: identity?.names?.fromStreet,
    crossStreetTwo: identity?.names?.toStreet,
    compassDirection,
  };
  if (!BOROUGHS.has(tuple.borough) || !compassDirection
    || [tuple.onStreet, tuple.crossStreetOne, tuple.crossStreetTwo]
      .some(value => !validStreet(value))) return null;
  return Object.freeze(tuple);
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

async function proveCanonicalCurbIdentity(topologyResult, options = {}) {
  if (!hasPrimaryTopologyAuthority(topologyResult)) {
    return notProven('topology_primary_required');
  }
  const tuple = tupleFor(topologyResult);
  if (!tuple) return notProven('function3c_context_invalid');
  const blockfaceResolver = options.blockfaceResolver;
  if (!blockfaceResolver || typeof blockfaceResolver.resolve !== 'function') {
    return notProven('function3c_unavailable');
  }
  let result;
  try {
    result = await blockfaceResolver.resolve({ ...tuple, signal: options.signal });
  } catch {
    return notProven('unexpected_identity_proof_failure');
  }
  if (result?.ok !== true) return notProven(mapResolverFailure(result));
  if (!hasValidatedPrivateBlockfaceResult(result, tuple, blockfaceResolver)) {
    return notProven('function3c_contract_invalid');
  }
  const topologyBfi = topologyResult.identity?.officialBlockFaceId;
  if (typeof topologyBfi !== 'string' || !BFI.test(topologyBfi)
    || topologyBfi === '0000000000') return notProven('unexpected_identity_proof_failure');
  if (result.officialBlockFaceId !== topologyBfi) {
    return notProven('function3c_bfi_mismatch');
  }
  const proof = Object.freeze({ state: 'IDENTITY_PROVEN' });
  proofBindings.set(proof, topologyResult);
  return proof;
}

function hasCanonicalCurbIdentityProof(proof, topologyResult) {
  return Boolean(proof && topologyResult
    && hasPrimaryTopologyAuthority(topologyResult)
    && proofBindings.get(proof) === topologyResult);
}

module.exports = { proveCanonicalCurbIdentity, hasCanonicalCurbIdentityProof };
