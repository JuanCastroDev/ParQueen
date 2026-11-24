import { readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, it, expect } from 'vitest';

const config = JSON.parse(readFileSync(resolve(__dirname, '../firebase.json'), 'utf-8'));
const blocks: Array<{ source: string; headers: Array<{ key: string; value: string }> }> =
  config.hosting?.headers ?? [];

/**
 * Firebase Hosting matches a header `source` against the REQUEST path, never the
 * rewrite destination — that is the bug this file exists to prevent. `/index.html`
 * matched its rule; `/`, `/terms`, `/privacy` and every other SPA deep link did
 * not, so they fell through to Hosting's default max-age=3600 and users could
 * hold stale entry HTML for an hour after a deploy.
 *
 * When several sources match one request, Hosting applies them in array order and
 * the LAST match wins for a repeated header key. That is observable in production:
 * /firebase-messaging-sw.js matches both '**\/*.@(js|css|woff2)' (immutable) and
 * its own later no-cache rule, and is served no-cache.
 *
 * This mirrors that resolution so the ordering is asserted, not assumed.
 */
function cacheControlFor(requestPath: string): string | undefined {
  let winner: string | undefined;
  for (const block of blocks) {
    if (!matches(block.source, requestPath)) continue;
    const cc = block.headers.find(h => h.key === 'Cache-Control');
    if (cc) winner = cc.value; // later match overrides
  }
  return winner;
}

function matches(source: string, path: string): boolean {
  if (source === path) return true;
  // '**' matches every request path.
  if (source === '**') return true;
  // '**/*.@(a|b|c)' — extension alternation.
  const ext = source.match(/^\*\*\/\*\.@\(([^)]+)\)$/);
  if (ext) {
    const suffixes = ext[1].split('|');
    return suffixes.some(s => path.toLowerCase().endsWith('.' + s));
  }
  return false;
}

const HTML_ROUTES = ['/', '/terms', '/privacy', '/index.html', '/some/deep/link'];

describe('Firebase Hosting Cache-Control', () => {
  it('serves no-cache for every HTML route, not just /index.html', () => {
    for (const route of HTML_ROUTES) {
      expect(cacheControlFor(route), `stale HTML risk at ${route}`).toBe('no-cache');
    }
  });

  it('is driven by a no-cache default on the catch-all, so new routes are safe', () => {
    // The fix is a safe default rather than an enumeration: any future SPA route
    // inherits no-cache without anyone remembering to add a rule for it.
    const star = blocks.find(b => b.source === '**');
    expect(star).toBeDefined();
    expect(star!.headers.find(h => h.key === 'Cache-Control')?.value).toBe('no-cache');
    expect(blocks[0].source).toBe('**');
  });

  it('keeps fingerprinted JS/CSS immutable for a year', () => {
    const immutable = 'public, max-age=31536000, immutable';
    expect(cacheControlFor('/assets/index-BOBWu-VL.js')).toBe(immutable);
    expect(cacheControlFor('/assets/index-CtzyVk69.css')).toBe(immutable);
    expect(cacheControlFor('/assets/StreetParkingView-abc123.css')).toBe(immutable);
    expect(cacheControlFor('/assets/inter-latin-def456.woff2')).toBe(immutable);
  });

  it('does not disable caching for unfingerprinted images', () => {
    // public/ passthrough files carry no hash, so they get a moderate TTL rather
    // than either extreme — this is what they were served before the fix.
    expect(cacheControlFor('/icons/apple-touch-icon.png')).toBe('public, max-age=3600');
    expect(cacheControlFor('/Parqueen_Logo.png')).toBe('public, max-age=3600');
    expect(cacheControlFor('/flags/us.svg')).toBe('public, max-age=3600');
  });

  it('keeps the service worker and manifest revalidating', () => {
    // The service worker also matches the immutable js rule; its own rule is later
    // in the array and must win, or a stale worker pins users to an old build.
    expect(cacheControlFor('/firebase-messaging-sw.js')).toBe('no-cache');
    expect(cacheControlFor('/manifest.webmanifest')).toBe('no-cache');
  });

  it('keeps the unfingerprinted theme boot script revalidating', () => {
    // public/theme-boot.js keeps its name across builds; under the immutable js
    // rule a stale copy could pin a returning user to an old theme-boot forever.
    expect(cacheControlFor('/theme-boot.js')).toBe('no-cache');
  });

  it('orders the no-cache overrides after the long-lived asset rules', () => {
    const idx = (src: string) => blocks.findIndex(b => b.source === src);
    expect(idx('**')).toBeLessThan(idx('**/*.@(js|css|woff2)'));
    expect(idx('**/*.@(js|css|woff2)')).toBeLessThan(idx('/firebase-messaging-sw.js'));
  });

  it('never lets an HTML route be served with a max-age', () => {
    for (const route of HTML_ROUTES) {
      expect(cacheControlFor(route)).not.toMatch(/max-age=[1-9]/);
    }
  });
});
