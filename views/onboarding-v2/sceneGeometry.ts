// Locked scene geometry for the Onboarding 2.0 neighborhood (390 x 600 scene px, fixed camera).
// Values are the approved anchors of gateb-freeze-v1.1 (FREEZE.md / layers/anchors.json); do not change them
// without a new design freeze, because the painted-free vector art layers are drawn around these positions.

export const SCENE_WIDTH = 390;
export const SCENE_HEIGHT = 600;
/** Approved scene raise at 390 x 844: the top of the art is hidden behind the header. */
export const SCENE_SHIFT = 48;

export type Point = readonly [number, number];

export const SCENE_ANCHORS = {
  /** Tip of the production Ping on the white car's roof. */
  pingTip: [105.7, 374.5] as Point,
  /** Where the discovery phone's tail touches the red car's roof. */
  cueBase: [252.2, 284.9] as Point,
  /** The searching driver's phone, just above the red car. */
  phone: { x: 230, y: 200, w: 44, h: 76 },
  /** The departing driver's phone, where the spark starts. */
  hand: [165, 388] as Point,
  halo: { cx: 103.5, cy: 442.5, rx: 71.7, ry: 38.1 },
  /** Tap target over the white car: x, y, width, height. */
  carHit: [41.5, 362, 168, 122] as const,
  /** The white car's amber corner lamps (unlock blink). */
  amber: [[44.1, 469.3], [116.2, 469.3]] as const,
  redGlass: [254.2, 298.6] as Point,
  /** Band that must stay visible: discovery phone top to white-car bumper. */
  focusTop: 192,
  focusBottom: 505,
} as const;

/** Production Ping size in the scene (matches the map marker's proportions). */
export const PING_WIDTH = 44;
export const PING_HEIGHT = (PING_WIDTH * 46) / 40;

export type SignalDot = { x: number; y: number; r: number; glowR: number; glowAlpha: number; index: number };

/** Signal path from the Ping head to the discovery phone's left edge (quadratic curve). */
export function signalPath() {
  const { pingTip, phone } = SCENE_ANCHORS;
  const headY = pingTip[1] - PING_HEIGHT + 19 * (PING_WIDTH / 40);
  const p0: Point = [pingTip[0] + 24, headY - 6];
  const p2: Point = [phone.x - 1, phone.y + 30];
  const p1: Point = [(p0[0] + p2[0]) / 2 - 6, Math.min(p0[1], p2[1]) - 30];
  const at = (t: number): Point => [
    (1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t * t * p2[0],
    (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t * t * p2[1],
  ];
  return { p0, p1, p2, at, d: `M${p0} Q${p1} ${p2}` };
}

/** Eight dots; the last one sits on the phone's edge, so the path visibly ends at the phone. */
export function signalDots(): SignalDot[] {
  const { at } = signalPath();
  return [0.12, 0.25, 0.38, 0.51, 0.64, 0.77, 0.89, 1].map((t, i) => {
    const [x, y] = at(t);
    const r = 2.3 + i * 0.32;
    return {
      x: Number(x.toFixed(1)),
      y: Number(y.toFixed(1)),
      r: Number(r.toFixed(1)),
      glowR: Number((r + (i === 7 ? 7 : 4)).toFixed(1)),
      glowAlpha: i === 7 ? 0.32 : 0.22,
      index: i,
    };
  });
}
