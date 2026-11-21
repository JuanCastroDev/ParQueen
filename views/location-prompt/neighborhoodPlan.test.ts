// Composition rules for the location artwork, so later hand edits keep the story readable on every crop.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  ART_HEIGHT, ART_WIDTH, AVENUE, BLOCKS, BUILDINGS, FOCUS, PARKED_CARS, PINGS, RADIUS, STREET, YOU,
} from './neighborhoodPlan';

const art = readFileSync(new URL('./LocationNeighborhoodArt.tsx', import.meta.url), 'utf8');

describe('location artwork composition', () => {
  it('centres the example location on the intersection, inside the art', () => {
    expect(YOU.x).toBe(ART_WIDTH / 2);
    expect(YOU.x).toBe((AVENUE.x0 + AVENUE.x1) / 2);
    expect(YOU.y).toBe((STREET.y0 + STREET.y1) / 2);
    expect(Math.abs(YOU.y - ART_HEIGHT / 2)).toBeLessThan(ART_HEIGHT * 0.05);
    expect(RADIUS.outer).toBeLessThan(FOCUS.halfW);
  });

  it('keeps every example Ping inside the focus frame and the central focal zone', () => {
    // pin head is ~37 px tall above its tip
    for (const p of PINGS) {
      expect(Math.abs(p.x - YOU.x)).toBeLessThanOrEqual(FOCUS.halfW);
      expect(Math.abs(p.y - YOU.y)).toBeLessThanOrEqual(FOCUS.halfH);
      expect(p.x).toBeGreaterThan(ART_WIDTH * 0.2);
      expect(p.x).toBeLessThan(ART_WIDTH * 0.8);
      expect(p.y - 37).toBeGreaterThan(ART_HEIGHT * 0.2);
    }
  });

  it('places each Ping over a parked car (a driver there may be leaving), not over an empty curb', () => {
    for (const p of PINGS) {
      const car = PARKED_CARS.find(c => Math.hypot(c.cx - p.x, c.cy - p.y) < 1);
      expect(car, `ping at ${p.x},${p.y}`).toBeDefined();
    }
  });

  it('keeps buildings inside their blocks and off the streets', () => {
    const blocks = Object.values(BLOCKS);
    for (const b of BUILDINGS) {
      const inside = blocks.some(k => b.x >= k.x - 0.01 && b.y >= k.y - 0.01 && b.x + b.w <= k.x + k.w + 0.01 && b.y + b.h <= k.y + k.h + 0.01);
      expect(inside, JSON.stringify(b)).toBe(true);
    }
  });

  it('is pure editable vector: no words, rasters, remote assets or live data inside the art', () => {
    expect(art).not.toMatch(/<text|<image|<img|\.png|\.webp|\.jpe?g|https?:\/\//i);
    expect(art).not.toMatch(/firebase|mapbox|leaflet|geolocation/i);
    expect(art).toContain('PIN_PATH');
    expect(art).toContain('PARQUEEN_MARK_PATH');
  });
});
