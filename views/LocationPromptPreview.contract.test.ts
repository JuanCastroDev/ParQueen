// Source contract: the authenticated founder can inspect the real location
// screen without changing Android permissions or the existing session.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
const app = read('../App.tsx');
const settings = read('./SettingsView.tsx');
const location = read('./LocationPromptView.tsx');
describe('native Android location preview', () => {
  it('uses the existing Android founder-preview gate and never enters signup', () => {
    const start = app.indexOf('if (previewLocation && ONBOARDING_V2_ANDROID_PREVIEW_ENABLED');
    const end = app.indexOf('// MAP and MESSAGES share the same MapView', start);
    expect(start).toBeGreaterThan(-1);
    const code = app.slice(start, end);
    expect(code).toContain('<LocationPromptView previewMode onComplete={() => setPreviewLocation(false)} />');
    expect(code).not.toMatch(/persistAccessChoice|savePendingIntent|setCurrentView|httpsCallable/);
    expect(app).toContain('if (state.previewLocation && state.currentView === AppView.SETTINGS)');
    expect(app).toContain('onPreviewLocation={ONBOARDING_V2_ANDROID_PREVIEW_ENABLED && user?.id ? () => setPreviewLocation(true) : undefined}');
  });
  it('renders only in flagged Settings and cannot check/request permissions in preview', () => {
    expect(settings).toContain('{onPreviewLocation && (');
    expect(settings).toContain('data-testid="settings-preview-location"');
    expect(location).toContain('if (previewMode) return;');
    expect(location).toContain("if (previewMode) { onComplete('declined'); return; }");
  });
});
