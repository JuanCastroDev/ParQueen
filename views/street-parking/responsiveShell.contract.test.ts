import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const VIEWPORT_HIDING = /\b(?:hidden\s+(?:sm|md|lg|xl|2xl):(?:flex|inline-flex|block|grid)|(?:sm|md|lg|xl|2xl):hidden)\b/;

describe('unified responsive shell (Stage A)', () => {
  it('renders the docked nav at every width: no viewport-hiding classes on the nav or the map header', () => {
    const nav = read('views/street-parking/NavigationBar.tsx');
    expect(nav).toContain('<nav className="mobile-primary-nav"');
    expect(nav).not.toMatch(VIEWPORT_HIDING);
    expect(read('views/street-parking/HeaderBar.tsx')).not.toMatch(VIEWPORT_HIDING);
  });

  it('keeps the nav background full width and centres the items in a token-sized track', () => {
    const css = read('index.css');
    expect(css).toContain('--shell-nav-track: 398px;');
    expect(css).toMatch(/\.mobile-primary-nav-surface\s*\{[^}]*width:\s*100%[^}]*calc\(50% - var\(--shell-nav-track\) \/ 2\)/s);
    expect(css).toMatch(/@media \(min-width: 768px\) \{\s*[\s\S]*?--shell-nav-track: 480px;/);
    expect(css).not.toContain('calc(50% - 199px)');
  });

  it('keys compact mode on height only (no width or orientation limit)', () => {
    const css = read('index.css');
    expect(css).toContain('@media (max-height: 500px) {');
    expect(css).not.toMatch(/@media[^{]*max-height:\s*430px/);
    const start = css.indexOf('@media (max-height: 500px) {');
    const block = css.slice(start, css.indexOf('@media (min-width: 768px)', start));
    expect(block).toMatch(/--mobile-primary-nav-space:\s*calc\(70px \+ env\(safe-area-inset-bottom, 0px\)\)/);
    expect(block).toMatch(/\.mobile-primary-nav-surface\s*\{[^}]*height:\s*calc\(64px \+ env\(safe-area-inset-bottom, 0px\)\)/s);
    expect(block).toMatch(/\.mobile-primary-nav-item\s*\{[^}]*min-height:\s*52px/s);
    expect(block).toMatch(/\.map-control-button\s*\{[^}]*width:\s*44px[^}]*height:\s*44px/s);
  });

  it('pins My Car + Locate to the viewport lower-right above the nav on wide screens, at >= 44px', () => {
    const css = read('index.css');
    const wide = css.slice(css.indexOf('@media (min-width: 768px) {'));
    expect(wide).toMatch(/\.mobile-map-controls \.map-secondary-controls\s*\{[^}]*position:\s*fixed[^}]*right:\s*max\(16px,\s*env\(safe-area-inset-right,\s*0px\)\);[^}]*bottom:\s*calc\(var\(--mobile-primary-nav-space\) \+ 16px\)/s);
    expect(wide).toMatch(/\.mobile-map-controls\.mobile-map-controls\s*\{[^}]*padding-bottom:\s*calc\(var\(--mobile-primary-nav-space\) \+ 16px\)/s);
    expect(wide).toMatch(/\.map-context-chip\.map-context-chip\s*\{[^}]*display:\s*inline-flex[^}]*min-height:\s*44px/s);
    const map = read('views/StreetParkingView.tsx');
    expect(map).not.toContain('md:max-w-[380px]');
    expect(map).not.toContain('md:pb-16 md:px-4');
  });

  it('keeps legacy access paths and tour targets in Stage A', () => {
    const header = read('views/street-parking/HeaderBar.tsx');
    for (const target of ['profile', 'messages', 'bell', 'ai']) expect(header).toContain(`data-tour="${target}"`);
    const map = read('views/StreetParkingView.tsx');
    // The floating CTA is gone at every width; its state lives in the contextual chip, its action in the same handler.
    expect(map).not.toContain('map-primary-cta');
    expect(map).not.toContain('data-tour="share-spot"');
    expect(map).toContain("t('my_car.parked_car_label')");
    expect(map).toContain("t('my_car.youve_arrived')");
    expect(map).toMatch(/data-map-context-chip=\{mapContextChip\.kind\}\s*onClick=\{handlePrimaryMapAction\}/);
    expect(map).toMatch(/onPing=\{handlePrimaryMapAction\}/);
    const css = read('index.css');
    expect(css.slice(0, css.indexOf('@media'))).toMatch(/\.map-context-chip\s*\{\s*display:\s*none;/);
    expect(read('views/street-parking/NavigationBar.tsx')).toContain('data-tour-spotlight="share-spot"');
  });
});

describe('Option A: contextual chip on short landscape', () => {
  it('shows the chip only on short landscape (portrait cannot match), at 44px, and stays hidden by default below 768', () => {
    const css = read('index.css');
    const block = css.match(/@media \(max-height: 500px\) and \(orientation: landscape\) \{([\s\S]*?)\n\}/);
    expect(block).not.toBeNull();
    expect(block![1]).toMatch(/\.map-context-chip\.map-context-chip\s*\{[^}]*display:\s*inline-flex[^}]*min-height:\s*44px/s);
    expect(css).not.toMatch(/@media[^{]*orientation:\s*portrait[^{]*\{[^@]*\.map-context-chip/);
    expect(css.slice(0, css.indexOf('@media'))).toMatch(/\.map-context-chip\s*\{\s*display:\s*none;/);
  });
});

describe('phone portrait timer chip clears the docked nav', () => {
  it('pins the timer chip above the nav with a selector that outranks the pb-0/w-full/mx-auto utilities', () => {
    const css = read('index.css');
    const block = css.match(/@media \(max-width: 767px\) and \(min-height: 501px\) \{([\s\S]*?)\n\}/);
    expect(block).not.toBeNull();
    // two classes (0,2,0) beat any single utility class regardless of order (utilities are emitted last)
    expect(block![1]).toMatch(/\.mobile-map-controls \.map-timer-chip\s*\{[^}]*position:\s*fixed[^}]*bottom:\s*calc\(var\(--mobile-primary-nav-space\) \+ 14px\)[^}]*right:\s*max\(82px, env\(safe-area-inset-right, 0px\)\)[^}]*width:\s*auto/s);
    expect(css.indexOf('.mobile-map-controls .map-timer-chip')).toBeLessThan(css.indexOf('@tailwind utilities'));
    // the timer element carries no positioning utility that could compete
    const map = read('views/StreetParkingView.tsx');
    const timerClass = map.match(/className=\{?[`"](map-timer-chip[^`"]*)[`"]/)![1];
    expect(timerClass).not.toMatch(/\b(fixed|absolute|relative|sticky|bottom-|inset-|left-|right-)/);
    // the global pb-0 utility on the controls container is unchanged
    expect(map).toMatch(/mobile-map-controls w-full flex flex-col gap-3 pointer-events-auto mt-auto pb-0 px-0/);
  });
});

describe('contextual chip yields to the handoff-recovery card on short landscape', () => {
  it('uses the card render boolean for both the card and the chip suppression class', () => {
    const map = read('views/StreetParkingView.tsx');
    expect(map).toContain('const handoffRecoveryCardRendered = isHandoffRecoveryCardRendered(interestFlow);');
    expect(map).toMatch(/\{handoffRecoveryCardRendered && \(\s*<FinishHandoffChip/);
    expect(map).toContain("${handoffRecoveryCardRendered || timerChipRendered ? ' map-context-chip--suppressed' : ''}");
    // the old inline condition is gone (single source of truth)
    expect(map).not.toContain('interestFlow.handoffStep === null && (interestFlow.finderPendingHandoff');
  });
  it('hides the suppressed chip only inside the short-landscape media query', () => {
    const css = read('index.css');
    const block = css.match(/@media \(max-height: 500px\) and \(orientation: landscape\) \{([\s\S]*?)\n\}/)![1];
    expect(block).toMatch(/\.map-context-chip\.map-context-chip\.map-context-chip--suppressed\s*\{\s*display:\s*none;/);
    expect(css.split('map-context-chip--suppressed').length - 1).toBe(1);
  });
});

describe('short-landscape visibility priority: handoff card > timer chip > contextual chip', () => {
  it('derives suppression from the existing render conditions', () => {
    const map = read('views/StreetParkingView.tsx');
    expect(map).toContain('const timerChipRendered = !!(parkingTimer.timer && savedSpot);');
    expect(map).toMatch(/\{timerChipRendered && \(\s*<div className=\{`map-timer-chip\$\{handoffRecoveryCardRendered \? ' map-timer-chip--suppressed' : ''\}/);
    expect(map).not.toContain('{parkingTimer.timer && savedSpot && (');
  });
  it('hides suppressed elements and resets the card offset only on short landscape, without :has()', () => {
    const css = read('index.css');
    const start = css.indexOf('@media (max-height: 500px) and (orientation: landscape) {');
    const block = css.slice(start, css.indexOf('\n}', start));
    expect(block).toMatch(/\.map-timer-chip\.map-timer-chip--suppressed\s*\{\s*display:\s*none;/);
    expect(block).toMatch(/\.mobile-map-controls \.handoff-action-card\.handoff-action-card\s*\{\s*bottom:\s*calc\(var\(--mobile-primary-nav-space\) \+ 10px\);/);
    expect(block).not.toContain(':has(');
    for (const cls of ['map-timer-chip--suppressed', 'map-context-chip--suppressed']) expect(css.split(cls).length - 1).toBe(1);
    // must come after the max-height block's ":has(+ .map-timer-chip)" lift so it wins at equal specificity
    const lift = css.lastIndexOf('.mobile-map-controls .handoff-action-card:has(+ .map-timer-chip)');
    expect(lift).toBeGreaterThan(-1);
    expect(css.indexOf('.mobile-map-controls .handoff-action-card.handoff-action-card')).toBeGreaterThan(lift);
  });
});
