'use strict';

const { canonicalJson, sha256 } = require('./canonicalJson');
const { normalizeBfi } = require('./bfi');

const FORBIDDEN_KEYS = new Set([
  'coordinates',
  'rawrequest',
  'rawresponse',
  'token',
  'uid',
  'latitude',
  'longitude',
  'lat',
  'lng',
]);

const requireString = (value, label) => {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) {
    throw new TypeError(`${label} is required and normalized`);
  }
  return value;
};

const rejectForbidden = (value, path = '') => {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key.toLowerCase())) throw new TypeError(`forbidden corpus field: ${path}${key}`);
    rejectForbidden(child, `${path}${key}.`);
  }
};

const normalizeVerificationCorpusRecord = input => {
  if (!input || typeof input !== 'object') throw new TypeError('corpus record is required');
  rejectForbidden(input);
  const tuple = input.topologyTuple;
  if (!tuple || typeof tuple !== 'object') throw new TypeError('topology tuple is required');
  const expectedContext = {
    borough: requireString(tuple.borough, 'borough'),
    onStreet: requireString(tuple.onStreet, 'onStreet'),
    fromStreet: requireString(tuple.fromStreet, 'fromStreet'),
    toStreet: requireString(tuple.toStreet, 'toStreet'),
    side: requireString(tuple.side, 'side'),
  };
  if (!['LEFT', 'RIGHT'].includes(expectedContext.side)) throw new TypeError('side must be LEFT or RIGHT');
  const bfi = normalizeBfi(input.expectedBfi);
  return {
    corpusSchemaVersion: 1,
    internalTestId: requireString(input.internalTestId, 'internalTestId'),
    topologyTupleFingerprint: sha256(canonicalJson(expectedContext)),
    expectedBfiFingerprint: sha256(`bfi:${bfi}`),
    expectedContext,
    resultClassification: requireString(input.resultClassification, 'resultClassification'),
    sourceTopologyVersion: requireString(input.sourceTopologyVersion, 'sourceTopologyVersion'),
  };
};

module.exports = { normalizeVerificationCorpusRecord };
