import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { createOfficialDotRelationshipProvider } = require('./officialDotRelationshipProvider');
const { associateDotCandidates, createFaceAssociationContext } = require('./dotFaceAssociation');

const DOT_VERSION = Object.freeze({
  resourceId: 'nfid-uabd',
  rowsUpdatedAt: '2026-09-15T10:04:47Z',
  viewLastModified: '2026-09-15T10:00:16Z',
});
const RESOLVER_VERSION = Object.freeze({ release: '26c', provider: 'nyc-geosupport-function-3c' });
const FACE = '0212261301';

function candidate(overrides = {}) {
  return {
    orderNumber: 'P-01775228',
    recordType: 'Current',
    orderType: 'P-',
    borough: 'MANHATTAN',
    onStreet: 'GOLD STREET',
    onStreetSuffix: null,
    fromStreet: 'BEEKMAN STREET',
    fromStreetSuffix: null,
    toStreet: 'ANN STREET',
    toStreetSuffix: null,
    side: 'W',
    signCode: 'PS-246B',
    signDescription: 'NO PARKING (SANITATION BROOM SYMBOL) MONDAY 6:30AM-7:30AM <->',
    sourceVersion: DOT_VERSION,
    sourceNative: {},
    ...overrides,
  };
}

function snapshot(candidates, overrides = {}) {
  return {
    candidates,
    completeness: { state: 'COMPLETE', reason: null },
    sourceVersion: DOT_VERSION,
    ...overrides,
  };
}

function success(overrides = {}) {
  return {
    ok: true,
    officialBlockFaceId: FACE,
    normalizedStreetNames: {
      onStreet: 'GOLD STREET',
      crossStreetOne: 'BEEKMAN STREET',
      crossStreetTwo: 'ANN STREET',
    },
    returnCode: '00',
    reasonCode: null,
    sourceVersion: RESOLVER_VERSION,
    ...overrides,
  };
}

function provider(blockfaceResolver = { resolve: vi.fn(async () => success()) }) {
  return createOfficialDotRelationshipProvider({
    blockfaceResolver,
    providerId: 'nyc-geosupport-function-3c',
  });
}

function input(candidates = [candidate()], overrides = {}) {
  return {
    resolution: { state: 'SUPPORTED', officialIdentity: { officialBlockFaceId: FACE } },
    candidateSnapshot: snapshot(candidates),
    signal: new AbortController().signal,
    ...overrides,
  };
}

describe('official DOT order relationship provider', () => {
  it('maps an exact official block-front tuple and exact BFI to WHOLE_FACE', async () => {
    const blockfaceResolver = { resolve: vi.fn(async () => success()) };
    const result = await provider(blockfaceResolver).resolve(input());

    expect(result.ok).toBe(true);
    expect(result.faceContext.officialRelationship.orderApplicability).toEqual({
      'P-01775228': 'WHOLE_FACE',
    });
    expect(result.faceContext.officialRelationship.version).toContain(DOT_VERSION.rowsUpdatedAt);
    expect(result.faceContext.officialRelationship.version).toContain(DOT_VERSION.viewLastModified);
    expect(result.faceContext.officialRelationship.version).toContain('release:26c');
    expect(blockfaceResolver.resolve).toHaveBeenCalledWith({
      borough: 'MANHATTAN',
      onStreet: 'GOLD STREET',
      crossStreetOne: 'BEEKMAN STREET',
      crossStreetTwo: 'ANN STREET',
      compassDirection: 'W',
      signal: expect.any(AbortSignal),
    });
  });

  it.each([
    ['exact BFI with unknown geometry', { orderType: 'C-' }, 'dot_geometry_applicability_unknown'],
    ['BFI mismatch', {}, 'official_blockface_mismatch', success({ officialBlockFaceId: '0212261302' })],
    ['resolver ambiguity', {}, 'official_blockface_ambiguous', { ok: false, returnCode: '46', reasonCode: 'ambiguous' }],
    ['contradictory success carrying ambiguity', {}, 'official_blockface_ambiguous', success({ returnCode: '46', reasonCode: 'ambiguous' })],
    ['invalid compass side', { side: 'SIDEWAYS' }, 'dot_order_location_incomplete'],
    ['missing cross street', { toStreet: null }, 'dot_order_location_incomplete'],
    ['on-street suffix', { onStreetSuffix: 'W RDWY' }, 'dot_suffix_unresolved'],
    ['from-street suffix', { fromStreetSuffix: 'N S/R' }, 'dot_suffix_unresolved'],
    ['to-street suffix', { toStreetSuffix: 'E RDWY' }, 'dot_suffix_unresolved'],
    ['stretch order', { orderType: 'B-' }, 'dot_stretch_requires_decomposition'],
  ])('fails closed for %s', async (_label, candidateOverrides, reason, resolverResult = success()) => {
    const blockfaceResolver = { resolve: vi.fn(async () => resolverResult) };
    const result = await provider(blockfaceResolver).resolve(input([candidate(candidateOverrides)]));
    expect(result.faceContext.officialRelationship.orderApplicability).toEqual({
      [candidateOverrides.orderNumber || 'P-01775228']: 'UNKNOWN',
    });
    expect(result.diagnostics.orderReasons[candidateOverrides.orderNumber || 'P-01775228']).toContain(reason);
  });

  it.each([
    ['09', 'official_blockface_lookup_failed'],
    ['39', 'official_blockface_lookup_failed'],
    ['40', 'official_blockface_lookup_failed'],
    ['44', 'official_blockface_lookup_failed'],
    ['46', 'official_blockface_ambiguous'],
    ['50', 'official_blockface_lookup_failed'],
  ])('lets reviewed Function 3C failure code %s override contradictory success metadata', async (returnCode, reason) => {
    const result = await provider({
      resolve: vi.fn(async () => success({ returnCode })),
    }).resolve(input());

    expect(result.faceContext.officialRelationship.orderApplicability).toEqual({
      'P-01775228': 'UNKNOWN',
    });
    expect(result.diagnostics.orderReasons['P-01775228']).toContain(reason);
  });

  it('classifies geometry from documented order_type semantics, not a similar order-number prefix', async () => {
    const result = await provider().resolve(input([candidate({
      orderNumber: 'P-01775228',
      orderType: 'C-',
    })]));
    expect(result.faceContext.officialRelationship.orderApplicability['P-01775228']).toBe('UNKNOWN');
  });

  it('accepts reversed cross-street order when the authoritative resolver returns the same face', async () => {
    const blockfaceResolver = { resolve: vi.fn(async () => success({
      normalizedStreetNames: {
        onStreet: 'GOLD STREET',
        crossStreetOne: 'ANN STREET',
        crossStreetTwo: 'BEEKMAN STREET',
      },
    })) };
    const result = await provider(blockfaceResolver).resolve(input([candidate({
      fromStreet: 'ANN STREET',
      toStreet: 'BEEKMAN STREET',
    })]));
    expect(result.faceContext.officialRelationship.orderApplicability['P-01775228']).toBe('WHOLE_FACE');
  });

  it('accepts repeated consistent rows without depending on row order', async () => {
    const first = candidate({ signCode: 'PS-246B' });
    const second = candidate({ signCode: 'PS-18B' });
    const left = await provider().resolve(input([first, second]));
    const right = await provider().resolve(input([second, first]));
    expect(left.faceContext.officialRelationship.orderApplicability).toEqual(right.faceContext.officialRelationship.orderApplicability);
    expect(left.faceContext.officialRelationship.orderApplicability['P-01775228']).toBe('WHOLE_FACE');
  });

  it('fails a grouped order closed when material location rows conflict', async () => {
    const result = await provider().resolve(input([
      candidate(),
      candidate({ toStreet: 'FULTON STREET', signCode: 'PS-18B' }),
    ]));
    expect(result.faceContext.officialRelationship.orderApplicability['P-01775228']).toBe('UNKNOWN');
    expect(result.diagnostics.orderReasons['P-01775228']).toContain('dot_order_location_conflict');
  });

  it('fails a grouped order closed when rows disagree on official geometry classification', async () => {
    const result = await provider().resolve(input([
      candidate(),
      candidate({ orderType: 'B-', signCode: 'PS-18B' }),
    ]));
    expect(result.faceContext.officialRelationship.orderApplicability['P-01775228']).toBe('UNKNOWN');
    expect(result.diagnostics.orderReasons['P-01775228']).toContain('dot_order_location_conflict');
  });

  it('emits explicit UNKNOWN for every unresolved relevant order and prevents downstream promotion', async () => {
    const resolved = candidate();
    const unresolved = candidate({
      orderNumber: 'P-01775229',
      onStreetSuffix: 'W RDWY',
    });
    const result = await provider().resolve(input([resolved, unresolved]));
    expect(result.faceContext.officialRelationship.orderApplicability).toEqual({
      'P-01775228': 'WHOLE_FACE',
      'P-01775229': 'UNKNOWN',
    });

    const downstream = associateDotCandidates(
      createFaceAssociationContext(result.faceContext),
      snapshot([resolved, unresolved]),
    );
    expect(downstream.state).toBe('UNKNOWN');
    expect(downstream.applicability).toBe('UNKNOWN');
  });

  it.each([
    ['missing resolver', null, 'official_blockface_lookup_unavailable'],
    ['resolver throw', { resolve: vi.fn(async () => { throw new Error('sensitive upstream text'); }) }, 'official_blockface_lookup_failed'],
    ['malformed resolver result', { resolve: vi.fn(async () => ({ ok: true })) }, 'official_blockface_lookup_failed'],
    ['invalid resolver BFI', { resolve: vi.fn(async () => success({ officialBlockFaceId: 'not-a-bfi' })) }, 'official_blockface_lookup_failed'],
    ['missing resolver return code', { resolve: vi.fn(async () => success({ returnCode: null })) }, 'official_blockface_lookup_failed'],
    ['missing resolver source version', { resolve: vi.fn(async () => success({ sourceVersion: null })) }, 'official_blockface_lookup_failed'],
  ])('fails closed for %s without retaining raw errors', async (_label, resolver, reason) => {
    const result = await provider(resolver).resolve(input());
    expect(result.faceContext.officialRelationship.orderApplicability['P-01775228']).toBe('UNKNOWN');
    expect(result.diagnostics.orderReasons['P-01775228']).toContain(reason);
    expect(JSON.stringify(result)).not.toContain('sensitive upstream text');
  });

  it('passes the caller AbortSignal unchanged and fails an aborted lookup closed', async () => {
    const controller = new AbortController();
    const blockfaceResolver = { resolve: vi.fn(async ({ signal }) => {
      expect(signal).toBe(controller.signal);
      controller.abort();
      throw new DOMException('aborted details', 'AbortError');
    }) };
    const result = await provider(blockfaceResolver).resolve(input([candidate()], { signal: controller.signal }));
    expect(result.faceContext.officialRelationship.orderApplicability['P-01775228']).toBe('UNKNOWN');
    expect(result.diagnostics.orderReasons['P-01775228']).toContain('official_blockface_lookup_failed');
    expect(JSON.stringify(result)).not.toContain('aborted details');
  });

  it('makes zero lookups for a pre-aborted signal while retaining every order as explicit UNKNOWN', async () => {
    const controller = new AbortController();
    controller.abort();
    const blockfaceResolver = { resolve: vi.fn(async () => success()) };
    const result = await provider(blockfaceResolver).resolve(input([
      candidate(),
      candidate({ orderNumber: 'S-00000001', orderType: 'S-' }),
    ], { signal: controller.signal }));

    expect(blockfaceResolver.resolve).not.toHaveBeenCalled();
    expect(result.faceContext.officialRelationship.orderApplicability).toEqual({
      'P-01775228': 'UNKNOWN',
      'S-00000001': 'UNKNOWN',
    });
  });

  it('does not promote or start later lookups when the signal aborts during the first lookup', async () => {
    const controller = new AbortController();
    const blockfaceResolver = { resolve: vi.fn(async () => {
      controller.abort();
      return success();
    }) };
    const result = await provider(blockfaceResolver).resolve(input([
      candidate(),
      candidate({ orderNumber: 'S-00000001', orderType: 'S-' }),
    ], { signal: controller.signal }));

    expect(blockfaceResolver.resolve).toHaveBeenCalledTimes(1);
    expect(result.faceContext.officialRelationship.orderApplicability).toEqual({
      'P-01775228': 'UNKNOWN',
      'S-00000001': 'UNKNOWN',
    });
  });

  it('does not start later lookups or retain raw text when the first lookup throws after abort', async () => {
    const controller = new AbortController();
    const blockfaceResolver = { resolve: vi.fn(async () => {
      controller.abort();
      throw new DOMException('private abort detail', 'AbortError');
    }) };
    const result = await provider(blockfaceResolver).resolve(input([
      candidate(),
      candidate({ orderNumber: 'S-00000001', orderType: 'S-' }),
    ], { signal: controller.signal }));

    expect(blockfaceResolver.resolve).toHaveBeenCalledTimes(1);
    expect(result.faceContext.officialRelationship.orderApplicability).toEqual({
      'P-01775228': 'UNKNOWN',
      'S-00000001': 'UNKNOWN',
    });
    expect(JSON.stringify(result)).not.toContain('private abort detail');
  });

  it('resolves every valid order when the signal remains active', async () => {
    const blockfaceResolver = { resolve: vi.fn(async () => success()) };
    const result = await provider(blockfaceResolver).resolve(input([
      candidate(),
      candidate({ orderNumber: 'S-00000001', orderType: 'S-' }),
    ]));

    expect(blockfaceResolver.resolve).toHaveBeenCalledTimes(2);
    expect(result.faceContext.officialRelationship.orderApplicability).toEqual({
      'P-01775228': 'WHOLE_FACE',
      'S-00000001': 'WHOLE_FACE',
    });
  });

  it('fails every relevant order closed for incomplete snapshots and source-version disagreement', async () => {
    const candidates = [candidate(), candidate({ orderNumber: 'S-00000001' })];
    const incomplete = await provider().resolve(input(candidates, {
      candidateSnapshot: snapshot(candidates, { completeness: { state: 'INCOMPLETE', reason: 'truncated' } }),
    }));
    expect(incomplete.faceContext.officialRelationship.orderApplicability).toEqual({
      'P-01775228': 'UNKNOWN',
      'S-00000001': 'UNKNOWN',
    });

    const inconsistent = await provider().resolve(input([
      candidate(),
      candidate({ orderNumber: 'S-00000001', sourceVersion: { ...DOT_VERSION, rowsUpdatedAt: '2026-09-16T00:00:00Z' } }),
    ]));
    expect(inconsistent.faceContext.officialRelationship.orderApplicability['P-01775228']).toBe('UNKNOWN');
    expect(inconsistent.faceContext.officialRelationship.orderApplicability['S-00000001']).toBe('UNKNOWN');
    expect(inconsistent.diagnostics.orderReasons['P-01775228']).toContain('source_version_mismatch');
    expect(inconsistent.diagnostics.orderReasons['S-00000001']).toContain('source_version_mismatch');
  });

  it('fails resolved orders closed when the authoritative resolver version changes within one snapshot', async () => {
    let calls = 0;
    const blockfaceResolver = {
      resolve: vi.fn(async () => success({ sourceVersion: { release: calls++ === 0 ? '26c' : '26d' } })),
    };
    const second = candidate({ orderNumber: 'S-00000001' });
    const result = await provider(blockfaceResolver).resolve(input([candidate(), second]));
    expect(result.faceContext.officialRelationship.orderApplicability).toEqual({
      'P-01775228': 'UNKNOWN',
      'S-00000001': 'UNKNOWN',
    });
    expect(result.diagnostics.orderReasons['P-01775228']).toContain('source_version_mismatch');
    expect(result.diagnostics.orderReasons['S-00000001']).toContain('source_version_mismatch');
  });
});
