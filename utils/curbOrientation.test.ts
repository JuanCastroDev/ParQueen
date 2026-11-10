import { describe, expect, it } from 'vitest';
import {
  ALIGNED_AXIS_LIMIT_DEGREES,
  axisOffset,
  presentationAxis,
  presentationBearingDegrees,
  sidesForBearing,
} from './curbOrientation';

describe('client orientation precision', () => {
  it('compares the unrounded bearing with the 20 degree boundary', () => {
    expect(ALIGNED_AXIS_LIMIT_DEGREES).toBe(20);
    expect(axisOffset(70)).toBe(20);
    expect(axisOffset(69.9)).toBeCloseTo(20.1, 5);
    expect(presentationAxis(70)).toBe('east-west');
    expect(presentationAxis(69.9)).toBe('oblique');
    expect(presentationAxis(69.5)).toBe('oblique');
    expect(presentationAxis(70.1)).toBe('east-west');
    expect(presentationBearingDegrees(69.9)).toBe(70);
    expect(sidesForBearing(69.9)).toEqual({ LEFT: 'North', RIGHT: 'South' });
    expect(sidesForBearing(Number.NaN)).toBeNull();
  });
});
