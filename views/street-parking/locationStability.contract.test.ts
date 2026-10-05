import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const mapSource = readFileSync(join(__dirname, '..', 'StreetParkingView.tsx'), 'utf8');
const arrivalUiSource = readFileSync(join(__dirname, 'ArrivalGpsConfirm.tsx'), 'utf8');

function between(source: string, start: string, end: string): string {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe('iOS foreground location stability contract', () => {
  it('freezes one location for a new Ping instead of reverse-geocoding every watch update', () => {
    expect(mapSource).toContain('const [pingLocationSnapshot, setPingLocationSnapshot]');
    expect(mapSource).toContain('setPingLocationSnapshot(userLocation ? [userLocation[0], userLocation[1]] : null)');
    expect(mapSource).toContain('const pingLocation = pingLocationSnapshot ?? userLocation;');

    const addressBlock = between(
      mapSource,
      '// Spot address resolution. New Ping creation resolves the frozen snapshot,',
      '// User location marker',
    );
    expect(addressBlock).toContain('pingLocationSnapshot');
    expect(addressBlock).not.toContain('spotData.freeSpots');
    expect(addressBlock).not.toContain('userLocation');
  });

  it('keeps GPS accuracy in the arrival reading and uses the stabilizer in the UI', () => {
    expect(mapSource).toContain('{ coords: { latitude, longitude, accuracy }, timestampMs: position.timestampMs }');
    expect(arrivalUiSource).toContain('stabilizeArrivalLocation');
    expect(arrivalUiSource).toContain('INITIAL_ARRIVAL_RANGE_MEMORY');
    expect(arrivalUiSource).toContain('stabilized.next.confirmations');
    expect(arrivalUiSource).toContain('stabilized.next.lastSampleTimestampMs');
  });
});
