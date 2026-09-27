import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

describe('future Geosupport verification corpus', () => {
  it('emits deterministic fingerprints and normalized public context without raw BFI', () => {
    const { normalizeVerificationCorpusRecord } = require('./lib/geosupportCorpus');
    const input = {
      internalTestId: 'fixture-manhattan-001',
      topologyTuple: {
        borough: 'Manhattan',
        onStreet: 'BROADWAY',
        fromStreet: 'SPRING ST',
        toStreet: 'BROOME ST',
        side: 'LEFT',
      },
      expectedBfi: '0000000001',
      resultClassification: 'pending_verification',
      sourceTopologyVersion: 'topology-v1/cscl-release',
    };
    const first = normalizeVerificationCorpusRecord(input);
    const second = normalizeVerificationCorpusRecord(structuredClone(input));
    const serialized = JSON.stringify(first);

    expect(second).toEqual(first);
    expect(first).toEqual({
      corpusSchemaVersion: 1,
      internalTestId: 'fixture-manhattan-001',
      topologyTupleFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      expectedBfiFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      expectedContext: input.topologyTuple,
      resultClassification: 'pending_verification',
      sourceTopologyVersion: 'topology-v1/cscl-release',
    });
    expect(serialized).not.toContain(input.expectedBfi);
    expect(serialized).not.toContain('expectedBfi"');
  });

  it.each(['coordinates', 'rawRequest', 'rawResponse', 'token', 'uid'])('rejects forbidden raw field %s', key => {
    const { normalizeVerificationCorpusRecord } = require('./lib/geosupportCorpus');
    expect(() => normalizeVerificationCorpusRecord({
      internalTestId: 'fixture-1',
      topologyTuple: { borough: 'Queens', onStreet: '31ST AVE', fromStreet: '31ST ST', toStreet: '32ND ST', side: 'RIGHT' },
      expectedBfi: '0000000001',
      resultClassification: 'pending_verification',
      sourceTopologyVersion: 'v1',
      [key]: 'forbidden-test-value',
    })).toThrow(/forbidden/);
  });
});
