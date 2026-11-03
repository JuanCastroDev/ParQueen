'use strict';

const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');

// sidec1 body is the visible claim set only. The authenticated UID and the
// official block-face id are MAC inputs, not token fields. The length ceiling
// is the longest canonical token those bounded fields can produce.
const TOKEN_FORMAT = 'sidec1';
const TOKEN_PURPOSE = 'side-confirmation';
const TOKEN_LIFETIME_MS = 5 * 60 * 1000;
const KEY_MIN_BYTES = 32;
const MAC_LENGTH = 43;
const VISIBLE_KEYS = Object.freeze([
  'authorityDigest',
  'csclSide',
  'format',
  'issuedAt',
  'nonce',
  'publicCurbKey',
  'purpose',
  'rank',
]);

function reject(reason) {
  return { ok: false, reason };
}

function normalizeHmacKey(value) {
  if (Buffer.isBuffer(value)) return value.length >= KEY_MIN_BYTES ? value : null;
  if (typeof value !== 'string') return null;
  const secret = value.trim();
  if (secret.length < KEY_MIN_BYTES) return null;
  if (secret.includes('PRIVATE KEY') || secret.includes('BEGIN ')) return null;
  return Buffer.from(secret, 'utf8');
}

function readConfiguredSideConfirmationHmacKey(env = process.env) {
  return normalizeHmacKey(env?.CURB_SIDE_CONFIRMATION_HMAC_KEY);
}

function canonicalVisible(claims) {
  const authorityDigest = typeof claims?.authorityDigest === 'string'
    && /^[a-f0-9]{64}$/.test(claims.authorityDigest) ? claims.authorityDigest : null;
  const csclSide = claims?.csclSide === 'LEFT' || claims?.csclSide === 'RIGHT' ? claims.csclSide : null;
  const publicCurbKey = typeof claims?.publicCurbKey === 'string'
    && /^curb2_[a-f0-9]{32}$/.test(claims.publicCurbKey) ? claims.publicCurbKey : null;
  const rank = claims?.rank === 0 || claims?.rank === 1 ? claims.rank : null;
  const issuedAt = Number.isSafeInteger(claims?.issuedAt) && claims.issuedAt > 0 ? claims.issuedAt : null;
  const nonce = typeof claims?.nonce === 'string' && /^[a-f0-9]{32}$/.test(claims.nonce) ? claims.nonce : null;
  if (!authorityDigest || !csclSide || !publicCurbKey || rank === null || !issuedAt || !nonce) return null;
  return {
    authorityDigest,
    csclSide,
    format: TOKEN_FORMAT,
    issuedAt,
    nonce,
    publicCurbKey,
    purpose: TOKEN_PURPOSE,
    rank,
  };
}

function authenticatedBinding(binding) {
  const uid = typeof binding?.uid === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(binding.uid)
    ? binding.uid : null;
  const officialBlockFaceId = typeof binding?.officialBlockFaceId === 'string'
    && /^[0-9]{10}$/.test(binding.officialBlockFaceId) ? binding.officialBlockFaceId : null;
  if (!uid || !officialBlockFaceId) return null;
  return { officialBlockFaceId, uid };
}

function macBytes(visible, binding) {
  const authenticated = authenticatedBinding(binding);
  if (!visible || !authenticated) return null;
  return Buffer.from(JSON.stringify({
    authorityDigest: visible.authorityDigest,
    csclSide: visible.csclSide,
    format: visible.format,
    issuedAt: visible.issuedAt,
    nonce: visible.nonce,
    officialBlockFaceId: authenticated.officialBlockFaceId,
    publicCurbKey: visible.publicCurbKey,
    purpose: visible.purpose,
    rank: visible.rank,
    uid: authenticated.uid,
  }), 'utf8');
}

function encodeToken(visible, mac) {
  return `${TOKEN_FORMAT}.${Buffer.from(JSON.stringify(visible), 'utf8').toString('base64url')}.${mac}`;
}

function extremeVisible(issuedAt, csclSide, rank) {
  return canonicalVisible({
    authorityDigest: 'f'.repeat(64),
    csclSide,
    issuedAt,
    nonce: 'f'.repeat(32),
    publicCurbKey: `curb2_${'f'.repeat(32)}`,
    rank,
  });
}

const SIDE_CONFIRMATION_TOKEN_BODY_MIN = Buffer.from(JSON.stringify(
  extremeVisible(1, 'LEFT', 0),
), 'utf8').toString('base64url').length;
const SIDE_CONFIRMATION_TOKEN_BODY_MAX = Buffer.from(JSON.stringify(
  extremeVisible(Number.MAX_SAFE_INTEGER, 'RIGHT', 1),
), 'utf8').toString('base64url').length;
const SIDE_CONFIRMATION_TOKEN_MAX_LENGTH = TOKEN_FORMAT.length + 1
  + SIDE_CONFIRMATION_TOKEN_BODY_MAX + 1 + MAC_LENGTH;

function decodeBase64Url(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64url');
  if (!bytes.length || bytes.toString('base64url') !== value) return null;
  return bytes;
}

function macMatches(key, payload, presented) {
  const actual = decodeBase64Url(presented);
  const expected = createHmac('sha256', key).update(payload).digest();
  if (!actual || actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

function isSideConfirmationToken(token) {
  return typeof token === 'string' && token.startsWith(`${TOKEN_FORMAT}.`);
}

function issueSideConfirmationToken(claims, options = {}) {
  const key = normalizeHmacKey(options.key);
  const issuedAt = Number.isSafeInteger(options.now) ? options.now : null;
  const nonce = typeof options.nonce === 'string' && /^[a-f0-9]{32}$/.test(options.nonce)
    ? options.nonce
    : randomBytes(16).toString('hex');
  const visible = canonicalVisible({ ...claims, issuedAt, nonce });
  const payload = macBytes(visible, claims);
  if (!key || !payload) return null;
  const token = encodeToken(visible, createHmac('sha256', key).update(payload).digest('base64url'));
  if (token.length > SIDE_CONFIRMATION_TOKEN_MAX_LENGTH) return null;
  return token;
}

function parseSideConfirmationToken(token, options = {}) {
  if (typeof token !== 'string' || token.length > SIDE_CONFIRMATION_TOKEN_MAX_LENGTH) {
    return reject('oversized');
  }
  if (!isSideConfirmationToken(token)) return reject('malformed');
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_FORMAT) return reject('malformed');
  if (parts[1].length < SIDE_CONFIRMATION_TOKEN_BODY_MIN
    || parts[1].length > SIDE_CONFIRMATION_TOKEN_BODY_MAX
    || parts[2].length !== MAC_LENGTH) return reject('malformed');
  const payload = decodeBase64Url(parts[1]);
  if (!payload) return reject('malformed');
  let parsed;
  try {
    parsed = JSON.parse(payload.toString('utf8'));
  } catch {
    return reject('malformed');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return reject('malformed');
  if (Object.keys(parsed).length !== VISIBLE_KEYS.length
    || VISIBLE_KEYS.some(field => !Object.prototype.hasOwnProperty.call(parsed, field))) {
    return reject('malformed');
  }
  if (parsed.format !== TOKEN_FORMAT || parsed.purpose !== TOKEN_PURPOSE) return reject('malformed');
  if (Object.prototype.hasOwnProperty.call(parsed, 'uid')
    || Object.prototype.hasOwnProperty.call(parsed, 'officialBlockFaceId')) return reject('malformed');
  const visible = canonicalVisible(parsed);
  if (!visible || !Buffer.from(JSON.stringify(visible), 'utf8').equals(payload)) return reject('malformed');
  const now = Number.isSafeInteger(options.now) ? options.now : Date.now();
  if (visible.issuedAt > now) return reject('future_dated');
  if (now - visible.issuedAt >= TOKEN_LIFETIME_MS) return reject('expired');
  return { ok: true, visible, mac: parts[2] };
}

function inspectSideConfirmationToken(token, options = {}) {
  const key = normalizeHmacKey(options.key);
  if (!key) return reject('key_unavailable');
  const parsed = parseSideConfirmationToken(token, options);
  if (!parsed.ok) return parsed;
  const payload = macBytes(parsed.visible, options);
  if (!payload || !macMatches(key, payload, parsed.mac)) return reject('invalid_signature');
  return { ok: true, visible: parsed.visible };
}

module.exports = {
  MAC_LENGTH,
  SIDE_CONFIRMATION_TOKEN_BODY_MAX,
  SIDE_CONFIRMATION_TOKEN_BODY_MIN,
  SIDE_CONFIRMATION_TOKEN_MAX_LENGTH,
  TOKEN_FORMAT,
  TOKEN_LIFETIME_MS,
  TOKEN_PURPOSE,
  inspectSideConfirmationToken,
  isSideConfirmationToken,
  issueSideConfirmationToken,
  normalizeHmacKey,
  parseSideConfirmationToken,
  readConfiguredSideConfirmationHmacKey,
};
