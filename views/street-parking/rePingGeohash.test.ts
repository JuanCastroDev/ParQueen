import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as geofire from 'geofire-common';

// Real pre-existing bug, found during a geoquery-feasibility audit: the
// "re-ping over an existing selectedItem" write path in handleSaveSpot
// omitted `geohash` entirely, while Firestore rules require it (hasAll) —
// see firestore.rules.test.ts TM10-I/J for the authoritative rules-level
// proof. These tests guard the client source against regressing back to
// the buggy shape.
describe('StreetParkingView re-ping geohash fix', () => {
    const source = readFileSync(
        new URL('../StreetParkingView.tsx', import.meta.url),
        'utf8',
    );

    // Isolate the `if (selectedItem)` re-ping branch specifically, not the
    // sibling `else` branches, so these assertions can't accidentally match
    // the already-correct paths instead.
    const branchStart = source.indexOf('if (selectedItem) {');
    const branchEnd = source.indexOf('} else {', branchStart);
    const branch = source.slice(branchStart, branchEnd);

    it('CASE 1: the re-ping payload includes a geohash field', () => {
        expect(branch).toMatch(/geohash:\s*geofire\.geohashForLocation\(/);
    });

    it('CASE 2: geohash is derived from exactly the lat/lng written into the document (selectedItem.lat/lng)', () => {
        expect(branch).toMatch(
            /geohash:\s*geofire\.geohashForLocation\(\[selectedItem\.lat,\s*selectedItem\.lng\]\)/,
        );
    });

    it('does not trust a possibly-stale selectedItem.geohash', () => {
        // The fix must derive a fresh hash from the coordinates being
        // written, not copy any pre-existing geohash off selectedItem.
        expect(branch).not.toMatch(/geohash:\s*selectedItem\.geohash/);
    });

    it('CASE 3: geohashForLocation is deterministic for fixed coordinates (sanity check on the library call itself)', () => {
        const first = geofire.geohashForLocation([40.7128, -74.0060]);
        const second = geofire.geohashForLocation([40.7128, -74.0060]);
        expect(first).toBe(second);
        expect(typeof first).toBe('string');
        expect(first.length).toBeGreaterThan(0);
    });

    it('CASE 5: the normal immediate-ping path derives geohash from the exact frozen coordinates it writes', () => {
        expect(source).toContain('const pingLocation = pingLocationSnapshot ?? userLocation;');
        expect(source).toMatch(
            /lat:\s*pingLocation\[1\],[\s\S]*?lng:\s*pingLocation\[0\],[\s\S]*?geohash:\s*geofire\.geohashForLocation\(\[pingLocation\[1\],\s*pingLocation\[0\]\]\)/,
        );
    });

    it('CASE 6: the My Car scheduled-ping path still derives geohash the same way, unchanged', () => {
        expect(source).toMatch(
            /geohash:\s*geofire\.geohashForLocation\(\[savedSpot\.lat,\s*savedSpot\.lng\]\)/,
        );
    });
});
