import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { createRequire } from 'module';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SAVED_SPOT_KEY, type SavedSpot } from '../utils/savedSpot';

vi.hoisted(() => {
  const store = new Map<string, string>();
  (globalThis as { localStorage: Storage }).localStorage = {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => { store.set(key, String(value)); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    key: () => null,
    length: 0,
  } as Storage;
  (globalThis as { window: Window }).window = {
    location: { search: '' },
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Window;
});

const historicalCopy: Record<string, string> = {
  'street_intel.safe_until_label': 'Safe Until',
  'check.overall_clear': 'No known issue found',
  'check.street_next': 'Next: street cleaning {day} at {time}',
};

vi.mock('../i18n', async () => {
  const actual = await vi.importActual<typeof import('../i18n')>('../i18n');
  return {
    ...actual,
    t: (key: string, vars?: Record<string, unknown>) => {
      const historical = historicalCopy[key];
      if (!historical) return actual.t(key, vars as never);
      return historical.replace(/\{(\w+)\}/g, (_match, name: string) => String(vars?.[name] ?? ''));
    },
  };
});

let segmentReads = 0;
let segmentData: Record<string, unknown> | null = null;
let streetRuleRows: { id: string; data: Record<string, unknown> }[] = [];

vi.mock('../firebase', () => ({ db: {} }));
vi.mock('firebase/firestore', () => ({
  collection: (_db: unknown, ...path: string[]) => ({ __col: path }),
  doc: (_db: unknown, ...path: string[]) => ({ __doc: path }),
  query: (base: object, ...constraints: unknown[]) => ({ ...base, __constraints: constraints }),
  where: (field: string, op: string, value: unknown) => ({ __kind: 'where', field, op, value }),
  orderBy: (field: string, dir?: string) => ({ __kind: 'orderBy', field, dir }),
  getDoc: (ref: { __doc?: string[] }) => {
    if (ref?.__doc?.[0] === 'streetSegments') segmentReads += 1;
    return Promise.resolve({
      exists: () => segmentData != null,
      data: () => segmentData,
    });
  },
  getDocs: (q: { __col?: string[] }) => {
    const column = Array.isArray(q.__col) ? q.__col[q.__col.length - 1] : '';
    const rows = column === 'streetRules' ? streetRuleRows : [];
    return Promise.resolve({ docs: rows.map(row => ({ id: row.id, data: () => row.data })) });
  },
}));
vi.mock('./assistant/HydrantDistanceTool', () => ({
  lookupNearestHydrant: vi.fn(async () => ({ status: 'found', meters: 40 })),
}));

import { StreetIntelligenceCard } from './street-parking/legacy8650f23/StreetIntelligenceCard';
import { ParkingCheckTool } from './assistant/legacy8650f23/ParkingCheckTool';

const require = createRequire(import.meta.url);
const { buildHighConfidenceResponse } = require('../functions/curbIntelligence/canonicalCurbPublicResponse');

const CLEANING_RULE = {
  category: 'cleaning',
  type: 'streetCleaning',
  source: 'nyc_open_data',
  schedules: [{ days: ['Mon', 'Thu'], startTime: '08:30', endTime: '10:00', side: 'West' }],
};

function textOf(renderer: TestRenderer.ReactTestRenderer): string {
  return renderer.root.findAll(node => typeof node.children?.[0] === 'string')
    .flatMap(node => node.children.filter((child): child is string => typeof child === 'string'))
    .join(' ');
}

async function renderCard(rules: readonly Record<string, unknown>[] | null, status: 'verified' | 'partial' | 'unknown' | null) {
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <StreetIntelligenceCard
        segmentId="curb2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        parkingSide="West"
        streetName="MELVILLE STREET"
        sideConfidence="high"
        confirmedParkingSide={null}
        resolvedPublicRules={rules}
        resolvedRegulationStatus={status}
        onConfirmSide={vi.fn()}
      />,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return textOf(renderer);
}

function savedSpot(overrides: Partial<SavedSpot>): SavedSpot {
  return {
    lat: 40.7,
    lng: -73.99,
    address: 'Melville Street',
    savedAt: Date.now(),
    sessionId: 'session',
    linkedPingId: null,
    segmentId: 'curb2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    parkingSide: 'West',
    restrictionVersionId: null,
    segmentStreetName: 'MELVILLE STREET',
    streetIntelStatus: 'found',
    streetIntelReason: null,
    streetIntelCheckedAt: new Date().toISOString(),
    curbProtocolVersion: 2,
    curbResolutionStatus: 'high_confidence',
    curbSelector: null,
    curbSideConfirmation: null,
    curbRefreshAttempted: false,
    gpsAccuracyMeters: 1,
    sideConfidence: 'high',
    confirmedParkingSide: null,
    ...overrides,
  };
}

async function renderCheck(spot: SavedSpot) {
  localStorage.setItem(SAVED_SPOT_KEY, JSON.stringify(spot));
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(<ParkingCheckTool />);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
  return textOf(renderer);
}

describe('8650f23 client against the legacy response gate', () => {
  beforeEach(() => {
    segmentReads = 0;
    segmentData = null;
    streetRuleRows = [];
    localStorage.clear();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-23T12:00:00.000Z'));
  });

  it('shows Safe Until for the pre-gate version 1 cleaning payload', async () => {
    const myCar = await renderCard([CLEANING_RULE], 'verified');
    expect(myCar).toContain('Safe Until');
    expect(segmentReads).toBe(0);
    const parking = await renderCheck(savedSpot({
      publicRules: [CLEANING_RULE],
      regulationStatus: 'verified',
    }));
    expect(parking).toContain('No known issue found');
    expect(parking).toContain('Next: street cleaning');
  });

  it('does not show Safe Until for the gated version 1 response and does not read Firestore', async () => {
    const response = buildHighConfidenceResponse({
      segmentId: 'curb2_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      streetName: 'MELVILLE STREET',
      sideLabel: 'West',
    }, {
      rules: [CLEANING_RULE],
      cleaning: CLEANING_RULE,
      restrictions: [],
      timeLimits: [],
      meter: null,
      conflicts: [],
    }, {
      includeExtended: true,
      responseVersion: 1,
      dotComplete: true,
      sources: { parkNyc: { state: 'unavailable', reason: 'source_unavailable' } },
    });
    const myCar = await renderCard(response.publicRules, response.regulationStatus);
    expect(myCar).not.toContain('Safe Until');
    expect(segmentReads).toBe(0);
    const parking = await renderCheck(savedSpot({
      publicRules: response.publicRules,
      regulationStatus: response.regulationStatus,
    }));
    expect(parking).not.toContain('No known issue found');
    expect(parking).not.toContain('Safe Until');
    expect(parking).not.toContain('Next: street cleaning');
  });

  it('still shows Safe Until from a saved spot or a Firestore rule written before the gate', async () => {
    const stored = await renderCheck(savedSpot({
      publicRules: [CLEANING_RULE],
      regulationStatus: 'verified',
    }));
    expect(stored).toContain('No known issue found');
    expect(stored).toContain('Next: street cleaning');

    segmentData = {
      status: 'active',
      protocolVersion: 2,
      activeRuleSetVersion: 'curbrules2_beforegate',
      source: 'nyc_open_data',
      provenance: { provider: 'nyc_open_data' },
      confidenceScore: 1,
    };
    streetRuleRows = [{
      id: 'rule-1',
      data: {
        ...CLEANING_RULE,
        protocolVersion: 2,
        ruleSetVersion: 'curbrules2_beforegate',
        supersededAt: null,
      },
    }];
    const fallback = await renderCard(null, null);
    expect(segmentReads).toBeGreaterThan(0);
    expect(fallback).toContain('Safe Until');
  });
});
