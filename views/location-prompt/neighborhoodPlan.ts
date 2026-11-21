// Geometry for the location-permission artwork: one Onboarding 2.0 brownstone block, seen from above at
// blue hour. Plain data so the art stays editable by hand. Units are art px in a 390 x 440 view box.
// The camera "rises" from the street-level onboarding scene, and the map centres on the example location.
// Everything here is illustrative: no real addresses or landmarks, and no live data.

export const ART_WIDTH = 390;
export const ART_HEIGHT = 440;

/** The example "you are here" position: the centre of the intersection, which is also the focal centre. */
export const YOU = { x: 195, y: 228 } as const;

/** Accuracy radius rings around YOU. */
export const RADIUS = { outer: 62, inner: 36 } as const;

/** Viewfinder brackets that frame the neighborhood around YOU (the "centre the map on me" moment). */
export const FOCUS = { halfW: 110, halfH: 90, arm: 20 } as const;

/** North-south avenue and east-west street, curb to curb. */
export const AVENUE = { x0: 161, x1: 229, lane: 14 } as const;
export const STREET = { y0: 198, y1: 258, lane: 13 } as const;

export type Rect = { x: number; y: number; w: number; h: number };

/** City blocks inside the sidewalks; they run off the edges so the grid reads as continuing. */
export const BLOCKS: Record<'tl' | 'tr' | 'bl' | 'br', Rect> = {
  tl: { x: -20, y: -20, w: 168, h: 205 },
  tr: { x: 242, y: -20, w: 168, h: 205 },
  bl: { x: -20, y: 271, w: 168, h: 189 },
  br: { x: 242, y: 271, w: 168, h: 189 },
};

/** Blue-hour roof tones (tar and gravel, cool-shifted), sampled to sit with the Onboarding 2.0 street. */
export const ROOF_TONES = ['#3a3450', '#45334a', '#33395a', '#4a3a4c', '#2f3453', '#524055', '#3c4566'] as const;
/** Brick and brownstone facade tones, from the Onboarding 2.0 environment palette. */
export const FACADE_TONES = ['#6e3f43', '#5a3a4a', '#84585f', '#5c5f76', '#7a4a45'] as const;

/** Rowhouse depth along a street frontage. */
const DEPTH = 44;

export type RoofDetail = 'tower' | 'ac' | 'skylight' | 'hatch' | 'garden';
export type Building = Rect & {
  /** Index into ROOF_TONES. */
  tone: number;
  /** Street-facing facade (with stoop) visible on the building's south edge. */
  front?: boolean;
  /** Width of the rear facade visible on the south edge, over the backyard. */
  back?: number;
  detail?: RoofDetail;
  /** Corner store with a lit storefront and awning. */
  corner?: boolean;
};

type RunSpec = { sizes: number[]; details?: (RoofDetail | undefined)[]; toneShift?: number };

/** Lays out a row of attached buildings along x (dir 1 = rightwards from x0, -1 = leftwards). */
function rowX(x0: number, dir: 1 | -1, y: number, h: number, spec: RunSpec, extra: (b: Building, i: number) => Partial<Building> = () => ({})): Building[] {
  let x = x0;
  return spec.sizes.map((w, i) => {
    const bx = dir === 1 ? x : x - w;
    x = dir === 1 ? x + w : x - w;
    const b: Building = { x: bx, y, w, h, tone: (i + (spec.toneShift ?? 0)) % ROOF_TONES.length, detail: spec.details?.[i] };
    return { ...b, ...extra(b, i) };
  });
}

/** Lays out a column of attached buildings along y (dir -1 = upwards from y0, 1 = downwards). */
function colY(y0: number, dir: 1 | -1, x: number, w: number, spec: RunSpec): Building[] {
  let y = y0;
  return spec.sizes.map((h, i) => {
    const by = dir === 1 ? y : y - h;
    y = dir === 1 ? y + h : y - h;
    return { x, y: by, w, h, tone: (i + 3 + (spec.toneShift ?? 0)) % ROOF_TONES.length, detail: spec.details?.[i] };
  });
}

const tlSouthY = BLOCKS.tl.y + BLOCKS.tl.h - DEPTH; // 141
const blNorthY = BLOCKS.bl.y;                         // 271
const leftEdge = BLOCKS.tl.x + BLOCKS.tl.w;           // 148
const rightEdge = BLOCKS.tr.x;                        // 242

export const BUILDINGS: Building[] = [
  // Top-left block: east column along the avenue, then the south row whose fronts face the cross street.
  ...colY(tlSouthY, -1, leftEdge - DEPTH, DEPTH, { sizes: [22, 26, 20, 28, 24, 22, 19], details: ['ac', undefined, 'skylight', 'tower', undefined, 'hatch'] }),
  ...rowX(leftEdge, -1, tlSouthY, DEPTH, { sizes: [34, 20, 24, 18, 22, 26, 24], details: [undefined, 'skylight', 'tower', undefined, 'ac', 'garden', 'skylight'], toneShift: 1 },
    (_b, i) => ({ front: true, corner: i === 0 })),

  // Top-right block.
  ...colY(tlSouthY, -1, rightEdge, DEPTH, { sizes: [24, 20, 28, 22, 26, 21, 20], details: ['hatch', 'skylight', undefined, 'ac', 'tower'], toneShift: 2 }),
  ...rowX(rightEdge, 1, tlSouthY, DEPTH, { sizes: [36, 22, 18, 26, 20, 24, 22], details: ['ac', undefined, 'skylight', 'tower', undefined, 'skylight', 'ac'], toneShift: 4 },
    (_b, i) => ({ front: true, corner: i === 0 })),

  // Bottom-left block: the north row's rear facades face the backyards.
  ...colY(blNorthY + DEPTH, 1, leftEdge - DEPTH, DEPTH, { sizes: [24, 22, 28, 20, 26, 25], details: [undefined, 'skylight', 'ac', 'tower', undefined, 'hatch'], toneShift: 5 }),
  ...rowX(leftEdge, -1, blNorthY, DEPTH, { sizes: [34, 22, 20, 26, 18, 24, 24], details: ['ac', 'tower', undefined, 'skylight', 'hatch', undefined, 'ac'], toneShift: 3 },
    (b) => ({ back: Math.max(0, Math.min(b.x + b.w, leftEdge - DEPTH) - b.x) })),

  // Bottom-right block.
  ...colY(blNorthY + DEPTH, 1, rightEdge, DEPTH, { sizes: [26, 22, 24, 28, 20, 25], details: ['skylight', undefined, 'tower', 'ac', undefined, 'skylight'], toneShift: 6 }),
  ...rowX(rightEdge, 1, blNorthY, DEPTH, { sizes: [36, 20, 24, 18, 26, 22, 22], details: [undefined, 'ac', 'skylight', undefined, 'tower', 'garden', 'hatch'], toneShift: 0 },
    (b) => {
      const from = Math.max(b.x, rightEdge + DEPTH);
      return { back: Math.max(0, b.x + b.w - from) };
    }),
];

/** Backyards: the open interior of each block (classic NYC rowhouse block). */
export const BACKYARDS: Rect[] = [
  { x: -20, y: -20, w: leftEdge - DEPTH + 20, h: tlSouthY + 20 },
  { x: rightEdge + DEPTH, y: -20, w: 410 - rightEdge - DEPTH, h: tlSouthY + 20 },
  { x: -20, y: blNorthY + DEPTH, w: leftEdge - DEPTH + 20, h: 460 - blNorthY - DEPTH },
  { x: rightEdge + DEPTH, y: blNorthY + DEPTH, w: 410 - rightEdge - DEPTH, h: 460 - blNorthY - DEPTH },
];

export type CarKind = 'silver' | 'white' | 'red' | 'maroon' | 'navy' | 'slate' | 'teal' | 'taxi';
export type Car = { cx: number; cy: number; /** degrees; 0 = nose up */ angle: number; kind: CarKind; moving?: boolean };

const CAR_LEN = 24;
const vLane = (cx: number, tops: number[], kinds: CarKind[], angle = 0): Car[] =>
  tops.map((top, i) => ({ cx, cy: top + CAR_LEN / 2, angle, kind: kinds[i % kinds.length] }));
const hLane = (cy: number, lefts: number[], kinds: CarKind[], angle = 90): Car[] =>
  lefts.map((left, i) => ({ cx: left + CAR_LEN / 2, cy, angle, kind: kinds[i % kinds.length] }));

const westLaneX = AVENUE.x0 + AVENUE.lane / 2;   // 168
const eastLaneX = AVENUE.x1 - AVENUE.lane / 2;   // 222
const northLaneY = STREET.y0 + STREET.lane / 2;  // 204.5
const southLaneY = STREET.y1 - STREET.lane / 2;  // 251.5

export const PARKED_CARS: Car[] = [
  ...vLane(westLaneX, [152, 124, 98, 66, 40, 10, -20], ['silver', 'navy', 'red', 'slate', 'teal', 'navy', 'maroon']),
  ...vLane(westLaneX, [280, 308, 338, 366, 396, 426], ['teal', 'slate', 'navy', 'red', 'navy', 'silver']),
  ...vLane(eastLaneX, [154, 126, 68, 36, 6, -22], ['white', 'maroon', 'slate', 'navy', 'red', 'slate'], 180),
  ...vLane(eastLaneX, [282, 312, 340, 400, 430], ['navy', 'silver', 'red', 'slate', 'teal'], 180),
  ...hLane(northLaneY, [120, 92, 62, 32, 2, -28], ['slate', 'red', 'navy', 'teal', 'silver', 'navy'], 270),
  ...hLane(northLaneY, [248, 276, 334, 362, 392], ['silver', 'teal', 'maroon', 'navy', 'slate'], 270),
  ...hLane(southLaneY, [122, 94, 62, 34, 4, -26], ['navy', 'slate', 'silver', 'red', 'teal', 'maroon']),
  ...hLane(southLaneY, [250, 278, 306, 336, 364], ['red', 'white', 'navy', 'slate', 'teal']),
];

/** Moving traffic, with headlights: a yellow cab heading uptown and a car approaching the corner. */
export const MOVING_CARS: Car[] = [
  { cx: 205, cy: 58, angle: 0, kind: 'taxi', moving: true },
  { cx: 46, cy: 237, angle: 90, kind: 'white', moving: true },
];

/** Example Pings hover over three parked cars near YOU (a driver there may be leaving). Values are the pin tips. */
export const PINGS: { x: number; y: number }[] = [
  { x: westLaneX, y: 152 + CAR_LEN / 2 },
  { x: 278 + CAR_LEN / 2, y: southLaneY },
  { x: 92 + CAR_LEN / 2, y: northLaneY },
];

export type Tree = { x: number; y: number; r: number };

/** Street trees at the curbs, and a few larger backyard trees. */
export const TREES: Tree[] = [
  // sidewalk trees, top blocks
  { x: 28, y: 191, r: 10 }, { x: 82, y: 192, r: 11 }, { x: 155, y: 34, r: 10 }, { x: 154, y: 104, r: 11 },
  { x: 304, y: 191, r: 11 }, { x: 362, y: 192, r: 10 }, { x: 236, y: 58, r: 10 }, { x: 235, y: 124, r: 9 },
  // sidewalk trees, bottom blocks
  { x: 40, y: 265, r: 11 }, { x: 98, y: 264, r: 9 }, { x: 155, y: 330, r: 11 }, { x: 154, y: 400, r: 10 },
  { x: 290, y: 265, r: 9 }, { x: 352, y: 264, r: 11 }, { x: 236, y: 344, r: 10 }, { x: 235, y: 412, r: 11 },
  // backyard trees
  { x: 34, y: 62, r: 17 }, { x: 78, y: 112, r: 13 }, { x: 330, y: 70, r: 18 }, { x: 372, y: 118, r: 12 },
  { x: 40, y: 376, r: 16 }, { x: 86, y: 420, r: 13 }, { x: 322, y: 384, r: 17 }, { x: 366, y: 352, r: 12 },
];

/** Street lamps: the lamp heads sit at the curb; their warm pools spill onto sidewalk and street. */
export const LAMPS: { x: number; y: number }[] = [
  { x: 154, y: 191 }, { x: 236, y: 191 }, { x: 154, y: 265 }, { x: 236, y: 265 },
  { x: 56, y: 192 }, { x: 330, y: 264 },
];
