'use strict';

const {
  scheduleSides,
  cardinalFromCsclSide,
  resolverTuple,
  runSweepSideResolution,
} = require('./sweepSideResolution');

const EASTBOUND = {
  type: 'MultiLineString',
  coordinates: [[[-74.001, 40.7], [-73.999, 40.7]]],
};
const NORTHBOUND = {
  type: 'MultiLineString',
  coordinates: [[[-74, 40.699], [-74, 40.701]]],
};

const SWEEP_RULES = {
  segment: {
    source: 'sweepnyc', provenance: { provider: 'sweepnyc' }, status: 'active',
    confidenceScore: 0.95, confidence: { level: 'community' },
  },
  activeRules: [{
    type: 'streetCleaning', source: 'sweepnyc',
    schedules: [
      { side: 'East', days: ['Tue'], startTime: '08:30', endTime: '10:00' },
      { side: 'West', days: ['Wed'], startTime: '08:30', endTime: '10:00' },
    ],
  }],
};

const LOCATION = { lat: 40.7001, lng: -73.9999, accuracyMeters: 8 };
const STREET = {
  borough: 'MN',
  onStreet: 'MELVILLE STREET',
  crossStreetOne: 'JAMAICA AVENUE',
  crossStreetTwo: 'HILLSIDE AVENUE',
};

function runtime(csclSide, geometry, state = 'SUPPORTED') {
  return {
    resolution: { state, officialIdentity: { officialBlockFaceId: '0212261301' } },
    runtimeEvidence: {
      csclSide,
      selectedGeometry: geometry,
    },
  };
}

describe('SweepNYC curb side resolution', () => {
  it('maps CSCL left/right onto cardinal sides from digitized geometry', () => {
    expect(cardinalFromCsclSide('RIGHT', NORTHBOUND, LOCATION)).toBe('East');
    expect(cardinalFromCsclSide('LEFT', NORTHBOUND, { lat: 40.7, lng: -74.0001, accuracyMeters: 8 }))
      .toBe('West');
    expect(cardinalFromCsclSide('LEFT', EASTBOUND, { lat: 40.7001, lng: -74, accuracyMeters: 8 }))
      .toBe('North');
  });

  it('does not run when SweepNYC already has a single schedule side', async () => {
    const result = await runSweepSideResolution({
      location: LOCATION,
      legacyEvidence: {
        ...SWEEP_RULES,
        activeRules: [{
          type: 'streetCleaning', source: 'sweepnyc',
          schedules: [{ side: 'East', days: ['Tue'], startTime: '08:30', endTime: '10:00' }],
        }],
      },
      resolveCurbRuntime: vi.fn(),
      dependencies: { blockfaceResolver: { resolve: vi.fn() } },
    });
    expect(result.skipOrFailureClass).toBe('unambiguous_schedule');
    expect(scheduleSides(SWEEP_RULES)).toEqual(expect.arrayContaining(['East', 'West']));
  });

  it('selects east or west from a confident CSCL relationship and resolver confirmation', async () => {
    const resolve = vi.fn(async () => ({
      ok: true, officialBlockFaceId: '0212261301', returnCode: '00', reasonCode: ' ',
    }));
    const east = await runSweepSideResolution({
      location: LOCATION,
      legacyEvidence: SWEEP_RULES,
      streetContext: STREET,
      resolveCurbRuntime: async () => runtime('RIGHT', NORTHBOUND),
      dependencies: { blockfaceResolver: { resolve } },
    });
    expect(east).toEqual(expect.objectContaining({
      outcome: 'COMPLETED', curbState: 'SUPPORTED', parkingSide: 'East',
    }));
    const west = await runSweepSideResolution({
      location: { lat: 40.7, lng: -74.0001, accuracyMeters: 8 },
      legacyEvidence: SWEEP_RULES,
      streetContext: STREET,
      resolveCurbRuntime: async () => runtime('LEFT', NORTHBOUND),
      dependencies: { blockfaceResolver: { resolve } },
    });
    expect(west.parkingSide).toBe('West');
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(east)).not.toMatch(/0212261301|officialBlockFaceId/);
  });

  it('keeps the chooser on UNKNOWN, timeout, 5xx, and CAUTION', async () => {
    const unknown = await runSweepSideResolution({
      location: LOCATION,
      legacyEvidence: SWEEP_RULES,
      streetContext: STREET,
      resolveCurbRuntime: async () => runtime('RIGHT', NORTHBOUND, 'UNKNOWN'),
      dependencies: { blockfaceResolver: { resolve: vi.fn() } },
    });
    expect(unknown.parkingSide).toBe(null);
    expect(unknown.curbState).toBe('UNKNOWN');

    const timeout = await runSweepSideResolution({
      location: LOCATION,
      legacyEvidence: SWEEP_RULES,
      streetContext: STREET,
      resolveCurbRuntime: async () => runtime('RIGHT', NORTHBOUND),
      dependencies: { blockfaceResolver: { resolve: async () => ({ ok: false, failureClass: 'TIMEOUT' }) } },
    });
    expect(timeout.skipOrFailureClass).toBe('execution_timeout');
    expect(timeout.parkingSide).toBe(null);

    const fiveXx = await runSweepSideResolution({
      location: LOCATION,
      legacyEvidence: SWEEP_RULES,
      streetContext: STREET,
      resolveCurbRuntime: async () => runtime('RIGHT', NORTHBOUND),
      dependencies: { blockfaceResolver: { resolve: async () => ({ ok: false, failureClass: 'UPSTREAM_UNAVAILABLE' }) } },
    });
    expect(fiveXx.skipOrFailureClass).toBe('internal_failure');
    expect(fiveXx.parkingSide).toBe(null);

    const caution = await runSweepSideResolution({
      location: LOCATION,
      legacyEvidence: SWEEP_RULES,
      streetContext: STREET,
      resolveCurbRuntime: async () => runtime('RIGHT', NORTHBOUND, 'CAUTION'),
      dependencies: { blockfaceResolver: { resolve: vi.fn() } },
    });
    expect(caution.curbState).toBe('CAUTION');
    expect(caution.parkingSide).toBe(null);
  });

  it('builds a private resolver tuple without leaking BFI', () => {
    expect(resolverTuple(STREET, 'East')).toEqual({
      borough: 'MANHATTAN',
      onStreet: 'MELVILLE STREET',
      crossStreetOne: 'JAMAICA AVENUE',
      crossStreetTwo: 'HILLSIDE AVENUE',
      compassDirection: 'E',
    });
  });
});
