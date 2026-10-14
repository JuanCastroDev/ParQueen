import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Press feedback on the map status chips must never change their geometry: Chromium hit-tests the
// transformed box, so a scale on :active shrinks the target and edge releases miss (UI Interaction P1).
const map = readFileSync('views/StreetParkingView.tsx', 'utf8');
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
// Phone portrait only (same query as the Stage A portrait timer fix): an invisible ::before on the Nearby
// button grows its tap area from 32px to 44px tall. Landscape/tablet/wide have no room and stay unchanged.
const PORTRAIT = '[@media(max-width:767px)_and_(min-height:501px)]';

describe('Nearby chip portrait tap area', () => {
  it('adds a scoped invisible ::before that extends the button 7px above and below', () => {
    const cls = tokens(nearby);
    expect(cls).toEqual(expect.arrayContaining([
      `${PORTRAIT}:relative`,
      `${PORTRAIT}:before:absolute`,
      `${PORTRAIT}:before:inset-x-0`,
      `${PORTRAIT}:before:-inset-y-[7px]`,
    ]));
  });

  it('keeps the expansion scoped to phone portrait and off the contextual chip', () => {
    const unscoped = tokens(nearby).filter(c => /(^|:)(relative|absolute|before:)/.test(c) && !c.startsWith(`${PORTRAIT}:`));
    expect(unscoped).toEqual([]);
    expect(tokens(nearby).filter(c => /before:/.test(c) && !/^\[@media\(max-width:767px\)_and_\(min-height:501px\)\]:/.test(c))).toEqual([]);
    expect(tokens(contextChip).filter(c => /before:|after:/.test(c))).toEqual([]);
  });

  it('does not add backgrounds, borders or pointer-events changes to the tap area', () => {
    expect(tokens(nearby).filter(c => /before:(bg|border|shadow|ring|pointer-events)/.test(c))).toEqual([]);
    expect(tokens(nearby).filter(c => /pointer-events/.test(c))).toEqual([]);
  });
});
