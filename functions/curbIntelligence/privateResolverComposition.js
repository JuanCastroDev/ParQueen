'use strict';

const { createOfficialDotRelationshipProvider } = require('./officialDotRelationshipProvider');
const { createPrivateBlockfaceResolver } = require('./privateBlockfaceResolver');
const { readPrivateResolverConfig } = require('./privateBlockfaceResolverConfig');
const { DEFAULT_EXECUTION_POLICY, runCurbIntelligenceShadow } = require('./shadowExecution');
const { createNoopShadowSink } = require('./shadowTelemetry');

function reviewedSources(value) {
  return value
    && typeof value.curbCandidateStore?.queryCandidates === 'function'
    && typeof value.dotSource?.query === 'function'
    && typeof value.parkNycSource?.query === 'function';
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

  const sourceDependenciesFactory = options.sourceDependenciesFactory || (() => null);
  let sources;
  try {
    sources = sourceDependenciesFactory();
  } catch {
    return productionResult;
  }
  if (!reviewedSources(sources)) return productionResult;

  const resolverFactory = options.resolverFactory || createPrivateBlockfaceResolver;
  const relationshipProviderFactory = options.relationshipProviderFactory
    || createOfficialDotRelationshipProvider;
  const runShadow = options.runShadow || runCurbIntelligenceShadow;

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
    await runShadow({
      location: input.location,
      legacyEvidence: input.legacyEvidence,
      dependencies: {
        ...sources,
        blockfaceResolver,
        officialRelationshipProvider,
        sink: createNoopShadowSink(),
      },
      executionPolicy: DEFAULT_EXECUTION_POLICY,
    });
  } catch {
    // Shadow evidence is observational. It must never affect the callable.
  }

  return productionResult;
}

module.exports = { observePrivateResolverShadow };
