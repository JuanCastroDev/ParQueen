// Release configuration contract: Onboarding 2.0 ships ON in production builds through the committed,
// non-secret .env.production, while founder previews, diagnostics, QA auth and emulator switches stay out.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');

const assignments = (source: string): Record<string, string> =>
  Object.fromEntries(
    source
      .split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'))
      .map(line => {
        const eq = line.indexOf('=');
        return [line.slice(0, eq), line.slice(eq + 1)];
      }),
  );

describe('.env.production (release switches)', () => {
  const vars = assignments(read('.env.production'));

  it('turns Onboarding 2.0 on for release builds', () => {
    expect(vars.VITE_ONBOARDING_V2).toBe('1');
  });

  it('contains only the release switch: no secrets, previews, diagnostics, QA auth or emulator flags', () => {
    expect(Object.keys(vars)).toEqual(['VITE_ONBOARDING_V2']);
  });

  it('documents the rollback path', () => {
    expect(read('.env.production')).toContain('VITE_ONBOARDING_V2=0');
  });

  it('is not ignored by git, so every release checkout gets the same switch', () => {
    const ignored = read('.gitignore').split('\n').map(line => line.trim());
    expect(ignored).not.toContain('.env.production');
    expect(ignored).not.toContain('.env*');
  });

  it('keeps the founder Settings previews behind their own opt-in flag', () => {
    expect(read('utils/onboardingPreview.ts')).toContain("import.meta.env.VITE_OBV2_PREVIEW === '1'");
  });
});
