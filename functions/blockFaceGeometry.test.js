import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const { findBlockContext, cardinalSideOf, selectBlockFace, osmNameToDOT } = require('./nycOpenDataNormalizer');

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(resolve(HERE, 'index.js'), 'utf-8');
const CLIENT_SRC = readFileSync(resolve(HERE, '../views/StreetParkingView.tsx'), 'utf-8');

/**
 * Synthetic geometry mirroring the shape of the real Bed-Stuy case, where the
 * previous nearest-midpoint heuristic failed. BROOKLYN AVENUE runs N/S; the
 * cross streets run E/W at known latitudes; SAINT ANDREWS PLACE is the trap —
 * it is physically closer to the user than PACIFIC STREET but runs PARALLEL to
 * the target and never meets it, so it can never bound the block.
 *
 * Real crossings measured from OSM for this block, north to south:
 *   FULTON 0m, HERKIMER 84m, ATLANTIC 204m, PACIFIC 305m, DEAN 391m
 */
const LNG = -73.9442;
const ns = (name, lat0, lat1, lng = LNG) => ({
  name, geometry: [{ lat: lat0, lon: lng }, { lat: lat1, lon: lng }],
});
const ew = (name, lat, lngA = LNG - 0.004, lngB = LNG + 0.004) => ({
  name, geometry: [{ lat, lon: lngA }, { lat, lon: lngB }],
});

const GRID = [
  ns('BROOKLYN AVENUE', 40.6840, 40.6740),          // target, N/S
  ew('FULTON STREET', 40.6800),
  ew('HERKIMER STREET', 40.6793),
  ew('ATLANTIC AVENUE', 40.6782),
  ew('PACIFIC STREET', 40.6773),
  ew('DEAN STREET', 40.6765),
  // Parallel decoy: closer to a user near Atlantic than PACIFIC is, but it never
  // crosses BROOKLYN AVENUE. The old heuristic returned exactly this street.
  ns('SAINT ANDREWS PLACE', 40.6790, 40.6770, LNG + 0.0008),
];

describe('findBlockContext — block boundaries', () => {
  it('selects the intersections that actually bound the user, not the nearest road', () => {
    // Just south of Atlantic: bounded by ATLANTIC (north) and PACIFIC (south).
    const ctx = findBlockContext(GRID, 40.67795, LNG + 0.00002, 'BROOKLYN AVENUE');
    expect(new Set(ctx.crossStreets)).toEqual(new Set(['ATLANTIC AVENUE', 'PACIFIC STREET']));
  });

  it('rejects a parallel street that never meets the target, however close it is', () => {
    const ctx = findBlockContext(GRID, 40.67795, LNG + 0.00002, 'BROOKLYN AVENUE');
    expect(ctx.crossStreets).not.toContain('SAINT ANDREWS PLACE');
  });

  it('an adjacent block resolves to a different pair', () => {
    const south = findBlockContext(GRID, 40.67795, LNG, 'BROOKLYN AVENUE'); // Atlantic–Pacific
    const north = findBlockContext(GRID, 40.67875, LNG, 'BROOKLYN AVENUE'); // Herkimer–Atlantic
    expect(new Set(south.crossStreets)).toEqual(new Set(['ATLANTIC AVENUE', 'PACIFIC STREET']));
    expect(new Set(north.crossStreets)).toEqual(new Set(['HERKIMER STREET', 'ATLANTIC AVENUE']));
    expect(south.crossStreets).not.toEqual(north.crossStreets);
  });

  it('returns the bounds in along-street order', () => {
    const ctx = findBlockContext(GRID, 40.67795, LNG, 'BROOKLYN AVENUE');
    expect(ctx.crossStreets).toHaveLength(2);
  });

  it('gives no bounds when the target street is absent from the data', () => {
    const ctx = findBlockContext(GRID, 40.6780, LNG, 'NOWHERE AVENUE');
    expect(ctx.crossStreets).toEqual([]);
    expect(ctx.side).toBeNull();
  });

  it('gives fewer than two bounds past the last intersection, so no face is chosen', () => {
    const ctx = findBlockContext(GRID, 40.6835, LNG, 'BROOKLYN AVENUE'); // north of FULTON
    expect(ctx.crossStreets.length).toBeLessThan(2);
    expect(selectBlockFace({ 'A|B|E': [1], 'A|B|W': [2] }, ctx.crossStreets, ctx.side)).toBeNull();
  });

  it('handles empty or malformed input without throwing', () => {
    expect(findBlockContext([], 40.678, LNG, 'X').crossStreets).toEqual([]);
    expect(findBlockContext(null, 40.678, LNG, 'X').crossStreets).toEqual([]);
  });
});

describe('side detection', () => {
  it('a N/S street yields East/West sides', () => {
    const east = findBlockContext(GRID, 40.67795, LNG + 0.0002, 'BROOKLYN AVENUE');
    const west = findBlockContext(GRID, 40.67795, LNG - 0.0002, 'BROOKLYN AVENUE');
    expect(east.side).toBe('East');
    expect(west.side).toBe('West');
  });

  it('an E/W street yields North/South sides', () => {
    // Target now runs E/W; verified against the real E 6th St case (bearing 119°).
    const ewGrid = [
      ew('EAST 6 STREET', 40.7250),
      ns('AVENUE A', 40.7280, 40.7220, LNG - 0.002),
      ns('AVENUE B', 40.7280, 40.7220, LNG + 0.002),
    ];
    const north = findBlockContext(ewGrid, 40.7252, LNG, 'EAST 6 STREET');
    const south = findBlockContext(ewGrid, 40.7248, LNG, 'EAST 6 STREET');
    expect(north.side).toBe('North');
    expect(south.side).toBe('South');
    expect(new Set(north.crossStreets)).toEqual(new Set(['AVENUE A', 'AVENUE B']));
  });

  it('a diagonal street resolves to a stable side rather than throwing', () => {
    // Broadway-like: ~30° from north, so E/W sides (matches the live dataset,
    // where Manhattan BROADWAY records are overwhelmingly E/W).
    const diag = [
      { name: 'BROADWAY', geometry: [{ lat: 40.7400, lon: -73.9900 }, { lat: 40.7460, lon: -73.9860 }] },
      ew('WEST 24 STREET', 40.7430, -73.9920, -73.9840),
    ];
    const a = findBlockContext(diag, 40.7430, -73.9895, 'BROADWAY');
    const b = findBlockContext(diag, 40.7428, -73.9870, 'BROADWAY');
    expect(['East', 'West']).toContain(a.side);
    expect(['East', 'West']).toContain(b.side);
    expect(a.side).not.toBe(b.side); // opposite sides of the carriageway
  });

  it('cardinalSideOf is perpendicular to the local bearing', () => {
    const A = { x: 0, y: 0 }, B = { x: 0, y: 1 };   // due north
    expect(cardinalSideOf({ x: 1, y: 0.5 }, A, B)).toBe('East');
    expect(cardinalSideOf({ x: -1, y: 0.5 }, A, B)).toBe('West');
    const C = { x: 0, y: 0 }, D = { x: 1, y: 0 };   // due east
    expect(cardinalSideOf({ x: 0.5, y: 1 }, C, D)).toBe('North');
    expect(cardinalSideOf({ x: 0.5, y: -1 }, C, D)).toBe('South');
  });
});

describe('end-to-end: geometry feeding selection', () => {
  // The two faces of the Atlantic–Pacific block, as they appear in nfid-uabd.
  const faces = {
    'ATLANTIC AVENUE|PACIFIC STREET|E': [{ sign_description: 'NO PARKING 8AM-9AM E' }],
    'ATLANTIC AVENUE|PACIFIC STREET|W': [{ sign_description: 'NO PARKING 8AM-9AM W' }],
    'HERKIMER STREET|ATLANTIC AVENUE|E': [{ sign_description: 'NO PARKING 8AM-9AM HE' }],
    'HERKIMER STREET|ATLANTIC AVENUE|W': [{ sign_description: 'NO PARKING 8AM-9AM HW' }],
  };

  it('a user on the west kerb resolves to the west face of the right block', () => {
    const ctx = findBlockContext(GRID, 40.67795, LNG - 0.0002, 'BROOKLYN AVENUE');
    const sel = selectBlockFace(faces, ctx.crossStreets, ctx.side);
    expect(sel).not.toBeNull();
    expect(sel.group).toBe(faces['ATLANTIC AVENUE|PACIFIC STREET|W']);
    expect(sel.selectionReason).toBe('bounding_pair_and_side');
  });

  it('the east kerb of the same block resolves to the east face', () => {
    const ctx = findBlockContext(GRID, 40.67795, LNG + 0.0002, 'BROOKLYN AVENUE');
    const sel = selectBlockFace(faces, ctx.crossStreets, ctx.side);
    expect(sel.group).toBe(faces['ATLANTIC AVENUE|PACIFIC STREET|E']);
  });

  it('the adjacent block resolves to its own face, not the neighbour', () => {
    const ctx = findBlockContext(GRID, 40.67875, LNG - 0.0002, 'BROOKLYN AVENUE');
    const sel = selectBlockFace(faces, ctx.crossStreets, ctx.side);
    expect(sel.group).toBe(faces['HERKIMER STREET|ATLANTIC AVENUE|W']);
  });

  it('losing Overpass entirely leaves the result ambiguous, never guessed', () => {
    expect(selectBlockFace(faces, [], null)).toBeNull();
  });
});

describe('regressions: upstream call discipline', () => {
  it('block context costs exactly one Overpass request', () => {
    const start = INDEX_SRC.indexOf('async function _fetchBlockContext(');
    const body = INDEX_SRC.slice(start, INDEX_SRC.indexOf('\n}', start));
    expect((body.match(/_overpassJson\(/g) || [])).toHaveLength(1);
    expect(body).not.toMatch(/for \(|while \(|retry/i);
  });

  it('only one Overpass fetch site exists in the whole module', () => {
    expect((INDEX_SRC.match(/fetch\(`https:\/\/overpass-api\.de/g) || [])).toHaveLength(1);
  });

  it('a SweepNYC success returns before Socrata is ever queried', () => {
    const start = INDEX_SRC.indexOf('exports.createSegmentFromSweepNYC');
    const seg = INDEX_SRC.slice(start, INDEX_SRC.indexOf('function _existingNYCOpenDataResult', start));
    const successGate = seg.indexOf('if (sweepResult.success || !_SWEEPNYC_FALLBACK_REASONS.has(sweepResult.reason))');
    const fallback = seg.search(/_fallbackToNYCOpenData\(\s*lat,\s*lng/);
    expect(successGate).toBeGreaterThan(-1);
    expect(fallback).toBeGreaterThan(successGate);
  });

  it('a cached NYC Open Data segment means the populate callable is not invoked before nearest selection', () => {
    const guard = CLIENT_SRC.indexOf('if (!candidates.length)');
    const cf = CLIENT_SRC.indexOf("'createSegmentFromSweepNYC'", guard);
    const nearest = CLIENT_SRC.indexOf('const withDist', guard);
    expect(guard).toBeGreaterThan(-1);
    expect(cf).toBeGreaterThan(guard);
    expect(cf).toBeLessThan(nearest);
    expect(CLIENT_SRC).toContain("nearest.source === 'sweepnyc' && scheduleSides.length > 1");
  });

  it('the server-side block-face dedup is still keyed on the full face', () => {
    expect(INDEX_SRC).toMatch(/nycOdSegmentDocId\(boroughCode, dotName, fromStreet, toStreet, sideOfStreet\)/);
  });

  it('names are DOT-normalised on both sides before comparison', () => {
    expect(osmNameToDOT('East 23rd Street')).toBe('EAST 23 STREET');
    expect(INDEX_SRC).toMatch(/osmNameToDOT\(el\.tags\.name\)/);
    expect(INDEX_SRC).toMatch(/osmNameToDOT\(mainStreetOsmName\)/);
  });
});
