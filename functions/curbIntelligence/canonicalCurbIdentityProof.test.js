import { beforeAll, describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { resolveCanonicalCurb } = require('./canonicalCurbResolver');
const { createPrivateBlockfaceResolver } = require('./privateBlockfaceResolver');
const {
  proveCanonicalCurbIdentity,
  hasCanonicalCurbIdentityProof,
} = require('./canonicalCurbIdentityProof');

const SERVICE_URL = 'https://parqueen-test-resolver-uc.a.run.app';
const location = Object.freeze({
  lat: 40.7, lng: -73.9999, accuracyMeters: 5, sampleCount: 4, consistencyMeters: 4,
});
const metadata = Object.freeze({
  id: 'inkn-q76z', rowsUpdatedAt: 1767225600, viewLastModified: 1767225660,
});
const raw = (left = '1000000001', right = '1000000002') => ({
  globalid: `global-${left}`, physicalid: `physical-${left}`, b5sc: `b5sc-${left}`,
  l_blockfaceid: left, r_blockfaceid: right, boroughcode: '2', rw_type: '1',
  full_street_name: 'MARAN PLACE', street_name: 'MARAN PLACE', stname_label: 'MARAN PLACE',
  streetwidth: '34', from_level_code: '13', to_level_code: '13', status: '2',
  nonped: '', accessible: '', from_street: 'WHITE PLAINS ROAD', to_street: 'LURTING AVENUE',
  the_geom: {
    type: 'MultiLineString', coordinates: [[[-74.001, 40.69992], [-73.999, 40.69992]]],
  },
});
const fetchFor = rows => vi.fn(async url => ({ ok: true, json: async () => (
  String(url).includes('/api/views/') ? metadata : rows
) }));
const validSuccess = officialBlockFaceId => ({
  ok: true,
  officialBlockFaceId,
  normalizedStreetNames: {
    onStreet: 'MARAN PLACE',
    crossStreetOne: 'WHITE PLAINS ROAD',
    crossStreetTwo: 'LURTING AVENUE',
  },
  returnCode: '00',
  reasonCode: ' ',
  sourceVersion: { geosupportRelease: '26C', geosupportVersion: '26.3' },
});
const response = body => ({ status: 200, text: async () => JSON.stringify(body) });

function resolver(body, overrides = {}) {
  const transport = vi.fn(async () => response(body));
  const blockfaceResolver = createPrivateBlockfaceResolver({
    mode: 'shadow',
    serviceUrl: SERVICE_URL,
    getIdToken: vi.fn(async () => 'synthetic-token'),
    transport,
    ...overrides,
  });
  return { blockfaceResolver, transport };
}

let primaryA;
let primaryB;
let primaryInvalidContext;
let ambiguous;
beforeAll(async () => {
  primaryA = await resolveCanonicalCurb(location, {
    fetchFn: fetchFor([raw()]), requestNonce: 'proof-a',
  });
  primaryB = await resolveCanonicalCurb(location, {
    fetchFn: fetchFor([raw('1000000003', '1000000004')]), requestNonce: 'proof-b',
  });
  primaryInvalidContext = await resolveCanonicalCurb(location, {
    fetchFn: fetchFor([{ ...raw(),
      full_street_name: 'A'.repeat(33), street_name: 'A'.repeat(33), stname_label: 'A'.repeat(33) }]),
    requestNonce: 'proof-invalid-context',
  });
  ambiguous = await resolveCanonicalCurb({
    ...location, lat: 40.700035, lng: -73.999965, accuracyMeters: 3, consistencyMeters: 3,
  }, {
    fetchFn: fetchFor([
      { ...raw(), globalid: 'horizontal' },
      {
        ...raw('2000000001', '2000000002'), globalid: 'vertical',
        full_street_name: 'WHITE PLAINS ROAD', street_name: 'WHITE PLAINS ROAD',
        stname_label: 'WHITE PLAINS ROAD', from_street: 'MARAN PLACE', to_street: 'MACE AVENUE',
        the_geom: { type: 'MultiLineString', coordinates: [[[-74, 40.7], [-74, 40.701]]] },
      },
    ]),
    requestNonce: 'proof-ambiguous',
  });
});

describe('canonical Function 3C identity proof', () => {
  it('mints one process-local proof only for exact validated BFI equality', async () => {
    const { blockfaceResolver, transport } = resolver(validSuccess('1000000001'));

    const proof = await proveCanonicalCurbIdentity(primaryA, { blockfaceResolver });

    expect(proof).toEqual({ state: 'IDENTITY_PROVEN' });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(hasCanonicalCurbIdentityProof(proof, primaryA)).toBe(true);
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each([
    ['valid mismatch', '1000000009'],
    ['opposite-side BFI', '1000000002'],
  ])('fails closed for %s', async (_label, function3cBfi) => {
    const { blockfaceResolver } = resolver(validSuccess(function3cBfi));
    await expect(proveCanonicalCurbIdentity(primaryA, { blockfaceResolver })).resolves.toEqual({
      state: 'IDENTITY_NOT_PROVEN', reason: 'function3c_bfi_mismatch',
    });
  });

  it('rejects a perfectly shaped caller-created topology result before Function 3C', async () => {
    const forged = Object.freeze({ ...primaryA });
    const blockfaceResolver = { resolve: vi.fn(async () => validSuccess('1000000001')) };

    await expect(proveCanonicalCurbIdentity(forged, { blockfaceResolver })).resolves.toEqual({
      state: 'IDENTITY_NOT_PROVEN', reason: 'topology_primary_required',
    });
    expect(blockfaceResolver.resolve).not.toHaveBeenCalled();
  });

  it('does not let Function 3C rescue an attested ambiguous or recovery-shaped topology', async () => {
    const blockfaceResolver = { resolve: vi.fn(async () => validSuccess('1000000001')) };
    const recoveryShaped = Object.freeze({
      state: 'SUPPORTED', authority: 'RECOVERED', identity: primaryA.identity,
    });

    await expect(proveCanonicalCurbIdentity(ambiguous, { blockfaceResolver })).resolves.toEqual({
      state: 'IDENTITY_NOT_PROVEN', reason: 'topology_primary_required',
    });
    await expect(proveCanonicalCurbIdentity(recoveryShaped, { blockfaceResolver })).resolves.toEqual({
      state: 'IDENTITY_NOT_PROVEN', reason: 'topology_primary_required',
    });
    expect(blockfaceResolver.resolve).not.toHaveBeenCalled();
  });

  it('rejects a perfectly shaped but unattested Function 3C success', async () => {
    const blockfaceResolver = { resolve: vi.fn(async () => validSuccess('1000000001')) };
    await expect(proveCanonicalCurbIdentity(primaryA, { blockfaceResolver })).resolves.toEqual({
      state: 'IDENTITY_NOT_PROVEN', reason: 'function3c_contract_invalid',
    });
  });

  it('rejects an attested success replayed through a different resolver wrapper', async () => {
    const { blockfaceResolver: producingResolver, transport } = resolver(validSuccess('1000000001'));
    const retained = await producingResolver.resolve({
      borough: 'BRONX',
      onStreet: 'MARAN PLACE',
      crossStreetOne: 'WHITE PLAINS ROAD',
      crossStreetTwo: 'LURTING AVENUE',
      compassDirection: 'N',
    });
    const replayingResolver = { resolve: vi.fn(async () => retained) };

    await expect(proveCanonicalCurbIdentity(primaryA, {
      blockfaceResolver: replayingResolver,
    })).resolves.toEqual({
      state: 'IDENTITY_NOT_PROVEN', reason: 'function3c_contract_invalid',
    });
    expect(transport).toHaveBeenCalledOnce();
    expect(replayingResolver.resolve).toHaveBeenCalledOnce();
  });

  it('rejects resolver substitution during an asynchronous proof operation', async () => {
    const { blockfaceResolver: producingResolver } = resolver(validSuccess('1000000001'));
    const retained = await producingResolver.resolve({
      borough: 'BRONX',
      onStreet: 'MARAN PLACE',
      crossStreetOne: 'WHITE PLAINS ROAD',
      crossStreetTwo: 'LURTING AVENUE',
      compassDirection: 'N',
    });
    const options = {};
    const replayingResolver = {
      resolve: vi.fn(async () => {
        options.blockfaceResolver = producingResolver;
        return retained;
      }),
    };
    options.blockfaceResolver = replayingResolver;

    await expect(proveCanonicalCurbIdentity(primaryA, options)).resolves.toEqual({
      state: 'IDENTITY_NOT_PROVEN', reason: 'function3c_contract_invalid',
    });
    expect(replayingResolver.resolve).toHaveBeenCalledOnce();
  });

  it.each([
    ['blank BFI', validSuccess(''), 'function3c_bfi_blank'],
    ['malformed BFI', validSuccess('1001'), 'function3c_bfi_malformed'],
    ['invalid source version', {
      ...validSuccess('1000000001'),
      sourceVersion: { geosupportRelease: '', geosupportVersion: '26.3' },
    }, 'function3c_source_version_invalid'],
    ['closed contract failure', { ...validSuccess('1000000001'), returnCode: '01' }, 'function3c_contract_invalid'],
  ])('fails closed for %s', async (_label, body, reason) => {
    const { blockfaceResolver } = resolver(body);
    await expect(proveCanonicalCurbIdentity(primaryA, { blockfaceResolver })).resolves.toEqual({
      state: 'IDENTITY_NOT_PROVEN', reason,
    });
  });

  it.each([
    ['missing resolver', {}, 'function3c_unavailable'],
    ['resolver exception', { blockfaceResolver: { resolve: vi.fn(async () => { throw new Error('private'); }) } }, 'unexpected_identity_proof_failure'],
  ])('fails closed for %s', async (_label, options, reason) => {
    await expect(proveCanonicalCurbIdentity(primaryA, options)).resolves.toEqual({
      state: 'IDENTITY_NOT_PROVEN', reason,
    });
  });

  it('rejects a topology context outside the closed Function 3C tuple contract before resolution', async () => {
    const blockfaceResolver = { resolve: vi.fn(async () => validSuccess('1000000001')) };
    await expect(proveCanonicalCurbIdentity(primaryInvalidContext, { blockfaceResolver })).resolves.toEqual({
      state: 'IDENTITY_NOT_PROVEN', reason: 'function3c_context_invalid',
    });
    expect(blockfaceResolver.resolve).not.toHaveBeenCalled();
  });

  it('classifies an attested transport failure as Function 3C unavailable', async () => {
    const blockfaceResolver = createPrivateBlockfaceResolver({
      mode: 'shadow', serviceUrl: SERVICE_URL,
      getIdToken: vi.fn(async () => 'synthetic-token'),
      transport: vi.fn(async () => ({ status: 503, text: async () => '' })),
    });
    await expect(proveCanonicalCurbIdentity(primaryA, { blockfaceResolver })).resolves.toEqual({
      state: 'IDENTITY_NOT_PROVEN', reason: 'function3c_unavailable',
    });
  });

  it('binds proof authority to the exact proof and topology objects', async () => {
    const { blockfaceResolver } = resolver(validSuccess('1000000001'));
    const proof = await proveCanonicalCurbIdentity(primaryA, { blockfaceResolver });
    const spread = { ...proof };
    const roundTrip = JSON.parse(JSON.stringify(proof));
    const reconstructed = Object.freeze({ state: 'IDENTITY_PROVEN' });

    expect(hasCanonicalCurbIdentityProof(proof, primaryA)).toBe(true);
    expect(hasCanonicalCurbIdentityProof(proof, primaryB)).toBe(false);
    expect(hasCanonicalCurbIdentityProof(spread, primaryA)).toBe(false);
    expect(hasCanonicalCurbIdentityProof(roundTrip, primaryA)).toBe(false);
    expect(hasCanonicalCurbIdentityProof(reconstructed, primaryA)).toBe(false);
  });
});
