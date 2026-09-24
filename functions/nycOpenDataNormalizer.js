'use strict';

const { expandDailyDays, CANONICAL_WEEKDAYS } = require('./streetIntelDays');

// Expands common street type abbreviations to full DOT words.
// Applied BEFORE ordinal stripping so "81st" doesn't collide with "St" expansion.
const SUFFIX_EXPAND = [
  // Multi-word or ambiguous abbreviations first
  [/\bBlvds?\b/gi, 'Boulevard'],
  [/\bPkwy\b/gi, 'Parkway'],
  [/\bExpwy\b/gi, 'Expressway'],
  [/\bTpkes?\b/gi, 'Turnpike'],
  [/\bHwy\b/gi, 'Highway'],
  [/\bFwy\b/gi, 'Freeway'],
  // Single-letter abbreviations last (to avoid "St" matching inside "1st" etc.)
  // Word-boundary anchors prevent "EAST" → "EAEET"
  [/\bAves?\b/gi, 'Avenue'],
  [/\bRd\b/gi, 'Road'],
  [/\bPl\b/gi, 'Place'],
  [/\bDr\b/gi, 'Drive'],
  [/\bLn\b/gi, 'Lane'],
  [/\bCt\b/gi, 'Court'],
  // "St" last — most likely to conflict with ordinals and directionals
  [/\bSts?\b/gi, 'Street'],
];

/**
 * Converts an OSM-style street name to NYC DOT format (all-caps, no ordinals).
 *
 * "East 85th Street"  → "EAST 85 STREET"
 * "3rd Avenue"        → "3 AVENUE"
 * "West 181st Street" → "WEST 181 STREET"
 * "Amsterdam Ave"     → "AMSTERDAM AVENUE"
 * "Grand Concourse"   → "GRAND CONCOURSE"
 */
function osmNameToDOT(osmName) {
  if (!osmName) return '';
  let s = osmName.trim();
  // Expand abbreviations before stripping ordinals (avoid "St" matching "81st")
  for (const [rx, expansion] of SUFFIX_EXPAND) {
    s = s.replace(rx, expansion);
  }
  // Strip ordinal suffixes from numbers: "85th" → "85", "3rd" → "3"
  s = s.replace(/\b(\d+)(st|nd|rd|th)\b/gi, '$1');
  // Uppercase and collapse whitespace
  return s.toUpperCase().replace(/\s+/g, ' ').trim();
}

/**
 * Normalizes a street name for comparison (uppercase, single spaces).
 * Works on both OSM and DOT format names.
 */
function normalizeStreetName(name) {
  if (!name) return '';
  return String(name).toUpperCase().replace(/\s+/g, ' ').trim();
}

/**
 * Builds a Socrata LIKE wildcard pattern from a DOT-format name.
 * Handles extra internal spaces in DOT names like "EAST   85 STREET".
 * "EAST 85 STREET" → "EAST%85%STREET"
 */
function streetNameToLikePattern(dotName) {
  return dotName.trim().split(/\s+/).filter(Boolean).join('%');
}

/** Maps _detectBorough codes to NYC Open Data borough name strings. */
const BOROUGH_CODE_TO_NAME = {
  BX: 'Bronx',
  SI: 'Staten Island',
  BK: 'Brooklyn',
  QN: 'Queens',
  MN: 'Manhattan',
};

/**
 * Converts a NYC DOT side_of_street code to a parkingSide cardinal string.
 * "N" → "North", "S" → "South", "E" → "East", "W" → "West"
 */
function dotSideToCardinal(side) {
  const MAP = {
    N: 'North', S: 'South', E: 'East', W: 'West',
    NORTH: 'North', SOUTH: 'South', EAST: 'East', WEST: 'West',
  };
  return MAP[String(side || '').toUpperCase().trim()] || null;
}

/**
 * Builds a deterministic Firestore doc ID for an NYC Open Data block-face segment.
 * Keyed on borough + onStreet + fromStreet + toStreet + side so Broadway block A
 * never deduplicates against Broadway block B.
 */
function nycOdSegmentDocId(boroughCode, dotName, fromStreet, toStreet, side) {
  const norm = s => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '');
  return `nyc_od_${norm(boroughCode)}_${norm(dotName)}_${norm(fromStreet)}_${norm(toStreet)}_${norm(side)}`.slice(0, 200);
}

/**
 * Selects a single block face from grouped NYC Open Data rows.
 *
 * @param {{ [key: string]: object[] }} groups  keyed by "from_street|to_street|side"
 * @param {string[]} crossStreets  the two streets BOUNDING the user's block, in
 *        along-street order, DOT-normalised (see findBlockContext). These are the
 *        intersections immediately before and after the user along the target
 *        street — not merely nearby roads.
 * @param {string|null} userSide  cardinal side the user stands on ('North'|'South'
 *        |'East'|'West'), or null when geometry could not determine it.
 * @returns {{ group: object[], selectionReason: string, score: number } | null}
 *
 * Evidence model. from_street/to_street name the two ends of a DOT block face and
 * the dataset uses both orderings for the same physical block, so the pair is
 * compared as an unordered SET. side_of_street is the cardinal side perpendicular
 * to the street's local bearing, which is directly comparable to userSide.
 *
 *   block evidence   both bounding streets matched  -> 6   (the only decisive level)
 *                    exactly one matched            -> 3   (never sufficient alone)
 *                    neither                        -> 0
 *   side evidence    candidate side === userSide    -> +1
 *
 * Scored as block * 10 + side, so side can only ever separate candidates that are
 * already tied on block evidence — it can never drag a wrong block above a right
 * one. A winner must have the full bounding pair AND strictly beat second place;
 * anything else stays ambiguous rather than guessing. That is what distinguishes
 * the two faces of one block (E vs W), which is otherwise a genuine tie.
 *
 * selectionReason values:
 *   'single_candidate'          1 group, no cross-street context needed
 *   'bounding_pair_and_side'    both bounds matched and side broke the tie
 *   'bounding_pair'             both bounds matched and it won outright
 *   null return                 ambiguous; caller returns nyc_open_data_ambiguous_block
 */
function selectBlockFace(groups, crossStreets = [], userSide = null) {
  const keys = Object.keys(groups);
  if (!keys.length) return null;

  // No cross-street context: only an unambiguous single candidate is safe.
  if (!crossStreets.length) {
    if (keys.length === 1) return { group: groups[keys[0]], selectionReason: 'single_candidate', score: 0 };
    return null;
  }

  const norm = v => String(v || '').toUpperCase().replace(/\s+/g, ' ').trim();
  const bounds = new Set(crossStreets.map(norm).filter(Boolean));
  const wantSide = norm(userSide);

  const scored = keys.map(key => {
    const [fromStr, toStr, sideStr] = key.split('|');
    const from = norm(fromStr), to = norm(toStr);
    // Unordered comparison: the dataset stores A|B and B|A for the same block.
    let block = 0;
    if (bounds.size >= 2 && bounds.has(from) && bounds.has(to) && from !== to) block = 6;
    else if (bounds.has(from) || bounds.has(to)) block = 3;
    const sideCardinal = norm(dotSideToCardinal(sideStr));
    const side = wantSide && sideCardinal && sideCardinal === wantSide ? 1 : 0;
    return { key, block, side, total: block * 10 + side };
  });
  scored.sort((a, b) => b.total - a.total);

  const best = scored[0];
  const second = scored[1];

  // Partial evidence must never force a choice.
  if (best.block < 6) return null;
  // Still indistinguishable (e.g. both faces of the block, side unknown).
  if (second && best.total === second.total) return null;

  return {
    group: groups[best.key],
    selectionReason: best.side ? 'bounding_pair_and_side' : 'bounding_pair',
    score: best.total,
  };
}

// ── Block-face geometry ───────────────────────────────────────────────────────
// Pure helpers: they take OSM way geometry (already fetched by the caller's
// single Overpass request) plus the user's coordinate, and work out which BLOCK
// the user stands on and which SIDE of it they are on.
//
// The previous approach took the two named ways whose midpoints were nearest the
// user, which routinely returned a parallel street that does not bound the block
// at all — Bed-Stuy returned SAINT ANDREWS PLACE, which never meets Brooklyn
// Avenue. Bounding streets are a question of order ALONG the target street, not
// straight-line proximity, so the user is projected onto the target centreline
// and the nearest true crossing on each side is taken.

// Longitude degrees are shorter than latitude degrees; scaling by cos(lat) makes
// planar maths accurate enough over the ~1 km windows used here.
const NYC_LNG_SCALE = Math.cos((40.7 * Math.PI) / 180);
const toXY = (lat, lng) => ({ x: lng * NYC_LNG_SCALE, y: lat });

function projectOnSegment(p, a, b) {
  const vx = b.x - a.x, vy = b.y - a.y;
  const wx = p.x - a.x, wy = p.y - a.y;
  const len2 = vx * vx + vy * vy;
  if (len2 === 0) return { t: 0, d2: wx * wx + wy * wy };
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / len2));
  const dx = p.x - (a.x + t * vx), dy = p.y - (a.y + t * vy);
  return { t, d2: dx * dx + dy * dy };
}

/** Closest point on a polyline: its cumulative distance along, and the segment hit. */
function projectOnPolyline(p, pts) {
  let best = null, acc = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    const pr = projectOnSegment(p, a, b);
    const along = acc + pr.t * segLen;
    if (!best || pr.d2 < best.d2) best = { d2: pr.d2, along, a, b };
    acc += segLen;
  }
  return best;
}

function segmentsIntersect(a, b, c, d) {
  const rx = b.x - a.x, ry = b.y - a.y;
  const sx = d.x - c.x, sy = d.y - c.y;
  const den = rx * sy - ry * sx;
  if (den === 0) return null; // parallel or collinear
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / den;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return t;
}

/**
 * Distance along `target` at which `other` crosses it, or null if it never does.
 * Falls back to a near-touch test within `tol` so T-junctions whose OSM geometry
 * stops a few metres short still count as intersections.
 */
function crossingAlong(target, other, tol) {
  let acc = 0, best = null;
  for (let i = 0; i + 1 < target.length; i++) {
    const a = target[i], b = target[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    for (let j = 0; j + 1 < other.length; j++) {
      const t = segmentsIntersect(a, b, other[j], other[j + 1]);
      if (t !== null) {
        const along = acc + t * segLen;
        if (best === null || along < best) best = along;
      }
    }
    acc += segLen;
  }
  if (best !== null) return best;
  for (const pt of other) {
    const pr = projectOnPolyline(pt, target);
    if (pr && Math.sqrt(pr.d2) <= tol && (best === null || pr.along < best)) best = pr.along;
  }
  return best;
}

const CHAIN_GAP = 0.0006; // ~60 m: beyond this, a fragment is a different run

/**
 * Joins the target street's way fragments into one polyline, seeded at the
 * fragment the user actually stands on and grown in BOTH directions. Seeding
 * arbitrarily can leave the user at an end of the chain, which silently loses the
 * cross street on one side of them.
 */
function chainWays(segs, seedPoint) {
  if (!segs.length) return [];
  const near = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  const remaining = segs.slice();
  let seedIdx = 0;
  if (seedPoint) {
    let bestD = Infinity;
    remaining.forEach((sg, i) => {
      for (let j = 0; j + 1 < sg.length; j++) {
        const pr = projectOnSegment(seedPoint, sg[j], sg[j + 1]);
        if (pr.d2 < bestD) { bestD = pr.d2; seedIdx = i; }
      }
    });
  }
  let chain = remaining.splice(seedIdx, 1)[0].slice();
  for (;;) {
    let bestI = -1, bestD = Infinity, mode = null;
    for (let i = 0; i < remaining.length; i++) {
      const sg = remaining[i];
      const opts = [
        [near(chain[chain.length - 1], sg[0]), 'tail-head'],
        [near(chain[chain.length - 1], sg[sg.length - 1]), 'tail-tail'],
        [near(chain[0], sg[sg.length - 1]), 'head-tail'],
        [near(chain[0], sg[0]), 'head-head'],
      ];
      for (const [d, m] of opts) if (d < bestD) { bestD = d; bestI = i; mode = m; }
    }
    if (bestI < 0 || bestD > CHAIN_GAP) break;
    const sg = remaining.splice(bestI, 1)[0];
    if (mode === 'tail-head') chain = chain.concat(sg.slice(1));
    else if (mode === 'tail-tail') chain = chain.concat(sg.slice().reverse().slice(1));
    else if (mode === 'head-tail') chain = sg.slice(0, -1).concat(chain);
    else chain = sg.slice().reverse().slice(0, -1).concat(chain);
  }
  return chain;
}

/**
 * Which cardinal side of the roadway a point lies on.
 *
 * nfid-uabd's side_of_street is the cardinal side PERPENDICULAR to the street's
 * local bearing — verified against the live dataset: N/S-running streets use
 * E/W (BROOKLYN AVENUE W=175 E=151), E/W-running streets use N/S (ATLANTIC
 * AVENUE N=530 S=524), and diagonal Broadway uses E/W. The bearing must be
 * normalised to [0,180] first, the same convention _detectCardinalSide relies on.
 */
function cardinalSideOf(point, a, b) {
  let brg = ((Math.atan2(b.x - a.x, b.y - a.y) * 180) / Math.PI + 360) % 360;
  let A = a, B = b;
  if (brg > 180) { A = b; B = a; brg = (brg + 180) % 360; }
  const cross = (B.x - A.x) * (point.y - A.y) - (B.y - A.y) * (point.x - A.x);
  const positive = cross > 0;
  if (brg < 45) return positive ? 'West' : 'East';
  if (brg < 135) return positive ? 'North' : 'South';
  return positive ? 'East' : 'West';
}

const TOUCH_TOL = 0.00025; // ~25 m

/**
 * Works out the block the user is standing on.
 *
 * @param {{name: string, geometry: {lat: number, lon: number}[]}[]} ways
 *        Named road ways from one Overpass response, names already DOT-normalised.
 * @param {number} lat
 * @param {number} lng
 * @param {string} mainDotName  target street, DOT-normalised
 * @returns {{ crossStreets: string[], side: string|null, bearing: number|null }}
 *          crossStreets holds the two bounding streets in along-street order.
 *          Fewer than two means the block could not be bounded, and the caller
 *          must not guess a face from it.
 */
function findBlockContext(ways, lat, lng, mainDotName) {
  const empty = { crossStreets: [], side: null, bearing: null };
  if (!Array.isArray(ways) || !ways.length) return empty;
  const target = ways.filter(w => w.name === mainDotName && w.geometry && w.geometry.length >= 2);
  if (!target.length) return empty;

  const user = toXY(lat, lng);
  const poly = chainWays(target.map(w => w.geometry.map(g => toXY(g.lat, g.lon))), user);
  if (poly.length < 2) return empty;
  const proj = projectOnPolyline(user, poly);
  if (!proj) return empty;

  const nearest = new Map();
  for (const w of ways) {
    if (w.name === mainDotName || !w.geometry || w.geometry.length < 2) continue;
    const along = crossingAlong(poly, w.geometry.map(g => toXY(g.lat, g.lon)), TOUCH_TOL);
    if (along === null) continue; // never meets the target street, so cannot bound it
    const prev = nearest.get(w.name);
    if (prev === undefined || Math.abs(along - proj.along) < Math.abs(prev - proj.along)) {
      nearest.set(w.name, along);
    }
  }

  const ordered = [...nearest.entries()].map(([name, along]) => ({ name, along }))
    .sort((p, q) => p.along - q.along);
  const before = [...ordered].filter(c => c.along <= proj.along).pop() || null;
  const after = ordered.find(c => c.along > proj.along) || null;

  let bearing = ((Math.atan2(proj.b.x - proj.a.x, proj.b.y - proj.a.y) * 180) / Math.PI + 360) % 360;
  if (bearing > 180) bearing = (bearing + 180) % 360;

  return {
    crossStreets: [before && before.name, after && after.name].filter(Boolean),
    side: cardinalSideOf(user, proj.a, proj.b),
    bearing,
  };
}

// ── NYC Open Data ASP sign parsing ────────────────────────────────────────────
// nfid-uabd writes a different grammar from SweepNYC, which is why
// _parseSweepNYCSign rejected every row: its regex is anchored on
// "...<time>-<time> [on <street>] [(Side: X)]$", and DOT text carries trailing
// arrows and (SUPERSEDES ...) metadata, so the anchor never matched.
//
// Grammar observed across 337 distinct ASP texts sampled from all five boroughs:
//
//   modern  NO PARKING (SANITATION BROOM SYMBOL) MONDAY THURSDAY 8:30AM-10AM <-> (SUPERSEDES SP-369C)
//   legacy  NO PARKING (SANITATION BROOM SYMBOL) 9:30-11AM TUES & FRI <-----> (SUPERSEDED BY SP-63C)
//   except  NO PARKING 8AM-1PM EXCEPT SUNDAY --> (SUPERSEDES SP-211CA)
//
// Day semantics, established from the data rather than from English: a HYPHEN is
// a range (MONDAY-FRIDAY, 32 rows) and WHITESPACE/& is a discrete list. The list
// reading is forced by the three- and four-token cases — MONDAY WEDNESDAY FRIDAY
// (10 rows) and MONDAY TUESDAY THURSDAY FRIDAY (8 rows) — which cannot be ranges.
// So "MONDAY THURSDAY" is Monday AND Thursday, not Monday through Thursday.
//
// Arrow semantics: <->, -->, <--, <-, ->, <-----> and the phrase W/SINGLE ARROW
// mark how far the regulation extends along the block from the sign post. They
// are independent of the schedule — the same day/time patterns appear with both
// <-> (126 distinct time tails) and --> (106) — and the block face is already
// pinned by from_street/to_street/side before parsing, so they carry no schedule
// meaning here. They are stripped from the schedule parse and returned in
// `provenance` rather than discarded.

const _NYCOD_DAYS = {
  MONDAY: 'Mon', TUESDAY: 'Tue', WEDNESDAY: 'Wed', THURSDAY: 'Thu',
  FRIDAY: 'Fri', SATURDAY: 'Sat', SUNDAY: 'Sun',
  MON: 'Mon', TUE: 'Tue', TUES: 'Tue', WED: 'Wed', WEDS: 'Wed',
  THU: 'Thu', THUR: 'Thu', THURS: 'Thu', FRI: 'Fri', SAT: 'Sat', SUN: 'Sun',
};
const _NYCOD_WEEK = CANONICAL_WEEKDAYS.slice();

// Parentheticals that are pictogram or administrative notes, never schedule.
const _NYCOD_NOISE = [
  /\(SANITATION BROOM SYMBOL\)/gi,
  /\(MOON\s*&\s*STARS\s*\(SYMBOLS\)\)/gi,
  /MOON\s*&\s*STARS\s*\(SYMBOLS\)/gi,
  /W\/\s*\(MOON\/STARS SYMBOLS\)/gi,
  /\(SUPERSEDES[^)]*\)/gi,
  /\(SUPERSEDED BY[^)]*\)/gi,
  /\(DON'?T LITTER\)/gi,
  /\(SINGLE ARROW\)/gi,
  /W\/\s*SINGLE ARROW/gi,
];
const _NYCOD_ARROWS = /<-+>|-+>|<-+/g;

/** Splits a sign into schedule text and the non-schedule metadata removed from it. */
function stripNYCODNoise(text) {
  const provenance = { arrows: [], notes: [] };
  let out = String(text || '');
  const arrows = out.match(_NYCOD_ARROWS);
  if (arrows) provenance.arrows = arrows.map(a => a.trim());
  if (/W\/\s*SINGLE ARROW/i.test(out)) provenance.arrows.push('W/SINGLE ARROW');
  for (const re of _NYCOD_NOISE) {
    const hits = out.match(re);
    if (hits) provenance.notes.push(...hits.map(h => h.trim()));
    out = out.replace(re, ' ');
  }
  out = out.replace(_NYCOD_ARROWS, ' ');
  // Any remaining parenthetical is unrecognised: keep it as provenance, and the
  // caller treats its presence as a reason to be careful rather than to guess.
  const leftovers = out.match(/\([^)]*\)/g);
  if (leftovers) provenance.notes.push(...leftovers.map(h => h.trim()));
  out = out.replace(/\([^)]*\)/g, ' ');
  return { text: out.replace(/\s+/g, ' ').trim(), provenance, unknownParens: !!leftovers };
}

/** "8:30AM" / "9:30" / "MIDNIGHT" / "NOON" → minutes since midnight, or null. */
function parseNYCODClock(raw, inheritMeridiem) {
  const t = String(raw || '').toUpperCase().replace(/\./g, '').replace(/\s+/g, '');
  if (t === 'MIDNIGHT') return 0;
  if (t === 'NOON') return 12 * 60;
  const m = t.match(/^(\d{1,2})(?::(\d{2}))?(AM|PM)?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const mer = m[3] || inheritMeridiem;
  if (!mer) return null;                    // never assume AM or PM
  if (h < 1 || h > 12 || min > 59) return null;
  if (mer === 'PM' && h !== 12) h += 12;
  if (mer === 'AM' && h === 12) h = 0;
  return h * 60 + min;
}

const _fmtClock = mins => `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
const _meridiemOf = raw => {
  const t = String(raw || '').toUpperCase();
  if (t.includes('MIDNIGHT')) return 'AM';
  if (t.includes('NOON')) return 'PM';
  const m = t.match(/(AM|PM)/);
  return m ? m[1] : null;
};

/**
 * Day list. Hyphen ranges expand; whitespace/&/comma separate discrete days.
 * Returns [] when a token is not a recognised day so the caller can refuse the
 * sign rather than parse a partial week.
 */
function parseNYCODDays(raw) {
  const cleaned = String(raw || '').toUpperCase().replace(/\bAND\b/g, ' ').replace(/&/g, ' ').replace(/,/g, ' ').trim();
  if (!cleaned) return [];
  const daily = expandDailyDays(cleaned);
  if (daily) return daily;
  const range = cleaned.match(/^([A-Z]+)\s*(?:-|THRU|THROUGH)\s*([A-Z]+)$/);
  if (range) {
    const a = _NYCOD_DAYS[range[1]], b = _NYCOD_DAYS[range[2]];
    if (!a || !b) return [];
    const i = _NYCOD_WEEK.indexOf(a), j = _NYCOD_WEEK.indexOf(b);
    if (i < 0 || j < 0) return [];
    const out = [];
    for (let k = i; ; k = (k + 1) % 7) { out.push(_NYCOD_WEEK[k]); if (k === j) break; if (out.length > 7) return []; }
    return out;
  }
  const out = [];
  for (const tok of cleaned.split(/\s+/)) {
    if (!tok) continue;
    if (tok === 'HOLIDAYS' || tok === 'HOLIDAY') continue; // not a weekday
    const d = _NYCOD_DAYS[tok];
    if (!d) return [];                       // unknown token: refuse the whole sign
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

const _NYCOD_TIME = String.raw`(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?|MIDNIGHT|NOON)`;

/**
 * Parses an nfid-uabd ASP sign into the same canonical shape as
 * _parseSweepNYCSign: { street, fromCross, toCross, side, days, startTime,
 * endTime }, plus `source` and `provenance` so the raw metadata survives.
 *
 * Returns null whenever the schedule is not fully determined. It never invents a
 * day or a time: an unreadable sign must leave the block unparsed rather than
 * imply that parking is allowed.
 */
function parseNYCOpenDataSign(signText, streetCtx) {
  if (!signText || typeof signText !== 'string') return null;
  const ctx = streetCtx || {};
  const raw = signText;
  const { text, provenance } = stripNYCODNoise(raw.toUpperCase());
  // Check the prefix AFTER whitespace is collapsed: the dataset contains rows
  // written "NO   PARKING", which a raw startsWith would reject.
  if (!text.startsWith('NO PARKING')) return null;
  const body = text.replace(/^NO PARKING\s*/, '').trim();
  if (!body) return null;

  const timeRange = String.raw`${_NYCOD_TIME}\s*(?:-|–|\bTO\b)\s*${_NYCOD_TIME}`;

  let daysRaw = null, startRaw = null, endRaw = null, exceptRaw = null;

  // days then time  — NO PARKING MONDAY THURSDAY 8:30AM-10AM
  let m = body.match(new RegExp(String.raw`^([A-Z\s&,\-]*?)\s*${timeRange}\s*$`));
  if (m && m[1].trim()) { daysRaw = m[1]; startRaw = m[2]; endRaw = m[3]; }

  // time then EXCEPT days — NO PARKING 8AM-1PM EXCEPT SUNDAY
  if (!daysRaw) {
    m = body.match(new RegExp(String.raw`^${timeRange}\s*EXCEPT\s+([A-Z\s&,]+?)\s*$`));
    if (m) { startRaw = m[1]; endRaw = m[2]; exceptRaw = m[3]; }
  }

  // time then days (legacy) — NO PARKING 9:30-11AM TUES & FRI
  if (!daysRaw && !exceptRaw) {
    m = body.match(new RegExp(String.raw`^${timeRange}\s+([A-Z\s&,\-]+?)\s*$`));
    if (m) { startRaw = m[1]; endRaw = m[2]; daysRaw = m[3]; }
  }

  if (!startRaw || !endRaw) return null;

  // A first time without AM/PM inherits the second's ("9:30-11AM" is 9:30 AM).
  const endMer = _meridiemOf(endRaw);
  const start = parseNYCODClock(startRaw, _meridiemOf(startRaw) ? null : endMer);
  const end = parseNYCODClock(endRaw, null);
  if (start === null || end === null || start === end) return null;

  let days;
  if (exceptRaw) {
    const excluded = parseNYCODDays(exceptRaw);
    if (!excluded.length) return null;
    days = _NYCOD_WEEK.filter(d => !excluded.includes(d));
  } else {
    days = parseNYCODDays(daysRaw);
  }
  if (!days.length) return null;

  return {
    street: ctx.street || 'Unknown Street',
    fromCross: ctx.fromCross || null,
    toCross: ctx.toCross || null,
    side: ctx.side || null,
    days,
    startTime: _fmtClock(start),
    endTime: _fmtClock(end),
    source: 'nyc_open_data',
    provenance: { rawText: raw, arrows: provenance.arrows, notes: provenance.notes },
  };
}

module.exports = {
  osmNameToDOT, normalizeStreetName, streetNameToLikePattern,
  dotSideToCardinal, BOROUGH_CODE_TO_NAME,
  nycOdSegmentDocId, selectBlockFace,
  findBlockContext, cardinalSideOf, chainWays, projectOnPolyline, crossingAlong,
  parseNYCOpenDataSign, parseNYCODDays, parseNYCODClock, stripNYCODNoise,
};
