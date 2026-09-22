'use strict';

const {
  validateCleaningShadowTelemetry,
  createStructuredCloudLoggingSink,
} = require('./structuredShadowTelemetry');

const valid = Object.freeze({
  event: 'curb_shadow_v1',
  schemaVersion: 'curb-shadow-cleaning-v1',
  engineVersion: '2a15-local-1',
  cohort: 'operator',
  outcome: 'COMPLETED',
  skipOrFailureClass: 'none',
  curbState: 'SUPPORTED',
  cleaningState: 'SUPPORTED',
  comparisonCategory: 'agreement',
  legacyAvailability: 'USABLE',
  csclAvailability: 'COMPLETE',
  dotAvailability: 'COMPLETE',
  relationshipAvailability: 'SUPPORTED',
  latencyBucket: 'lt_1s',
  cleaningRuleCountBucket: '1',
  reasonBuckets: [],
  sourceVersions: {
    cscl: 'sha256-1111111111111111',
    dotSigns: 'sha256-2222222222222222',
    resolver: 'sha256-3333333333333333',
  },
});

describe('strict cleaning-shadow structured telemetry', () => {
  it('accepts exactly the reviewed schema and returns a detached allowlisted object', () => {
    const result = validateCleaningShadowTelemetry(valid);
    expect(result).toEqual({ ok: true, telemetry: valid });
    expect(result.telemetry).not.toBe(valid);
  });

  it.each([
    ['unknown key', { extra: 'value' }],
    ['BFI', { officialBlockFaceId: '0212261301' }],
    ['coordinates', { latitude: 40.7 }],
    ['accuracy', { accuracyMeters: 5 }],
    ['street', { streetName: 'GOLD STREET' }],
    ['UID', { uid: 'user-1' }],
    ['request identifier', { requestId: 'request-1' }],
    ['token', { token: 'secret' }],
    ['raw object', { rawResult: { ok: true } }],
  ])('rejects %s fields', (_label, addition) => {
    const result = validateCleaningShadowTelemetry({ ...valid, ...addition });
    expect(result.ok).toBe(false);
  });

  it.each([
    ['outcome', 'MAYBE'], ['curbState', 'GOOD'], ['comparisonCategory', 'street-value'],
    ['latencyBucket', '927ms'], ['cleaningRuleCountBucket', '99'],
  ])('rejects an unbounded %s value', (field, value) => {
    expect(validateCleaningShadowTelemetry({ ...valid, [field]: value }).ok).toBe(false);
  });

  it('rejects nested unknown keys, raw objects, token-looking source versions, and arbitrary errors', () => {
    expect(validateCleaningShadowTelemetry({ ...valid, sourceVersions: { ...valid.sourceVersions, street: 'secret' } }).ok).toBe(false);
    expect(validateCleaningShadowTelemetry({ ...valid, sourceVersions: { cscl: { version: 'one' } } }).ok).toBe(false);
    expect(validateCleaningShadowTelemetry({ ...valid, sourceVersions: { cscl: 'Bearer abc.def.ghi' } }).ok).toBe(false);
    expect(validateCleaningShadowTelemetry({ ...valid, reasonBuckets: [new Error('private')] }).ok).toBe(false);
    expect(validateCleaningShadowTelemetry({ ...valid, sourceVersions: { cscl: 'GOLD-STREET' } }).ok).toBe(false);
    expect(validateCleaningShadowTelemetry({ ...valid, cohort: 'user-123' }).ok).toBe(false);
    expect(validateCleaningShadowTelemetry({ ...valid, engineVersion: '0212261301' }).ok).toBe(false);
  });

  it('accepts the pre-release product cohort without treating it as organic sampled', () => {
    const result = validateCleaningShadowTelemetry({ ...valid, cohort: 'pre_release_product' });
    expect(result.ok).toBe(true);
    expect(result.telemetry.cohort).toBe('pre_release_product');
  });

  it('accepts the bounded relationship-timeout reason without accepting raw error details', () => {
    const result = validateCleaningShadowTelemetry({
      ...valid,
      outcome: 'UNKNOWN',
      skipOrFailureClass: 'relationship_unknown',
      reasonBuckets: ['execution_timeout'],
    });
    expect(result.ok).toBe(true);
  });

  it('emits one validated structured object and never stringifies it', async () => {
    const logger = { info: vi.fn() };
    const sink = createStructuredCloudLoggingSink({ logger });
    const result = await sink.record(valid);

    expect(result).toEqual({ accepted: true });
    expect(logger.info).toHaveBeenCalledWith(valid);
    expect(typeof logger.info.mock.calls[0][0]).toBe('object');
  });

  it('rejects invalid payloads without logging them', async () => {
    const logger = { info: vi.fn() };
    const sink = createStructuredCloudLoggingSink({ logger });

    const result = await sink.record({ ...valid, bfi: '0212261301' });

    expect(result).toEqual({ accepted: false, reason: 'unexpected_field' });
    expect(logger.info).not.toHaveBeenCalled();
  });
});
