'use strict';

// CommonJS entry for Node require() callers (Functions integration tests).
// No logic here: Node 22 loads the ES module implementation via require(esm),
// so commitToHeadingDecision.mjs stays the single source of truth.
module.exports = require('./commitToHeadingDecision.mjs');
