'use strict';

function loadCanonicalV2Modules() {
  const { runCanonicalCurbOrchestrator } = require('./canonicalCurbOrchestrator');
  const { createCsclCandidateStore } = require('./csclSocrataAdapter');
  const { createPlanimetricCurbStore } = require('./planimetricCurbAdapter');
  const { createParkNycCandidateStore } = require('./parkNycSocrataAdapter');
  const { createPrivateBlockfaceResolver } = require('./privateBlockfaceResolver');
  const { readPrivateResolverConfig } = require('./privateBlockfaceResolverConfig');
  const { createCurbTelemetry } = require('./curbTelemetry');
  return Object.freeze({
    runCanonicalCurbOrchestrator,
    createCsclCandidateStore,
    createPlanimetricCurbStore,
    createParkNycCandidateStore,
    createPrivateBlockfaceResolver,
    readPrivateResolverConfig,
    createCurbTelemetry,
  });
}

function createCanonicalV2ModuleLoader(loadModules = loadCanonicalV2Modules) {
  let modules = null;
  const initialize = () => {
    if (!modules) modules = loadModules();
    return modules;
  };
  return Object.freeze({ initialize, get: initialize });
}

function selectCanonicalV2Handler(requestData, hook, fallback) {
  if (requestData?.protocolVersion !== 2) return null;
  return typeof hook === 'function' ? hook : fallback;
}

module.exports = {
  createCanonicalV2ModuleLoader,
  loadCanonicalV2Modules,
  selectCanonicalV2Handler,
};
