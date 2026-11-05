import { describe, expect, it } from 'vitest';
import { baseLayout, computeLayout, placeOverlays, type LayoutMeasurements } from './onboardingV2Layout';
import { STORY_STEPS, STORY_TIMELINE } from './onboardingV2Timeline';
import { SCENE_ANCHORS, signalDots, signalPath } from './sceneGeometry';

const m = (over: Partial<LayoutMeasurements> = {}): LayoutMeasurements => ({
  insetTop: 24, storyPanelHeight: 300, arrivalHeight: 260, arrivalTightHeight: 220,
  heroBottom: 200, heroHeight: 120, headerSpace: 260, brandMiniWidth: 120, ...over,
});

describe('onboarding 2.0 timeline (gateb-freeze-v1.1)', () => {
  it('keeps the approved ~8.3 s one-tap story', () => {
    expect(STORY_TIMELINE.caption2At).toBe(2300);
    expect(STORY_TIMELINE.caption3At).toBe(6000);
    expect(STORY_TIMELINE.choicesAt).toBe(7700);
    expect(STORY_TIMELINE.choicesFullyVisibleAt).toBe(8300);
    expect(STORY_STEPS.map(s => s.at)).toEqual([2300, 6000, 7700]);
    expect(STORY_STEPS[STORY_STEPS.length - 1].action).toBe('choices');
  });
});

describe('onboarding 2.0 layout', () => {
  it('classifies sizes', () => {
    expect(baseLayout(390, 844)).toMatchObject({ land: false, short: false, tiny: false });
    expect(baseLayout(360, 712)).toMatchObject({ land: false, short: true, tiny: false });
    expect(baseLayout(320, 568)).toMatchObject({ land: false, short: true, tiny: true });
    expect(baseLayout(800, 360)).toMatchObject({ land: true, short: false, tiny: false });
  });

  it('portrait: the story band (discovery phone to car bumper) is never under the story panel or header', () => {
    for (const [w, h] of [[320, 568], [360, 712], [390, 844], [412, 915]]) {
      for (const panel of [240, 300, 360, 420]) {
        const L = computeLayout(baseLayout(w, h), m({ storyPanelHeight: panel }));
        expect(L.k).toBeCloseTo(w / 390);
        const bandTop = SCENE_ANCHORS.focusTop * L.k + L.ty;
        const bandBottom = SCENE_ANCHORS.focusBottom * L.k + L.ty;
        expect(bandTop).toBeGreaterThanOrEqual(24 + 44 + 6 - 0.01);
        if (L.scrollPanel) {
          expect(L.panelMax).not.toBeNull();
          expect(bandBottom + (L.panelMax as number)).toBeLessThanOrEqual(h);
        } else {
          expect(bandBottom).toBeLessThanOrEqual(h - panel - 8 + 0.01);
        }
      }
    }
  });

  it('200% text: a very tall panel scrolls instead of covering the story', () => {
    const L = computeLayout(baseLayout(320, 568), m({ storyPanelHeight: 700 }));
    expect(L.scrollPanel).toBe(true);
    expect(L.panelMax).toBeGreaterThan(0);
  });

  it('places the arrival headline under the car when there is room, otherwise drops the supporting line first', () => {
    expect(computeLayout(baseLayout(390, 844), m({ storyPanelHeight: 260, arrivalHeight: 200 })).arriveUnder).toBe(true);
    const tight = computeLayout(baseLayout(320, 568), m({ arrivalHeight: 330, arrivalTightHeight: 280 }));
    expect(tight.arriveUnder).toBe(false);
    expect(tight.arriveTight).toBe(true);
  });

  it('shows the wordmark only when Back + logo + wordmark fit beside EN/ES', () => {
    expect(computeLayout(baseLayout(390, 844), m({ headerSpace: 260, brandMiniWidth: 120 })).logoOnly).toBe(false);
    expect(computeLayout(baseLayout(320, 568), m({ headerSpace: 170, brandMiniWidth: 120 })).logoOnly).toBe(true);
  });

  it('landscape: one camera that fills the height and keeps the story beside the side panel', () => {
    const L = computeLayout(baseLayout(800, 360), m());
    expect(L.land).toBe(true);
    expect(L.tx).toBeLessThanOrEqual(0);
    expect(L.ty).toBeGreaterThanOrEqual(360 - 600 * L.k - 0.01);
    expect(L.arriveUnder).toBe(false);
  });

  it('overlay placement follows the panel heights', () => {
    const L = computeLayout(baseLayout(390, 844), m());
    const o = placeOverlays(L, 'choose', 320, 320, 40);
    expect(o.scrimTop).toBe(844 - 320 - 70);
    expect(o.replayTop).toBe(844 - 320 - 40 - 10);
  });
});

describe('onboarding 2.0 scene geometry', () => {
  it('the cyan signal runs from the Ping toward the discovery phone', () => {
    expect(signalPath().d.startsWith('M')).toBe(true);
    const dots = signalDots();
    expect(dots).toHaveLength(8);
    const last = dots[dots.length - 1];
    const ph = SCENE_ANCHORS.phone;
    expect(last.x).toBeGreaterThan(SCENE_ANCHORS.pingTip[0]);
    expect(last.y).toBeLessThanOrEqual(ph.y + ph.h + 20);
  });
});
