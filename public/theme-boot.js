// Runs before first paint, as a classic same-origin script (the Hosting CSP
// forbids inline scripts). Two jobs:
//
// 1. Theme. Apply the saved light/dark theme so the branded boot frame and
//    <LoadingScreen /> never flash the wrong background. Mirrors App.tsx:
//    localStorage 'theme', defaulting to 'dark'. Public legal pages never
//    mount App and have always rendered light, so they are skipped (keep this
//    list equal to LEGAL_ROUTES in utils/legalRoutes.ts; a test checks).
//
// 2. Boot watchdog. index.html shows the pulsing logo until React's first
//    commit replaces it. If the app bundle fails to load, or throws before it
//    renders, that never happens, so the logo is swapped for the same
//    "couldn't finish starting / Try again" recovery AuthStartupRecovery
//    shows. It fires at once on a failed script load, or after
//    BOOT_TIMEOUT_MS. A slow load that finishes later still replaces it.
(function () {
  var BOOT_TIMEOUT_MS = 15000;
  var publicLegalPaths = ['/privacy', '/privacy-policy', '/terms', '/terms-conditions'];
  var COPY = {
    en: { title: 'ParQueen couldn’t finish starting.', body: 'Check your connection and try again.', retry: 'Try Again' },
    es: { title: 'ParQueen no pudo terminar de iniciarse.', body: 'Revisa tu conexión e inténtalo de nuevo.', retry: 'Intentar de nuevo' }
  };

  function stored(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  var path = window.location.pathname.replace(/\/+$/, '') || '/';
  if (publicLegalPaths.indexOf(path) === -1 && (stored('theme') || 'dark') === 'dark') {
    document.documentElement.classList.add('dark');
  }

  var shown = false;
  function showRecovery() {
    var boot = document.querySelector('#root > [data-pq-boot]');
    if (shown || !boot) return;
    shown = true;
    var copy = COPY[stored('parqueen_lang') === 'es' ? 'es' : 'en'];
    // Same classes as components/AuthStartupRecovery.tsx, so Tailwind emits them.
    var panel = document.createElement('div');
    panel.className = 'h-full w-full flex flex-col items-center justify-center gap-4 px-8 bg-[var(--color-bg)] text-center';
    panel.setAttribute('role', 'alert');
    panel.setAttribute('data-pq-boot-recovery', '');
    var title = document.createElement('h1');
    title.className = 'text-xl font-semibold text-[var(--color-text-primary)]';
    title.textContent = copy.title;
    var body = document.createElement('p');
    body.className = 'text-[var(--color-text-secondary)]';
    body.textContent = copy.body;
    var retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'px-6 py-2 bg-blue-500 text-white rounded-lg';
    retry.textContent = copy.retry;
    retry.addEventListener('click', function () { window.location.reload(); });
    panel.appendChild(title);
    panel.appendChild(body);
    panel.appendChild(retry);
    boot.parentNode.replaceChild(panel, boot);
  }

  // A script that fails to load (the app bundle, or a module it imports)
  // fires a non-bubbling error event on its element; capture sees it here.
  window.addEventListener('error', function (event) {
    var target = event && event.target;
    if (target && target.tagName === 'SCRIPT') showRecovery();
  }, true);
  window.setTimeout(showRecovery, BOOT_TIMEOUT_MS);
})();
