'use strict';

const { readFileSync } = require('fs');
const { join } = require('path');

const source = readFileSync(join(__dirname, '..', 'index.js'), 'utf8');
const start = source.indexOf('exports.createSegmentFromSweepNYC = onCall(');
const end = source.indexOf('function _existingNYCOpenDataResult', start);
const callable = source.slice(start, end);

describe('createSegmentFromSweepNYC private resolver composition boundary', () => {
  it('routes protocol V2 through the canonical orchestrator after auth and rate limiting', () => {
    expect(callable).toContain("await checkRateLimit(uid, 'createSegmentFromSweepNYC'");
    expect(callable).toContain('selectCanonicalV2Handler(');
    expect(callable).toContain('_callableHooks.canonicalCurbOrchestrator');
    expect(callable).toContain('_runCanonicalCurbV2');
    expect(callable).toContain('return canonicalV2Handler(request.data, request.auth.uid)');
    expect(callable).not.toContain('request.data.uid');
    expect(callable).not.toContain('request.data?.uid');
    expect(callable.indexOf('await checkRateLimit(uid')).toBeLessThan(
      callable.indexOf('request.data?.protocolVersion !== 2'),
    );
    expect(callable.indexOf('request.data?.protocolVersion !== 2')).toBeLessThan(
      callable.indexOf('return canonicalV2Handler(request.data, request.auth.uid)'),
    );
    expect(callable).not.toContain('_tryCreateFromSweepNYC');
    expect(callable).not.toContain('revalidateSegmentId');
    const v2Start = source.indexOf('async function _runCanonicalCurbV2');
    const v2 = source.slice(v2Start, source.indexOf('// ─── Hydrant proximity', v2Start));
    expect(v2).not.toContain('candidateStore: createCsclCandidateStore');
    expect(v2).toContain('fetchFn: fetch');
    expect(v2).toContain('planimetricStore: createPlanimetricCurbStore');
    expect(v2).toContain('parkNycStore: createParkNycCandidateStore');
    expect(v2).toContain('sweepSource: { query: _queryCanonicalSweepEvidence }');
    expect(v2).toContain('blockfaceResolver');
    expect(v2).not.toMatch(/\.set\(|\.add\(|\.update\(/);
  });

  it('declares the dedicated curb caller runtime identity on this function only', () => {
    expect(callable).toContain("serviceAccount: 'parqueen-curb-caller@parkqueen-46475363-ccf36.iam.gserviceaccount.com'");
    expect(callable).not.toContain("serviceAccount: 'parqueen-user@parkqueen-46475363-ccf36.iam.gserviceaccount.com'");
  });

  it('does not return a legacy parking answer or expose BFI from the callable', () => {
    expect(callable).not.toContain('_observeCurbIntelligenceShadow');
    expect(callable).not.toContain('_fallbackToNYCOpenData');
    expect(callable).not.toMatch(/officialBlockFaceId|blockFaceId|blockfaceId/);
    expect(callable).not.toMatch(/\.set\(|\.add\(|\.update\(/);
    expect(callable).not.toMatch(/success:\s*true/);
  });

  it('does not supply operatorAuthorized to the shadow observer', () => {
    const observerStart = source.indexOf('async function _observeCurbIntelligenceShadow');
    const observerEnd = source.indexOf('// ─── Hydrant proximity', observerStart);
    const observer = source.slice(observerStart, observerEnd);
    expect(observerStart).toBeGreaterThan(-1);
    expect(observerEnd).toBeGreaterThan(observerStart);
    expect(observer).toContain('applyProductOverlay: _callableHooks.curbProductOverlay || _applyCurbProductOverlay');
    expect(observer).toContain('}, {');
    expect(observer).not.toMatch(/operatorAuthorized/);
    expect(observer).not.toMatch(/\boperator\s*:/);
    expect(observer).not.toMatch(/officialBlockFaceId|blockFaceId|blockfaceId/);
    expect(observer).toContain('productMeterLookup');
    expect(observer).toContain('persistMeter');
    expect(observer).toContain('productRestrictionLookup');
    expect(observer).toContain('persistRestrictions');
    expect(observer).toContain('_publicCurbProductResult');
    expect(observer).toContain('Restriction lookup is fail-soft');
  });

  it('loads active SweepNYC streetRules instead of only sweepnyc_v1', () => {
    const attachStart = source.indexOf('async function _attachSweepnycProductEvidence');
    const attach = source.slice(attachStart, source.indexOf('async function _tryCreateFromSweepNYC', attachStart));
    expect(attach).toContain("db.collection(`streetSegments/${segmentId}/streetRules`)");
    expect(attach).toContain(".where('supersededAt', '==', null)");
    expect(attach).not.toMatch(/officialBlockFaceId|blockFaceId|blockfaceId/);
  });
});
