'use strict';

const {
  observePrivateResolverShadow,
} = require('./privateResolverComposition');

const SERVICE_URL = 'https://parqueen-curb-resolver-spike-oxbozdhlwa-uc.a.run.app';
const TUPLE = Object.freeze({
  borough: 'MANHATTAN',
  onStreet: 'GOLD STREET',
  crossStreetOne: 'BEEKMAN STREET',
  crossStreetTwo: 'ANN STREET',
  compassDirection: 'E',
});
const SUCCESS = Object.freeze({
  ok: true,
  officialBlockFaceId: '0212261301',
  normalizedStreetNames: {
    onStreet: TUPLE.onStreet,
    crossStreetOne: TUPLE.crossStreetOne,
    crossStreetTwo: TUPLE.crossStreetTwo,
  },
  returnCode: '00',
  reasonCode: ' ',
  sourceVersion: { geosupportRelease: '26C', geosupportVersion: '26.3' },
});

const httpResponse = body => ({ status: 200, text: async () => JSON.stringify(body) });

function reviewedSources() {
  return {
    curbCandidateStore: { async queryCandidates() { return null; } },
    dotSource: { async query() { return null; } },
    parkNycSource: { async query() { return null; } },
  };
}

function shadowOptions(overrides = {}) {
  return {
    readConfig: () => ({ mode: 'shadow', serviceUrl: SERVICE_URL }),
    sourceDependenciesFactory: () => reviewedSources(),
    getIdToken: vi.fn(async () => 'short-lived-token'),
    transport: vi.fn(async () => httpResponse(SUCCESS)),
    ...overrides,
  };
}

describe('private resolver production composition', () => {
  it('returns before resolver construction, URL access, auth, transport, or orchestration when off', async () => {
    const productionResult = { success: true, segmentId: 'existing-segment' };
    const counters = { resolver: 0, sources: 0, auth: 0, transport: 0, shadow: 0 };
    const config = { mode: 'off' };
    Object.defineProperty(config, 'serviceUrl', { get() { throw new Error('URL must stay unread'); } });

    const result = await observePrivateResolverShadow({ productionResult }, {
      readConfig: () => config,
      resolverFactory: () => { counters.resolver += 1; throw new Error('must not construct'); },
      sourceDependenciesFactory: () => { counters.sources += 1; return reviewedSources(); },
      getIdToken: async () => { counters.auth += 1; },
      transport: async () => { counters.transport += 1; },
      runShadow: async () => { counters.shadow += 1; },
    });

    expect(result).toBe(productionResult);
    expect(counters).toEqual({ resolver: 0, sources: 0, auth: 0, transport: 0, shadow: 0 });
  });

  it('creates separate resolver/dedup scopes for separate callable executions', async () => {
    const options = shadowOptions({
      runShadow: async ({ dependencies }) => {
        await Promise.all([
          dependencies.blockfaceResolver.resolve(TUPLE),
          dependencies.blockfaceResolver.resolve({ ...TUPLE }),
        ]);
      },
    });

    await observePrivateResolverShadow({ productionResult: { success: true } }, options);
    await observePrivateResolverShadow({ productionResult: { success: true } }, options);

    expect(options.getIdToken).toHaveBeenCalledTimes(2);
    expect(options.transport).toHaveBeenCalledTimes(2);
  });

  it('returns the original production result object regardless of shadow output', async () => {
    const productionResult = { success: true, segmentId: 'existing-segment', streetName: 'Visible UI Name' };
    const options = shadowOptions({
      runShadow: async () => ({
        officialBlockFaceId: SUCCESS.officialBlockFaceId,
        mutatedResult: { success: false },
      }),
    });

    const result = await observePrivateResolverShadow({ productionResult }, options);

    expect(result).toBe(productionResult);
    expect(result).toEqual({ success: true, segmentId: 'existing-segment', streetName: 'Visible UI Name' });
    expect(JSON.stringify(result)).not.toContain(SUCCESS.officialBlockFaceId);
  });

  it.each([
    'resolver rejection', 'authentication failure', 'network failure', 'malformed response',
    'timeout', 'abort', 'unexpected resolver exception', 'shadow orchestration exception',
  ])('isolates %s from the production result', async failureClass => {
    const productionResult = { success: false, reason: 'existing_behavior' };
    const options = shadowOptions({
      runShadow: async () => { throw new Error(`${failureClass}: ${SUCCESS.officialBlockFaceId}`); },
    });

    await expect(observePrivateResolverShadow({ productionResult }, options)).resolves.toBe(productionResult);
  });

  it('skips shadow safely when reviewed production source adapters are unavailable', async () => {
    const productionResult = { success: true };
    const resolverFactory = vi.fn();
    const runShadow = vi.fn();
    const getIdToken = vi.fn();
    const transport = vi.fn();

    const result = await observePrivateResolverShadow({ productionResult }, shadowOptions({
      sourceDependenciesFactory: () => null,
      resolverFactory,
      runShadow,
      getIdToken,
      transport,
    }));

    expect(result).toBe(productionResult);
    expect(resolverFactory).not.toHaveBeenCalled();
    expect(runShadow).not.toHaveBeenCalled();
    expect(getIdToken).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
  });

  it('forces the privacy-safe no-op sink and does not expose BFI through result or telemetry', async () => {
    const productionResult = { success: true };
    const externalSink = { record: vi.fn() };
    let injected;
    const options = shadowOptions({
      sourceDependenciesFactory: () => ({ ...reviewedSources(), sink: externalSink }),
      runShadow: async input => {
        injected = input.dependencies;
        await input.dependencies.sink.record({ officialBlockFaceId: SUCCESS.officialBlockFaceId });
        return { officialBlockFaceId: SUCCESS.officialBlockFaceId };
      },
    });

    const result = await observePrivateResolverShadow({ productionResult }, options);

    expect(result).toBe(productionResult);
    expect(externalSink.record).not.toHaveBeenCalled();
    expect(injected.sink.snapshot()).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(SUCCESS.officialBlockFaceId);
  });
});
