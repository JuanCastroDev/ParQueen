import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { handleVitePreloadError } from './utils/staleChunkRecovery';
import { initSentry } from './utils/sentryInit';
import { PublicLegalRoute } from './components/PublicLegalRoute';
import { resolvePublicLegalRoute } from './utils/legalRoutes';

// Production-only exception monitoring; a no-op in dev/test or when no DSN
// is configured (see utils/sentryInit.ts for the full privacy contract).
initSentry({
  isProd: import.meta.env.PROD,
  dsn: import.meta.env.VITE_SENTRY_DSN,
  release: __APP_RELEASE__,
});

// Polyfill process for browser environment to prevent "process is not defined" errors
// This is necessary because the Gemini SDK and other libs might reference 'process'
if (typeof window !== 'undefined' && !(window as any).process) {
  (window as any).process = { env: {} };
}

// A tab left open across a Hosting deploy can hold a lazy-route reference to
// a chunk hash that no longer exists. Vite's build wraps every dynamic
// import (all of this app's React.lazy() routes) so that a failure like that
// dispatches this event before rethrowing — recover automatically, once per
// distinct failure, instead of letting it reach the ErrorBoundary at all.
window.addEventListener('vite:preloadError', handleVitePreloadError);

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error("Could not find root element to mount to");
}

// Publicly opened legal pages are reached from the marketing site, the app
// stores and external links, so Back returns there rather than to the app host
// root. In-app legal navigation is wired separately in App.tsx.
const PUBLIC_LEGAL_EXIT_URL = 'https://parqueen.app';

const root = ReactDOM.createRoot(rootElement);
const publicLegalRoute = resolvePublicLegalRoute(window.location.pathname);
if (publicLegalRoute && window.location.pathname !== publicLegalRoute.canonicalPath) {
  window.history.replaceState(
    null,
    '',
    `${publicLegalRoute.canonicalPath}${window.location.search}${window.location.hash}`,
  );
}
root.render(
  <React.StrictMode>
    {publicLegalRoute
      ? <PublicLegalRoute document={publicLegalRoute.document} onExit={() => window.location.assign(PUBLIC_LEGAL_EXIT_URL)} />
      : <App />}
  </React.StrictMode>
);
