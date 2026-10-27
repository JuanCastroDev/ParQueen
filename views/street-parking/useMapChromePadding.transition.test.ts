import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { isMapChromePaddingSuspended } from './useMapChromePadding';

/**
 * L1-R3: Messages keeps MapView mounted under inert; showPrimaryNavigation flips false→true on return.
 * The hook must suspend while hidden and re-enter the effect (fresh measure) when visible again.
 */
describe('isMapChromePaddingSuspended (Messages visibility gate)', () => {
  it('runs when map is visible and search is not frozen', () => {
    expect(isMapChromePaddingSuspended(false, true)).toBe(false);
  });

  it('suspends while Messages obscures the keep-mounted map (visible=false)', () => {
    expect(isMapChromePaddingSuspended(false, false)).toBe(true);
  });

  it('suspends while search is open even if the map chrome is otherwise visible', () => {
    expect(isMapChromePaddingSuspended(true, true)).toBe(true);
  });

  it('stays suspended when both search-frozen and Messages-obscured', () => {
    expect(isMapChromePaddingSuspended(true, false)).toBe(true);
  });

  it('hidden→visible falling edge leaves suspension (forces effect remount / remasure)', () => {
    const whileMessages = isMapChromePaddingSuspended(false, false);
    const afterReturnToMap = isMapChromePaddingSuspended(false, true);
    expect(whileMessages).toBe(true);
    expect(afterReturnToMap).toBe(false);
  });
});

describe('MapView wires showPrimaryNavigation into useMapChromePadding', () => {
  it('passes showPrimaryNavigation as the visible argument', () => {
    const spv = readFileSync(resolve(__dirname, '../StreetParkingView.tsx'), 'utf8');
    expect(spv).toMatch(
      /useMapChromePadding\(\s*mapRef\s*,\s*mapContainerRef\s*,\s*mapReady\s*,\s*search\.searchOpen\s*,\s*showPrimaryNavigation\s*\)/,
    );
  });

  it('hook effect depends on visible so hidden→visible re-attaches observers', () => {
    const hook = readFileSync(resolve(__dirname, './useMapChromePadding.ts'), 'utf8');
    expect(hook).toMatch(/isMapChromePaddingSuspended\(frozen,\s*visible\)/);
    expect(hook).toMatch(/\[mapRef,\s*containerRef,\s*mapReady,\s*frozen,\s*visible\]/);
  });
});