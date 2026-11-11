import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CurbSideCrossSection } from './CurbSideCrossSection';
import { parseCanonicalCurbResponse, type SideConfirmation } from '../../utils/canonicalCurbClient';
import { readSavedSpot, writeSavedSpot, SAVED_SPOT_KEY, type SavedSpot } from '../../utils/savedSpot';
import { sampleSideConfirmationToken } from '../../utils/sideConfirmationTokenFixture';

const token = (rank: string) => sampleSideConfirmationToken(rank);
const confirmation: SideConfirmation = {
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
        <CurbSideCrossSection confirmation={confirmation} onSelect={onSelect} onCancel={onCancel} loading={false} allowDiagonalCurbDrawing />,
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
    const markup = JSON.stringify(renderer!.toJSON());
    expect(markup).not.toContain('data-token');
    expect(markup).not.toContain(token('2'));
    expect(markup).not.toContain(token('1'));
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('places west on the left of a north-south road and leaves cancel unselected', () => {
    const onSelect = vi.fn();
    const onCancel = vi.fn();
    const vertical: SideConfirmation = {
      ...confirmation,
      orientation: { north: 'up', axis: 'north-south' },
      curbs: [
        { token: token('3'), cardinal: 'East' },
        { token: token('4'), cardinal: 'West' },
      ],
    };
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <CurbSideCrossSection confirmation={vertical} onSelect={onSelect} onCancel={onCancel} loading={false} allowDiagonalCurbDrawing />,
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
    const broken: SideConfirmation = {
      ...confirmation,
      curbs: [
        { token: token('1'), cardinal: 'North' },
        { token: token('2'), cardinal: 'East' },
      ],
    };
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <CurbSideCrossSection confirmation={broken} onSelect={onSelect} onCancel={vi.fn()} loading={false} allowDiagonalCurbDrawing />,
      );
    });
    expect(renderer!.root.findAllByProps({ className: expect.stringContaining('pq-curb-side-choice') })).toHaveLength(0);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('drops a stored confirmation that carries a private face and keeps cancel unsupported', () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value); },
      removeItem: (key: string) => { store.delete(key); },
    };
    vi.stubGlobal('localStorage', storage);
    writeSavedSpot(spot());
    expect(readSavedSpot()?.curbResolutionStatus).toBe('side_confirmation_required');
    expect(readSavedSpot()?.confirmedParkingSide).toBeNull();
    storage.setItem(SAVED_SPOT_KEY, JSON.stringify({
      ...spot(),
      curbSideConfirmation: {
        streetName: confirmation.streetName,
        orientation: confirmation.orientation,
        curbs: confirmation.curbs,
        officialBlockFaceId: '1000000001',
      },
    }));
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
    const select = view.slice(view.indexOf('const handleSideConfirmation ='), view.indexOf('const handleSideConfirmationCancel'));
    expect(select).toContain('canonicalResponseFields(response)');
    expect(select).toContain('requestCanonicalCurb(savedSpot.lat, savedSpot.lng, candidateToken)');
    expect(select).not.toMatch(/notifyNearby|incrementTotalSpotsPinged|createPing/);
    const fields = view.slice(view.indexOf('const canonicalResponseFields'), view.indexOf('const segmentRetrySessionRef'));
    expect(fields).toContain('parkingSide: response.sideLabel');
    expect(fields).toContain('segmentId: response.segmentId');
  });

  it('draws a diagonal road at its bearing and submits the matching token', () => {
    const onSelect = vi.fn();
    const diagonal: SideConfirmation = {
      streetName: 'Diagonal Avenue',
      orientation: { north: 'up', axis: 'oblique', bearingDegrees: 45 },
      curbs: [
        { token: token('nw'), cardinal: 'Northwest' },
        { token: token('se'), cardinal: 'Southeast' },
      ],
    };
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <CurbSideCrossSection confirmation={diagonal} onSelect={onSelect} onCancel={vi.fn()} loading={false} allowDiagonalCurbDrawing />,
      );
    });
    const northwest = renderer!.root.findByProps({ 'data-cardinal': 'Northwest' });
    const southeast = renderer!.root.findByProps({ 'data-cardinal': 'Southeast' });
    const place = (style: { left: string; top: string }) => ({
      left: Number.parseFloat(style.left),
      top: Number.parseFloat(style.top),
    });
    const northwestPlace = place(northwest.props.style);
    const southeastPlace = place(southeast.props.style);
    expect(northwestPlace.top).toBeLessThan(southeastPlace.top);
    expect(northwestPlace.left).toBeLessThan(southeastPlace.left);
    const road = renderer!.root.findByProps({ className: 'pq-curb-side-road' });
    expect(road.props.style.transform).toBe('translate(-50%, -50%) rotate(-45deg)');
    const markup = JSON.stringify(renderer!.toJSON());
    expect(markup).toContain('North is up');
    expect(markup).toContain('where your vehicle is parked');
    expect(markup).toContain('Diagonal Avenue');
    expect(markup).not.toContain('reserved');
    expect(markup).not.toContain(token('nw'));
    expect(markup).not.toContain(token('se'));
    act(() => { northwest.props.onClick(); });
    expect(onSelect).toHaveBeenCalledWith(token('nw'));
  });

  it('does not select a curb while loading and rejects a swapped diagonal pair', () => {
    const onSelect = vi.fn();
    const diagonal: SideConfirmation = {
      streetName: 'Diagonal Avenue',
      orientation: { north: 'up', axis: 'oblique', bearingDegrees: 45 },
      curbs: [
        { token: token('nw'), cardinal: 'Northwest' },
        { token: token('se'), cardinal: 'Southeast' },
      ],
    };
    let loadingView: TestRenderer.ReactTestRenderer;
    act(() => {
      loadingView = TestRenderer.create(
        <CurbSideCrossSection confirmation={diagonal} onSelect={onSelect} onCancel={vi.fn()} loading allowDiagonalCurbDrawing />,
      );
    });
    act(() => { loadingView!.root.findByProps({ 'data-cardinal': 'Northwest' }).props.onClick(); });
    expect(onSelect).not.toHaveBeenCalled();
    expect(loadingView!.root.findByProps({ className: 'pq-curb-side-cancel' }).props.disabled).toBe(true);

    const swapped: SideConfirmation = {
      ...diagonal,
      curbs: [
        { token: token('n'), cardinal: 'North' },
        { token: token('s'), cardinal: 'South' },
      ],
    };
    let rejected: TestRenderer.ReactTestRenderer;
    act(() => {
      rejected = TestRenderer.create(
        <CurbSideCrossSection confirmation={swapped} onSelect={onSelect} onCancel={vi.fn()} loading={false} allowDiagonalCurbDrawing />,
      );
    });
    expect(rejected!.root.findAllByProps({ className: expect.stringContaining('pq-curb-side-choice') })).toHaveLength(0);
  });

  it('offers left and right for a verified one-way without a road drawing', () => {
    const onSelect = vi.fn();
    const oneWay: SideConfirmation = {
      streetName: 'Maran Place',
      orientation: { north: 'up', axis: 'oblique', bearingDegrees: 321 },
      curbs: [
        { token: token('sw'), cardinal: 'Southwest', drivingSide: 'left' },
        { token: token('ne'), cardinal: 'Northeast', drivingSide: 'right' },
      ],
    };
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <CurbSideCrossSection confirmation={oneWay} onSelect={onSelect} onCancel={vi.fn()} loading={false} allowDiagonalCurbDrawing />,
      );
    });
    const markup = JSON.stringify(renderer!.toJSON());
    expect(markup).toContain('Which side did you park on?');
    expect(markup).toContain('Facing the direction of traffic');
    expect(markup).toContain('← Left side');
    expect(markup).toContain('Right side →');
    expect(markup).not.toContain('Maran Place');
    expect(markup).not.toContain('pq-curb-side-road');
    expect(markup).not.toContain('rotate(');
    expect(markup).not.toContain('Northeast curb');
    const right = renderer!.root.findByProps({ 'data-driving-side': 'right' });
    act(() => { right.props.onClick(); });
    expect(onSelect).toHaveBeenCalledWith(token('ne'));
    expect(renderer!.root.findByProps({ 'data-driving-side': 'right' }).props['aria-pressed']).toBe(true);
    act(() => { renderer!.root.findByProps({ 'data-driving-side': 'left' }).props.onClick(); });
    expect(onSelect).toHaveBeenCalledTimes(1);

    onSelect.mockClear();
    let loadingView: TestRenderer.ReactTestRenderer;
    act(() => {
      loadingView = TestRenderer.create(
        <CurbSideCrossSection confirmation={oneWay} onSelect={onSelect} onCancel={vi.fn()} loading />,
      );
    });
    const loadingRight = loadingView!.root.findByProps({ 'data-driving-side': 'right' });
    expect(loadingRight.props.disabled).toBe(true);
    expect(loadingView!.root.findByProps({ className: 'pq-curb-side-cancel' }).props.disabled).toBeUndefined();
    act(() => { loadingRight.props.onClick(); });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('does not draw a diagonal curb when the client feature gate is off', () => {
    const diagonal: SideConfirmation = {
      streetName: 'Diagonal Avenue',
      orientation: { north: 'up', axis: 'oblique', bearingDegrees: 45 },
      curbs: [
        { token: token('nw'), cardinal: 'Northwest' },
        { token: token('se'), cardinal: 'Southeast' },
      ],
    };
    let renderer: TestRenderer.ReactTestRenderer;
    act(() => {
      renderer = TestRenderer.create(
        <CurbSideCrossSection confirmation={diagonal} onSelect={vi.fn()} onCancel={vi.fn()} loading={false} />,
      );
    });
    const markup = JSON.stringify(renderer!.toJSON());
    expect(markup).toContain('could not distinguish the two curbs');
    expect(markup).not.toContain('pq-curb-side-road');
    expect(markup).not.toContain('rotate(');
    expect(() => renderer!.root.findByProps({ className: 'pq-curb-side-diagram is-oblique' })).toThrow();
  });
});
