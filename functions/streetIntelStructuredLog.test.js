'use strict';

const { emitStructuredLog } = require('./streetIntelStructuredLog');

describe('streetIntelStructuredLog', () => {
  it('keeps the test seam as JSON text', () => {
    const lines = [];
    emitStructuredLog({ message: 'dedup_hit_usable', event: 'dedup_hit_usable', domain: 'street_intel_refresh' }, line => lines.push(line));
    expect(JSON.parse(lines[0])).toEqual({
      message: 'dedup_hit_usable',
      event: 'dedup_hit_usable',
      domain: 'street_intel_refresh',
    });
  });

  it('writes an object to logger.info so Cloud Logging can index event', () => {
    const calls = [];
    emitStructuredLog(
      { message: 'meter_supported', event: 'meter_supported', domain: 'street_intel_meter' },
      undefined,
      { info: payload => calls.push(payload) },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].event).toBe('meter_supported');
    expect(typeof calls[0]).toBe('object');
  });
});
