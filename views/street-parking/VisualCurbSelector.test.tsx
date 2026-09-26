import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mapState = vi.hoisted(() => ({
  handlers: new Map<string, (event?: any) => void>(),
  remove: vi.fn(),
  fitBounds: vi.fn(),
  addSource: vi.fn(),
  addLayer: vi.fn(),
  project: vi.fn(([lng, lat]: [number, number]) => ({
    x: (lng + 74) * 100_000,
    y: (lat - 40.7) * 100_000,
  })),
}));

vi.mock('mapbox-gl', () => ({
  default: {
    accessToken: '',
    Map: class MockMap {
      on(event: string, handler: (value?: any) => void) {
        mapState.handlers.set(event, handler);
        if (event === 'load') handler();
      }
      off = vi.fn();
      remove = mapState.remove;
      fitBounds = mapState.fitBounds;
      addSource = mapState.addSource;
      addLayer = mapState.addLayer;
      project = mapState.project;
    },
    LngLatBounds: class MockBounds {
      extend() { return this; }
    },
  },
}));
vi.mock('../../utils/browserCredentials', () => ({ getMapboxToken: () => 'test-token' }));

import { VisualCurbSelector } from './VisualCurbSelector';

const selector = {
  center: { lat: 40.7, lng: -74 },
  candidates: [
    {
      token: `candidate2_${'a'.repeat(16)}_${'0'.repeat(32)}`,
      streetName: 'Maran Place',
      stroke: { type: 'MultiLineString' as const, coordinates: [[[-74.001, 40.7], [-73.999, 40.7]]] },
    },
    {
      token: `candidate2_${'a'.repeat(16)}_${'1'.repeat(32)}`,
      streetName: 'White Plains Road',
      stroke: { type: 'MultiLineString' as const, coordinates: [[[-74, 40.699], [-74, 40.701]]] },
    },
  ] as const,
};

const render = async (props: Partial<React.ComponentProps<typeof VisualCurbSelector>> = {}) => {
  let renderer: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(
      <VisualCurbSelector selector={selector} onSelect={vi.fn()} loading={false} {...props} />,
      { createNodeMock: () => ({}) },
    );
  });
  return renderer!;
};

describe('VisualCurbSelector', () => {
  beforeEach(() => {
    mapState.handlers.clear();
    vi.clearAllMocks();
  });

  it('renders two public street controls, two highlighted strokes, and a saved-car marker', async () => {
    const renderer = await render();
    const buttons = renderer.root.findAllByType('button');
    expect(buttons.map(button => button.props['aria-label'])).toEqual([
      'Curb along Maran Place', 'Curb along White Plains Road',
    ]);
    expect(mapState.addSource).toHaveBeenCalledTimes(3);
    expect(mapState.addLayer).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(renderer.toJSON())).not.toMatch(/North|South|East|West|Block.?Face|global|physical|b5sc/i);
  });

  it('selects from an accessible control and locks both controls while loading', async () => {
    const onSelect = vi.fn();
    const renderer = await render({ onSelect, loading: true });
    const buttons = renderer.root.findAllByType('button');
    expect(buttons.every(button => button.props.disabled === true)).toBe(true);

    await act(async () => { buttons[0].props.onClick(); });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('selects the nearest public stroke from a map click', async () => {
    const onSelect = vi.fn();
    await render({ onSelect });

    await act(async () => {
      mapState.handlers.get('click')?.({ point: { x: -80, y: 0 } });
    });
    expect(onSelect).toHaveBeenCalledWith(selector.candidates[0].token);
  });

  it('ignores clicks outside the stroke tolerance or without a decisive nearest stroke', async () => {
    const onSelect = vi.fn();
    await render({ onSelect });

    await act(async () => {
      mapState.handlers.get('click')?.({ point: { x: 500, y: 500 } });
      mapState.handlers.get('click')?.({ point: { x: 0, y: 0 } });
    });
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('cleans up map listeners/resources on unmount', async () => {
    const renderer = await render();
    await act(async () => { renderer.unmount(); });
    expect(mapState.remove).toHaveBeenCalledOnce();
  });

  it('shows calm unavailable fallback when strokes are not distinct', async () => {
    const invalid = {
      ...selector,
      candidates: [selector.candidates[0], { ...selector.candidates[1], stroke: selector.candidates[0].stroke }],
    } as any;
    const renderer = await render({ selector: invalid });
    expect(renderer.root.findAllByType('button')).toHaveLength(0);
    expect(JSON.stringify(renderer.toJSON())).toContain('could not verify');
  });
});
