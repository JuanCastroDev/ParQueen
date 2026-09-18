'use strict';

const { readFileSync } = require('fs');
const { join } = require('path');

const source = readFileSync(join(__dirname, '..', 'index.js'), 'utf8');
const start = source.indexOf('exports.createSegmentFromSweepNYC = onCall(');
const end = source.indexOf('function _existingNYCOpenDataResult', start);
const callable = source.slice(start, end);

describe('createSegmentFromSweepNYC private resolver composition boundary', () => {
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
});
