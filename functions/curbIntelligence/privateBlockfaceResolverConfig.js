'use strict';

const { defineString } = require('firebase-functions/params');

const curbResolverMode = defineString('CURB_RESOLVER_MODE', { default: 'off' });
const curbResolverUrl = defineString('CURB_RESOLVER_URL', { default: '' });
const curbShadowSamplePermille = defineString('CURB_SHADOW_SAMPLE_PERMILLE', { default: '0' });

function parseSamplePermille(value) {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return 0;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 1000 ? parsed : 0;
}

function readPrivateResolverConfig(parameters = {}) {
  const mode = (parameters.mode || curbResolverMode).value();
  if (mode !== 'shadow') return { mode: 'off', serviceUrl: '', samplePermille: 0 };
  const serviceUrl = (parameters.url || curbResolverUrl).value();
  const samplePermille = parseSamplePermille(
    (parameters.samplePermille || curbShadowSamplePermille).value(),
  );
  return {
    mode: 'shadow',
    serviceUrl: typeof serviceUrl === 'string' ? serviceUrl : '',
    samplePermille,
  };
}

module.exports = {
  curbResolverMode,
  curbResolverUrl,
  curbShadowSamplePermille,
  readPrivateResolverConfig,
};
