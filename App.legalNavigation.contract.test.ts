import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

describe('in-app legal return destination', () => {
  it('opens legal through caller-aware navigation instead of always returning to Profile', () => {
    expect(app).toContain('useInAppLegalNavigation(currentView, setCurrentView)');
    expect(app).toContain('setViewWithLegalReturn');
    expect(app).toContain('onOpenLegal={document => setViewWithLegalReturn(legalViewFor(document))}');
    expect(app).toContain('setView={setViewWithLegalReturn}');
    expect(app).toContain('<PrivacyPolicyView onBack={closeLegal} />');
    expect(app).toContain('<TermsOfUseView onBack={closeLegal} />');
    expect(app).not.toContain('PrivacyPolicyView onBack={() => setCurrentView(AppView.PROFILE)}');
    expect(app).not.toContain('TermsOfUseView onBack={() => setCurrentView(AppView.PROFILE)}');
  });
});
