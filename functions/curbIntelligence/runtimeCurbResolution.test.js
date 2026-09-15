import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createMemoryCandidateStore } = require('./candidateStore');
const { normalizeCsclRow } = require('./csclNormalizer');
const { resolveOfficialCurbRuntime } = require('./runtimeCurbResolution');

const VERSION = { resourceId: 'inkn-q76z', version: 'fixture-v1' };
const coverageEnvelope = { minLat: 40.69, maxLat: 40.71, minLng: -74.01, maxLng: -73.99 };

function record(overrides = {}) {
  const row = {
    the_geom: { type: 'MultiLineString', coordinates: [[[-74.001, 40.7], [-73.999, 40.7]]] },
    globalid: 'selected-global', physicalid: '123', l_blockfaceid: '1000000001', r_blockfaceid: '1000000002',
    boroughcode: '1', b5sc: '123456', rw_type: '1', full_street_name: 'TEST STREET',
    street_name: 'TEST', stname_label: 'TEST ST', trafdir: 'FT', nominaldir: null,
    streetwidth: '40', from_level_code: '13', to_level_code: '13', accessible: null,
    nonped: null, status: '2', modified_date: '2026-09-15', created_date: '2020-01-01',
    ...overrides,
  };
  const normalized = normalizeCsclRow(row, VERSION);
  if (!normalized.ok) throw new Error(normalized.reason);
  return normalized.record;
}

describe('ephemeral curb resolution runtime evidence', () => {
  it('keeps selected geometry and identifiers out of the resolution projection', async () => {
    const candidate = record();
    const candidateStore = createMemoryCandidateStore([candidate], { coverageEnvelope });
    const result = await resolveOfficialCurbRuntime(
      { lat: 40.70005, lng: -74, accuracyMeters: 1 },
      { candidateStore, modelErrorMeters: 1 },
    );

    expect(result.resolution.state).toBe('SUPPORTED');
    expect(result.runtimeEvidence).toMatchObject({
      nonPersistable: true,
      officialBlockFaceId: '1000000001',
      csclSide: 'LEFT',
      streetWidthFeet: 40,
      modelUncertaintyMeters: 1,
      candidateCoverageComplete: true,
      sourceVersion: VERSION,
    });
    expect(result.runtimeEvidence.selectedGeometry).toEqual(candidate.geometry);
    expect(result.runtimeEvidence.resolvedPoint).toEqual({ lat: 40.70005, lng: -74 });
    expect(JSON.stringify(result.resolution)).not.toContain('coordinates');
    expect(result.resolution).not.toHaveProperty('runtimeEvidence');
  });

  it('retains competing roadway geometry only in non-persistable evidence', async () => {
    const selected = record();
    const competing = record({
      globalid: 'competing-global', physicalid: '456', b5sc: '654321',
      l_blockfaceid: '1000000003', r_blockfaceid: '1000000004',
      full_street_name: 'OTHER STREET', street_name: 'OTHER', stname_label: 'OTHER ST',
      the_geom: { type: 'MultiLineString', coordinates: [[[-74.001, 40.7003], [-73.999, 40.7003]]] },
    });
    const candidateStore = createMemoryCandidateStore([selected, competing], { coverageEnvelope });
    const result = await resolveOfficialCurbRuntime(
      { lat: 40.70002, lng: -74, accuracyMeters: 1 },
      { candidateStore, modelErrorMeters: 1 },
    );

    expect(result.runtimeEvidence.competingRoadways).toEqual([{ geometry: competing.geometry }]);
    expect(JSON.stringify(result.resolution)).not.toContain('40.7003');
  });

  it('returns no runtime evidence when resolution has no selected official face', async () => {
    const result = await resolveOfficialCurbRuntime(
      { lat: 40.7, lng: -74, accuracyMeters: 2 },
      { candidateStore: createMemoryCandidateStore([], { coverageEnvelope }) },
    );
    expect(result.resolution.state).toBe('UNKNOWN');
    expect(result.runtimeEvidence).toBeNull();
  });

  it('fails candidate coverage closed when the runtime cap truncates a store response', async () => {
    const first = record();
    const second = record({ globalid: 'second-global', physicalid: '456' });
    const sourceStore = {
      async queryCandidates() {
        return { candidates: [first, second], completeness: { state: 'COMPLETE', reason: null } };
      },
    };
    const result = await resolveOfficialCurbRuntime(
      { lat: 40.70005, lng: -74, accuracyMeters: 1 },
      { candidateStore: sourceStore, modelErrorMeters: 1, maxCandidates: 1 },
    );

    expect(result.resolution.state).toBe('UNKNOWN');
    expect(result.resolution.candidateCompleteness).toEqual({
      state: 'INCOMPLETE', reason: 'candidate_limit_reached',
    });
    expect(result.runtimeEvidence).toMatchObject({
      nonPersistable: true,
      candidateCoverageComplete: false,
      candidateCompleteness: { state: 'INCOMPLETE', reason: 'candidate_limit_reached' },
    });
  });
});
