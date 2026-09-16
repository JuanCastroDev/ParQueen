import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  createPersistableShadowTelemetry,
  createNoopShadowSink,
  createMemoryAggregateShadowSink,
} = require('./shadowTelemetry');

const valid = (overrides = {}) => ({
  schemaVersion: 'curb-shadow-aggregate-v1', engineVersion: 'phase2a-v1',
  curbState: 'SUPPORTED', cleaningState: 'CAUTION', meterState: 'SUPPORTED',
  cleaningComparisonCategory: 'new_more_cautious',
  legacyCleaningPresent: true, newCleaningPresent: true, passengerMeterRulePresent: true,
  cleaningRuleCount: 1, meterRuleCount: 4,
  reasonBuckets: ['official_order_relationship_missing'],
  sourceVersions: { cscl: 'fixture-v1', dotSigns: '2026-09-15T10:04:47Z', parkNyc: '2026-09-01T10:21:51Z' },
  ...overrides,
});

describe('aggregate-safe shadow telemetry', () => {
  it('projects reviewed dimensions and buckets rule counts', () => {
    expect(createPersistableShadowTelemetry(valid())).toEqual({
      ok: true,
      telemetry: {
        schemaVersion: 'curb-shadow-aggregate-v1', engineVersion: 'phase2a-v1',
        curbState: 'SUPPORTED', cleaningState: 'CAUTION', meterState: 'SUPPORTED',
        cleaningComparisonCategory: 'new_more_cautious',
        legacyCleaningPresent: true, newCleaningPresent: true, passengerMeterRulePresent: true,
        cleaningRuleCountBucket: '1', meterRuleCountBucket: '3+',
        reasonBuckets: ['official_order_relationship_missing'],
        sourceVersions: { cscl: 'fixture-v1', dotSigns: '2026-09-15T10:04:47Z', parkNyc: '2026-09-01T10:21:51Z' },
      },
    });
  });

  it.each([
    'lat', 'latitude', 'lng', 'longitude', 'coordinate', 'coordinates', 'geometry', 'geohash',
    'address', 'location', 'point', 'blockfaceid', 'officialBlockFaceId', 'zoneId', 'orderNumber',
    'globalId', 'physicalId', 'street', 'streetName', 'fromStreet', 'toStreet', 'userId', 'uid',
    'email', 'phone', 'sessionId', 'requestId', 'deviceId',
  ])('rejects nested sensitive key %s, including array smuggling', key => {
    const result = createPersistableShadowTelemetry(valid({ nested: [{ safe: { [key]: 'smuggled' } }] }));
    expect(result).toMatchObject({ ok: false, reason: 'sensitive_field' });
  });

  it('rejects runtime evidence instead of silently projecting it away', () => {
    const result = createPersistableShadowTelemetry(valid({
      runtimeEvidence: { selectedGeometry: { coordinates: [[[-74, 40.7]]] } },
    }));
    expect(result).toMatchObject({ ok: false, reason: 'sensitive_field' });
  });

  it('rejects arbitrary categories, reasons, versions, fields, and count types', () => {
    expect(createPersistableShadowTelemetry(valid({ cleaningComparisonCategory: 'legacy_wrong' }))).toMatchObject({ ok: false });
    expect(createPersistableShadowTelemetry(valid({ reasonBuckets: ['Gold Street'] }))).toMatchObject({ ok: false });
    expect(createPersistableShadowTelemetry(valid({ sourceVersions: { cscl: 'bad version with spaces' } }))).toMatchObject({ ok: false });
    expect(createPersistableShadowTelemetry(valid({ exceptionMessage: 'network payload' }))).toMatchObject({ ok: false });
    expect(createPersistableShadowTelemetry(valid({ meterRuleCount: 1.5 }))).toMatchObject({ ok: false });
  });

  it('provides a no-op sink and a counter-only aggregate memory sink', async () => {
    const payload = createPersistableShadowTelemetry(valid()).telemetry;
    const noop = createNoopShadowSink();
    expect(await noop.record(payload)).toEqual({ accepted: true });
    expect(noop.snapshot()).toEqual([]);

    const memory = createMemoryAggregateShadowSink();
    await memory.record(payload);
    await memory.record({ ...payload, reasonBuckets: [...payload.reasonBuckets] });
    const snapshot = memory.snapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].count).toBe(2);
    expect(snapshot[0]).not.toHaveProperty('events');
  });
});
