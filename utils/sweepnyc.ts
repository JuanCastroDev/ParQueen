import { computeCrossRaw } from './streetIntelligence';
import { parseSweepNYCDayList } from './streetIntelDays';

// Must stay in sync with PARSER_VERSION in functions/index.js CF #27.
export const PARSER_VERSION = '1.0';

function parseAmPmTime(t: string): string {
  const m = t.match(/^(\d+)(?::(\d+))?\s*(AM|PM)$/i);
  if (!m) return '00:00';
  let h = parseInt(m[1]);
  const min = m[2] ? parseInt(m[2]) : 0;
  if (m[3].toUpperCase() === 'PM' && h !== 12) h += 12;
  if (m[3].toUpperCase() === 'AM' && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function parseSweepNYCSign(signText: string): {
  street: string; fromCross: string; toCross: string;
  side: string; days: string[]; startTime: string; endTime: string;
} | null {
  const m = signText.match(
    /^No Parking (.+?) (\d+(?::\d+)?\s*[AP]M)-(\d+(?::\d+)?\s*[AP]M) on (.+?) from (.+?) to (.+?) \(Side: (\w+)\)$/i,
  );
  if (!m) return null;
  const [, daysRaw, startRaw, endRaw, street, fromCross, toCross, side] = m;
  const days = parseSweepNYCDayList(daysRaw);
  if (!days.length) return null;
  return {
    street, fromCross, toCross, side,
    days,
    startTime: parseAmPmTime(startRaw),
    endTime: parseAmPmTime(endRaw),
  };
}

/**
 * Detects which cardinal direction the user is on relative to the street.
 * Used for SweepNYC-sourced segments (cardinal model, not even/odd).
 * bearing must be normalized to 0–180° (as stored by fetchStreetGeometry).
 */
export function detectCardinalSide(
  userLat: number, userLng: number,
  fromLat: number, fromLng: number,
  toLat: number, toLng: number,
  bearing: number,
): string {
  const cross = computeCrossRaw(userLat, userLng, fromLat, fromLng, toLat, toLng);
  const isPositive = cross > 0;
  if (bearing < 45) return isPositive ? 'West' : 'East';
  if (bearing < 135) return isPositive ? 'North' : 'South';
  return isPositive ? 'East' : 'West';
}
