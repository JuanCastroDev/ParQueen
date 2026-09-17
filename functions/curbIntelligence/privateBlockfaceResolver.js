'use strict';

const BOROUGHS = new Set(['MANHATTAN', 'BRONX', 'BROOKLYN', 'QUEENS', 'STATEN ISLAND']);
const DIRECTIONS = new Set(['N', 'S', 'E', 'W']);
const REQUIRED_FIELDS = ['borough', 'onStreet', 'crossStreetOne', 'crossStreetTwo', 'compassDirection'];
const ALLOWED_FIELDS = new Set([...REQUIRED_FIELDS, 'signal']);
const STREET_FIELDS = ['onStreet', 'crossStreetOne', 'crossStreetTwo'];
const SUCCESS_FIELDS = new Set([
  'ok', 'officialBlockFaceId', 'normalizedStreetNames', 'returnCode', 'reasonCode', 'sourceVersion',
]);
const NAME_FIELDS = new Set(STREET_FIELDS);
const VERSION_FIELDS = new Set(['geosupportRelease', 'geosupportVersion']);
const BFI = /^\d{10}$/;
const RETURN_CODE = /^[A-Z0-9 ]{2}$/;
const REASON_CODE = /^[A-Z0-9 ]$/;

const failure = failureClass => ({ ok: false, failureClass });

function sameFields(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every(key => expected.has(key));
}

function validPrintableAscii(value, maxBytes = 32) {
  if (typeof value !== 'string' || !value || value !== value.trim()) return false;
  if (Buffer.byteLength(value, 'utf8') > maxBytes) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function parseTuple(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.some(key => !ALLOWED_FIELDS.has(key))
    || REQUIRED_FIELDS.some(key => !Object.hasOwn(value, key))) return null;
  if (!BOROUGHS.has(value.borough) || !DIRECTIONS.has(value.compassDirection)) return null;
  if (STREET_FIELDS.some(field => !validPrintableAscii(value[field]))) return null;
  if (value.signal !== undefined
    && (!value.signal || typeof value.signal !== 'object' || typeof value.signal.aborted !== 'boolean')) return null;
  return {
    payload: Object.fromEntries(REQUIRED_FIELDS.map(field => [field, value[field]])),
    signal: value.signal,
  };
}

function validVersion(value) {
  return sameFields(value, VERSION_FIELDS)
    && validPrintableAscii(value.geosupportRelease, 128)
    && validPrintableAscii(value.geosupportVersion, 128);
}

function validNames(value) {
  return sameFields(value, NAME_FIELDS)
    && STREET_FIELDS.every(field => validPrintableAscii(value[field]));
}

function parseSuccess(value) {
  if (!sameFields(value, SUCCESS_FIELDS) || value.ok !== true || value.returnCode !== '00') return null;
  if (typeof value.officialBlockFaceId !== 'string'
    || !BFI.test(value.officialBlockFaceId)
    || value.officialBlockFaceId === '0000000000') return null;
  if (!REASON_CODE.test(value.reasonCode) || !validNames(value.normalizedStreetNames)
    || !validVersion(value.sourceVersion)) return null;
  return {
    ok: true,
    officialBlockFaceId: value.officialBlockFaceId,
    normalizedStreetNames: { ...value.normalizedStreetNames },
    returnCode: value.returnCode,
    reasonCode: value.reasonCode,
    sourceVersion: { ...value.sourceVersion },
  };
}

function parseSafeRejection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.ok !== false || value.failureClass !== 'NOT_AUTHORITATIVE'
    || !RETURN_CODE.test(value.returnCode) || value.returnCode === '00'
    || !REASON_CODE.test(value.reasonCode)) return null;
  return {
    ok: false,
    returnCode: value.returnCode,
    reasonCode: value.reasonCode,
    failureClass: 'NOT_AUTHORITATIVE',
  };
}

function httpFailure(status) {
  if (status === 400) return failure('INVALID_REQUEST');
  if (status === 401 || status === 403) return failure('AUTHENTICATION_FAILURE');
  if (status === 404) return failure('ROUTING_FAILURE');
  if (status === 429) return failure('SATURATED');
  return failure('UPSTREAM_UNAVAILABLE');
}

function transportFailure(error) {
  if (error?.name === 'AbortError') return failure('ABORTED');
  if (error?.name === 'TimeoutError') return failure('TIMEOUT');
  return failure('UPSTREAM_UNAVAILABLE');
}

function normalizeServiceUrl(value) {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname.endsWith('.run.app')
      || url.username || url.password || url.search || url.hash
      || (url.pathname !== '/' && url.pathname !== '')) return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function defaultGetIdToken(audience) {
  const { GoogleAuth } = require('google-auth-library');
  const client = await new GoogleAuth().getIdTokenClient(audience);
  const headers = await client.getRequestHeaders();
  const authorization = typeof headers?.get === 'function'
    ? headers.get('authorization') : headers?.Authorization || headers?.authorization;
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    throw new Error('identity_token_unavailable');
  }
  return authorization.slice('Bearer '.length);
}

async function defaultTransport(request) {
  return fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
    redirect: 'error',
  });
}

function createPrivateBlockfaceResolver(options = {}) {
  const enabled = options.mode === 'shadow';
  const serviceUrl = enabled ? normalizeServiceUrl(options.serviceUrl) : null;
  const getIdToken = options.getIdToken || defaultGetIdToken;
  const transport = options.transport || defaultTransport;
  const requests = new Map();

  async function attempt(parsed) {
    if (parsed.signal?.aborted) return failure('ABORTED');
    let token;
    try {
      token = await getIdToken(serviceUrl);
    } catch {
      return failure('AUTHENTICATION_FAILURE');
    }
    if (typeof token !== 'string' || !token) return failure('AUTHENTICATION_FAILURE');
    if (parsed.signal?.aborted) return failure('ABORTED');

    let response;
    try {
      response = await transport({
        url: `${serviceUrl}/resolve-blockface`,
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(parsed.payload),
        signal: parsed.signal,
      });
    } catch (error) {
      return transportFailure(error);
    }
    if (!response || response.status !== 200) return httpFailure(response?.status);

    let value;
    try {
      value = JSON.parse(await response.text());
    } catch {
      return failure('INVALID_RESPONSE');
    }
    if (value?.ok === false) return parseSafeRejection(value) || failure('INVALID_RESPONSE');
    return parseSuccess(value) || failure('INVALID_RESPONSE');
  }

  return Object.freeze({
    resolve(value) {
      if (!enabled) return Promise.resolve(failure('DISABLED'));
      if (!serviceUrl) return Promise.resolve(failure('CONFIGURATION_FAILURE'));
      const parsed = parseTuple(value);
      if (!parsed) return Promise.resolve(failure('INVALID_REQUEST'));
      const key = REQUIRED_FIELDS.map(field => parsed.payload[field]).join(' | ');
      if (!requests.has(key)) requests.set(key, attempt(parsed));
      return requests.get(key);
    },
  });
}

module.exports = { createPrivateBlockfaceResolver };
