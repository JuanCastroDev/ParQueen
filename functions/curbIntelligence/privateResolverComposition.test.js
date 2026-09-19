'use strict';

const { observePrivateResolverShadow } = require('./privateResolverComposition');
const { createStructuredCloudLoggingSink } = require('./structuredShadowTelemetry');

const SERVICE_URL = 'https://parqueen-curb-resolver-spike-oxbozdhlwa-uc.a.run.app';
const TUPLE = Object.freeze({
  borough: 'MANHATTAN', onStreet: 'GOLD STREET', crossStreetOne: 'BEEKMAN STREET',
  crossStreetTwo: 'ANN STREET', compassDirection: 'W', // mocked sample matches reviewed live Gold/W resolver fixture
});
const SUCCESS = Object.freeze({
  ok: true,
  officialBlockFaceId: '0212261301',
  normalizedStreetNames: {
    onStreet: TUPLE.onStreet,
    crossStreetOne: TUPLE.crossStreetOne,
    crossStreetTwo: TUPLE.crossStreetTwo,
  },
  returnCode: '00', reasonCode: ' ',
  sourceVersion: { geosupportRelease: '26C', geosupportVersion: '26.3' },
});
const DOT_VERSION = Object.freeze({
  resourceId: 'nfid-uabd', rowsUpdatedAt: '2026-01-01T00:00:00.000Z',
  viewLastModified: '2026-01-02T00:00:00.000Z',
});
const ELIGIBLE_INPUT = Object.freeze({
  productionResult: { success: true, segmentId: 'nyc-od:public-segment' },
  location: { lat: 40.712, lng: -74.006, accuracyMeters: 10 },
  productionPath: 'nyc_open_data_fallback',
  dotEvidence: {
    complete: true,
    selectedRows: [{
      order_number: 'P-100', record_type: 'Current', order_type: 'P-', borough: 'MANHATTAN',
      on_street: 'GOLD STREET', from_street: 'BEEKMAN STREET', to_street: 'ANN STREET',
      side_of_street: 'W', sign_code: 'PS-1',
      sign_description: 'NO PARKING (SANITATION BROOM SYMBOL) TUESDAY 8:30AM-10AM',
    }],
    sourceVersion: DOT_VERSION,
  },
  legacyEvidence: {
    segment: {
      source: 'nyc_open_data', provenance: { provider: 'nyc_open_data' }, status: 'active',
      confidenceScore: 1, confidence: { level: 'verified' },
      blockFaceEvidence: { blockDecisive: true, sideResolved: true, parseComplete: true },
    },
    activeRules: [{
      type: 'streetCleaning', source: 'nyc_open_data', status: 'active',
      schedules: [{ side: 'East', days: ['Tue'], startTime: '08:30', endTime: '10:00' }],
    }],
  },
});

const httpResponse = body => ({ status: 200, text: async () => JSON.stringify(body) });

function reviewedSources() {
  return {
    candidateStore: { async queryCandidates() { return null; } },
    dotSource: { async query() { return null; } },
    sink: createStructuredCloudLoggingSink({ logger: { info: vi.fn() } }),
  };
}

function shadowOptions(overrides = {}) {
  return {
    readConfig: () => ({ mode: 'shadow', serviceUrl: SERVICE_URL, samplePermille: 0 }),
    operatorAuthorized: true,
    sourceDependenciesFactory: () => reviewedSources(),
    getIdToken: vi.fn(async () => 'short-lived-token'),
    transport: vi.fn(async () => httpResponse(SUCCESS)),
    ...overrides,
  };
}

describe('private resolver minimum-shadow composition', () => {
  it('keeps a populated resolver URL and zero sample inert when mode is off', async () => {
    const productionResult = { success: true, segmentId: 'existing-segment' };
    const counters = { resolver: 0, sources: 0, auth: 0, transport: 0, shadow: 0, telemetry: 0 };
    const config = { mode: 'off', serviceUrl: SERVICE_URL, samplePermille: 0 };

    const result = await observePrivateResolverShadow({ productionResult }, {
      readConfig: () => config,
      resolverFactory: () => { counters.resolver += 1; throw new Error('must not construct'); },
      sourceDependenciesFactory: () => { counters.sources += 1; return reviewedSources(); },
      getIdToken: async () => { counters.auth += 1; },
      transport: async () => { counters.transport += 1; },
      runShadow: async () => { counters.shadow += 1; },
      sink: { record: async () => { counters.telemetry += 1; } },
    });

    expect(result).toBe(productionResult);
    expect(counters).toEqual({ resolver: 0, sources: 0, auth: 0, transport: 0, shadow: 0, telemetry: 0 });
  });

  it.each([
    ['ordinary sample-zero request', { operatorAuthorized: false }],
    ['missing accuracy', {}, { location: { lat: 40.712, lng: -74.006 } }],
    ['SweepNYC success', {}, { productionPath: 'sweepnyc' }],
    ['missing legacy evidence', {}, { legacyEvidence: null }],
    ['malformed legacy evidence', {}, { legacyEvidence: { segment: {}, activeRules: [] } }],
    ['multiple DOT orders', {}, { dotEvidence: { ...ELIGIBLE_INPUT.dotEvidence, selectedRows: [{ order_number: 'A' }, { order_number: 'B' }] } }],
    ['malformed DOT evidence', {}, { dotEvidence: { ...ELIGIBLE_INPUT.dotEvidence, selectedRows: [{ ...ELIGIBLE_INPUT.dotEvidence.selectedRows[0], sign_code: '' }] } }],
  ])('skips %s before constructing sources or resolver', async (_label, optionChanges, inputChanges = {}) => {
    const sources = vi.fn();
    const resolver = vi.fn();
    const runShadow = vi.fn();
    const input = { ...ELIGIBLE_INPUT, ...inputChanges };
    const result = await observePrivateResolverShadow(input, shadowOptions({
      sourceDependenciesFactory: sources,
      resolverFactory: resolver,
      runShadow,
      ...optionChanges,
    }));
    expect(result).toBe(input.productionResult);
    expect(sources).not.toHaveBeenCalled();
    expect(resolver).not.toHaveBeenCalled();
    expect(runShadow).not.toHaveBeenCalled();
  });

  it('creates separate resolver scopes across calls while identical tuples deduplicate within one call', async () => {
    const options = shadowOptions({
      runShadow: async ({ dependencies }) => {
        await Promise.all([
          dependencies.blockfaceResolver.resolve(TUPLE),
          dependencies.blockfaceResolver.resolve({ ...TUPLE }),
        ]);
      },
    });

    await observePrivateResolverShadow(ELIGIBLE_INPUT, options);
    await observePrivateResolverShadow(ELIGIBLE_INPUT, options);

    expect(options.getIdToken).toHaveBeenCalledTimes(2);
    expect(options.transport).toHaveBeenCalledTimes(2);
  });

  it('passes only in-memory reviewed evidence into a fresh per-call source factory', async () => {
    const factory = vi.fn(() => reviewedSources());
    await observePrivateResolverShadow(ELIGIBLE_INPUT, shadowOptions({
      sourceDependenciesFactory: factory,
      runShadow: vi.fn(async () => ({ outcome: 'COMPLETED' })),
    }));
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory.mock.calls[0][0]).toEqual(expect.objectContaining({
      dotEvidence: ELIGIBLE_INPUT.dotEvidence,
      legacyEvidence: ELIGIBLE_INPUT.legacyEvidence,
    }));
  });

  it('returns the original result unchanged regardless of output or any failure', async () => {
    const productionResult = { success: true, segmentId: 'nyc-od:public-segment', streetName: 'Visible UI Name' };
    for (const failure of [null, new Error(`failure ${SUCCESS.officialBlockFaceId}`)]) {
      const result = await observePrivateResolverShadow({ ...ELIGIBLE_INPUT, productionResult }, shadowOptions({
        runShadow: async () => {
          if (failure) throw failure;
          return { officialBlockFaceId: SUCCESS.officialBlockFaceId, mutatedResult: { success: false } };
        },
      }));
      expect(result).toBe(productionResult);
      expect(result).toEqual({ success: true, segmentId: 'nyc-od:public-segment', streetName: 'Visible UI Name' });
      expect(JSON.stringify(result)).not.toContain(SUCCESS.officialBlockFaceId);
    }
  });

  it('skips safely when reviewed source adapters are unavailable', async () => {
    const resolverFactory = vi.fn();
    const runShadow = vi.fn();
    const result = await observePrivateResolverShadow(ELIGIBLE_INPUT, shadowOptions({
      sourceDependenciesFactory: () => null,
      resolverFactory,
      runShadow,
    }));
    expect(result).toBe(ELIGIBLE_INPUT.productionResult);
    expect(resolverFactory).not.toHaveBeenCalled();
    expect(runShadow).not.toHaveBeenCalled();
  });

  it('does not trust client-shaped operator controls', async () => {
    const runShadow = vi.fn();
    await observePrivateResolverShadow({
      ...ELIGIBLE_INPUT,
      requestData: { operator: true, operatorAuthorized: true },
    }, shadowOptions({ operatorAuthorized: false, runShadow }));
    expect(runShadow).not.toHaveBeenCalled();
  });

  it('permits deterministic positive sampling without an operator override or exposing the basis', async () => {
    const runShadow = vi.fn(async input => {
      expect(input.cohort).toBe('sampled');
      expect(JSON.stringify(input)).not.toContain('nyc-od:public-segment');
    });
    await observePrivateResolverShadow(ELIGIBLE_INPUT, shadowOptions({
      readConfig: () => ({ mode: 'shadow', serviceUrl: SERVICE_URL, samplePermille: 1000 }),
      operatorAuthorized: false,
      runShadow,
    }));
    expect(runShadow).toHaveBeenCalledTimes(1);
  });

  it('returns the original result after the fixed eight-second overall shadow deadline', async () => {
    vi.useFakeTimers();
    try {
      const pending = observePrivateResolverShadow(ELIGIBLE_INPUT, shadowOptions({
        runShadow: () => new Promise(() => {}),
      }));
      await vi.advanceTimersByTimeAsync(8000);
      await expect(pending).resolves.toBe(ELIGIBLE_INPUT.productionResult);
    } finally {
      vi.useRealTimers();
    }
  });
});
