import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it, vi } from 'vitest';

const requireFromHere = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const { runCanonicalCurbOrchestrator } = requireFromHere('./curbIntelligence/canonicalCurbOrchestrator');
const { resolveCanonicalCurb } = requireFromHere('./curbIntelligence/canonicalCurbResolver');
const { createPrivateBlockfaceResolver } = requireFromHere('./curbIntelligence/privateBlockfaceResolver');

const indexSource = readFileSync(join(__dirname, 'index.js'), 'utf8');
const clientSource = readFileSync(join(__dirname, '..', 'views', 'StreetParkingView.tsx'), 'utf8');
const callable = indexSource.slice(
  indexSource.indexOf('exports.createSegmentFromSweepNYC = onCall('),
  indexSource.indexOf('function _existingNYCOpenDataResult'),
);

const location = Object.freeze({
  lat: 40.7,
  lng: -73.9999,
  accuracyMeters: 5,
  sampleCount: 4,
  consistencyMeters: 4,
});
const request = overrides => ({ protocolVersion: 2, location, ...overrides });
const metadata = { id: 'inkn-q76z', rowsUpdatedAt: 1767225600, viewLastModified: 1767225660 };
const raw = (id, name, geometry, left = '1000000001', right = '1000000002') => ({
  globalid: id, physicalid: `${id}-physical`, b5sc: `${id}-b5sc`,
  l_blockfaceid: left, r_blockfaceid: right, boroughcode: '2', rw_type: '1',
  full_street_name: name, street_name: name, stname_label: name, streetwidth: '34',
  from_level_code: '13', to_level_code: '13', status: '2', nonped: '', accessible: '',
  from_street: 'WHITE PLAINS ROAD', to_street: 'LURTING AVENUE', the_geom: geometry,
});
const fetchFor = rows => vi.fn(async url => ({
  ok: true,
  json: async () => (String(url).includes('/api/views/') ? metadata : rows),
}));
const line = {
  type: 'MultiLineString',
  coordinates: [[[-74.001, 40.69992], [-73.999, 40.69992]]],
};

function proofTransport(officialBlockFaceId) {
  return vi.fn(async () => ({
    status: 200,
    text: async () => JSON.stringify({
      ok: true,
      officialBlockFaceId,
      normalizedStreetNames: {
        onStreet: 'MARAN PLACE',
        crossStreetOne: 'WHITE PLAINS ROAD',
        crossStreetTwo: 'LURTING AVENUE',
      },
      returnCode: '00',
      reasonCode: ' ',
      sourceVersion: { geosupportRelease: 'release-a', geosupportVersion: '1' },
    }),
  }));
}

function proofResolver(officialBlockFaceId) {
  const transport = proofTransport(officialBlockFaceId);
  return {
    transport,
    blockfaceResolver: createPrivateBlockfaceResolver({
      mode: 'shadow',
      serviceUrl: 'https://parqueen-test-resolver-uc.a.run.app',
      getIdToken: vi.fn(async () => 'synthetic-token'),
      transport,
    }),
  };
}

function sideEffects() {
  return {
    readCanonicalCache: vi.fn(async () => ({ hit: false, reason: 'exact_identity_missing' })),
    loadCanonicalRules: vi.fn(async () => ({ state: 'complete', selected: {
      rules: [], cleaning: null, restrictions: [], timeLimits: [], meter: null, admin: [], conflicts: [],
    }, sources: {} })),
    persistCanonicalCurb: vi.fn(async () => ({ success: true })),
  };
}

let authenticPrimary;
let authenticAmbiguous;

beforeAll(async () => {
  authenticPrimary = await resolveCanonicalCurb(location, {
    fetchFn: fetchFor([raw('private-global', 'MARAN PLACE', line)]),
    requestNonce: 'server-nonce',
  });
  authenticAmbiguous = await resolveCanonicalCurb({
    ...location, lat: 40.700035, lng: -73.999965, accuracyMeters: 3, consistencyMeters: 3,
  }, {
    fetchFn: fetchFor([
      raw('horizontal', 'MARAN PLACE', { type: 'MultiLineString', coordinates: [[[-74, 40.7], [-73.999, 40.7]]] }),
      raw('vertical', 'WHITE PLAINS ROAD', { type: 'MultiLineString', coordinates: [[[-74, 40.7], [-74, 40.701]]] }, '2000000001', '2000000002'),
    ]),
    requestNonce: 'server-nonce',
  });
});

describe('SI-RELEASE-02 product path', () => {
  it('returns a public high-confidence result only after one Function 3C proof', async () => {
    const proof = proofResolver('1000000001');
    const effects = sideEffects();
    const result = await runCanonicalCurbOrchestrator(request(), {
      ...effects,
      resolveCanonicalCurb: vi.fn(async () => authenticPrimary),
      blockfaceResolver: proof.blockfaceResolver,
      inFlight: new Map(),
    });
    expect(authenticPrimary.state).toBe('SUPPORTED');
    expect(result.status).toBe('high_confidence');
    expect(result.protocolVersion).toBe(2);
    expect(result.segmentId).toMatch(/^curb2_[a-f0-9]{32}$/);
    expect(proof.transport).toHaveBeenCalledTimes(1);
    expect(effects.readCanonicalCache).toHaveBeenCalledTimes(1);
    expect(effects.persistCanonicalCurb).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).not.toMatch(/officialBlockFaceId|1000000001/);
  });

  it('does not call Function 3C or write authority when topology is unavailable', async () => {
    const proof = proofResolver('1000000001');
    const effects = sideEffects();
    const result = await runCanonicalCurbOrchestrator(request(), {
      ...effects,
      resolveCanonicalCurb: vi.fn(async () => ({ state: 'UNSUPPORTED', reasons: ['canonical_candidate_missing'] })),
      blockfaceResolver: proof.blockfaceResolver,
      inFlight: new Map(),
    });
    expect(result).toEqual({ protocolVersion: 2, status: 'unsupported', reason: 'candidate_incomplete' });
    expect(proof.transport).not.toHaveBeenCalled();
    expect(effects.readCanonicalCache).not.toHaveBeenCalled();
    expect(effects.persistCanonicalCurb).not.toHaveBeenCalled();
  });

  it('abstains on ambiguous topology before Function 3C', async () => {
    const proof = proofResolver('1000000001');
    const effects = sideEffects();
    const result = await runCanonicalCurbOrchestrator(request(), {
      ...effects,
      resolveCanonicalCurb: vi.fn(async () => authenticAmbiguous),
      blockfaceResolver: proof.blockfaceResolver,
      inFlight: new Map(),
    });
    expect(authenticAmbiguous.state).toBe('AMBIGUOUS');
    expect(result.status).toBe('ambiguous');
    expect(result.selector.candidates).toHaveLength(2);
    expect(proof.transport).not.toHaveBeenCalled();
    expect(effects.persistCanonicalCurb).not.toHaveBeenCalled();
  });

  it.each([
    ['unavailable', { ok: false, failureClass: 'UPSTREAM_UNAVAILABLE' }],
    ['malformed', { ok: false, failureClass: 'INVALID_RESPONSE' }],
    ['contract failure', { ok: false, failureClass: 'NOT_AUTHORITATIVE' }],
    ['BFI unavailable', { ok: false, failureClass: 'BFI_BLANK' }],
  ])('abstains when Function 3C is %s', async (_label, resolverResult) => {
    const resolve = vi.fn(async () => resolverResult);
    const effects = sideEffects();
    const result = await runCanonicalCurbOrchestrator(request(), {
      ...effects,
      resolveCanonicalCurb: vi.fn(async () => authenticPrimary),
      blockfaceResolver: { resolve },
      inFlight: new Map(),
    });
    expect(result).toEqual({ protocolVersion: 2, status: 'unsupported', reason: 'source_unavailable' });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(effects.readCanonicalCache).not.toHaveBeenCalled();
    expect(effects.persistCanonicalCurb).not.toHaveBeenCalled();
  });

  it('abstains on a Function 3C BFI mismatch before cache or persistence', async () => {
    const proof = proofResolver('1000000002');
    const effects = sideEffects();
    const result = await runCanonicalCurbOrchestrator(request(), {
      ...effects,
      resolveCanonicalCurb: vi.fn(async () => authenticPrimary),
      blockfaceResolver: proof.blockfaceResolver,
      inFlight: new Map(),
    });
    expect(result).toEqual({ protocolVersion: 2, status: 'unsupported', reason: 'source_unavailable' });
    expect(proof.transport).toHaveBeenCalledTimes(1);
    expect(effects.readCanonicalCache).not.toHaveBeenCalled();
    expect(effects.persistCanonicalCurb).not.toHaveBeenCalled();
  });

  it('does not let visual selection or a caller-shaped result reach cache before proof', async () => {
    const proof = proofResolver('1000000001');
    const effects = sideEffects();
    const plain = { state: 'SUPPORTED', identity: authenticPrimary.identity, reasons: [] };
    const selected = await runCanonicalCurbOrchestrator(request({ candidateToken: 'candidate2_aaaaaaaaaaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' }), {
      ...effects,
      applyVisualCurbSelection: vi.fn(async () => plain),
      blockfaceResolver: proof.blockfaceResolver,
      inFlight: new Map(),
    });
    expect(selected.status).toBe('unsupported');
    expect(proof.transport).not.toHaveBeenCalled();
    expect(effects.readCanonicalCache).not.toHaveBeenCalled();
    expect(effects.persistCanonicalCurb).not.toHaveBeenCalled();
  });

  it('rejects a cache hit when the orchestrator is given no proof resolver', async () => {
    const effects = sideEffects();
    effects.readCanonicalCache.mockResolvedValue({ hit: true, publicSegment: { segmentId: 'curb2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ruleSummary: { cleaningAvailable: true } } });
    const result = await runCanonicalCurbOrchestrator(request(), {
      ...effects,
      resolveCanonicalCurb: vi.fn(async () => authenticPrimary),
      inFlight: new Map(),
    });
    expect(result.status).toBe('unsupported');
    expect(effects.readCanonicalCache).not.toHaveBeenCalled();
    expect(effects.persistCanonicalCurb).not.toHaveBeenCalled();
  });

  it('does not return legacy success for a missing or non-v2 protocol', () => {
    expect(callable).toContain('request.data?.protocolVersion !== 2');
    expect(callable).toContain("status: 'unsupported'");
    expect(callable).not.toMatch(/success:\s*true/);
    expect(callable).not.toContain('_tryCreateFromSweepNYC');
    expect(callable).not.toContain('_fallbackToNYCOpenData');
    expect(callable).not.toContain('_observeCurbIntelligenceShadow');
  });

  it('sends protocol 2 from every Street Parking callable site and withholds the card without a proven segment', () => {
    const marker = "'createSegmentFromSweepNYC'";
    const indexes = [];
    let from = 0;
    while (from < clientSource.length) {
      const found = clientSource.indexOf(marker, from);
      if (found < 0) break;
      indexes.push(found);
      from = found + marker.length;
    }
    expect(indexes.length).toBeGreaterThan(0);
    for (const found of indexes) {
      const window = clientSource.slice(found, found + 700);
      const usesProtocol2 = window.includes('protocol2LocationRequest(')
        || window.includes('resolveCanonicalCurbWithLocation');
      expect(usesProtocol2).toBe(true);
    }
    expect(clientSource).toContain('resolveCanonicalCurbWithLocation');
    expect(clientSource).toContain("status === 'high_confidence'");
    expect(clientSource).toContain('segmentId: null');
    expect(clientSource).toContain("t('street_intel.could_not_verify')");
    const cardBranch = clientSource.slice(
      clientSource.indexOf("savedSpot.segmentId && savedSpot.segmentStreetName"),
      clientSource.indexOf('<StreetIntelligenceCard'),
    );
    expect(cardBranch).not.toContain('data.success');
  });
});
