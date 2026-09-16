import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');
const ruleBetween = (css: string, startMarker: string, endMarker: string, selector: string) => {
  const start = css.indexOf(startMarker);
  const end = css.indexOf(endMarker, start + startMarker.length);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const match = css.slice(start, end).match(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, 's'));
  expect(match).not.toBeNull();
  return match?.[1] ?? '';
};

describe('mobile shell layout contract', () => {
  it('reserves the complete safe-area-aware navigation footprint for primary content and map controls', () => {
    const css = read('index.css');
    expect(css).toContain('--mobile-primary-nav-space: calc(104px + env(safe-area-inset-bottom, 0px))');
    expect(css).toMatch(/\.mobile-primary-screen\s*\{[^}]*padding-bottom:\s*var\(--mobile-primary-nav-space\)/s);
    expect(css).toMatch(/\.mobile-map-controls\s*\{[^}]*padding-bottom:\s*var\(--mobile-primary-nav-space\)/s);
    expect(css).toContain('env(safe-area-inset-top, 0px)');
  });

  it('keeps mobile targets large and keyboard focus visible while desktop retains its header controls', () => {
    const css = read('index.css');
    const header = read('views/street-parking/HeaderBar.tsx');
    expect(css).toMatch(/\.mobile-primary-nav-item\s*\{[^}]*min-height:\s*70px/s);
    expect(css).toContain('.mobile-primary-nav-item:focus-visible');
    expect(header).toContain('hidden md:inline-flex');
  });

  it('suppresses the map navigation copy while the Messages overlay owns the visible primary navigation', () => {
    const app = read('App.tsx');
    expect(app).toContain('showPrimaryNavigation={currentView === AppView.MAP}');
    expect(app).toContain('setView={navigatePrimary}');
  });

  it('keeps MapView mounted under Messages but marks that background layer inert and accessibility-hidden', () => {
    const app = read('App.tsx');
    expect(app).toContain('currentView === AppView.MAP || currentView === AppView.MESSAGES');
    expect(app).toContain('const messagesObscuresMap = currentView === AppView.MESSAGES');
    expect(app).toContain('showPrimaryNavigation={currentView === AppView.MAP}');
    expect(app).toContain('aria-hidden={messagesObscuresMap ? true : undefined}');
    expect(app).toContain("messagesObscuresMap ? ({ inert: '' } as Record<string, string>) : {}");
    expect(app).toMatch(/<div[\s\S]*messagesObscuresMap[\s\S]*<MapView[\s\S]*<\/div>\s*\{currentView === AppView\.MESSAGES && \(/);
    expect(app).toContain('className="fixed inset-0 z-50 bg-[var(--color-bg)]"');
    expect(app).not.toContain('setSelectedItem(null)');
    expect(app).toMatch(/setActiveChatContext\(\{ userId, context \}\)[\s\S]*setCurrentView\(AppView\.MESSAGES\)/);
  });

  it('treats an ancestor-inert modal as suspended so it cannot reclaim focus from a foreground overlay', () => {
    const hook = read('hooks/useModalAccessibility.ts');
    expect(hook).toContain("return Boolean(modalRoot.closest?.('[inert]'))");
    expect(hook).toMatch(/if \(!modalRootIsSuspended\(modalRoot\)\) \{\s*focusInsideDialog\(/);
    expect(hook).toMatch(/if \(modalRootIsSuspended\(modalRoot\)\) return;\s*const active = document\.activeElement/);
  });

  it('wires every map sheet/dialog state into the idle-root visibility guard', () => {
    const map = read('views/StreetParkingView.tsx');
    for (const mapping of [
      'spotModalOpen: isSpotModalOpen',
      'spotDetailsOpen: !!selectedItem',
      'sessionSheetOpen: showSessionSheet',
      'postSaveOfferOpen: showPostSaveOffer',
      'departureSheetOpen: showDepartureSheet',
      'handoffSheetOpen: interestFlow.handoffStep !== null',
      'stackSheetOpen: !!stackGroup',
      'deleteDialogOpen: showDeleteConfirm',
      'destinationActivitySheetOpen: !!search.selectedDestination',
    ]) expect(map).toContain(mapping);
    expect(map).toContain('{mapPrimaryNavigationVisible && (');
  });

  it('keeps the mobile map hierarchy on shared quiet-premium surface treatments', () => {
    const css = read('index.css');
    const header = read('views/street-parking/HeaderBar.tsx');
    const map = read('views/StreetParkingView.tsx');

    expect(css).toContain('--mobile-shell-surface:');
    expect(css).toContain('--mobile-shell-border:');
    expect(css).toContain('--mobile-shell-accent:');
    expect(css).toContain('--mobile-shell-focus: #82bdff');
    expect(css).toMatch(/\.map-search-shell,[^}]*backdrop-filter:\s*blur\(/s);
    expect(css).toMatch(/\.map-ai-action\s*\{[^}]*min-height:\s*44px/s);
    expect(css).toMatch(/\.map-ai-action:focus-visible,[^}]*outline:\s*2px solid var\(--mobile-shell-focus\)/s);
    expect(css).toMatch(/\.map-primary-cta\s*\{[^}]*letter-spacing:\s*-0\.02em/s);
    expect(css).toContain('.map-primary-cta-icon');
    expect(css).toContain('.map-status-chip');
    expect(css).toContain('.map-control-button');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.map-primary-cta/s);

    expect(header).toContain('map-search-shell');
    expect(header).toContain('map-ai-action');
    expect(map).toContain('map-status-chip');
    expect(map).toContain('map-control-button');
    expect(map).toContain('map-primary-cta');
  });

  it('uses one slimmer portrait header grid while retaining touch and responsive geometry', () => {
    const css = read('index.css');

    expect(css).toContain('--mobile-map-header-width: min(86vw, 372px)');
    expect(css).toMatch(/\.map-search-shell\s*\{[^}]*width:\s*var\(--mobile-map-header-width\)[^}]*height:\s*54px/s);
    expect(css).toMatch(/\.map-status-row\s*\{[^}]*width:\s*var\(--mobile-map-header-width\)/s);
    expect(css).toMatch(/\.map-ai-action\s*\{[^}]*height:\s*44px[^}]*min-height:\s*44px/s);
    expect(css).toMatch(/@media \(orientation: landscape\)[\s\S]*?\.map-search-shell\s*\{[^}]*height:\s*52px/s);
    expect(css).toMatch(/@media \(orientation: landscape\)[\s\S]*?\.map-ai-action\s*\{[^}]*height:\s*44px[^}]*min-height:\s*44px/s);
    expect(css).toMatch(/@media \(min-width: 768px\)[\s\S]*?\.map-search-shell\s*\{[^}]*height:\s*50px/s);
  });

  it('provides intentional light and dark mobile shell palettes with theme-aware map visibility', () => {
    const css = read('index.css');

    for (const token of [
      '--mobile-shell-surface-strong:',
      '--mobile-shell-text:',
      '--mobile-shell-text-muted:',
      '--mobile-map-overlay:',
      '--mobile-map-edge:',
      '--mobile-ping-cradle:',
    ]) {
      expect(ruleBetween(css, ':root {', '.dark {', ':root')).toContain(token);
      expect(ruleBetween(css, '.dark {', 'html, body, #root', '\\.dark')).toContain(token);
    }

    expect(css).toMatch(/\.map-search-icon\s*\{[^}]*color:\s*var\(--mobile-shell-text-muted\)/s);
    expect(css).toMatch(/\.map-search-input\s*\{[^}]*color:\s*var\(--mobile-shell-text\)/s);
    expect(css).toMatch(/\.map-status-chip\s*\{[^}]*color:\s*var\(--mobile-shell-text-muted\)/s);
    expect(css).toMatch(/\.mobile-primary-nav-surface\s*\{[^}]*color:\s*var\(--mobile-shell-text-muted\)/s);
    expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]*?\.map-blue-tint-overlay\s*\{[^}]*background:\s*var\(--mobile-map-overlay\)/s);
    expect(css).toMatch(/@media \(max-width: 767px\)[\s\S]*?\.map-blue-tint-soft\s*\{[^}]*background:\s*var\(--mobile-map-edge\)/s);
  });

  it('keeps production Tailwind utilities from overriding semantic shell geometry and foregrounds', () => {
    const header = read('views/street-parking/HeaderBar.tsx');
    const map = read('views/StreetParkingView.tsx');
    const classNames = (source: string, semanticClass: string) => {
      const match = source.match(new RegExp(`className="([^"]*\\b${semanticClass}\\b[^"]*)"`));
      expect(match).not.toBeNull();
      return match?.[1] ?? '';
    };

    const searchShell = classNames(header, 'map-search-shell');
    expect(searchShell).not.toContain('w-full');
    expect(searchShell).not.toMatch(/(?:^|\s)(?:md:)?h-\[/);

    const searchIcon = classNames(header, 'map-search-icon');
    expect(searchIcon).not.toContain('text-[var(--color-text-secondary)]');

    const searchInput = classNames(header, 'map-search-input');
    expect(searchInput).not.toContain('text-[var(--color-text)]');
    expect(searchInput).not.toContain('placeholder-[var(--color-text-secondary)]');

    const statusRow = classNames(map, 'map-status-row');
    expect(statusRow).not.toMatch(/(?:^|\s)w-full(?:\s|$)/);
    expect(statusRow).toContain('md:w-full');

    for (const statusClass of ['is-available', 'is-empty']) {
      const statusChip = classNames(map, `map-status-chip ${statusClass}`);
      expect(statusChip).not.toMatch(/(?:^|\s)text-(?:emerald-400|\[var\(--color-text-secondary\)\])(?:\s|$)/);
    }
  });

  it('keeps the centered Ping geometry while using the lighter theme-aware cradle', () => {
    const css = read('index.css');
    const orbit = css.match(/\.mobile-primary-nav-ping-orbit\s*\{([^}]*)\}/s)?.[1] ?? '';

    expect(orbit).toMatch(/width:\s*72px/);
    expect(orbit).toMatch(/height:\s*72px/);
    expect(orbit).toMatch(/background:\s*var\(--mobile-ping-cradle\)/);
    expect(orbit).toMatch(/border:\s*1px solid var\(--mobile-ping-cradle-border\)/);
  });

  it('keeps the car and Locate controls in one aligned vertical utility stack at every mobile viewport', () => {
    const css = read('index.css');
    const map = read('views/StreetParkingView.tsx');
    expect(map).toContain('map-secondary-controls flex flex-col items-end');
    expect(css).toMatch(/@media \(orientation: landscape\) and \(max-height: 430px\)/);
    expect(css).toMatch(/@media \(orientation: landscape\)[\s\S]*?\.mobile-map-controls \.map-secondary-controls\s*\{[^}]*position:\s*fixed[^}]*right:\s*max\(16px,\s*env\(safe-area-inset-right,\s*0px\),\s*calc\(50% - 190px\)\)[^}]*bottom:\s*calc\(var\(--mobile-primary-nav-space\) \+ 10px\)[^}]*flex-direction:\s*column[^}]*gap:\s*10px/s);
    expect(css).toMatch(/\.map-control-button\s*\{[^}]*width:\s*50px[^}]*height:\s*50px/s);
    expect(css).toMatch(/@media \(orientation: landscape\)[\s\S]*?\.map-timer-chip\s*\{[^}]*position:\s*fixed/s);
    expect(map).toContain('map-timer-chip');
  });

  it('anchors portrait map controls above the complete safe-area-aware centered-Ping footprint', () => {
    const css = read('index.css');
    const portraitControls = ruleBetween(
      css,
      '@media (max-width: 767px)',
      '.mobile-primary-nav-ping',
      '\\.mobile-map-controls \\.map-secondary-controls',
    );

    expect(portraitControls).toMatch(/position:\s*fixed/);
    expect(portraitControls).toMatch(/right:\s*max\(16px,\s*env\(safe-area-inset-right,\s*0px\),\s*calc\(50% - 195px\)\)/);
    expect(portraitControls).toMatch(/bottom:\s*calc\(var\(--mobile-primary-nav-space\) \+ 16px\)/);
    expect(portraitControls).toMatch(/width:\s*auto/);
    expect(portraitControls).toMatch(/margin:\s*0/);
    expect(portraitControls).toMatch(/flex-direction:\s*column/);
    expect(portraitControls).toMatch(/gap:\s*10px/);
  });

  it('keeps the center Ping core stationary while suppressing its idle halo for reduced motion', () => {
    const css = read('index.css');
    expect(css).toMatch(/\.mobile-primary-nav-ping-orbit::before\s*\{[^}]*animation:\s*mobile-primary-nav-ping-pulse 2\.8s/s);
    expect(css).toMatch(/@keyframes mobile-primary-nav-ping-pulse\s*\{[\s\S]*transform:\s*scale\(1\.28\)[\s\S]*opacity:\s*0/s);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*\.mobile-primary-nav-ping-orbit::before\s*\{[^}]*animation:\s*none[^}]*opacity:\s*0/s);
    expect(css).not.toMatch(/\.mobile-primary-nav-ping-core\s*\{[^}]*animation:/s);
  });

  it('restores the pre-polish map-shell geometry at the desktop breakpoint', () => {
    const css = read('index.css');
    expect(css).toMatch(/@media \(min-width: 768px\)[\s\S]*?\.map-search-shell\s*\{[^}]*height:\s*50px/s);
    expect(css).toMatch(/@media \(min-width: 768px\)[\s\S]*?\.map-control-button\s*\{[^}]*width:\s*40px[^}]*height:\s*40px/s);
    expect(css).toMatch(/@media \(min-width: 768px\)[\s\S]*?\.map-primary-cta\s*\{[^}]*min-height:\s*52px/s);
  });
});
