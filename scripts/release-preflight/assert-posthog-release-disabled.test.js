import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertPostHogReleaseAssets } from './assert-posthog-release-disabled.mjs';

const roots = [];
function fixture(html = '<html><head><meta name="parqueen-posthog-release" content="off" /></head><body></body></html>', js = 'const app = true;') {
  const root = mkdtempSync(join(tmpdir(), 'pq-posthog-artifact-'));
  roots.push(root);
  mkdirSync(join(root, 'assets'));
  writeFileSync(join(root, 'index.html'), html);
  writeFileSync(join(root, 'assets', 'bundle.js'), js);
  return root;
}
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

describe('compiled PostHog release asset guard', () => {
  it('accepts marked analytics-OFF artifacts', () => {
    expect(() => assertPostHogReleaseAssets(fixture())).not.toThrow();
  });
  it('blocks a missing or duplicated marker', () => {
    expect(() => assertPostHogReleaseAssets(fixture('<html><head></head></html>'))).toThrow(/marker/);
    const marker = '<meta name="parqueen-posthog-release" content="off" />';
    expect(() => assertPostHogReleaseAssets(fixture(marker + marker))).toThrow(/marker/);
  });
  it('rejects dummy tokens without printing their values', () => {
    const token = 'phc_fake_token_not_a_real_project_key';
    try { assertPostHogReleaseAssets(fixture(undefined, 'const token="' + token + '";')); }
    catch (error) {
      expect(String(error)).toContain('project-token-shaped');
      expect(String(error)).not.toContain(token);
      return;
    }
    throw new Error('Expected token detection to reject artifact.');
  });
  it('blocks missing or empty JavaScript assets', () => {
    const root = fixture();
    rmSync(join(root, 'assets'), { recursive: true, force: true });
    expect(() => assertPostHogReleaseAssets(root)).toThrow(/assets missing/);
    mkdirSync(join(root, 'assets'));
    expect(() => assertPostHogReleaseAssets(root)).toThrow(/no compiled JavaScript/);
  });
});
