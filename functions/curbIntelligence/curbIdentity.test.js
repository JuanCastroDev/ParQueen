import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  createOfficialCurbIdentity,
  normalizeBlockFaceId,
  normalizeCsclSourceVersion,
} = require('./curbIdentity');

const SOURCE_VERSION = {
  mapAssetId: '3mf9-qshr',
  resourceId: 'inkn-q76z',
  version: '2026-09-12T15:37:00.000Z',
};

const GOLD_STREET = {
  l_blockfaceid: '212261301',
  r_blockfaceid: '212260958',
  globalid: '{6073FD70-7F59-449D-8445-9056FBC76531}',
  physicalid: '189761',
  boroughcode: '1',
  b5sc: '110460',
  rw_type: '1',
  from_level_code: '0',
  to_level_code: '0',
  full_street_name: 'GOLD STREET',
  street_name: 'GOLD',
  stname_label: 'Gold St',
};

describe('CSCL Block Face ID normalization', () => {
  it('preserves an existing leading zero and pads a shorter source string to ten digits', () => {
    expect(normalizeBlockFaceId('0012345678')).toBe('0012345678');
    expect(normalizeBlockFaceId('212261301')).toBe('0212261301');
  });

  it.each([212261301, 0, '0', '0000000000', '', '12A34', '12345678901', null, undefined])(
    'rejects an unsafe or unusable identity value: %s',
    value => expect(normalizeBlockFaceId(value)).toBeNull(),
  );
});
describe('CSCL source-version boundary', () => {
  it('requires the official map, query resource, and an explicit version', () => {
    expect(normalizeCsclSourceVersion(SOURCE_VERSION)).toEqual(SOURCE_VERSION);
    expect(normalizeCsclSourceVersion({ ...SOURCE_VERSION, version: '' })).toBeNull();
    expect(normalizeCsclSourceVersion({ ...SOURCE_VERSION, resourceId: '3mf9-qshr' })).toBeNull();
  });
});

describe('official curb identity', () => {
  it('uses the selected official face while retaining segment and physical IDs only as evidence', () => {
    const result = createOfficialCurbIdentity({
      csclRows: [GOLD_STREET, { ...GOLD_STREET, globalid: '{SECOND}', physicalid: '189762' }],
      csclSide: 'LEFT',
      sourceVersion: SOURCE_VERSION,
      canonicalSearchName: 'GOLD STREET',
      resolutionEvidence: { state: 'SUPPORTED', reasonCodes: [], bestDistanceMeters: 5.8 },
    });

    expect(result.ok).toBe(true);
    expect(result.identity).toMatchObject({
      jurisdiction: 'NYC',
      officialBlockFaceId: '0212261301',
      side: { cscl: 'LEFT', cardinal: null },
      roadway: {
        boroughCode: '1', b5sc: '110460', roadwayType: '1',
        fromLevelCode: '0', toLevelCode: '0',
      },
      names: {
        sourceNativePrimary: 'GOLD STREET',
        sourceNativeStreet: 'GOLD',
        sourceNativeLabel: 'Gold St',
        canonicalSearchName: 'GOLD STREET',
      },
    });
    expect(result.identity.cscl.globalIds).toEqual([
      '{6073FD70-7F59-449D-8445-9056FBC76531}', '{SECOND}',
    ]);
    expect(result.identity.cscl.physicalIds).toEqual(['189761', '189762']);
    expect(result.identity.cscl).not.toHaveProperty('objectIds');
  });

  it('fails closed when the selected side lacks a usable official face', () => {
    const result = createOfficialCurbIdentity({
      csclRows: [{ ...GOLD_STREET, l_blockfaceid: null }],
      csclSide: 'LEFT',
      sourceVersion: SOURCE_VERSION,
      resolutionEvidence: { state: 'UNKNOWN', reasonCodes: ['official_face_missing'] },
    });
    expect(result).toEqual({ ok: false, reason: 'official_face_missing' });
  });

  it('does not accept a numeric Block Face ID whose leading-zero history is unknowable', () => {
    const result = createOfficialCurbIdentity({
      csclRows: [{ ...GOLD_STREET, l_blockfaceid: 212261301 }],
      csclSide: 'LEFT',
      sourceVersion: SOURCE_VERSION,
      resolutionEvidence: { state: 'UNKNOWN', reasonCodes: ['invalid_identity'] },
    });
    expect(result).toEqual({ ok: false, reason: 'invalid_block_face_id' });
  });
});
