// Responsive camera and panel layout for the Onboarding 2.0 stage.
// Same rules as the approved prototype (gateb-freeze-v1.1): one camera per viewport size, shared by every
// state and both languages; the story band (discovery phone to white-car bumper) never sits under a panel;
// at large text sizes panels scroll instead of shrinking text.
import { SCENE_ANCHORS, SCENE_HEIGHT, SCENE_SHIFT, SCENE_WIDTH } from './sceneGeometry';

const HEADER_ROW = 44;
const BACK_BUTTON = 44 + 6;
const HEADER_GAP = 8;
/** Height of the bottom scrim's transparent-to-opaque ramp (px); matches onboardingV2.css. */
export const SCRIM_RAMP = 110;

export type BaseLayout = { width: number; height: number; land: boolean; short: boolean; tiny: boolean };

/** Classes that depend only on the stage size; they change panel heights, so they are applied before measuring. */
export function baseLayout(width: number, height: number): BaseLayout {
  const land = width > height;
  return { width, height, land, short: !land && height < 740, tiny: !land && height < 620 };
}

export type LayoutMeasurements = {
  /** Safe top inset applied to the header (px). */
  insetTop: number;
  /** Tallest demo or choices panel across English and Spanish (px). */
  storyPanelHeight: number;
  /** Arrival panel height with and without its supporting line (px). */
  arrivalHeight: number;
  arrivalTightHeight: number;
  /** Large logo lockup on arrival: bottom edge and height (px). */
  heroBottom: number;
  heroHeight: number;
  /** Space between the header's left edge and the EN/ES switch (px). */
  headerSpace: number;
  /** Compact logo + wordmark width (px). */
  brandMiniWidth: number;
};

export type OnboardingLayout = BaseLayout & {
  k: number;
  tx: number;
  ty: number;
  scrollPanel: boolean;
  panelMax: number | null;
  arriveUnder: boolean;
  arriveTop: number | null;
  arriveTight: boolean;
  arriveCompact: boolean;
  arriveScroll: boolean;
  arriveMax: number | null;
  logoOnly: boolean;
  /** Bottom of the white car on screen (px), used to place the arrival scrim. */
  carBottom: number;
};

export function computeLayout(base: BaseLayout, m: LayoutMeasurements): OnboardingLayout {
  const { width: W, height: H, land } = base;
  const { focusTop, focusBottom } = SCENE_ANCHORS;
  let k: number, tx = 0, ty: number;
  let scrollPanel = false, panelMax: number | null = null;
  if (land) {
    const sceneW = W - Math.min(380, W * 0.48) + 28;
    k = Math.max(sceneW / SCENE_WIDTH, H / (SCENE_HEIGHT - SCENE_SHIFT));
    tx = Math.min(0, sceneW / 2 - 180 * k);
    ty = Math.max(H - SCENE_HEIGHT * k, Math.min(-SCENE_SHIFT * k, H - 10 - focusBottom * k));
  } else {
    k = W / SCENE_WIDTH;
    const storyTop = H - m.storyPanelHeight;
    const rowBottom = m.insetTop + HEADER_ROW;
    const maxTy = storyTop - 8 - focusBottom * k;
    const minTy = rowBottom + 6 - focusTop * k;           // discovery phone stays below the header row
    ty = Math.min(-SCENE_SHIFT * k, maxTy);
    if (ty < minTy) {
      ty = minTy;
      panelMax = Math.floor(H - (focusBottom * k + ty) - 4);
      scrollPanel = true;
    }
  }
  const carBottom = focusBottom * k + ty;
  // header: wordmark only when Back + logo + wordmark fit beside EN/ES with room to spare
  let logoOnly = m.headerSpace - (BACK_BUTTON + m.brandMiniWidth) < HEADER_GAP;
  if (land && m.brandMiniWidth > 170) logoOnly = true;   // a large wordmark would sit over the street story
  let arriveUnder = false, arriveTop: number | null = null, arriveTight = false;
  let arriveCompact = land && m.heroHeight > H * 0.38;
  let arriveScroll = false, arriveMax: number | null = null;
  if (!land) {
    if (H - (carBottom + 14) >= m.arrivalHeight + 24) {
      arriveUnder = true;                                 // headline under the car, actions at the bottom
      arriveTop = Math.round(carBottom + 14);
    } else {
      // the panel would hide the car (the thing to tap): drop only its supporting line
      arriveTight = H - m.arrivalHeight < (focusBottom - 30) * k + ty;
      const need = arriveTight ? m.arrivalTightHeight : m.arrivalHeight;
      if (m.heroBottom + 12 > H - need) arriveCompact = true;
      const room = H - (m.insetTop + HEADER_ROW + 12);
      if (need > room) { arriveScroll = true; arriveMax = Math.floor(room); }
    }
  }
  return { ...base, k, tx, ty, scrollPanel, panelMax, arriveUnder, arriveTop, arriveTight, arriveCompact, arriveScroll, arriveMax, logoOnly, carBottom };
}

/** Top of the bottom scrim and of the Replay button for the given state (px). */
export function placeOverlays(layout: OnboardingLayout, state: 'arrive' | 'demo' | 'choose', activePanelHeight: number, choosePanelHeight: number, replayHeight: number) {
  const H = layout.height;
  // the scrim must be fully opaque before the street art ends (bottom of the 390x600 frame), so the art never stops in a hard line
  const sceneBottom = SCENE_HEIGHT * layout.k + layout.ty;
  const scrimTop = state === 'arrive' && layout.arriveUnder
    ? Math.max(0, Math.min(layout.carBottom - 48, sceneBottom - SCRIM_RAMP))
    : Math.max(0, Math.min(H - activePanelHeight - 70, sceneBottom - SCRIM_RAMP));
  const replayTop = Math.max(0, H - choosePanelHeight - (replayHeight || 40) - 10);
  return { scrimTop, replayTop };
}
