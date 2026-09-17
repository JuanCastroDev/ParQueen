'use strict';

const { defineString } = require('firebase-functions/params');

const curbResolverMode = defineString('CURB_RESOLVER_MODE', { default: 'off' });
const curbResolverUrl = defineString('CURB_RESOLVER_URL', { default: '' });

function readPrivateResolverConfig(parameters = {}) {
  const mode = (parameters.mode || curbResolverMode).value();
  if (mode !== 'shadow') return { mode: 'off', serviceUrl: '' };
  const serviceUrl = (parameters.url || curbResolverUrl).value();
  return { mode: 'shadow', serviceUrl: typeof serviceUrl === 'string' ? serviceUrl : '' };
}

module.exports = { curbResolverMode, curbResolverUrl, readPrivateResolverConfig };
