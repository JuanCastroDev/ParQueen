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
import type { ArrivalLocationReading } from './arrivalLocation';

const now = Date.parse('2026-08-03T16:00:00.000Z');

const myClaim: MapItem = {
  id: 'mine',
  lat: 40.82,
  lng: -73.91,
  type: 'free',
  status: 'interested',
  title: 'Nearby street',
  finderId: 'finder',
  finderName: 'Alex',
  pingMode: 'now',
  reportedAt: { toMillis: () => now - 60_000 },
  expiresAt: { toMillis: () => now + 20 * 60_000 },
  interestedUserId: 'viewer',
  claimState: 'heading',
};

function mount(reading: ArrivalLocationReading, overrides: Record<string, unknown> = {}) {
  const onArrival = vi.fn();
  const onRetryArrivalLocation = vi.fn();
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(
      <SpotDetailsCard
        selectedItem={myClaim}
        freeSpots={[myClaim]}
        user={{ id: 'viewer' }}
        userLocation={[myClaim.lng, myClaim.lat]}
        spotAddress=""
        onHeadingThere={vi.fn()}
        onScheduledClaim={vi.fn()}
        onCommitToHeading={vi.fn()}
        onEditSpot={vi.fn()}
        onDeletePing={vi.fn()}
        onArrival={onArrival}
        onCancelByFinder={vi.fn()}
        onCancelByClaimer={vi.fn()}
        onDriverArrived={vi.fn()}
        onMessageUser={vi.fn()}
        interestError={null}
        estDriveMinutes={4}
        isWithinArrivalRange={false}
        maxEtaMinutes={7}
        nowMs={now}
        arrivalNowMs={now}
        arrivalLocation={reading}
        onRetryArrivalLocation={onRetryArrivalLocation}
        {...overrides}
      />,
    );
  });
  return { renderer, onArrival, onRetryArrivalLocation };
}

function text(renderer: TestRenderer.ReactTestRenderer): string {
  return JSON.stringify(renderer.toJSON());
}

function buttonWithText(renderer: TestRenderer.ReactTestRenderer, label: string) {
  return renderer.root.findAll(
    (node) => node.type === 'button' && textOf(node).includes(label),
  )[0];
}

function textOf(node: TestRenderer.ReactTestInstance): string {
  const parts: string[] = [];
  const visit = (value: unknown) => {
    if (typeof value === 'string' || typeof value === 'number') parts.push(String(value));
    else if (Array.isArray(value)) value.forEach(visit);
  };
  visit(node.props.children);
  return parts.join('');
}

function click(renderer: TestRenderer.ReactTestRenderer, label: string) {
  const button = buttonWithText(renderer, label);
  expect(button).toBeTruthy();
  act(() => { button.props.onClick(); });
}

describe('SpotDetailsCard arrival GPS recovery', () => {
  beforeEach(() => setLang('en'));

  it('does not require an override for a healthy in-range fix', () => {
    const { renderer, onArrival } = mount({
      fix: { lat: myClaim.lat, lng: myClaim.lng, timestampMs: now - 1_000 },
      fault: null,
    });
    const body = text(renderer);
    expect(body).toContain(t('claim_flow.ive_arrived'));
    expect(body).not.toContain(t('claim_flow.im_here_anyway'));
    expect(body).not.toContain(t('claim_flow.arrival_override'));
    expect(body).not.toContain(t('claim_flow.arrival_ack_override'));
    const arrive = buttonWithText(renderer, t('claim_flow.ive_arrived'));
    expect(arrive.props.disabled).toBe(false);
    click(renderer, t('claim_flow.ive_arrived'));
    expect(onArrival).toHaveBeenCalledTimes(1);
    expect(onArrival).toHaveBeenCalledWith();
    act(() => renderer.unmount());
  });

  it('warns and offers a location retry, and shows I\'m here anyway only after acknowledgement', () => {
    const { renderer, onArrival, onRetryArrivalLocation } = mount({
      fix: { lat: myClaim.lat + 0.01, lng: myClaim.lng, timestampMs: now - 1_000 },
      fault: null,
    });
    let body = text(renderer);
    expect(body).toContain(t('claim_flow.arrival_far_title'));
    expect(body).toContain(t('claim_flow.arrival_far_body'));
    expect(body).toContain(t('claim_flow.arrival_retry'));
    expect(body).not.toContain(t('claim_flow.im_here_anyway'));
    expect(body).not.toContain(t('claim_flow.ive_arrived'));

    click(renderer, t('claim_flow.arrival_retry'));
    expect(onRetryArrivalLocation).toHaveBeenCalledTimes(1);
    expect(onArrival).not.toHaveBeenCalled();
    expect(text(renderer)).not.toContain(t('claim_flow.im_here_anyway'));

    click(renderer, t('claim_flow.arrival_ack_far'));
    body = text(renderer);
    expect(body).toContain(t('claim_flow.im_here_anyway'));
    expect(body).not.toContain(t('claim_flow.arrival_ack_far'));

    click(renderer, t('claim_flow.im_here_anyway'));
    expect(onArrival).toHaveBeenCalledTimes(1);
    expect(onArrival).toHaveBeenCalledWith();
    act(() => renderer.unmount());
  });

  it('shows the override for a denied location only after one acknowledgement', () => {
    const { renderer, onArrival, onRetryArrivalLocation } = mount({
      fix: null,
      fault: 'permission_denied',
    });
    expect(text(renderer)).toContain(t('claim_flow.arrival_denied_body'));
    expect(text(renderer)).not.toContain(t('claim_flow.arrival_override'));
    expect(text(renderer)).not.toContain(t('claim_flow.im_here_anyway'));
    expect(buttonWithText(renderer, t('claim_flow.arrival_retry'))).toBeUndefined();

    click(renderer, t('claim_flow.arrival_ack_override'));
    expect(text(renderer)).toContain(t('claim_flow.arrival_override'));
    click(renderer, t('claim_flow.arrival_override'));
    expect(onArrival).toHaveBeenCalledTimes(1);
    expect(onArrival).toHaveBeenCalledWith();
    expect(onRetryArrivalLocation).not.toHaveBeenCalled();
    act(() => renderer.unmount());
  });

  it('shows the override for an unavailable location only after one acknowledgement', () => {
    const { renderer, onArrival } = mount({
      fix: null,
      fault: 'unavailable',
    });
    expect(text(renderer)).toContain(t('claim_flow.arrival_unavailable_body'));
    expect(buttonWithText(renderer, t('claim_flow.arrival_override'))).toBeUndefined();
    click(renderer, t('claim_flow.arrival_ack_override'));
    click(renderer, t('claim_flow.arrival_override'));
    expect(onArrival).toHaveBeenCalledTimes(1);
    expect(onArrival).toHaveBeenCalledWith();
    act(() => renderer.unmount());
  });

  it('treats a fix older than 120 seconds as stale and a 120 second fix as healthy', () => {
    const stale = mount({
      fix: { lat: myClaim.lat, lng: myClaim.lng, timestampMs: now - 120_001 },
      fault: null,
    });
    expect(text(stale.renderer)).toContain(t('claim_flow.arrival_stale_body'));
    expect(text(stale.renderer)).not.toContain(t('claim_flow.ive_arrived'));
    expect(text(stale.renderer)).not.toContain(t('claim_flow.arrival_far_title'));
    expect(buttonWithText(stale.renderer, t('claim_flow.arrival_override'))).toBeUndefined();
    click(stale.renderer, t('claim_flow.arrival_ack_override'));
    expect(text(stale.renderer)).toContain(t('claim_flow.arrival_override'));
    act(() => stale.renderer.unmount());

    const fresh = mount({
      fix: { lat: myClaim.lat, lng: myClaim.lng, timestampMs: now - 120_000 },
      fault: null,
    });
    expect(text(fresh.renderer)).toContain(t('claim_flow.ive_arrived'));
    expect(text(fresh.renderer)).not.toContain(t('claim_flow.arrival_stale_body'));
    expect(text(fresh.renderer)).not.toContain(t('claim_flow.arrival_override'));
    act(() => fresh.renderer.unmount());
  });

  it('keeps the in-flight arrive guard on the healthy path and on the override', () => {
    const healthy = mount({
      fix: { lat: myClaim.lat, lng: myClaim.lng, timestampMs: now - 1_000 },
      fault: null,
    }, { arriving: true });
    const arrive = buttonWithText(healthy.renderer, t('claim_flow.ive_arrived'));
    expect(arrive.props.disabled).toBe(true);
    expect(arrive.props['aria-busy']).toBe(true);
    act(() => healthy.renderer.unmount());

    const denied = mount({ fix: null, fault: 'permission_denied' }, { arriving: true });
    click(denied.renderer, t('claim_flow.arrival_ack_override'));
    const override = buttonWithText(denied.renderer, t('claim_flow.arrival_override'));
    expect(override.props.disabled).toBe(true);
    expect(override.props['aria-busy']).toBe(true);
    expect(denied.onArrival).not.toHaveBeenCalled();
    act(() => denied.renderer.unmount());
  });
});
