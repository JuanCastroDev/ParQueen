import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Press feedback on the map status chips must never change their geometry: Chromium hit-tests the
// transformed box, so a scale on :active shrinks the target and edge releases miss (UI Interaction P1).
const map = readFileSync('views/StreetParkingView.tsx', 'utf8');
const css = readFileSync('index.css', 'utf8');
const nearby = map.match(/onClick=\{handleNearbyPillClick\}[\s\S]*?className="([^"]+)"/)?.[1] ?? '';
const contextChip = map.match(/data-map-context-chip=\{mapContextChip\.kind\}[\s\S]*?className=\{`([^`]+)`\}/)?.[1] ?? '';
const tokens = (cls: string) => cls.replace(/\$\{[^}]*\}/g, ' ').split(/\s+/).filter(Boolean);
const GEOMETRIC = /(^|:)-?(scale|translate|rotate|skew)(-|$)|(^|:)transform(-gpu|-none)?$|(^|:)transition-(transform|all)$|^transition$/;

describe('map status chip press feedback', () => {
  it('finds both chip class lists', () => {
    expect(nearby).toContain('map-status-chip is-available');
    expect(contextChip).toContain('map-context-chip');
  });

  it.each([['Nearby', () => nearby], ['contextual', () => contextChip]])('%s chip has no geometric press effect', (_, get) => {
    const cls = tokens(get());
    expect(cls.filter(c => GEOMETRIC.test(c))).toEqual([]);
  });

  it.each([['Nearby', () => nearby], ['contextual', () => contextChip]])('%s chip keeps non-geometric feedback and respects reduced motion', (_, get) => {
    const cls = tokens(get());
    expect(cls).toContain('active:opacity-80');
    expect(cls).toContain('transition-opacity');
    expect(cls).toContain('motion-reduce:transition-none');
  });

  it('keeps handlers, labels and suppression wiring unchanged', () => {
    expect(map).toContain('onClick={handleNearbyPillClick}');
    expect(map).toMatch(/data-map-context-chip=\{mapContextChip\.kind\}\s*onClick=\{handlePrimaryMapAction\}/);
    expect(contextChip).toContain("${handoffRecoveryCardRendered || timerChipRendered ? ' map-context-chip--suppressed' : ''}");
    expect(contextChip).toContain("${mapContextChip.arrived ? ' is-arrived' : ''}");
  });
});
describe('Nearby chip touch and keyboard target', () => {
  it('uses a native button with an accessible name and the existing action', () => {
    expect(map).toMatch(/<button\s+type="button"\s+onClick=\{handleNearbyPillClick\}\s+aria-label=\{spotCount === 1/);
  });

  it('keeps the interactive box at least 44px tall at every breakpoint', () => {
    expect(css).toMatch(/\.map-status-chip\.is-available\s*\{[^}]*min-height:\s*44px/s);
    expect(css).not.toMatch(/@media[^{]*\{[\s\S]*?\.map-status-chip\.is-available\s*\{[^}]*min-height:\s*(?:0|[1-3]\d)px/s);
  });

  it('uses the product focus token for an explicit visible keyboard indicator', () => {
    expect(css).toMatch(/\.map-status-chip\.is-available:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--mobile-shell-focus\)[^}]*outline-offset:\s*3px/s);
  });

  it('does not rely on an invisible pseudo-element hit area', () => {
    expect(tokens(nearby).filter(c => /before:|after:/.test(c))).toEqual([]);
    expect(tokens(nearby).filter(c => /pointer-events/.test(c))).toEqual([]);
    expect(tokens(contextChip).filter(c => /before:|after:/.test(c))).toEqual([]);
  });

  it('keeps the empty status noninteractive', () => {
    expect(map).toMatch(/<div className="map-status-chip is-empty[^>]*>[\s\S]*?map\.no_spots_nearby/);
    expect(map).not.toMatch(/<button[^>]*className="map-status-chip is-empty/);
  });
});
