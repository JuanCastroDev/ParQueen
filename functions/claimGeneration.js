'use strict';

// Server-minted claim generation. 32 cryptographically random bytes, lowercase
// hex. This is an authorization value for cancellation. It is not an attempt
// id, a timestamp, or a client-supplied token.
const GENERATION_ID_RE = /^[0-9a-f]{64}$/;

function isClaimGenerationId(value) {
  return typeof value === 'string' && GENERATION_ID_RE.test(value);
}

// Any stored value other than an absent field blocks a new claim. A later
// acquisition must not inherit a previous generation, including a malformed one.
function hasLeftoverGenerationId(value) {
  return value !== undefined && value !== null;
}

function mintClaimGenerationId(randomBytes) {
  if (typeof randomBytes !== 'function') {
    throw new Error('generation id source missing');
  }
  const bytes = randomBytes(32);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
    throw new Error('generation id source failed');
  }
  const id = bytes.toString('hex');
  if (!isClaimGenerationId(id)) {
    throw new Error('generation id source failed');
  }
  return id;
}

module.exports = {
  GENERATION_ID_RE,
  isClaimGenerationId,
  hasLeftoverGenerationId,
  mintClaimGenerationId,
};
