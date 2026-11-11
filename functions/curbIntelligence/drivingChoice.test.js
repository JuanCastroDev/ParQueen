import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { drivingChoices, orientationForTangent } = require('./sideConfirmation');

const row = trafdir => ({ sourceNative: { trafdir } });
const tangent = degrees => ({
  eastMeters: Math.sin(degrees * Math.PI / 180),
  northMeters: Math.cos(degrees * Math.PI / 180),
});

describe('drivingChoices', () => {
  it('maps a with-geometry one-way to the driver left and right', () => {
    expect(drivingChoices([row('FT'), row('ft')])).toEqual({ LEFT: 'left', RIGHT: 'right' });
  });

  it('reverses left and right when travel is against the drawn centerline', () => {
    expect(drivingChoices([row('TF')])).toEqual({ LEFT: 'right', RIGHT: 'left' });
  });

  it('does not offer left or right for two-way, missing, or contradictory direction', () => {
    expect(drivingChoices([row('TW'), row('TW')])).toBeNull();
    expect(drivingChoices([row(''), row(null)])).toBeNull();
    expect(drivingChoices([row('FT'), row('TF')])).toBeNull();
    expect(drivingChoices([row('NV')])).toBeNull();
    expect(drivingChoices([])).toBeNull();
  });

  it('maps the 321-degree centerline right side to Northeast when travel follows the geometry', () => {
    const orientation = orientationForTangent(tangent(321));
    expect(orientation.axis).toBe('oblique');
    expect(orientation.bearingDegrees).toBe(321);
    expect(orientation.sides).toEqual({ LEFT: 'Southwest', RIGHT: 'Northeast' });
    const driving = drivingChoices([row('FT')]);
    expect(driving.RIGHT).toBe('right');
    expect(orientation.sides[Object.keys(driving).find(side => driving[side] === 'right')]).toBe('Northeast');
  });

  it('uses the local tangent, so a curve does not inherit a different segment direction', () => {
    expect(orientationForTangent(tangent(321)).sides.RIGHT).toBe('Northeast');
    expect(orientationForTangent(tangent(20)).sides.RIGHT).not.toBe('Northeast');
  });
});
