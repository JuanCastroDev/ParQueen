import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
  const values = new Map<string, string>();
  const listeners = new Map<string, Set<() => void>>();
  const eventTarget = {
    addEventListener: (type: string, listener: () => void) => {
      const handlers = listeners.get(type) ?? new Set();
      handlers.add(listener);
      listeners.set(type, handlers);
    },
    removeEventListener: (type: string, listener: () => void) => listeners.get(type)?.delete(listener),
  };
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: eventTarget });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { ...eventTarget, visibilityState: 'visible' } });
});

import { setLang, t } from '../../i18n';
import { SpotDetailsCard } from './SpotDetailsCard';
import { MapItem } from './types';

const now = Date.parse('2026-08-03T16:00:00.000Z');

const liveAvailable: MapItem = {
  id: 'live',
  lat: 40.82,
  lng: -73.91,
  type: 'free',
  status: 'available',
  title: 'Nearby street',
  finderId: 'finder',
  finderName: 'Alex',
  pingMode: 'now',
  reportedAt: { toMillis: () => now - 60_000 },
  expiresAt: { toMillis: () => now + 20 * 60_000 },
};

const scheduledAvailable: MapItem = {
  ...liveAvailable,
  id: 'scheduled',
  pingMode: 'later',
  reportedAt: { toMillis: () => now + 60 * 60_000 },
  expiresAt: { toMillis: () => now + 90 * 60_000 },
};

const myClaim: MapItem = {
  ...liveAvailable,
  id: 'mine',
  status: 'interested',
  interestedUserId: 'viewer',
  claimState: 'heading',
};

const myScheduledClaim: MapItem = {
  ...scheduledAvailable,
  id: 'sched-claim',
  status: 'interested',
  interestedUserId: 'viewer',
  claimState: 'committed',
};

function mount(item: MapItem, overrides: Record<string, unknown> = {}) {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <SpotDetailsCard
        selectedItem={item}
        freeSpots={[item]}
        user={{ id: 'viewer' }}
        userLocation={[-73.92, 40.81]}
        spotAddress=""
        onHeadingThere={vi.fn()}
        onScheduledClaim={vi.fn()}
        onCommitToHeading={vi.fn()}
        onEditSpot={vi.fn()}
        onDeletePing={vi.fn()}
        onArrival={vi.fn()}
        onCancelByFinder={vi.fn()}
        onCancelByClaimer={vi.fn()}
        onDriverArrived={vi.fn()}
        onMessageUser={vi.fn()}
        interestError={null}
        estDriveMinutes={4}
        isWithinArrivalRange={false}
        maxEtaMinutes={7}
        nowMs={now}
        {...overrides}
      />,
    );
  });
  return renderer;
}

function buttonLabel(node: TestRenderer.ReactTestInstance): string {
  const parts: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === 'string' || typeof value === 'number') parts.push(String(value));
    else if (Array.isArray(value)) value.forEach(visit);
  };
  visit(node.props.children);
  return parts.join('');
}

function buttonWithText(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    (node) => node.type === 'button' && buttonLabel(node).includes(label),
  )[0];
}

describe('SpotDetailsCard in-flight claim and arrive controls', () => {
  beforeEach(() => setLang('en'));

  it('disables the immediate claim button and marks it busy while claiming', () => {
    const idle = mount(liveAvailable);
    const idleClaim = buttonWithText(idle, t('claim_flow.im_heading_there'));
    expect(idleClaim.props.disabled).toBe(false);
    expect(idleClaim.props['aria-busy']).toBe(false);
    act(() => idle.unmount());

    const busy = mount(liveAvailable, { claiming: true });
    const busyClaim = buttonWithText(busy, t('claim_flow.im_heading_there'));
    expect(busyClaim.props.disabled).toBe(true);
    expect(busyClaim.props['aria-busy']).toBe(true);
    act(() => busy.unmount());
  });

  it('disables the scheduled claim button and marks it busy while claiming', () => {
    const busy = mount(scheduledAvailable, { claiming: true });
    const claim = buttonWithText(busy, 'Claim for');
    expect(claim.props.disabled).toBe(true);
    expect(claim.props['aria-busy']).toBe(true);
    act(() => busy.unmount());
  });

  it('disables commit-to-heading and marks it busy while claiming', () => {
    const busy = mount(myScheduledClaim, { claiming: true });
    const commit = buttonWithText(busy, t('scheduled_claim.im_heading_there'));
    expect(commit.props.disabled).toBe(true);
    expect(commit.props['aria-busy']).toBe(true);
    act(() => busy.unmount());
  });

  it('disables I\'ve arrived and marks it busy while arriving, without changing the label', () => {
    const idle = mount(myClaim, { isWithinArrivalRange: true });
    const idleArrive = buttonWithText(idle, t('claim_flow.ive_arrived'));
    expect(idleArrive.props.disabled).toBe(false);
    expect(idleArrive.props['aria-busy']).toBe(false);
    act(() => idle.unmount());

    const busy = mount(myClaim, { isWithinArrivalRange: true, arriving: true });
    const busyArrive = buttonWithText(busy, t('claim_flow.ive_arrived'));
    expect(busyArrive.props.disabled).toBe(true);
    expect(busyArrive.props['aria-busy']).toBe(true);
    act(() => busy.unmount());
  });

  it('still disables arrival from proximity when no arrive request is in flight', () => {
    const outOfRange = mount(myClaim, { isWithinArrivalRange: false, arriving: false });
    const arrive = buttonWithText(outOfRange, 'away');
    expect(arrive).toBeTruthy();
    expect(arrive.props.disabled).toBe(true);
    expect(arrive.props['aria-busy']).toBe(false);
    expect(buttonWithText(outOfRange, t('claim_flow.ive_arrived'))).toBeUndefined();
    act(() => outOfRange.unmount());
  });

  it('still disables cancel and marks it busy while a cancel is in flight', () => {
    const busy = mount(myScheduledClaim, { cancelingClaim: true });
    const cancel = buttonWithText(busy, t('claim_flow.canceling'));
    expect(cancel.props.disabled).toBe(true);
    expect(cancel.props['aria-busy']).toBe(true);
    const commit = buttonWithText(busy, t('scheduled_claim.im_heading_there'));
    expect(commit.props.disabled).toBe(true);
    expect(commit.props['aria-busy']).toBe(false);
    act(() => busy.unmount());
  });

  it('disables cancel while a claim or arrival is in flight without swapping in the canceling label', () => {
    const claiming = mount(myScheduledClaim, { claiming: true });
    const claimCancel = buttonWithText(claiming, t('scheduled_claim.cancel'));
    expect(claimCancel.props.disabled).toBe(true);
    expect(claimCancel.props['aria-busy']).toBe(false);
    act(() => claiming.unmount());

    const arriving = mount(myClaim, { arriving: true, isWithinArrivalRange: true });
    const arriveCancel = buttonWithText(arriving, t('claim_flow.cancel'));
    expect(arriveCancel.props.disabled).toBe(true);
    expect(arriveCancel.props['aria-busy']).toBeFalsy();
    act(() => arriving.unmount());
  });

  it('disables arrival while a cancel is in flight, and still keeps the arrived label', () => {
    const busy = mount(myClaim, { cancelingClaim: true, isWithinArrivalRange: true });
    const arrive = buttonWithText(busy, t('claim_flow.ive_arrived'));
    expect(arrive.props.disabled).toBe(true);
    expect(arrive.props['aria-busy']).toBe(false);
    act(() => busy.unmount());
  });
});
