'use strict';

const { createOfficialDotRelationshipProvider } = require('./officialDotRelationshipProvider');
const { createPrivateBlockfaceResolver } = require('./privateBlockfaceResolver');
const { readPrivateResolverConfig } = require('./privateBlockfaceResolverConfig');
const { runMinimumCleaningShadow } = require('./minimumCleaningShadow');
const { createMinimumShadowSources } = require('./minimumShadowSources');
const {
  evaluatePreSourceEligibility,
  evaluateProductPathEligibility,
  deterministicSampleSelected,
} = require('./minimumShadowControl');
const { decideProductPresentation } = require('./productPathDecision');

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

function executionCohort(config, productEligible) {
  if (productEligible) return 'pre_release_product';
  return config.samplePermille === 0 ? 'operator' : 'sampled';
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
  const eligibilityInput = {
    mode: config.mode,
    samplePermille,
    operatorAuthorized: options.operatorAuthorized === true,
    sampleSelected,
    productPath: config.productPath,
    accuracyMeters: input.location?.accuracyMeters,
    productionPath: input.productionPath,
    dotEvidence: input.dotEvidence,
    legacyEvidence: input.legacyEvidence,
  };
  const productEligible = evaluateProductPathEligibility(eligibilityInput).eligible === true;
  const shadowEligible = evaluatePreSourceEligibility(eligibilityInput).eligible === true;
  if (!productEligible && !shadowEligible) return productionResult;

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
  let executionResult = null;

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
    executionResult = await boundedShadow(() => runShadow({
      location: input.location,
      legacyEvidence: input.legacyEvidence,
      cohort: executionCohort(config, productEligible),
      signal: controller.signal,
      dependencies: {
        ...sources,
        blockfaceResolver,
        officialRelationshipProvider,
      },
    }), OVERALL_DEADLINE_MS, controller);
  } catch {
    // Observational and product overlay failures must never replace the callable result.
  }

  if (productEligible && typeof options.applyProductOverlay === 'function') {
    try {
      const decision = decideProductPresentation(executionResult);
      await options.applyProductOverlay(productionResult, decision, executionResult);
    } catch {
      // Overlay is fail-open. Legacy production result remains.
    }
  }

  return productionResult;
}

module.exports = { observePrivateResolverShadow };
