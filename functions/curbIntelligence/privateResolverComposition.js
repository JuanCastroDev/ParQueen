'use strict';

const { createOfficialDotRelationshipProvider } = require('./officialDotRelationshipProvider');
const { createPrivateBlockfaceResolver } = require('./privateBlockfaceResolver');
const { readPrivateResolverConfig } = require('./privateBlockfaceResolverConfig');
const { runMinimumCleaningShadow } = require('./minimumCleaningShadow');
const { createMinimumShadowSources } = require('./minimumShadowSources');
const {
  evaluatePreSourceEligibility,
  deterministicSampleSelected,
} = require('./minimumShadowControl');

const OVERALL_DEADLINE_MS = 8000;

function reviewedSources(value) {
  return value
    && typeof value.candidateStore?.queryCandidates === 'function'
    && typeof value.dotSource?.query === 'function'
    && typeof value.sink?.record === 'function';
}

async function boundedShadow(run, milliseconds, controller) {
  let timer;
  try {
    return await Promise.race([
      run(),
      new Promise(resolve => {
        timer = setTimeout(() => {
          controller.abort();
          resolve({ outcome: 'FAILED', skipOrFailureClass: 'execution_timeout' });
        }, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function observePrivateResolverShadow(input = {}, options = {}) {
  const productionResult = input.productionResult;
  const readConfig = options.readConfig || readPrivateResolverConfig;

  let config;
  try {
    config = readConfig();
  } catch {
    return productionResult;
  }
  if (config?.mode !== 'shadow') return productionResult;

  const samplePermille = Number.isInteger(config.samplePermille) ? config.samplePermille : 0;
  const sampleSelected = samplePermille > 0
    && deterministicSampleSelected(productionResult?.segmentId, samplePermille);
  const eligibility = evaluatePreSourceEligibility({
    mode: config.mode,
    samplePermille,
    operatorAuthorized: options.operatorAuthorized === true,
    sampleSelected,
    accuracyMeters: input.location?.accuracyMeters,
    productionPath: input.productionPath,
    dotEvidence: input.dotEvidence,
    legacyEvidence: input.legacyEvidence,
  });
  if (!eligibility.eligible) return productionResult;

  const sourceDependenciesFactory = options.sourceDependenciesFactory || createMinimumShadowSources;
  let sources;
  try {
    sources = sourceDependenciesFactory(input, {
      fetchFn: options.fetchFn,
      getSocrataToken: options.getSocrataToken,
      logger: options.logger,
    });
  } catch {
    return productionResult;
  }
  if (!reviewedSources(sources)) return productionResult;

  const resolverFactory = options.resolverFactory || createPrivateBlockfaceResolver;
  const relationshipProviderFactory = options.relationshipProviderFactory
    || createOfficialDotRelationshipProvider;
  const runShadow = options.runShadow || runMinimumCleaningShadow;
  const controller = new AbortController();

  try {
    const blockfaceResolver = resolverFactory({
      mode: 'shadow',
      serviceUrl: config.serviceUrl,
      getIdToken: options.getIdToken,
      transport: options.transport,
    });
    const officialRelationshipProvider = relationshipProviderFactory({
      providerId: 'private-geosupport-function-3c',
      blockfaceResolver,
    });
    await boundedShadow(() => runShadow({
      location: input.location,
      legacyEvidence: input.legacyEvidence,
      cohort: samplePermille === 0 ? 'operator' : 'sampled',
      signal: controller.signal,
      dependencies: {
        ...sources,
        blockfaceResolver,
        officialRelationshipProvider,
      },
    }), OVERALL_DEADLINE_MS, controller);
  } catch {
    // Shadow evidence is observational. It must never affect the callable.
  }

  return productionResult;
}

module.exports = { observePrivateResolverShadow };
