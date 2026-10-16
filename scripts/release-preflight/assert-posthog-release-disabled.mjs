import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_DIST = join(ROOT, 'dist');
const MARKER = '<meta name="parqueen-posthog-release" content="off" />';
const TOKEN_PATTERN = /phc_[A-Za-z0-9_-]{8,}/;

export function assertPostHogReleaseAssets(distDir = DEFAULT_DIST) {
  const index = join(distDir, 'index.html');
  if (!existsSync(index)) throw new Error('PostHog release check blocked: dist/index.html missing.');
  const html = readFileSync(index, 'utf8');
  if (html.split(MARKER).length !== 2) {
    throw new Error('PostHog release check blocked: analytics-OFF build marker missing or duplicated.');
  }
  const assets = join(distDir, 'assets');
  if (!existsSync(assets)) throw new Error('PostHog release check blocked: dist/assets missing.');
  if (!statSync(assets).isDirectory()) throw new Error('PostHog release check blocked: assets is not a directory.');
  let jsCount = 0;
  function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const pathname = join(dir, entry.name);
      if (entry.isDirectory()) { walk(pathname); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue;
      jsCount += 1;
      if (TOKEN_PATTERN.test(readFileSync(pathname, 'utf8'))) {
        throw new Error('PostHog release check blocked: project-token-shaped value found in compiled JS (value withheld).');
      }
    }
  }
  walk(assets);
  if (jsCount === 0) throw new Error('PostHog release check blocked: no compiled JavaScript assets.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    assertPostHogReleaseAssets();
    console.log('PASS: PostHog release marked OFF; no project-token-shaped value found in compiled JS.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'PostHog release check blocked.');
    process.exitCode = 1;
  }
}
