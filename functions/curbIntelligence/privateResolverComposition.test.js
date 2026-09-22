'use strict';

const { readFileSync } = require('fs');
const { join } = require('path');
const { observePrivateResolverShadow } = require('./privateResolverComposition');
const { createStructuredCloudLoggingSink } = require('./structuredShadowTelemetry');
const { runMinimumCleaningShadow } = require('./minimumCleaningShadow');
const { DEFAULT_EXECUTION_POLICY } = require('./shadowExecution');

const COMPOSITION_SOURCE = readFileSync(join(__dirname, 'privateResolverComposition.js'), 'utf8');

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

const DOT_SNAPSHOT = Object.freeze({
  candidates: [{
    orderNumber: 'P-100', recordType: 'Current', orderType: 'P-', borough: 'MANHATTAN',
    onStreet: 'GOLD STREET', fromStreet: 'BEEKMAN STREET', toStreet: 'ANN STREET', side: 'W',
    signCode: 'PS-1', signDescription: 'NO PARKING (SANITATION BROOM SYMBOL) TUESDAY 8:30AM-10AM',
    sourceVersion: DOT_VERSION,
    sourceNative: {
      record_type: 'Current', sign_code: 'PS-1',
      sign_description: 'NO PARKING (SANITATION BROOM SYMBOL) TUESDAY 8:30AM-10AM',
    },
  }],
  completeness: { state: 'COMPLETE', reason: null },
  sourceVersion: DOT_VERSION,
});
const RUNTIME = Object.freeze({
  resolution: { state: 'SUPPORTED', reasons: [], officialIdentity: { officialBlockFaceId: '0212261301' } },
  runtimeEvidence: {
    nonPersistable: true,
    officialBlockFaceId: '0212261301',
    sourceVersion: { resourceId: 'inkn-q76z', version: '1:2' },
    candidateCoverageComplete: true,
    candidateCompleteness: { state: 'COMPLETE', reason: null },
  },
});

function runBoundedCleaningShadow({ signal, dependencies }) {
  return runMinimumCleaningShadow({
    location: ELIGIBLE_INPUT.location,
    legacyEvidence: ELIGIBLE_INPUT.legacyEvidence,
    signal,
    dependencies: {
      ...dependencies,
      candidateStore: { queryCandidates: vi.fn() },
      dotSource: { query: vi.fn(async () => DOT_SNAPSHOT) },
      sink: { record: vi.fn(async () => ({ accepted: true })) },
    },
    resolveCurbRuntime: vi.fn(async () => RUNTIME),
  });
}

function shadowOptions(overrides = {}) {
  return {
    readConfig: () => ({ mode: 'shadow', serviceUrl: SERVICE_URL, samplePermille: 0, productPath: 'off' }),
    operatorAuthorized: true,
    sourceDependenciesFactory: () => reviewedSources(),
    getIdToken: vi.fn(async () => 'short-lived-token'),
    transport: vi.fn(async () => httpResponse(SUCCESS)),
    ...overrides,
  };
}

describe('private resolver minimum-shadow composition', () => {
  it('keeps the overall shadow deadline at 8000ms above the 3000ms relationship budget', () => {
    expect(COMPOSITION_SOURCE).toMatch(/const OVERALL_DEADLINE_MS = 8000;/);
    expect(DEFAULT_EXECUTION_POLICY.overallDeadlineMs).toBe(8000);
    expect(DEFAULT_EXECUTION_POLICY.sourceDeadlineMs.relationship).toBe(3000);
    expect(DEFAULT_EXECUTION_POLICY.sourceDeadlineMs.relationship)
      .toBeLessThan(DEFAULT_EXECUTION_POLICY.overallDeadlineMs);
  });

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
    ['omitted operatorAuthorized option', { operatorAuthorized: undefined }],
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
      readConfig: () => ({ mode: 'shadow', serviceUrl: SERVICE_URL, samplePermille: 1000, productPath: 'off' }),
      operatorAuthorized: false,
      runShadow,
    }));
    expect(runShadow).toHaveBeenCalledTimes(1);
  });

  it('returns the original result after the fixed eight-second overall shadow deadline', async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const pending = observePrivateResolverShadow(ELIGIBLE_INPUT, shadowOptions({
        runShadow: () => new Promise(() => {}),
      })).then(result => {
        settled = true;
        return result;
      });
      await vi.advanceTimersByTimeAsync(7999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe(ELIGIBLE_INPUT.productionResult);
    } finally {
      vi.useRealTimers();
    }
  });

  it('forwards the overall AbortSignal to resolver transport without retrying', async () => {
    const transport = vi.fn(async ({ signal }) => {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(false);
      return httpResponse(SUCCESS);
    });
    const result = await observePrivateResolverShadow(ELIGIBLE_INPUT, shadowOptions({
      transport,
      runShadow: async ({ signal, dependencies }) => {
        await dependencies.blockfaceResolver.resolve({ ...TUPLE, signal });
      },
    }));
    expect(result).toBe(ELIGIBLE_INPUT.productionResult);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(transport.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
  });

  it('keeps a 2700ms resolver completion inside the relationship budget and unchanged production result', async () => {
    vi.useFakeTimers();
    try {
      const transport = vi.fn(async ({ signal }) => {
        await new Promise(done => setTimeout(done, 2700));
        expect(signal.aborted).toBe(false);
        return httpResponse(SUCCESS);
      });
      const pending = observePrivateResolverShadow(ELIGIBLE_INPUT, shadowOptions({
        transport,
        runShadow: runBoundedCleaningShadow,
      }));
      await vi.advanceTimersByTimeAsync(2700);
      await expect(pending).resolves.toBe(ELIGIBLE_INPUT.productionResult);
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out a hanging resolver POST at 3000ms with one request and unchanged production result', async () => {
    vi.useFakeTimers();
    try {
      let transportSignal;
      const transport = vi.fn(({ signal }) => {
        transportSignal = signal;
        return new Promise(() => {});
      });
      const pending = observePrivateResolverShadow(ELIGIBLE_INPUT, shadowOptions({
        transport,
        runShadow: runBoundedCleaningShadow,
      }));
      await vi.advanceTimersByTimeAsync(2999);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(transportSignal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe(ELIGIBLE_INPUT.productionResult);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(transportSignal.aborted).toBe(true);
      expect(JSON.stringify(ELIGIBLE_INPUT.productionResult)).not.toContain(SUCCESS.officialBlockFaceId);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets the overall 8000ms deadline abort a nested relationship before 3000ms when less time remains', async () => {
    vi.useFakeTimers();
    try {
      let transportSignal;
      const transport = vi.fn(({ signal }) => {
        transportSignal = signal;
        return new Promise(() => {});
      });
      const pending = observePrivateResolverShadow(ELIGIBLE_INPUT, shadowOptions({
        transport,
        runShadow: async (input) => {
          await new Promise(done => setTimeout(done, 5500));
          return runBoundedCleaningShadow(input);
        },
      }));
      await vi.advanceTimersByTimeAsync(5500);
      expect(transport).toHaveBeenCalledTimes(1);
      expect(transportSignal.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(2500);
      await expect(pending).resolves.toBe(ELIGIBLE_INPUT.productionResult);
      expect(transportSignal.aborted).toBe(true);
      expect(transport).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs the product path without organic sampling and applies a confident overlay', async () => {
    const applyProductOverlay = vi.fn();
    const runShadow = vi.fn(async input => {
      expect(input.cohort).toBe('pre_release_product');
      return {
        outcome: 'COMPLETED',
        skipOrFailureClass: 'none',
        curbState: 'SUPPORTED',
        cleaningState: 'SUPPORTED',
        comparisonCategory: 'schedule_difference',
        productSchedules: [{ side: 'East', days: ['Tue'], startTime: '08:30', endTime: '10:00' }],
      };
    });
    const result = await observePrivateResolverShadow(ELIGIBLE_INPUT, shadowOptions({
      readConfig: () => ({ mode: 'shadow', serviceUrl: SERVICE_URL, samplePermille: 100, productPath: 'on' }),
      operatorAuthorized: false,
      runShadow,
      applyProductOverlay,
    }));
    expect(result).toBe(ELIGIBLE_INPUT.productionResult);
    expect(runShadow).toHaveBeenCalledTimes(1);
    expect(applyProductOverlay).toHaveBeenCalledTimes(1);
    expect(applyProductOverlay.mock.calls[0][1]).toEqual(expect.objectContaining({ apply: true, caution: false }));
  });

  it('does not apply overlay after timeout or internal failure', async () => {
    const applyProductOverlay = vi.fn();
    await observePrivateResolverShadow(ELIGIBLE_INPUT, shadowOptions({
      readConfig: () => ({ mode: 'shadow', serviceUrl: SERVICE_URL, samplePermille: 100, productPath: 'on' }),
      operatorAuthorized: false,
      runShadow: async () => ({ outcome: 'FAILED', skipOrFailureClass: 'internal_failure' }),
      applyProductOverlay,
    }));
    expect(applyProductOverlay.mock.calls[0][1].apply).toBe(false);
  });

  it('does not let the client enable product execution', async () => {
    const runShadow = vi.fn();
    await observePrivateResolverShadow({
      ...ELIGIBLE_INPUT,
      requestData: { productPath: 'on', operatorAuthorized: true },
    }, shadowOptions({
      readConfig: () => ({ mode: 'shadow', serviceUrl: SERVICE_URL, samplePermille: 100, productPath: 'off' }),
      operatorAuthorized: false,
      runShadow,
    }));
    expect(runShadow).not.toHaveBeenCalled();
  });

  it('logs a privacy-safe product skip when SweepNYC evidence is present but accuracy is missing', async () => {
    const logger = { info: vi.fn() };
    const runShadow = vi.fn();
    await observePrivateResolverShadow({
      ...SWEEP_INPUT,
      location: { lat: 40.712, lng: -74.006 },
    }, shadowOptions({
      readConfig: () => ({ mode: 'shadow', serviceUrl: SERVICE_URL, samplePermille: 100, productPath: 'on' }),
      operatorAuthorized: false,
      logger,
      runShadow,
    }));
    expect(runShadow).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'curb_product_skip',
      reason: 'accuracy_missing',
      accuracyPresent: false,
      productionPath: 'sweepnyc',
    }));
    expect(JSON.stringify(logger.info.mock.calls)).not.toMatch(/officialBlockFaceId|blockFaceId|BFI|0212261301/);
  });
});

const SWEEP_LEGACY = Object.freeze({
  segment: {
    source: 'sweepnyc', provenance: { provider: 'sweepnyc' }, status: 'active',
    confidenceScore: 0.95, confidence: { level: 'community' },
  },
  activeRules: [{
    type: 'streetCleaning', source: 'sweepnyc', status: 'active',
    schedules: [
      { side: 'East', days: ['Tue'], startTime: '08:30', endTime: '10:00' },
      { side: 'West', days: ['Wed'], startTime: '08:30', endTime: '10:00' },
    ],
  }],
});

const SWEEP_INPUT = Object.freeze({
  productionResult: {
    success: true, segmentId: 'nyc_melville', parkingSide: 'West', streetName: 'MELVILLE STREET',
  },
  location: { lat: 40.712, lng: -74.006, accuracyMeters: 10 },
  productionPath: 'sweepnyc',
  streetContext: {
    borough: 'MANHATTAN', onStreet: 'MELVILLE STREET',
    crossStreetOne: 'JAMAICA AVENUE', crossStreetTwo: 'HILLSIDE AVENUE',
  },
  legacyEvidence: SWEEP_LEGACY,
});

describe('SweepNYC product-path side composition', () => {
  it('auto-selects east or west from SweepNYC schedules with cohort=pre_release_product', async () => {
    const applyProductOverlay = vi.fn();
    for (const side of ['East', 'West']) {
      const result = await observePrivateResolverShadow(SWEEP_INPUT, shadowOptions({
        readConfig: () => ({ mode: 'shadow', serviceUrl: SERVICE_URL, samplePermille: 100, productPath: 'on' }),
        operatorAuthorized: false,
        applyProductOverlay,
        runSweepSideResolution: async input => {
          expect(input.cohort).toBe('pre_release_product');
          return {
            outcome: 'COMPLETED', skipOrFailureClass: 'none', curbState: 'SUPPORTED', parkingSide: side,
          };
        },
        runShadow: vi.fn(async () => { throw new Error('organic shadow must not run'); }),
      }));
      expect(result.parkingSide).toBe(side);
      expect(result.sideConfidence).toBe('high');
      expect(result.streetName).toBe('MELVILLE STREET');
      expect(JSON.stringify(result)).not.toMatch(/officialBlockFaceId|blockFaceId|BFI|0212261301/);
    }
    expect(applyProductOverlay).not.toHaveBeenCalled();
  });

  it('keeps the original SweepNYC result on UNKNOWN, timeout, 5xx, and CAUTION', async () => {
    for (const execution of [
      { outcome: 'UNKNOWN', skipOrFailureClass: 'relationship_unknown', curbState: 'UNKNOWN' },
      { outcome: 'FAILED', skipOrFailureClass: 'execution_timeout', curbState: 'UNKNOWN' },
      { outcome: 'FAILED', skipOrFailureClass: 'internal_failure', curbState: 'UNKNOWN' },
      { outcome: 'COMPLETED', skipOrFailureClass: 'none', curbState: 'CAUTION', parkingSide: 'East' },
    ]) {
      const result = await observePrivateResolverShadow(SWEEP_INPUT, shadowOptions({
        readConfig: () => ({ mode: 'shadow', serviceUrl: SERVICE_URL, samplePermille: 100, productPath: 'on' }),
        operatorAuthorized: false,
        runSweepSideResolution: async () => execution,
      }));
      expect(result).toBe(SWEEP_INPUT.productionResult);
      expect(result.sideConfidence).toBeUndefined();
    }
  });

  it('does not count SweepNYC product execution as organic sampled', async () => {
    const runShadow = vi.fn();
    await observePrivateResolverShadow(SWEEP_INPUT, shadowOptions({
      readConfig: () => ({ mode: 'shadow', serviceUrl: SERVICE_URL, samplePermille: 1000, productPath: 'on' }),
      operatorAuthorized: false,
      runShadow,
      runSweepSideResolution: async input => {
        expect(input.cohort).toBe('pre_release_product');
        return { outcome: 'COMPLETED', skipOrFailureClass: 'none', curbState: 'SUPPORTED', parkingSide: 'East' };
      },
    }));
    expect(runShadow).not.toHaveBeenCalled();
  });

  it('leaves organic 1000‰ NYC Open Data sampled cohort on the shadow path', async () => {
    const runShadow = vi.fn(async input => {
      expect(input.cohort).toBe('sampled');
      return { outcome: 'COMPLETED' };
    });
    await observePrivateResolverShadow(ELIGIBLE_INPUT, shadowOptions({
      readConfig: () => ({ mode: 'shadow', serviceUrl: SERVICE_URL, samplePermille: 1000, productPath: 'off' }),
      operatorAuthorized: false,
      runShadow,
      runSweepSideResolution: vi.fn(async () => { throw new Error('sweep runner must not run'); }),
    }));
    expect(runShadow).toHaveBeenCalledTimes(1);
  });

  it('logs a privacy-safe product skip when SweepNYC evidence is present but accuracy is missing', async () => {
    const logger = { info: vi.fn() };
    const runShadow = vi.fn();
    await observePrivateResolverShadow({
      ...SWEEP_INPUT,
      location: { lat: 40.712, lng: -74.006 },
    }, shadowOptions({
      readConfig: () => ({ mode: 'shadow', serviceUrl: SERVICE_URL, samplePermille: 100, productPath: 'on' }),
      operatorAuthorized: false,
      logger,
      runShadow,
    }));
    expect(runShadow).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({
      event: 'curb_product_skip',
      reason: 'accuracy_missing',
      accuracyPresent: false,
      productionPath: 'sweepnyc',
    }));
    expect(JSON.stringify(logger.info.mock.calls)).not.toMatch(/officialBlockFaceId|blockFaceId|BFI|0212261301/);
  });
});
