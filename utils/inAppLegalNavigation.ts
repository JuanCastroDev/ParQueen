import { AppView } from '../types';
import type { PublicLegalDocument } from './legalRoutes';

export const IN_APP_LEGAL_HISTORY_KEY = 'parqueenInAppLegal';

export const legalViewFor = (document: PublicLegalDocument): AppView => (
  document === 'privacy' ? AppView.PRIVACY_POLICY : AppView.TERMS_OF_USE
);

export const isInAppLegalView = (view: AppView): boolean => (
  view === AppView.PRIVACY_POLICY || view === AppView.TERMS_OF_USE
);

export const historyStateIsInAppLegal = (state: unknown): boolean => (
  !!state
  && typeof state === 'object'
  && (state as { [IN_APP_LEGAL_HISTORY_KEY]?: unknown })[IN_APP_LEGAL_HISTORY_KEY] === true
);

export const pushInAppLegalHistory = (
  history: Pick<History, 'pushState'> | undefined = typeof window === 'undefined' ? undefined : window.history,
): void => {
  history?.pushState({ [IN_APP_LEGAL_HISTORY_KEY]: true }, '');
};
