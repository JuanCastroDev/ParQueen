'use strict';

const { readFileSync } = require('fs');
const { join } = require('path');
const { streetIntelligenceAppCheckRejection } = require('./streetIntelligenceAppCheck');

const source = readFileSync(join(__dirname, 'index.js'), 'utf8');
const callableStart = source.indexOf('exports.createSegmentFromSweepNYC = onCall(');
const callableEnd = source.indexOf('function _existingNYCOpenDataResult', callableStart);
const callable = source.slice(callableStart, callableEnd);
const options = callable.slice(0, callable.indexOf('async (request)'));
const body = callable.slice(callable.indexOf('async (request)'));

describe('createSegmentFromSweepNYC App Check boundary', () => {
  it('enforces App Check on the production callable declaration', () => {
    expect(options).toContain('enforceAppCheck: true');
    expect(options).not.toContain('enforceAppCheck: false');
    expect(options).not.toContain('FUNCTIONS_EMULATOR');
    expect(options).not.toContain('process.env');
    expect(options).not.toContain('enforceAppCheck: false');
  });

  it('rejects a missing or invalid App Check app id before authority work', () => {
    expect(streetIntelligenceAppCheckRejection(undefined)).toBe(true);
    expect(streetIntelligenceAppCheckRejection({})).toBe(true);
    expect(streetIntelligenceAppCheckRejection({ app: null })).toBe(true);
    expect(streetIntelligenceAppCheckRejection({ app: {} })).toBe(true);
    expect(streetIntelligenceAppCheckRejection({ app: { appId: '' } })).toBe(true);
    expect(streetIntelligenceAppCheckRejection({ app: { appId: 'x'.repeat(257) } })).toBe(true);
    expect(streetIntelligenceAppCheckRejection({ data: { app: { appId: 'caller-supplied' } } })).toBe(true);
    expect(streetIntelligenceAppCheckRejection({ app: { appId: '1:768131391875:web:613c5d2a948862333196b6' } })).toBe(false);
  });

  it('places the App Check guard before rate limit, protocol, and the frozen handler', () => {
    const guard = body.indexOf('streetIntelligenceAppCheckRejection(request)');
    const rate = body.indexOf("checkRateLimit(uid, 'createSegmentFromSweepNYC'");
    const protocol = body.indexOf('request.data?.protocolVersion !== 2');
    const frozen = body.indexOf('return canonicalV2Handler(request.data, request.auth.uid)');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(rate);
    expect(rate).toBeLessThan(protocol);
    expect(protocol).toBeLessThan(frozen);
    expect(body).toContain("throw new HttpsError('unauthenticated', 'App Check required.')");
  });

  it('keeps protocol 2 as the only accepted request shape', () => {
    expect(body).toContain('request.data?.protocolVersion !== 2');
    expect(body).toContain("status: 'unsupported'");
    expect(body).not.toContain('success: true');
    expect(body).not.toContain('_tryCreateFromSweepNYC');
    expect(body).not.toContain('_fallbackToNYCOpenData');
  });

  it('does not let a legacy payload skip the App Check declaration', () => {
    expect(options).toContain('enforceAppCheck: true');
    expect(body.indexOf('streetIntelligenceAppCheckRejection(request)'))
      .toBeLessThan(body.indexOf('request.data?.protocolVersion !== 2'));
  });

  it('does not weaken the production declaration for the emulator', () => {
    expect(callable).not.toContain('FUNCTIONS_EMULATOR');
    expect(callable).not.toContain('skipTokenVerification');
    expect(callable).not.toMatch(/enforceAppCheck:\s*(process\.env|false)/);
  });
});
