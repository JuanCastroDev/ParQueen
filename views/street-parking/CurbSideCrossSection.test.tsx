import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CurbSideCrossSection } from './CurbSideCrossSection';
import { parseCanonicalCurbResponse } from '../../utils/canonicalCurbClient';
import { readSavedSpot, writeSavedSpot, type SavedSpot } from '../../utils/savedSpot';

const token = (rank: string) => `candidate2_${'b'.repeat(16)}_${rank.repeat(32)}`;
const confirmation = {
  streetName: 'Maran Place',
  orientation: { north: 'up' as const, axis: 'east-west' as const },
  curbs: [
    { token: token('1'), cardinal: 'South' as const },
    { token: token('2'), cardinal: 'North' as const },
  ],
};
const spot = (): SavedSpot => ({
  lat: 40.7,
  lng: -74,
  address: 'Maran Place',
  savedAt: Date.now(),
  sessionId: 'session',
  linkedPingId: null,
  segmentId: null,
  parkingSide: null,
  restrictionVersionId: null,
  segmentStreetName: null,
  streetIntelStatus: null,
  streetIntelReason: null,
  streetIntelCheckedAt: null,
  curbProtocolVersion: 2,
  curbResolutionStatus: 'side_confirmation_required',
  curbSelector: null,
  curbSideConfirmation: confirmation,
  curbRefreshAttempted: true,
  gpsAccuracyMeters: 8,
  sideConfidence: 'unknown',
  confirmedParkingSide: null,
});

describe('CurbSideCrossSection', () => {
  it('places north above an east-west road and submits only the token', () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <CurbSideCrossSection confirmation={confirmation} onSelect={onSelect} onCancel={onCancel} loading={false} />,
      );
    });
    const north = renderer!.root.findByProps({ 'data-cardinal': 'North' });
    const south = renderer!.root.findByProps({ 'data-cardinal': 'South' });
    const choices = renderer!.root.findAll(node => typeof node.props['data-cardinal'] === 'string');
    expect(choices.map(choice => choice.props['data-cardinal'])).toEqual(['North', 'South']);
    expect(north.props['data-place']).toBe('top');
    expect(south.props['data-place']).toBe('bottom');
    act(() => { north.props.onClick(); });
    expect(onSelect).toHaveBeenCalledWith(token('2'));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('places west on the left of a north-south road and leaves cancel unselected', () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const vertical = {
      ...confirmation,
      orientation: { north: 'up' as const, axis: 'north-south' as const },
      curbs: [
        { token: token('3'), cardinal: 'East' as const },
        { token: token('4'), cardinal: 'West' as const },
      ],
    };
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <CurbSideCrossSection confirmation={vertical} onSelect={onSelect} onCancel={onCancel} loading={false} />,
      );
    });
    expect(renderer!.root.findByProps({ 'data-cardinal': 'West' }).props['data-place']).toBe('left');
    expect(renderer!.root.findByProps({ 'data-cardinal': 'East' }).props['data-place']).toBe('right');
    act(() => { renderer!.root.findByProps({ className: 'pq-curb-side-cancel' }).props.onClick(); });
    expect(onCancel).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('fails closed when the curbs are not a geographically opposite pair', () => {
    const onSelect = vi.fn();
    const broken = {
      ...confirmation,
      curbs: [
        { token: token('1'), cardinal: 'North' as const },
        { token: token('2'), cardinal: 'East' as const },
      ],
    };
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <CurbSideCrossSection confirmation={broken} onSelect={onSelect} onCancel={vi.fn()} loading={false} />,
      );
    });
    expect(renderer!.root.findAllByProps({ className: expect.stringContaining('pq-curb-side-choice') })).toHaveLength(0);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('drops a stored confirmation that carries a private face and keeps cancel unsupported', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    });
    writeSavedSpot(spot());
    expect(readSavedSpot()?.curbResolutionStatus).toBe('side_confirmation_required');
    expect(readSavedSpot()?.confirmedParkingSide).toBeNull();
    writeSavedSpot({
      ...spot(),
      curbSideConfirmation: { ...confirmation, officialBlockFaceId: '1000000001' } as never,
    });
    const rejected = readSavedSpot();
    expect(rejected?.curbResolutionStatus).toBe('unsupported');
    expect(rejected?.curbSideConfirmation).toBeNull();
    expect(rejected?.confirmedParkingSide).toBeNull();
    expect(parseCanonicalCurbResponse({
      protocolVersion: 2, status: 'unsupported', reason: 'candidate_incomplete',
    }).status).toBe('unsupported');
    const view = readFileSync(new URL('../StreetParkingView.tsx', import.meta.url), 'utf8');
    const side = view.indexOf("curbResolutionStatus === 'side_confirmation_required'");
    const ambiguous = view.indexOf("curbResolutionStatus === 'ambiguous'");
    const cancel = view.slice(view.indexOf('const handleSideConfirmationCancel'), view.indexOf('const retryStreetIntelInFlightRef'));
    expect(side).toBeGreaterThan(-1);
    expect(side).toBeLessThan(ambiguous);
    expect(cancel).not.toContain('requestCanonicalCurb');
    expect(cancel).toContain("status: 'unsupported'");
    expect(cancel).toContain('confirmedParkingSide: null');
  });
});
