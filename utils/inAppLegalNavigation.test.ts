import { describe, expect, it, vi } from 'vitest';
import { AppView } from '../types';
import {
  historyStateIsInAppLegal,
  isInAppLegalView,
  legalViewFor,
  pushInAppLegalHistory,
} from './inAppLegalNavigation';

describe('in-app legal navigation', () => {
  it('maps documents onto the existing legal views', () => {
    expect(legalViewFor('privacy')).toBe(AppView.PRIVACY_POLICY);
    expect(legalViewFor('terms')).toBe(AppView.TERMS_OF_USE);
  });

  it('recognizes only the in-app legal views', () => {
    expect(isInAppLegalView(AppView.PRIVACY_POLICY)).toBe(true);
    expect(isInAppLegalView(AppView.TERMS_OF_USE)).toBe(true);
    expect(isInAppLegalView(AppView.CREATE_ACCOUNT)).toBe(false);
    expect(isInAppLegalView(AppView.PROFILE)).toBe(false);
    expect(isInAppLegalView(AppView.SETTINGS)).toBe(false);
  });

  it('pushes a history state so Android hardware Back can return to the caller', () => {
    const pushState = vi.fn();
    pushInAppLegalHistory({ pushState });
    expect(pushState).toHaveBeenCalledWith({ parqueenInAppLegal: true }, '');
    expect(historyStateIsInAppLegal({ parqueenInAppLegal: true })).toBe(true);
    expect(historyStateIsInAppLegal(null)).toBe(false);
  });
});
