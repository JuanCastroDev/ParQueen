import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { exchangePhoneAuthSessionHandler, AUTH_BRIDGE_SERVICE_ACCOUNT } = require('./exchangePhoneAuthSession');

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(resolve(HERE, 'index.js'), 'utf8');
const HANDLER_SRC = readFileSync(resolve(HERE, 'exchangePhoneAuthSession.js'), 'utf8');

function authed(uid, provider, data, authTime = Math.floor(Date.now() / 1000)) {
  const token = { firebase: { sign_in_provider: provider } };
  if (authTime !== null) token.auth_time = authTime;
  return {
    auth: { uid, token },
    data,
  };
}

function deps(createCustomToken = vi.fn(async (uid) => `token-for-${uid}`)) {
  return {
    checkRateLimit: vi.fn(async () => {}),
    createCustomToken,
  };
}

describe('exchangePhoneAuthSession', () => {
  it('rejects an unauthenticated caller', async () => {
    const bridge = deps();
    await expect(exchangePhoneAuthSessionHandler({ data: {} }, bridge)).rejects.toMatchObject({
      code: 'unauthenticated',
    });
    expect(bridge.createCustomToken).not.toHaveBeenCalled();
  });

  it('rejects a non-phone sign-in provider', async () => {
    const bridge = deps();
    await expect(
      exchangePhoneAuthSessionHandler(authed('uid-1', 'password', {}), bridge),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(bridge.createCustomToken).not.toHaveBeenCalled();
  });

  it('mints only request.auth.uid when the body names a different UID', async () => {
    const createCustomToken = vi.fn(async (uid) => `token-for-${uid}`);
    const bridge = deps(createCustomToken);
    const result = await exchangePhoneAuthSessionHandler(
      authed('uid-real', 'phone', { uid: 'uid-attacker', expectedUid: 'uid-real' }),
      bridge,
    );
    expect(createCustomToken).toHaveBeenCalledTimes(1);
    expect(createCustomToken).toHaveBeenCalledWith('uid-real');
    expect(result).toEqual({ token: 'token-for-uid-real' });
  });

  it('rejects an expectedUid that does not match the authenticated UID', async () => {
    const bridge = deps();
    await expect(
      exchangePhoneAuthSessionHandler(authed('uid-real', 'phone', { expectedUid: 'uid-other' }), bridge),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(bridge.createCustomToken).not.toHaveBeenCalled();
  });

  it('rejects an empty or non-string expectedUid', async () => {
    const bridge = deps();
    await expect(
      exchangePhoneAuthSessionHandler(authed('uid-real', 'phone', { expectedUid: '' }), bridge),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(
      exchangePhoneAuthSessionHandler(authed('uid-real', 'phone', { expectedUid: 12 }), bridge),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(bridge.createCustomToken).not.toHaveBeenCalled();
  });

  it('runs the rate limiter for the authenticated UID before minting', async () => {
    const bridge = deps();
    await exchangePhoneAuthSessionHandler(authed('uid-real', 'phone', {}), bridge);
    expect(bridge.checkRateLimit).toHaveBeenCalledWith(
      'uid-real',
      'exchangePhoneAuthSession',
      { limit: 8, windowSec: 600 },
    );
  });

  it('mints a token for a phone session authenticated within 120 seconds', async () => {
    const nowMs = 1_700_000_000_000;
    const bridge = deps();
    bridge.now = () => nowMs;
    const result = await exchangePhoneAuthSessionHandler(
      authed('uid-real', 'phone', { auth_time: 1 }, nowMs / 1000 - 30),
      bridge,
    );
    expect(result).toEqual({ token: 'token-for-uid-real' });
    expect(bridge.createCustomToken).toHaveBeenCalledWith('uid-real');
  });

  it('rejects a missing, stale, future, or malformed auth_time without minting', async () => {
    const nowMs = 1_700_000_000_000;
    const nowSec = nowMs / 1000;
    const cases = [
      authed('uid-real', 'phone', {}, null),
      authed('uid-real', 'phone', {}, nowSec - 121),
      authed('uid-real', 'phone', {}, nowSec + 31),
      authed('uid-real', 'phone', {}, Number.NaN),
      authed('uid-real', 'phone', {}, Number.POSITIVE_INFINITY),
      authed('uid-real', 'phone', {}, '1700000000'),
    ];
    for (const request of cases) {
      const bridge = deps();
      bridge.now = () => nowMs;
      await expect(exchangePhoneAuthSessionHandler(request, bridge)).rejects.toMatchObject({
        code: 'failed-precondition',
      });
      expect(bridge.createCustomToken).not.toHaveBeenCalled();
    }
  });

  it('ignores auth_time supplied in the request body', async () => {
    const nowMs = 1_700_000_000_000;
    const bridge = deps();
    bridge.now = () => nowMs;
    await expect(
      exchangePhoneAuthSessionHandler(
        authed('uid-real', 'phone', { auth_time: nowMs / 1000 }, nowMs / 1000 - 500),
        bridge,
      ),
    ).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(bridge.createCustomToken).not.toHaveBeenCalled();
    expect(HANDLER_SRC).not.toContain('data.auth_time');
  });

  it('does not log the token and declares the dedicated service account', () => {
    expect(HANDLER_SRC).not.toMatch(/console\.(log|info|debug|warn|error)/);
    const start = INDEX_SRC.indexOf('exports.exchangePhoneAuthSession');
    const block = INDEX_SRC.slice(start, INDEX_SRC.indexOf(');', start));
    expect(block).toContain('enforceAppCheck: false');
    expect(block).toContain('serviceAccount: AUTH_BRIDGE_SERVICE_ACCOUNT');
    expect(HANDLER_SRC).toContain(AUTH_BRIDGE_SERVICE_ACCOUNT);
    expect(block).toContain('exchangePhoneAuthSessionHandler');
    expect(block).not.toContain('request.data.uid');
    for (const name of ['deleteChat', 'updateDisplayName', 'adminReadView', 'checkHydrantDistance']) {
      const fnStart = INDEX_SRC.indexOf(`exports.${name}`);
      const marker = INDEX_SRC.indexOf('enforceAppCheck:', fnStart);
      expect(INDEX_SRC.slice(marker, marker + 40)).toMatch(/^enforceAppCheck:\s*true/);
    }
    const sendStart = INDEX_SRC.indexOf('exports.sendMessage');
    const sendMarker = INDEX_SRC.indexOf('enforceAppCheck:', sendStart);
    expect(INDEX_SRC.slice(sendMarker, sendMarker + 40)).toMatch(/^enforceAppCheck:\s*false/);
  });
});
