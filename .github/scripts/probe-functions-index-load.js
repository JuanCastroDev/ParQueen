'use strict';

/**
 * Bounded CI probe: require functions/index.js and exit.
 * Prints no env, secret, or payload values. process.exit is required so
 * firebase-admin / gRPC handles cannot keep the Node process alive.
 */
const path = require('path');

console.log('FUNCTIONS_INDEX_LOAD_START');
require(path.join(__dirname, '..', '..', 'functions', 'index.js'));
console.log('FUNCTIONS_INDEX_LOAD_OK');
process.exit(0);
