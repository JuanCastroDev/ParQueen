/**
 * Map camera padding derived from the floating chrome (header, status chips, bottom nav, right-hand controls).
 *
 * The Mapbox canvas fills the whole view and the chrome floats above it. Without padding, the camera centre (and so
 * Locate, the initial fix and every flyTo) lands at the geometric centre of the canvas, which on short landscape
 * viewports sits right at the edge of the chip stack and close to the nav. Padding moves the camera centre into the
 * band that is actually visible. Pure functions only; the DOM measuring lives in useMapChromePadding.
 */
export interface ChromeRect { left: number; top: number; right: number; bottom: number }
export interface MapPadding { top: number; bottom: number; left: number; right: number }
export interface ChromeLayout {
    container: ChromeRect;
    /** Chrome anchored to the top edge (search row, status chips). */
    top: ChromeRect[];
    /** Chrome anchored to the bottom edge (nav surface, centre Ping button). */
    bottom: ChromeRect[];
    /** Floating side controls (My Car / Locate stack). */
    side: ChromeRect[];
    /**
     * Mid-band floating chips (parking timer, handoff recovery). The visual centre must not land on them, but they
     * are not edge chrome — treating them as bottom padding would collapse the usable band.
     */
    floating?: ChromeRect[];
    safeArea: MapPadding;
}
export const ZERO_PADDING: MapPadding = { top: 0, bottom: 0, left: 0, right: 0 };
/** Minimum map area kept clear of padding; when the chrome is bigger than this allows, padding shrinks proportionally. */
export const MIN_USABLE_MAP = { width: 160, height: 96 };
/** Breathing room between a chrome edge and the usable map area. */
export const CHROME_GAP = 8;
/** Side controls only count once they cover this share of the visible vertical band (short landscape, not portrait). */
export const SIDE_BAND_SHARE = 0.4;
/**
 * When the clear band between top and bottom chrome is shorter than this, the visual centre is biased toward the
 * upper portion of the band (see SHORT_BAND_CENTER_FRAC). Mid-band centering on short landscape pushed content
 * immediately south of the user under the nav; the bias keeps that nearby context in the tappable region without
 * viewport-specific branches or marker ids.
 */
export const SHORT_BAND_PX = 200;
/** Fraction of the clear band above the visual centre when the band is short (0.5 = mid-band). */
export const SHORT_BAND_CENTER_FRAC = 0.35;

const isVisible = (r: ChromeRect) => r.right > r.left && r.bottom > r.top;
const clamp = (v: number, max: number) => Math.min(Math.max(0, v), Math.max(0, max));

function fitPair(a: number, b: number, total: number, min: number): [number, number] {
    if (total - a - b >= min) return [a, b];
    const sum = a + b;
    if (sum <= 0) return [0, 0];
    const k = Math.max(0, total - min) / sum;
    return [a * k, b * k];
}

export function computeMapChromePadding(layout: ChromeLayout): MapPadding {
    const c = layout.container;
    const width = c.right - c.left;
    const height = c.bottom - c.top;
    if (!(width > 0) || !(height > 0)) return { ...ZERO_PADDING };
    const overlapsX = (r: ChromeRect) => r.right > c.left && r.left < c.right;
    const overlapsY = (r: ChromeRect) => r.bottom > c.top && r.top < c.bottom;
    const safe = layout.safeArea;

    let top = Math.max(safe.top, 0, ...layout.top.filter((r) => isVisible(r) && overlapsX(r) && overlapsY(r)).map((r) => r.bottom - c.top + CHROME_GAP));
    let bottom = Math.max(safe.bottom, 0, ...layout.bottom.filter((r) => isVisible(r) && overlapsX(r) && overlapsY(r)).map((r) => c.bottom - r.top + CHROME_GAP));
    top = clamp(top, height);
    bottom = clamp(bottom, height);

    // Short-band bias: prefer more clear space below the centre so content just south of the user stays tappable.
    const bandBeforeSides = Math.max(0, height - top - bottom);
    if (bandBeforeSides > 0 && bandBeforeSides < SHORT_BAND_PX) {
        const usable = Math.max(MIN_USABLE_MAP.height, bandBeforeSides);
        const target = top + bandBeforeSides * SHORT_BAND_CENTER_FRAC;
        top = clamp(target - usable / 2, height);
        bottom = clamp(height - target - usable / 2, height);
    }

    let left = Math.max(0, safe.left);
    let right = Math.max(0, safe.right);
    const band = Math.max(0, height - top - bottom);
    const midX = c.left + width / 2;
    for (const r of layout.side) {
        if (!isVisible(r) || !overlapsX(r)) continue;
        const covered = Math.min(r.bottom, c.bottom - bottom) - Math.max(r.top, c.top + top);
        if (covered <= 0 || covered < band * SIDE_BAND_SHARE) continue;
        if ((r.left + r.right) / 2 >= midX) right = Math.max(right, c.right - r.left + CHROME_GAP);
        else left = Math.max(left, r.right - c.left + CHROME_GAP);
    }
    left = clamp(left, width);
    right = clamp(right, width);

    // Keep the visual centre from landing on mid-band floating chips (timer / handoff).
    let cy = top + (height - top - bottom) / 2;
    for (const f of layout.floating || []) {
        if (!isVisible(f) || !overlapsX(f)) continue;
        if (cy > f.top - CHROME_GAP && cy < f.bottom + CHROME_GAP) {
            const target = Math.max(top + MIN_USABLE_MAP.height / 2, f.top - CHROME_GAP - 12);
            const usable = Math.max(MIN_USABLE_MAP.height, height - top - bottom);
            top = clamp(target - usable / 2, height);
            bottom = clamp(height - target - usable / 2, height);
            cy = target;
        }
    }

    [top, bottom] = fitPair(top, bottom, height, Math.min(MIN_USABLE_MAP.height, height));
    [left, right] = fitPair(left, right, width, Math.min(MIN_USABLE_MAP.width, width));
    return { top: Math.round(top), bottom: Math.round(bottom), left: Math.round(left), right: Math.round(right) };
}

export function samePadding(a: MapPadding | null | undefined, b: MapPadding | null | undefined, tolerance = 1): boolean {
    if (!a || !b) return false;
    return Math.abs(a.top - b.top) <= tolerance && Math.abs(a.bottom - b.bottom) <= tolerance
        && Math.abs(a.left - b.left) <= tolerance && Math.abs(a.right - b.right) <= tolerance;
}