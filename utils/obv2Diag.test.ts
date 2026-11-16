import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OBV2_DIAG, diag } from './obv2Diag';

const root = join(__dirname, '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

describe('Onboarding 2.0 device diagnostics', () => {
  it('are off unless the QA build flag VITE_OBV2_DIAG=1 is set', () => {
    expect(import.meta.env.VITE_OBV2_DIAG).not.toBe('1');
    expect(OBV2_DIAG).toBe(false);
    expect(read('utils/obv2Diag.ts')).toContain("import.meta.env.VITE_OBV2_DIAG === '1'");
  });

  it('record nothing when off', () => {
    diag('back:press', { view: 'create-account' });
    expect((globalThis as unknown as { __obv2diag?: string[] }).__obv2diag).toBeUndefined();
  });

  it('only log navigation/lifecycle enums, never user data', () => {
    const calls = [read('App.tsx'), read('views/onboarding-v2/OnboardingV2View.tsx')].join('\n')
      .split('\n').filter(l => /\bdiag\(/.test(l) && !/import/.test(l));
    expect(calls.length).toBeGreaterThan(5);
    for (const l of calls) expect(l).not.toMatch(/phone|otp|code|token|uid|user\.|email|username|confirmation|credential/i);
  });

  it('are not enabled by any committed environment file', () => {
    for (const f of ['.env.example']) {
      try { expect(read(f)).not.toMatch(/VITE_OBV2_DIAG\s*=\s*1/); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    }
  });
});
