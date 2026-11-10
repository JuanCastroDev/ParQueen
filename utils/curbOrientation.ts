export const ALIGNED_AXIS_LIMIT_DEGREES = 20;

export const COMPASS = [
  'North', 'Northeast', 'East', 'Southeast', 'South', 'Southwest', 'West', 'Northwest',
] as const;

export type CurbCardinal = typeof COMPASS[number];

export const OPPOSITE: Readonly<Record<CurbCardinal, CurbCardinal>> = {
  North: 'South', South: 'North', East: 'West', West: 'East',
  Northeast: 'Southwest', Southwest: 'Northeast',
  Northwest: 'Southeast', Southeast: 'Northwest',
};

const AXIS: Readonly<Record<string, 'east-west' | 'north-south'>> = {
  North: 'east-west', South: 'east-west', East: 'north-south', West: 'north-south',
};

export function axisOffset(bearing: number): number {
  const quadrant = bearing % 90;
  return Math.min(quadrant, 90 - quadrant);
}

export function compassLabel(bearing: number): CurbCardinal {
  return COMPASS[Math.round(bearing / 45) % 8];
}

export function sidesForBearing(bearing: number): Readonly<{ LEFT: CurbCardinal; RIGHT: CurbCardinal }> | null {
  if (!Number.isInteger(bearing) || bearing < 0 || bearing > 359) return null;
  const left = compassLabel((bearing + 270) % 360);
  const right = compassLabel((bearing + 90) % 360);
  if (OPPOSITE[left] !== right) return null;
  return { LEFT: left, RIGHT: right };
}

export function presentationAxis(bearing: number): 'east-west' | 'north-south' | 'oblique' | null {
  const sides = sidesForBearing(bearing);
  if (!sides) return null;
  if (axisOffset(bearing) > ALIGNED_AXIS_LIMIT_DEGREES) return 'oblique';
  const axis = Math.min(Math.abs(bearing - 90), Math.abs(bearing - 270)) <= ALIGNED_AXIS_LIMIT_DEGREES
    ? 'east-west' : 'north-south';
  return AXIS[sides.LEFT] === axis ? axis : null;
}

export function obliqueCardinalsMatch(
  bearing: number,
  first: string,
  second: string,
): boolean {
  if (presentationAxis(bearing) !== 'oblique') return false;
  const sides = sidesForBearing(bearing);
  if (!sides) return false;
  return (first === sides.LEFT && second === sides.RIGHT)
    || (first === sides.RIGHT && second === sides.LEFT);
}

export function curbScreenPosition(
  bearing: number,
  cardinal: CurbCardinal,
): Readonly<{ x: number; y: number }> | null {
  const sides = sidesForBearing(bearing);
  if (!sides || presentationAxis(bearing) !== 'oblique') return null;
  const sideBearing = cardinal === sides.LEFT
    ? (bearing + 270) % 360
    : cardinal === sides.RIGHT ? (bearing + 90) % 360 : null;
  if (sideBearing === null) return null;
  const radians = sideBearing * Math.PI / 180;
  return {
    x: 50 + Math.sin(radians) * 34,
    y: 50 - Math.cos(radians) * 34,
  };
}
