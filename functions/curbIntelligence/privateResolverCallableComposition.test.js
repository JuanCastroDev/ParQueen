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
    expect(callable).toContain('if (request.data?.protocolVersion === 2)');
    expect(callable).toContain('_callableHooks.canonicalCurbOrchestrator || _runCanonicalCurbV2');
    expect(callable).toContain('return orchestrate(request.data)');
    expect(callable.indexOf('await checkRateLimit(uid')).toBeLessThan(
      callable.indexOf('if (request.data?.protocolVersion === 2)'),
    );
    expect(callable.indexOf('if (request.data?.protocolVersion === 2)')).toBeLessThan(
      callable.indexOf('const { lat, lng, accuracyMeters, revalidateSegmentId }'),
    );
    const v2Start = source.indexOf('async function _runCanonicalCurbV2');
    const v2 = source.slice(v2Start, source.indexOf('// ─── Hydrant proximity', v2Start));
    expect(v2).toContain('candidateStore: createCsclCandidateStore');
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

  it('observes the established result without exposing BFI or changing response/write construction', () => {
    expect(callable).toContain('_observeCurbIntelligenceShadow(productionResult, lat, lng, accuracyMeters, shadowEvidence)');
    expect(callable).not.toMatch(/officialBlockFaceId|blockFaceId|blockfaceId/);
    expect(callable).not.toMatch(/\.set\(|\.add\(|\.update\(/);
  });

  it('passes optional accuracy and captured fallback evidence only to the observer', () => {
    expect(callable).toContain('accuracyMeters');
    expect(callable).toContain('shadowEvidence');
    expect(callable).toMatch(/_fallbackToNYCOpenData\(\s*lat,\s*lng,\s*null,/);
    expect(callable).toContain('_observeCurbIntelligenceShadow(productionResult, lat, lng, accuracyMeters, shadowEvidence)');
    expect(callable).not.toMatch(/accuracyMeters\s*[,}][\s\S]*?\.set\(/);
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
