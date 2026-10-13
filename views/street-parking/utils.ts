import mapboxgl from 'mapbox-gl';
import { getMapboxToken } from '../../utils/browserCredentials';
import { PIN_PATH, PIN_VIEWBOX, PIN_VIEWBOX_WIDTH, parqueenMarkSvg, pinHeightForWidth } from './parqueenMark';

export const NYC_CENTER: [number, number] = [-73.9712, 40.7831];

const deg2rad = (deg: number) => deg * (Math.PI / 180);

export const getDistance = (lat1: number, lon1: number, lat2: number, lon2: number) => {
    const R = 6371;
    const dLat = deg2rad(lat2 - lat1);
    const dLon = deg2rad(lon2 - lon1);
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(deg2rad(lat1)) * Math.cos(deg2rad(lat2)) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
};

export const formatTimeLeft = (ms: number): string => {
    if (ms <= 0) {
        return "Expired";
    }
    const totalMinutes = Math.floor(ms / 60000);
    if (totalMinutes < 1) {
        return "< 1 minute";
    }
    if (totalMinutes < 60) {
        return `${totalMinutes} minutes`;
    }
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (minutes === 0) {
        return `${hours} hour${hours === 1 ? "" : "s"}`;
    }
    return `${hours} hour${hours === 1 ? "" : "s"} and ${minutes} minute${minutes === 1 ? "" : "s"}`;
};

const PIN_SIZE = 46;
/** Distance (pin units) of the stack badge centre from the head-circle centre along the 45 deg ray. */
export const BADGE_RAY_UNITS = 21.7;

const applyMarkerRootStyle = (el: HTMLElement) => {
    // No inline position: mapbox-gl.css gives .mapboxgl-marker position:absolute; top:0; left:0.
    // An inline 'relative' overrode it, so each marker after the first was offset by the
    // in-flow height of the markers before it instead of sitting on its coordinate.
    el.style.display = 'flex';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.cursor = 'pointer';
    el.style.zIndex = '10';
    el.style.overflow = 'visible';
};

/**
 * Foreground pin (body + ParQueen mark) shared by single and stack markers, so both render
 * the exact same geometry in the exact same box. The tip sits on the bottom edge of the
 * viewBox, so anchor: 'bottom' lands it on the coordinate.
 */
export const buildPinForegroundSvg = (color: string, extraStyle = ''): string =>
    `<svg data-pin-fg="true" viewBox="${PIN_VIEWBOX}" xmlns="http://www.w3.org/2000/svg" style="display:block;width:100%;height:100%;overflow:visible;filter:drop-shadow(0px 3px 6px rgba(0,0,0,0.45));${extraStyle}">` +
    `<path data-pin-body="true" d="${PIN_PATH}" fill="${color}" stroke="rgba(255,255,255,0.25)" stroke-width="0.5"/>` +
    `${parqueenMarkSvg()}</svg>`;

export const createMarkerElement = (scheduled = false, reportedMs = 0) => {
    const el = document.createElement('div');
    applyMarkerRootStyle(el);
    el.dataset.scheduled = String(scheduled);

    const color = scheduled ? '#eab308' : '#1e75ff';
    // Leaving Now and Leaving Later share one silhouette, mark and size; only the colour differs.
    const size = PIN_SIZE;
    const height = pinHeightForWidth(size);
    const now = Date.now();
    const ageMs = reportedMs ? now - reportedMs : 0;
    const isAging = ageMs > 15 * 60 * 1000;
    const isFresh = reportedMs && reportedMs <= now && ageMs >= 0 && ageMs < 5000;
    const opacity = isAging ? '0.55' : '1';
    const pulseDelay1 = isFresh ? '3s' : '0s';
    const pulseDelay2 = isFresh ? '3.7s' : '0.7s';

    // Rings live outside the sized pin wrapper so they never affect offsetHeight
    const pulseRings = !scheduled ? `
        <div class="map-pin-pulse" style="width:${size}px;height:${size}px;border:2px solid ${color};animation-delay:${pulseDelay1};position:absolute;top:40%;left:50%;"></div>
        <div class="map-pin-pulse" style="width:${size}px;height:${size}px;border:2px solid ${color};animation-delay:${pulseDelay2};position:absolute;top:40%;left:50%;"></div>
    ` : '';

    el.innerHTML = `
        ${pulseRings}
        <div data-pin-box="true" style="width:${size}px;height:${height}px;flex-shrink:0;opacity:${opacity};pointer-events:none;">
          ${buildPinForegroundSvg(color)}
        </div>
    `;
    return el;
};

/** Badge label for a stack: the exact count up to 99, then "99+". The real count is kept on data-stack-count. */
export const formatStackCount = (count: number): string => (count > 99 ? '99+' : String(count));

export const createStackMarkerElement = (count: number, hasAvailableNow: boolean): HTMLElement => {
    const el = document.createElement('div');
    applyMarkerRootStyle(el);
    el.dataset.stackCount = String(count);

    const color = hasAvailableNow ? '#1e75ff' : '#eab308';
    const badgeFill = hasAvailableNow ? '#0a4fa0' : '#92400e';
    const size = PIN_SIZE;
    const height = pinHeightForWidth(size);
    const countLabel = formatStackCount(count);
    const badgeFont = countLabel.length >= 3 ? 9 : 10;
    // Badge centre sits on the 45 deg upper-right ray from the head-circle centre (20, 19), BADGE_RAY_UNITS out
    // (head radius is 18), so it overlaps the pin edge and reads as attached while staying clear of the mark.
    const u = size / PIN_VIEWBOX_WIDTH;
    const badgeCx = +((20 + BADGE_RAY_UNITS * Math.SQRT1_2) * u).toFixed(2);
    const badgeCy = +((19 - BADGE_RAY_UNITS * Math.SQRT1_2) * u).toFixed(2);

    // Same box and same foreground as the single pin. The back pins and the badge are absolutely
    // positioned overlays inside the pin box (position:relative here, never on the root), so they
    // don't change the layout box or the bottom-centre anchor; the badge may overhang the top-right.
    el.innerHTML = `
        <div data-pin-box="true" style="width:${size}px;height:${height}px;flex-shrink:0;opacity:1;pointer-events:none;position:relative;overflow:visible;">
          <svg data-stack-decoration="true" aria-hidden="true" viewBox="${PIN_VIEWBOX}" xmlns="http://www.w3.org/2000/svg" style="position:absolute;inset:0;width:100%;height:100%;overflow:visible;z-index:0;">
            <path transform="translate(0,-2.6)" d="${PIN_PATH}" fill="${color}" opacity="0.30"/>
            <path transform="translate(0,-1.3)" d="${PIN_PATH}" fill="${color}" opacity="0.55"/>
          </svg>
          ${buildPinForegroundSvg(color, 'position:relative;z-index:1;')}
          <div data-stack-badge="true" style="position:absolute;z-index:2;left:${badgeCx}px;top:${badgeCy}px;transform:translate(-50%,-50%);box-sizing:border-box;min-width:19px;height:19px;padding:0 4px;border-radius:9.5px;background:${badgeFill};border:1.5px solid rgba(255,255,255,0.85);color:#fff;font:900 ${badgeFont}px/16px -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;text-align:center;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,0.35);">${countLabel}</div>
        </div>
    `;
    return el;
};

export const clearRoute = (map: mapboxgl.Map) => {
    if (map.getLayer('route')) {
        map.removeLayer('route');
    }
    if (map.getSource('route')) {
        map.removeSource('route');
    }
};

export const drawRoute = async (map: mapboxgl.Map, start: [number, number], end: [number, number]) => {
    const mapboxToken = getMapboxToken();
    if (!map.isStyleLoaded()) return;

    try {
        const response = await fetch(
            `https://api.mapbox.com/directions/v5/mapbox/walking/${start[0]},${start[1]};${end[0]},${end[1]}?geometries=geojson&access_token=${mapboxToken}`
        );
        const data = await response.json();
        if (!data.routes || data.routes.length === 0) return;

        const route = data.routes[0].geometry;

        if (map.getSource('route')) {
            const source = map.getSource('route') as mapboxgl.GeoJSONSource;
            source.setData({
                type: 'Feature',
                properties: {},
                geometry: route
            });
        } else {
            map.addSource('route', {
                type: 'geojson',
                data: {
                    type: 'Feature',
                    properties: {},
                    geometry: route
                }
            });

            map.addLayer({
                id: 'route',
                type: 'line',
                source: 'route',
                layout: {
                    'line-join': 'round',
                    'line-cap': 'round'
                },
                paint: {
                    'line-color': '#3B82F6',
                    'line-width': 6,
                    'line-opacity': 0.85
                }
            });
        }

        const coordinates = route.coordinates;
        if (coordinates.length > 0) {
            const bounds = new mapboxgl.LngLatBounds(coordinates[0], coordinates[0]);
            for (const coord of coordinates) {
                bounds.extend(coord);
            }
            map.fitBounds(bounds, {
                padding: { top: 80, bottom: 280, left: 50, right: 50 },
                duration: 1000
            });
        }
    } catch (error) {
        console.error("Error drawing route:", error);
    }
};
