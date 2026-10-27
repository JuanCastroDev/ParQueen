'use strict';

/**
 * Fail closed when the Functions runtime did not attach a verified App Check
 * app id. Production enforcement is `enforceAppCheck: true` on the callable.
 * This guard is the same missing-token condition, so a direct handler call
 * cannot enter Street Intelligence before the platform check runs.
 */
function streetIntelligenceAppCheckRejection(request) {
  const appId = request?.app?.appId;
  return typeof appId !== 'string' || appId.length === 0 || appId.length > 256;
}

module.exports = { streetIntelligenceAppCheckRejection };
