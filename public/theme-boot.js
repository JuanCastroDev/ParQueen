// Applies the saved light/dark theme before the first paint so the branded
// boot frame and <LoadingScreen /> never flash the wrong background.
// Mirrors App.tsx: localStorage 'theme', defaulting to 'dark'. Public legal
// pages never mount App and have always rendered light, so they are skipped
// (keep this list equal to LEGAL_ROUTES in utils/legalRoutes.ts; a test checks).
// Loaded as a classic same-origin script because the Hosting CSP forbids
// inline scripts.
(function () {
  var publicLegalPaths = ['/privacy', '/privacy-policy', '/terms', '/terms-conditions'];
  var path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (publicLegalPaths.indexOf(path) !== -1) return;
  var theme = 'dark';
  try { theme = window.localStorage.getItem('theme') || 'dark'; } catch (e) { /* storage blocked */ }
  if (theme === 'dark') document.documentElement.classList.add('dark');
})();
