import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const {
  createCanonicalCurbIdentity,
  publicCurbKey,
  createCandidateToken,
  candidateTokenNonceDigest,
  toPublicCurb,
} = require('./canonicalCurbIdentity');

const SOURCE_VERSION = Object.freeze({ resourceId: 'inkn-q76z', version: '1720000000:1720000100' });
const ROWS = Object.freeze([{
  l_blockfaceid: '12345',
  r_blockfaceid: '987654',
  globalid: 'private-global-id',
  physicalid: 'private-physical-id',
  b5sc: 'private-b5sc',
}]);
const GEOMETRY = Object.freeze({
  type: 'MultiLineString',
  coordinates: [[[-73.9, 40.7], [-73.899, 40.701]]],
});

const create = (overrides = {}) => createCanonicalCurbIdentity({
  csclRows: ROWS,
  csclSide: 'LEFT',
  sourceVersion: SOURCE_VERSION,
  selectedGlobalId: 'private-global-id',
  geometry: GEOMETRY,
  streetWidthFeet: 34,
  borough: 'Bronx',
  onStreet: 'Maran Place',
  fromStreet: 'White Plains Road',
  toStreet: 'Lurting Avenue',
  aliases: ['MARAN PL'],
  cardinalSide: 'North',
  resolutionMethod: 'automatic',
  ...overrides,
});

describe('canonical curb identity', () => {
  it('selects and normalizes the official Block Face ID for the CSCL side', () => {
    const left = create();
    const right = create({ csclSide: 'RIGHT', cardinalSide: 'South' });

    expect(left).toMatchObject({
      ok: true,
      identity: {
        schemaVersion: 2,
        officialBlockFaceId: '0000012345',
        csclSide: 'LEFT',
      },
    });
    expect(right).toMatchObject({
      ok: true,
      identity: { officialBlockFaceId: '0000987654', csclSide: 'RIGHT' },
    });
  });

  it('creates deterministic opaque curb2 keys and separates opposite sides', () => {
    const left = create().identity;
    const right = create({ csclSide: 'RIGHT', cardinalSide: 'South' }).identity;

    expect(publicCurbKey(left)).toMatch(/^curb2_[a-f0-9]{32}$/);
    expect(publicCurbKey(left)).toBe(publicCurbKey(create().identity));
    expect(publicCurbKey(left)).not.toBe(publicCurbKey(right));
    expect(publicCurbKey(left)).not.toContain(left.officialBlockFaceId);
  });

  it('projects only client-safe curb display fields', () => {
    const identity = create().identity;
    const publicCurb = toPublicCurb(identity);
    const serialized = JSON.stringify(publicCurb);

    expect(publicCurb).toEqual({
      schemaVersion: 2,
      segmentId: publicCurbKey(identity),
      streetName: 'Maran Place',
      sideLabel: 'North',
      geometry: GEOMETRY,
    });
    for (const forbidden of [
      '0000012345',
      'private-global-id',
      'private-physical-id',
      'private-b5sc',
      'blockface',
      'globalid',
      'physicalid',
      'b5sc',
      'signid',
      'diagnostics',
    ]) {
      expect(serialized.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('changes candidate tokens with nonce and rank without revealing private values', () => {
    const identity = create().identity;
    const key = publicCurbKey(identity);
    const first = createCandidateToken({ publicCurbKey: key, requestNonce: 'nonce-a', rank: 0 });
    const changedNonce = createCandidateToken({ publicCurbKey: key, requestNonce: 'nonce-b', rank: 0 });
    const changedRank = createCandidateToken({ publicCurbKey: key, requestNonce: 'nonce-a', rank: 1 });

    expect(first).toMatch(/^candidate2_[a-f0-9]{16}_[a-f0-9]{32}$/);
    expect(new Set([first, changedNonce, changedRank])).toHaveLength(3);
    expect(candidateTokenNonceDigest(first)).toMatch(/^[a-f0-9]{16}$/);
    expect(first).not.toContain(identity.officialBlockFaceId);
    expect(first).not.toContain(key);
    expect(first).not.toContain('nonce-a');
  });

  it('fails closed for invalid identity inputs', () => {
    expect(create({ csclSide: 'CENTER' })).toEqual({ ok: false, reason: 'invalid_cscl_side' });
    expect(create({ geometry: null })).toEqual({ ok: false, reason: 'invalid_geometry' });
  });
});
