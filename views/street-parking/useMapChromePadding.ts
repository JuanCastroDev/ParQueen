import { useEffect, type RefObject } from 'react';
import type mapboxgl from 'mapbox-gl';
import { computeMapChromePadding, samePadding, type ChromeRect, type MapPadding } from '../../utils/mapChromePadding';

const TOP_CHROME = ['.map-header-search-row', '.map-status-row'];
const BOTTOM_CHROME = ['.mobile-primary-nav-surface', '.mobile-primary-nav-ping'];
const FLOATING_CHROME = ['.map-timer-chip', '[data-testid="finish-handoff-chip"]'];
const SIDE_CHROME = ['.map-secondary-controls'];
const SETTLE_MS = 80;

const toRect = (r: DOMRect): ChromeRect => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });

function readSafeArea(): MapPadding {
    const probe = document.createElement('div');
    probe.style.cssText = 'position:fixed;inset:0 auto auto 0;width:0;height:0;visibility:hidden;pointer-events:none;'
        + 'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px)';
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const px = (v: string) => parseFloat(v) || 0;
    const out = { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) };
    probe.remove();
    return out;
}

/**
 * Keeps the Mapbox camera padding equal to the space taken by the floating map chrome, so the camera centre
 * (initial fix, Locate, flyTo/easeTo, which all inherit the map's padding) lands in the visible part of the map.
 *
 * Measures on mount, on chrome/container resize (ResizeObserver), on chrome mount/unmount and on viewport or
 * orientation changes, debounced and coalesced into one animation frame. setPadding is only called when the result
 * differs from the last applied value, so padding updates never feed back into another measurement. While `frozen`
 * (e.g. search is open and the chip row is temporarily unmounted) measurement is suspended to avoid shifting the map.
 */
export function useMapChromePadding(
    mapRef: RefObject<mapboxgl.Map | null>,
    containerRef: RefObject<HTMLElement | null>,
    mapReady: boolean,
    frozen = false,
): void {
    useEffect(() => {
        const map = mapRef.current;
        const container = containerRef.current;
        if (!mapReady || frozen || !map || !container) return;
        const root: ParentNode = container.closest('.sp-map')?.parentElement ?? document;

        let raf = 0;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let observed = new Set<Element>();
        const ro = new ResizeObserver(() => schedule());

        const query = (selectors: string[]) => selectors.flatMap((s) => [...root.querySelectorAll(s)]);
        const observeChrome = () => {
            const next = new Set<Element>([container, ...query([...TOP_CHROME, ...BOTTOM_CHROME, ...SIDE_CHROME, ...FLOATING_CHROME])]);
            observed.forEach((el) => { if (!next.has(el)) ro.unobserve(el); });
            next.forEach((el) => { if (!observed.has(el)) ro.observe(el); });
            observed = next;
        };
        const measure = () => {
            raf = 0;
            const m = mapRef.current;
            if (!m || m !== map) return;
            const W = window as any;
            if (W.__QA_MAP_PADDING_FREEZE) return;
            if (W.__QA_MAP_PADDING_OVERRIDE) {
                const next = W.__QA_MAP_PADDING_OVERRIDE;
                const cur = m.getPadding();
                if (!samePadding({ top: cur.top ?? 0, bottom: cur.bottom ?? 0, left: cur.left ?? 0, right: cur.right ?? 0 }, next)) m.setPadding(next);
                return;
            }
            const rects = (selectors: string[]) => query(selectors).map((el) => toRect(el.getBoundingClientRect()));
            const next = computeMapChromePadding({
                container: toRect(container.getBoundingClientRect()),
                top: rects(TOP_CHROME),
                bottom: rects(BOTTOM_CHROME),
                side: rects(SIDE_CHROME),
                floating: rects(FLOATING_CHROME),
                safeArea: readSafeArea(),
            });
            const cur = m.getPadding();
            if (samePadding({ top: cur.top ?? 0, bottom: cur.bottom ?? 0, left: cur.left ?? 0, right: cur.right ?? 0 }, next)) return;
            m.setPadding(next);
        };
        function schedule() {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => { if (!raf) raf = requestAnimationFrame(measure); }, SETTLE_MS);
        }

        // Chrome elements mount/unmount with app state (chips, My Car button); re-observe them when the overlay changes.
        const mo = new MutationObserver(() => { observeChrome(); schedule(); });
        mo.observe(root, { childList: true, subtree: true });
        window.addEventListener('resize', schedule);
        window.addEventListener('orientationchange', schedule);
        observeChrome();
        measure();

        return () => {
            if (timer) clearTimeout(timer);
            if (raf) cancelAnimationFrame(raf);
            ro.disconnect();
            mo.disconnect();
            window.removeEventListener('resize', schedule);
            window.removeEventListener('orientationchange', schedule);
        };
    }, [mapRef, containerRef, mapReady, frozen]);
}
