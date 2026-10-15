import { describe, expect, it } from 'vitest';
import { CHROME_GAP, MIN_USABLE_MAP, computeMapChromePadding, samePadding, ZERO_PADDING, type ChromeLayout } from './mapChromePadding';

const R = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
const base = (w: number, h: number, extra: Partial<ChromeLayout> = {}): ChromeLayout => ({
    container: R(0, 0, w, h), top: [], bottom: [], side: [], safeArea: { ...ZERO_PADDING }, ...extra,
});

describe('computeMapChromePadding', () => {
    it('returns zero padding when there is no chrome', () => {
        expect(computeMapChromePadding(base(390, 844))).toEqual(ZERO_PADDING);
    });

    it('pads short landscape (568x320) with an upward-biased centre still inside the clear band', () => {
        const p = computeMapChromePadding(base(568, 320, {
            top: [R(87, 8, 481, 60), R(87, 63, 481, 145)],
            bottom: [R(0, 256, 568, 320), R(241, 263, 327, 315)],
            side: [R(508, 142, 552, 240)],
        }));
        expect(320 - p.top - p.bottom).toBeGreaterThanOrEqual(MIN_USABLE_MAP.height - 1);
        expect(p.right).toBe(568 - 508 + CHROME_GAP);
        expect(p.left).toBe(0);
        const cy = p.top + (320 - p.top - p.bottom) / 2;
        expect(cy).toBeGreaterThan(145);
        expect(cy).toBeLessThan(200);
    });

    it('biases the centre upward on a 667x375 short band so southern nearby content stays above the nav', () => {
        const p = computeMapChromePadding(base(667, 375, {
            top: [R(137, 8, 531, 60), R(137, 63, 531, 145)],
            bottom: [R(0, 311, 667, 375), R(291, 318, 377, 370)],
            side: [R(607, 197, 651, 295)],
        }));
        const cy = p.top + (375 - p.top - p.bottom) / 2;
        expect(cy).toBeGreaterThan(190);
        expect(cy).toBeLessThan(215);
        expect(p.right).toBe(667 - 607 + CHROME_GAP);
        expect(311 - cy).toBeGreaterThanOrEqual(95);
    });

    it('keeps mid-band centering when the clear band is tall (portrait)', () => {
        const p = computeMapChromePadding(base(390, 844, {
            top: [R(16, 16, 374, 68), R(16, 72, 240, 104)],
            bottom: [R(0, 748, 390, 844)],
            side: [R(318, 600, 374, 724)],
        }));
        expect(p).toEqual({ top: 104 + CHROME_GAP, bottom: 96 + CHROME_GAP, left: 0, right: 0 });
    });

    it('shrinks proportionally when the chrome leaves less than the minimum usable area', () => {
        const p = computeMapChromePadding(base(400, 200, { top: [R(0, 0, 400, 120)], bottom: [R(0, 120, 400, 200)] }));
        expect(200 - p.top - p.bottom).toBeGreaterThanOrEqual(MIN_USABLE_MAP.height - 1);
        expect(p.top).toBeGreaterThan(p.bottom);
    });

    it('uses the safe-area insets as a floor and ignores hidden or off-container chrome', () => {
        const p = computeMapChromePadding(base(844, 390, {
            top: [R(10, 10, 10, 50), R(-200, 0, -10, 300)],
            safeArea: { top: 0, bottom: 21, left: 47, right: 47 },
        }));
        expect(p).toEqual({ top: 0, bottom: 21, left: 47, right: 47 });
    });

    it('nudges the centre above a floating timer chip without treating it as edge chrome', () => {
        const p = computeMapChromePadding(base(667, 375, {
            top: [R(137, 8, 531, 60), R(137, 63, 531, 95)],
            bottom: [R(0, 311, 667, 375)],
            side: [R(607, 197, 651, 295)],
            floating: [R(144, 199, 524, 234)],
        }));
        const cy = p.top + (375 - p.top - p.bottom) / 2;
        expect(cy).toBeLessThanOrEqual(199 - 8);
        expect(cy).toBeGreaterThan(95);
        expect(p.bottom).toBeLessThan(160); // not full-bleed to the timer top
    });

    it('returns zero for an unmeasured container', () => {
        expect(computeMapChromePadding(base(0, 0, { top: [R(0, 0, 100, 50)] }))).toEqual(ZERO_PADDING);
    });
});

describe('samePadding', () => {
    it('treats sub-pixel differences as unchanged', () => {
        expect(samePadding({ top: 10, bottom: 10, left: 0, right: 0 }, { top: 10.6, bottom: 9.5, left: 0, right: 1 })).toBe(true);
        expect(samePadding({ top: 10, bottom: 10, left: 0, right: 0 }, { top: 12, bottom: 10, left: 0, right: 0 })).toBe(false);
        expect(samePadding(null, ZERO_PADDING)).toBe(false);
    });
});