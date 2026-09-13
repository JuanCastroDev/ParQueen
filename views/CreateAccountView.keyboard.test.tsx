import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const signup = readFileSync(new URL('./CreateAccountView.tsx', import.meta.url), 'utf8');
const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');

describe('signup keyboard layout resilience', () => {
  it('lets short/keyboard viewports scroll instead of using a crushing h-full flex column', () => {
    expect(signup).toContain('min-h-full');
    expect(signup).toContain('shrink-0');
    expect(signup).toContain('flex-1 min-h-4');
    expect(signup).toContain("scrollIntoView({ block: 'center', inline: 'nearest' })");
    expect(signup).toContain('env(safe-area-inset-top');
    expect(signup).toContain('env(safe-area-inset-bottom');
    expect(signup).not.toMatch(/className="h-full w-full bg-\[var\(--color-bg\)\] flex flex-col px-6 pt-10"/);
  });

  it('sizes the app shell to the resized window rather than a static 100vh', () => {
    expect(app).toContain('h-full w-full flex flex-col');
    expect(app).toContain('flex-1 min-h-0 relative');
    expect(app).not.toContain('h-screen w-screen flex flex-col');
  });
});
