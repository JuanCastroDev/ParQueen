'use strict';

const { normalizeBlockFaceId } = require('./curbIdentity');
const { CURB_RESOLUTION_POLICY } = require('./curbResolutionPolicy');
const { runCanonicalDotLookup } = require('./canonicalDotLookup');
const { runCanonicalMeterLookup } = require('./productMeterLookup');
const { selectRuleSet } = require('./ruleConflictPolicy');
const { childBudgetMs } = require('./requestDeadline');

const unavailable = reason => ({ state: 'unavailable', reason, rules: [], product: null });

function validIdentity(identity) {
  return identity?.schemaVersion === 2 && identity?.jurisdiction === 'NYC'
    && Boolean(normalizeBlockFaceId(identity.officialBlockFaceId));
}

async function boundedLookup(lookup, input, options) {
  const controller = new AbortController();
  let finishAbort;
  const aborted = new Promise(resolve => { finishAbort = resolve; });
  const abort = () => {
    controller.abort();
    finishAbort(unavailable('execution_timeout'));
  };
  input.signal?.addEventListener('abort', abort, { once: true });
  const budget = childBudgetMs(CURB_RESOLUTION_POLICY.sourceDeadlineMs, {
    deadlineAt: options.deadlineAt ?? input.deadlineAt,
    signal: input.signal,
  });
  if (budget <= 0) {
    abort();
    return Promise.resolve(unavailable('execution_timeout')).finally(() => {
      input.signal?.removeEventListener('abort', abort);
    });
  }
  const timer = setTimeout(abort, budget);
  const task = Promise.resolve().then(() => lookup({
    identity: input.identity,
    signal: controller.signal,
  }, options)).catch(() => unavailable('source_unavailable'));
  return Promise.race([task, aborted]).finally(() => {
    clearTimeout(timer);
    input.signal?.removeEventListener('abort', abort);
  });
}

async function loadCanonicalRules(identity, options = {}) {
  if (!validIdentity(identity)) {
    return { state: 'unsupported', reason: 'canonical_identity_required' };
  }
  const sourceInput = { identity, signal: options.signal, deadlineAt: options.deadlineAt };
  const dotLookup = options.dotLookup || runCanonicalDotLookup;
  const parkNycLookup = options.parkNycLookup || runCanonicalMeterLookup;
  const adminLookup = options.adminLookup || (async () => ({ state: 'complete', rules: [] }));
  const [dot, parkNyc, admin] = await Promise.all([
    boundedLookup(dotLookup, sourceInput, options),
    boundedLookup(parkNycLookup, sourceInput, options),
    boundedLookup(adminLookup, sourceInput, options),
  ]);
  const sources = { dot, parkNyc, admin };
  return { state: 'complete', sources, selected: selectRuleSet(sources) };
}

module.exports = { loadCanonicalRules };
