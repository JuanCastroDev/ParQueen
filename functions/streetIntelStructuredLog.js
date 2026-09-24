'use strict';

function loadFunctionsLogger() {
  try {
    return require('firebase-functions').logger;
  } catch {
    return null;
  }
}

/**
 * Production Street Intelligence events must be objects so Cloud Logging
 * indexes jsonPayload.event / jsonPayload.domain. Test seams still receive
 * a JSON string so existing parsers keep working.
 */
function emitStructuredLog(payload, write, logger) {
  if (typeof write === 'function') {
    write(JSON.stringify(payload));
    return;
  }
  const sink = logger || loadFunctionsLogger();
  if (sink && typeof sink.info === 'function') {
    sink.info(payload);
    return;
  }
  console.log(JSON.stringify(payload));
}

module.exports = { emitStructuredLog };
