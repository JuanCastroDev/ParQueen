'use strict';

const { createCsclCandidateStore } = require('./csclSocrataAdapter');
const { createReusedDotCandidateSource } = require('./reusedDotEvidence');
const { createStructuredCloudLoggingSink } = require('./structuredShadowTelemetry');

function createMinimumShadowSources(input = {}, options = {}) {
  return Object.freeze({
    candidateStore: createCsclCandidateStore({
      fetchFn: options.fetchFn,
      getSocrataToken: options.getSocrataToken,
      candidateLimit: options.candidateLimit,
    }),
    dotSource: createReusedDotCandidateSource(input.dotEvidence),
    sink: createStructuredCloudLoggingSink({ logger: options.logger }),
  });
}

module.exports = { createMinimumShadowSources };
