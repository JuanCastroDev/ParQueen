import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  orientationForTangent,
  PRESENTATION_AXIS_LIMIT_DEGREES,
  presentationBearingDegrees,
} = require('./sideConfirmation');

const tangentForBearing = degrees => ({
  eastMeters: Math.sin(degrees * Math.PI / 180),
  northMeters: Math.cos(degrees * Math.PI / 180),
});

describe('orientation precision against the 20 degree boundary', () => {
  it('keeps the conservative exactly-20-degrees axis-aligned rule', () => {
    expect(PRESENTATION_AXIS_LIMIT_DEGREES).toBe(20);
  });

  it('classifies 19.9, 20.0, 20.1 and 20.5 from the unrounded bearing', () => {
    expect(orientationForTangent(tangentForBearing(90 - 19.9)).axis).toBe('east-west');
    expect(orientationForTangent(tangentForBearing(90 + 19.9)).axis).toBe('east-west');
    expect(orientationForTangent(tangentForBearing(90 - 20.0)).axis).toBe('east-west');
    expect(orientationForTangent(tangentForBearing(20.0)).axis).toBe('north-south');
    expect(orientationForTangent(tangentForBearing(90 - 20.1)).axis).toBe('oblique');
    expect(orientationForTangent(tangentForBearing(90 - 20.5)).axis).toBe('oblique');
    expect(orientationForTangent(tangentForBearing(20.1)).axis).toBe('oblique');
    expect(orientationForTangent(tangentForBearing(20.5)).axis).toBe('oblique');
  });

  it('keeps official LEFT/RIGHT cardinals for NE/NW/SE/SW and reversed geometry', () => {
    const northeast = orientationForTangent(tangentForBearing(45));
    expect(northeast).toMatchObject({
      axis: 'oblique',
      sides: { LEFT: 'Northwest', RIGHT: 'Southeast' },
    });
    const northwest = orientationForTangent(tangentForBearing(315));
    expect(northwest).toMatchObject({
      axis: 'oblique',
      sides: { LEFT: 'Southwest', RIGHT: 'Northeast' },
    });
    const southeast = orientationForTangent(tangentForBearing(135));
    expect(southeast).toMatchObject({
      axis: 'oblique',
      sides: { LEFT: 'Northeast', RIGHT: 'Southwest' },
    });
    const southwest = orientationForTangent(tangentForBearing(225));
    expect(southwest).toMatchObject({
      axis: 'oblique',
      sides: { LEFT: 'Southeast', RIGHT: 'Northwest' },
    });

    const forward = orientationForTangent(tangentForBearing(90));
    const reversed = orientationForTangent(tangentForBearing(270));
    expect(forward.sides).toEqual({ LEFT: 'North', RIGHT: 'South' });
    expect(reversed.sides).toEqual({ LEFT: 'South', RIGHT: 'North' });
    expect(forward.sides.LEFT).not.toBe(reversed.sides.LEFT);
    expect(presentationBearingDegrees(90 - 20.1)).toBe(70);
  });

  it('fails closed on a missing or zero-length tangent', () => {
    expect(orientationForTangent({ eastMeters: 0, northMeters: 0 })).toBeNull();
    expect(orientationForTangent({ eastMeters: Number.NaN, northMeters: 1 })).toBeNull();
    expect(orientationForTangent(null)).toBeNull();
  });
});
