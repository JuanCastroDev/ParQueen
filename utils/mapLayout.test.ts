import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';

const root = process.cwd();
const spv = readFileSync(resolve(root, 'views/StreetParkingView.tsx'), 'utf-8');
const indexCss = readFileSync(resolve(root, 'index.css'), 'utf-8');

// ── Layout wrapper ──────────────────────────────────────────────────────────

describe('map container — outer wrapper owns absolute positioning', () => {
  it('sp-map class is on the outer wrapper, not the mapContainerRef div', () => {
    // The outer wrapper must carry sp-map; the Mapbox container must not.
    // Ensures Mapbox adding mapboxgl-map to the inner div cannot override position:absolute.
    expect(spv).toContain('<div className="sp-map">');
    expect(spv).not.toContain('className="sp-map"' + ' onClick');
    expect(spv).not.toContain("ref={mapContainerRef} className=\"sp-map\"");
  });

  it('mapContainerRef div has explicit 100% width and height via inline style', () => {
    expect(spv).toContain("ref={mapContainerRef} style={{ width: '100%', height: '100%' }}");
  });

  it('sp-map CSS rule uses position:absolute and inset:0', () => {
    expect(indexCss).toContain('.sp-map {');
    expect(indexCss).toContain('position: absolute');
    expect(indexCss).toContain('inset: 0');
  });
});

// ── Cascade safety ──────────────────────────────────────────────────────────

describe('map container — Mapbox CSS cascade cannot collapse height', () => {
  it('mapContainerRef div does not rely on sp-map for its dimensions', () => {
    // With outer wrapper carrying sp-map, the inner div does not need absolute
    // positioning to have height. height:100% on a child of an absolutely-sized
    // parent resolves correctly even if Mapbox sets position:relative.
    expect(spv).not.toContain("ref={mapContainerRef} className=\"sp-map\"");
  });

  it('imported Mapbox CSS stylesheet cannot collapse the outer wrapper', () => {
    // The outer wrapper (.sp-map div) never receives the mapboxgl-map class
    // from Mapbox, so .mapboxgl-map{position:relative} cannot override it.
    expect(spv).toContain('<div className="sp-map">');
    // The mapContainerRef div immediately inside has explicit width/height,
    // making it independent of position:absolute vs position:relative.
    expect(spv).toContain("style={{ width: '100%', height: '100%' }}");
  });
});

// ── ResizeObserver lifecycle ─────────────────────────────────────────────────

describe('ResizeObserver — added and cleaned up', () => {
  it('ResizeObserver is created and observes the map container', () => {
    expect(spv).toContain('ro = new ResizeObserver');
    expect(spv).toContain('ro.observe(mapContainerRef.current!)');
  });

  it('ResizeObserver is disconnected on unmount', () => {
    expect(spv).toContain('ro?.disconnect()');
  });

  it('ResizeObserver variable is declared at useEffect scope, not inside initMap closure', () => {
    // Must be hoisted so the cleanup return() can reach it.
    expect(spv).toContain('let ro: ResizeObserver | undefined;');
  });
});

// ── Existing functionality unchanged ────────────────────────────────────────

describe('existing Mapbox functionality preserved', () => {
  it('Mapbox token is still loaded via getMapboxToken()', () => {
    expect(spv).toContain('getMapboxToken()');
    expect(spv).toContain("import { getMapboxToken } from '../utils/browserCredentials'");
  });

  it('map style still uses mapbox://styles/mapbox scheme', () => {
    expect(spv).toContain('mapbox://styles/mapbox/');
  });

  it('forward geocoding endpoint is unchanged', () => {
    expect(spv).toContain('api.mapbox.com/geocoding/v5/mapbox.places');
  });

  it('marker rendering is unchanged', () => {
    expect(spv).toContain('new mapboxgl.Marker');
    expect(spv).toContain('allMarkersRef');
  });

  it('Mapbox CSS is imported from npm package, not CDN', () => {
    expect(spv).toContain("import 'mapbox-gl/dist/mapbox-gl.css'");
    expect(spv).not.toContain('mapbox-gl-js/v2');
  });

  it('map.on(load) still calls map.resize() for initial sizing', () => {
    // Matched on intent, not formatting: the load handler also carries the
    // light-mode label styling, so it is no longer a single line.
    expect(spv).toMatch(/map\.on\('load',\s*\(\)\s*=>\s*\{[\s\S]{0,200}?map\.resize\(\);/);
  });


  it('does not mark the map ready until Mapbox fires the load event', () => {
    const initStart = spv.indexOf('const initMap = (center: [number, number]) => {');
    const loadStart = spv.indexOf("map.on('load'", initStart);
    expect(initStart).toBeGreaterThan(-1);
    expect(loadStart).toBeGreaterThan(initStart);
    expect(spv.slice(initStart, loadStart)).not.toContain('setMapReady(true)');
    expect(spv.slice(loadStart, loadStart + 300)).toContain('setMapReady(true)');
  });

  it('surfaces initial Mapbox errors with a visible reload recovery path', () => {
    expect(spv).toContain("map.on('error'");
    expect(spv).toContain("console.error('Mapbox initial load failed:'");
    expect(spv).toContain('setMapLoadError(true)');
    expect(spv).toContain("t('map.load_failed')");
    expect(spv).toContain("t('map.load_retry')");
    expect(spv).toContain('window.location.reload()');
  });
});
