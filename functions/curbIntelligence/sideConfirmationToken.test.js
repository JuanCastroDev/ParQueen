import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import {
  SIDE_CONFIRMATION_TOKEN_BODY_MAX,
  SIDE_CONFIRMATION_TOKEN_BODY_MIN,
  SIDE_CONFIRMATION_TOKEN_MAX_LENGTH,
} from '../../utils/sideConfirmationTokenLimits';

const require = createRequire(import.meta.url);
const {
  SIDE_CONFIRMATION_TOKEN_BODY_MAX: SERVER_BODY_MAX,
  SIDE_CONFIRMATION_TOKEN_BODY_MIN: SERVER_BODY_MIN,
  SIDE_CONFIRMATION_TOKEN_MAX_LENGTH: SERVER_MAX,
  TOKEN_LIFETIME_MS,
  inspectSideConfirmationToken,
  issueSideConfirmationToken,
  parseSideConfirmationToken,
  readConfiguredSideConfirmationHmacKey,
} = require('./sideConfirmationToken');

const KEY = 'side-confirmation-test-key-0123456789ab';
const OTHER_KEY = 'another-isolated-test-key-0123456789abcd';
const NOW = 1_700_000_000_000;
const FACE = '1000000001';
const claims = {
  uid: 'driver-1',
  authorityDigest: 'a'.repeat(64),
  officialBlockFaceId: FACE,
  publicCurbKey: `curb2_${'b'.repeat(32)}`,
  csclSide: 'LEFT',
  rank: 0,
};
const binding = { key: KEY, now: NOW, uid: claims.uid, officialBlockFaceId: FACE };

function bodyOf(token) {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

describe('side confirmation HMAC tokens', () => {
  it('signs a five-minute token without putting the uid or block face in the body', () => {
    const token = issueSideConfirmationToken(claims, { key: KEY, now: NOW, nonce: 'c'.repeat(32) });
    expect(token.startsWith('sidec1.')).toBe(true);
    expect(token).not.toContain(KEY);
    expect(token).not.toContain(claims.uid);
    expect(token).not.toContain(FACE);
    const decoded = bodyOf(token);
    expect(decoded).not.toHaveProperty('uid');
    expect(decoded).not.toHaveProperty('officialBlockFaceId');
    const accepted = inspectSideConfirmationToken(token, {
      ...binding, now: NOW + TOKEN_LIFETIME_MS - 1,
    });
    expect(accepted.ok).toBe(true);
    expect(accepted.visible.authorityDigest).toBe(claims.authorityDigest);
    expect(accepted.visible).not.toHaveProperty('uid');
    expect(inspectSideConfirmationToken(token, { ...binding, now: NOW + TOKEN_LIFETIME_MS }))
      .toEqual({ ok: false, reason: 'expired' });
    expect(inspectSideConfirmationToken(token, { ...binding, now: NOW - 1 }))
      .toEqual({ ok: false, reason: 'future_dated' });
  });

  it('uses the same maximum for the issuer and the client parser', () => {
    expect(SERVER_BODY_MIN).toBe(SIDE_CONFIRMATION_TOKEN_BODY_MIN);
    expect(SERVER_BODY_MAX).toBe(SIDE_CONFIRMATION_TOKEN_BODY_MAX);
    expect(SERVER_MAX).toBe(SIDE_CONFIRMATION_TOKEN_MAX_LENGTH);
    const longestUid = 'U'.repeat(128);
    const longest = issueSideConfirmationToken({
      ...claims,
      uid: longestUid,
      csclSide: 'RIGHT',
      rank: 1,
    }, { key: KEY, now: Number.MAX_SAFE_INTEGER, nonce: 'f'.repeat(32) });
    expect(longest.length).toBe(SERVER_MAX);
    expect(longest.length).toBeLessThanOrEqual(SIDE_CONFIRMATION_TOKEN_MAX_LENGTH);
    expect(longest).not.toContain(longestUid);
    expect(inspectSideConfirmationToken(longest, {
      key: KEY,
      now: Number.MAX_SAFE_INTEGER,
      uid: longestUid,
      officialBlockFaceId: FACE,
    }).ok).toBe(true);
  });

  it('rejects a modified MAC, another user, another block face, and a noncanonical body', () => {
    const token = issueSideConfirmationToken(claims, { key: KEY, now: NOW, nonce: 'd'.repeat(32) });
    const flipped = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
    expect(inspectSideConfirmationToken(flipped, binding).reason).toBe('invalid_signature');
    const [prefix, body, mac] = token.split('.');
    const parsed = bodyOf(token);
    parsed.authorityDigest = 'e'.repeat(64);
    const changed = `${prefix}.${Buffer.from(JSON.stringify(parsed)).toString('base64url')}.${mac}`;
    expect(inspectSideConfirmationToken(changed, binding).reason).toBe('invalid_signature');
    expect(inspectSideConfirmationToken(token, { ...binding, key: OTHER_KEY }).reason)
      .toBe('invalid_signature');
    expect(inspectSideConfirmationToken(token, { ...binding, uid: 'driver-2' }).reason)
      .toBe('invalid_signature');
    expect(inspectSideConfirmationToken(token, { ...binding, officialBlockFaceId: '1000000002' }).reason)
      .toBe('invalid_signature');
    const spaced = `${prefix}.${Buffer.from(Buffer.from(body, 'base64url').toString('utf8').replace('{', '{ ')).toString('base64url')}.${mac}`;
    expect(parseSideConfirmationToken(spaced, { now: NOW })).toEqual({ ok: false, reason: 'malformed' });
    expect(parseSideConfirmationToken(`${token}A`, { now: NOW }).reason).toBe('malformed');
    expect(parseSideConfirmationToken('A'.repeat(SERVER_MAX + 1), { now: NOW }).reason).toBe('oversized');
    expect(parseSideConfirmationToken('sidec1.not-token.not-a-mac', { now: NOW }).reason).toBe('malformed');
    expect(inspectSideConfirmationToken('candidate2_abcdef0123456789_0123456789abcdef0123456789abcdef', binding).reason)
      .toBe('malformed');
  });

  it('fails closed when the configured key is missing or too short', () => {
    expect(readConfiguredSideConfirmationHmacKey({})).toBeNull();
    expect(readConfiguredSideConfirmationHmacKey({ CURB_SIDE_CONFIRMATION_HMAC_KEY: 'short' })).toBeNull();
    expect(readConfiguredSideConfirmationHmacKey({
      CURB_SIDE_CONFIRMATION_HMAC_KEY: '-----BEGIN PRIVATE KEY-----\nnot-a-side-confirmation-key',
    })).toBeNull();
    expect(issueSideConfirmationToken(claims, { key: 'short', now: NOW })).toBeNull();
    expect(inspectSideConfirmationToken('sidec1.aaaa.bbbb', { now: NOW, uid: 'driver-1', officialBlockFaceId: FACE }).reason)
      .toBe('key_unavailable');
    const configured = readConfiguredSideConfirmationHmacKey({ CURB_SIDE_CONFIRMATION_HMAC_KEY: KEY });
    expect(configured.equals(Buffer.from(KEY, 'utf8'))).toBe(true);
  });
});
