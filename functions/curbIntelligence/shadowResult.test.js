import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { toPersistableShadowComparison } = require('./shadowResult');

const forbidden = /^(latitude|longitude|lat|lng|coordinate|coordinates|geometry|geohash|address|location|point|officialBlockFaceId|blockFaceId)$/i;
function sensitivePaths(value, path = []) {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => [
    ...(forbidden.test(key) ? [[...path, key].join('.')] : []),
    ...sensitivePaths(child, [...path, key]),
  ]);
}

describe('resolver shadow privacy boundary', () => {
  it('maps an identity-rich internal resolver result to the existing safe contract only', () => {
    const result = toPersistableShadowComparison({
      resolverResult: {
        state: 'SUPPORTED', reasons: [], officialIdentity: { officialBlockFaceId: '0212261301' },
        roadway: { geometry: { type: 'MultiLineString', coordinates: [[[-74, 40.7], [-74, 40.71]]] } },
        rawUserLocation: { lat: 40.7, lng: -74 },
      },
      category: 'exact_agreement', oldCleaningFingerprint: 'Mon|08:00|09:00',
      newCleaningFingerprint: 'Mon|08:00|09:00', meterRulePresent: false,
      sourceVersions: { cscl: 'v1', dotSigns: 'v1' },
    });
    expect(result.ok).toBe(true);
    expect(result.comparison.blockFaceResolutionState).toBe('SUPPORTED');
    expect(sensitivePaths(result.comparison)).toEqual([]);
    expect(Object.keys(result.comparison).sort()).toEqual([
      'blockFaceResolutionState', 'category', 'meterRulePresent', 'newCleaningFingerprint',
      'oldCleaningFingerprint', 'reasonCodes', 'sourceVersions',
    ]);
  });

  it('fails closed when the internal state cannot map to a reviewed shadow category', () => {
    expect(toPersistableShadowComparison({ resolverResult: { state: 'BROKEN', reasons: [] }, category: 'exact_agreement' }))
      .toEqual({ ok: false, reason: 'invalid_resolver_result' });
  });
});
