import { useCallback, useEffect, useRef } from 'react';
import { AppView } from '../types';
import type { PublicLegalDocument } from '../utils/legalRoutes';
import {
  historyStateIsInAppLegal,
  isInAppLegalView,
  legalViewFor,
  pushInAppLegalHistory,
} from '../utils/inAppLegalNavigation';

export const useInAppLegalNavigation = (
  currentView: AppView,
  setCurrentView: (view: AppView) => void,
) => {
  const returnViewRef = useRef<AppView>(AppView.PROFILE);

  const openLegalFrom = useCallback((document: PublicLegalDocument, from: AppView) => {
    returnViewRef.current = from;
    pushInAppLegalHistory();
    setCurrentView(legalViewFor(document));
  }, [setCurrentView]);

  const setViewWithLegalReturn = useCallback((view: AppView) => {
    if (isInAppLegalView(view)) {
      openLegalFrom(view === AppView.PRIVACY_POLICY ? 'privacy' : 'terms', currentView);
      return;
    }
    setCurrentView(view);
  }, [currentView, openLegalFrom, setCurrentView]);

  const closeLegal = useCallback(() => {
    if (typeof window !== 'undefined' && historyStateIsInAppLegal(window.history.state)) {
      window.history.back();
      return;
    }
    setCurrentView(returnViewRef.current);
  }, [setCurrentView]);

  useEffect(() => {
    const onPopState = () => {
      if (isInAppLegalView(currentView)) {
        setCurrentView(returnViewRef.current);
      }
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [currentView, setCurrentView]);

  return { openLegalFrom, setViewWithLegalReturn, closeLegal, legalReturnViewRef: returnViewRef };
};
