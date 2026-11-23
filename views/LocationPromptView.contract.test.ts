// Location prompt visual redesign contracts: the vector neighborhood art and the real native permission
// semantics are intentionally independent.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const screen = read('./LocationPromptView.tsx');
const artwork = read('./location-prompt/LocationNeighborhoodArt.tsx');
const styles = read('./location-prompt/locationPrompt.css');
const en = read('../i18n/en.ts');
const es = read('../i18n/es.ts');

describe('Onboarding 2.0 location permission continuation', () => {
  it('uses the original editable vector neighborhood and the production ParQueen Ping shape', () => {
    expect(screen).toContain("import { LocationNeighborhoodArt } from './location-prompt/LocationNeighborhoodArt'");
    expect(screen).toContain('<LocationNeighborhoodArt');
    expect(artwork).toContain('PARQUEEN_MARK_PATH');
    expect(artwork).toContain('PIN_PATH');
    expect(artwork).not.toMatch(/mapbox|firebase|https?:\/\//i);
    expect(styles).toContain('.pq-loc {');
  });

  it('keeps OS/browser permission state authoritative and never auto-prompts', () => {
    expect(screen).toContain('checkLocationPermission()');
    expect(screen).toContain('reconcileLocationAccess(snap.status, readPersistedAccess(), resolveGeolocationPath())');
    expect(screen).toContain("if (resolved === 'granted') onComplete('granted')");
    expect(screen).toContain("else if (resolved === 'denied') onComplete('denied')");
    expect(screen).toContain('requestLocationPermission()');
    expect(screen).toContain("if (snap.status === 'granted')");
    expect(screen).toContain("onComplete('declined')");
    expect(screen).toContain("setHint('services_off')");
    expect(screen).toContain("setHint('try_again')");
  });

  it('contains no saving-a-car promise and discloses example Pings in EN and ES', () => {
    const englishBody = en.match(/'location_prompt.body': '([^']+)'/)?.[1] ?? '';
    const spanishBody = es.match(/'location_prompt.body': '([^']+)'/)?.[1] ?? '';
    expect(englishBody.toLowerCase()).not.toMatch(/save|parked car|guarantee/);
    expect(spanishBody.toLowerCase()).not.toMatch(/guardar|guardaste|carro|garantiza/);
    for (const key of ['headline_accent', 'you_label', 'pings_label', 'map_desc']) {
      expect(en).toContain(`'location_prompt.${key}'`);
      expect(es).toContain(`'location_prompt.${key}'`);
    }
    expect(en).toContain("'location_prompt.pings_label': 'Example Pings'");
    expect(es).toContain("'location_prompt.pings_label': 'Pings de ejemplo'");
  });

  it('supports scrolling, short screens, landscape, reduced motion, two explicit actions, and status hints', () => {
    expect(styles).toContain('overflow-y: auto');
    expect(styles).toContain('@media (prefers-reduced-motion: reduce)');
    expect(styles).toContain('@media (max-height: 680px)');
    // The S20 WebView is 726px high: with a services-off hint the art must yield.
    expect(styles).toContain('@media (max-height: 760px) and (orientation: portrait)');
    expect(styles).toContain('.pq-loc:has(.pq-loc-hint) .pq-loc-hero { flex-basis: 132px; min-height: 132px; }');
    expect(styles).toContain('@media (orientation: landscape)');
    // only transform/opacity animate, and no animation repeats forever
    expect(styles).not.toMatch(/infinite/);
    expect(styles).not.toMatch(/backdrop-filter|filter:\s*blur/);
    expect(screen).toContain("t('location_prompt.enable')");
    expect(screen).toContain("t('location_prompt.skip')");
    expect(screen).toContain('aria-live="polite"');
    expect(screen).toContain('disabled={requesting}');
    expect(screen).toContain('if (previewMode) return;');
    expect(screen).toContain("if (previewMode) { onComplete('declined'); return; }");
  });
});
