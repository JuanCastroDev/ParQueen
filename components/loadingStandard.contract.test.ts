import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * Guard for the branded loading standard (docs/LOADING_STATES.md).
 * Every loading state in the client must use components/LoadingScreen.tsx
 * (LoadingScreen, SectionLoader, InlineLoader) — never a generic spinner.
 */

const ROOT = resolve(__dirname, '..');
const read = (path: string) => readFileSync(join(ROOT, path), 'utf8');

// Client code only. Cloud Functions, scripts, native projects, build output
// and the other worktrees in .worktrees/ are not rendered by the app.
const SOURCE_DIRS = ['components', 'views', 'utils', 'hooks', 'services', 'i18n'];
const ROOT_FILES = ['App.tsx', 'index.tsx', 'index.html', 'index.css'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.worktrees']);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(ROOT, dir))) {
    if (SKIP_DIRS.has(name)) continue;
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) out.push(...walk(rel));
    else out.push(rel);
  }
  return out;
}

const clientFiles = [
  ...ROOT_FILES,
  ...SOURCE_DIRS.flatMap(walk),
]
  .map(path => relative(ROOT, join(ROOT, path)).replace(/\\/g, '/'))
  .filter(path => /\.(tsx?|css|html)$/.test(path))
  .filter(path => !/\.test\.|\.spec\./.test(path));

// Generic indicators this app has shipped before, or that its dependencies
// offer: Tailwind's spin utility, lucide's loader icons, FontAwesome's spinner
// classes (index.html loads FontAwesome), and hand-rolled CSS spin keyframes.
const GENERIC_SPINNERS: Array<[string, RegExp]> = [
  ['Tailwind animate-spin', /\banimate-spin\b/],
  ['Tailwind arbitrary spin animation', /animate-\[spin/],
  ['lucide Loader2 / LoaderCircle / LoaderPinwheel', /\bLoader(?:2|Circle|Pinwheel)\b/],
  ['lucide Loader', /import\s*\{[^}]*\bLoader\b[^}]*\}\s*from\s*['"]lucide-react['"]/],
  ['FontAwesome spinner', /\bfa-(?:spin|spinner|circle-notch|pulse)\b/],
  ['CSS spin keyframes', /@keyframes\s+spin\b/],
  ['MUI / RN spinner', /\b(?:CircularProgress|ActivityIndicator)\b/],
];

describe('branded loading standard', () => {
  it('scans the client source it is meant to guard', () => {
    expect(clientFiles).toContain('App.tsx');
    expect(clientFiles).toContain('views/StreetParkingView.tsx');
    expect(clientFiles).toContain('components/LoadingScreen.tsx');
    expect(clientFiles.length).toBeGreaterThan(100);
  });

  it.each(GENERIC_SPINNERS)('no client file uses a generic spinner: %s', (_name, pattern) => {
    const offenders = clientFiles.filter(path => pattern.test(read(path)));
    expect(
      offenders,
      'Use LoadingScreen / SectionLoader / InlineLoader from components/LoadingScreen.tsx (docs/LOADING_STATES.md)',
    ).toEqual([]);
  });

  it('every Suspense boundary falls back to the branded LoadingScreen (overlays may render nothing)', () => {
    // AppCheckQaPanel is a floating QA overlay, not a screen: showing nothing
    // while it loads is correct and leaves the screen beneath it visible.
    const NULL_FALLBACK_ALLOWED = new Set(['AppCheckQaPanel']);
    for (const path of clientFiles.filter(p => p.endsWith('.tsx'))) {
      const source = read(path);
      const boundaries = [...source.matchAll(/<Suspense\s+fallback=\{([^}]*)\}\s*>\s*<(\w+)/g)];
      for (const [, fallback, child] of boundaries) {
        if (fallback.trim() === 'null') {
          expect(NULL_FALLBACK_ALLOWED, `${path}: <Suspense fallback={null}> around <${child}>`).toContain(child);
        } else {
          expect(fallback.trim(), `${path}: Suspense around <${child}>`).toMatch(/^<LoadingScreen\b/);
        }
      }
    }
  });

  it('shows the branded loader, not a spinner, while the map initializes, and keeps the error path', () => {
    const spv = read('views/StreetParkingView.tsx');
    const overlay = spv.slice(spv.indexOf('{!mapReady && ('), spv.indexOf('{!mapReady && (') + 1200);
    expect(overlay).toContain("t('map.load_failed')");
    expect(overlay).toContain("t('map.load_retry')");
    expect(overlay).toContain("<LoadingScreen label={t('map.loading')} />");
  });
});

describe('index.html branded boot frame', () => {
  const html = read('index.html');
  const loader = read('components/LoadingScreen.tsx');

  it('paints the same logo loader as <LoadingScreen /> before the bundle runs', () => {
    const boot = html.match(/<div id="root">([\s\S]*?)<\/div><\/div>/)?.[1] ?? '';
    expect(boot).toContain('class="pq-loading-screen"');
    // Marker the e2e smoke test uses to prove React replaced the boot frame.
    expect(boot).toContain('data-pq-boot');
    expect(boot).toContain('role="status"');
    expect(boot).toContain('aria-label="Loading ParQueen"');
    // Same source file as the component import, so Vite emits one hashed URL
    // and React's first frame reuses the already-decoded image.
    expect(boot).toContain('src="/assets/Parqueen_Logo.png"');
    expect(loader).toContain("import ParQueenLogo from '../assets/Parqueen_Logo.png'");
    // Same box as the React logo (818x669 asset at 160 px wide), so nothing shifts on decode.
    expect(boot).toContain('width="160" height="131"');
    expect(loader).toContain('const LOGO_ASPECT = 669 / 818;');
    expect(loader).toContain('<BrandedLogoMark size={160} />');
    expect(boot).toContain('pq-brand-pulse');
    expect(loader).toContain("const DEFAULT_LABEL = 'Loading ParQueen'");
  });

  it('applies the saved theme with a same-origin classic script before the app bundle', () => {
    const themeTag = html.indexOf('<script src="/theme-boot.js"></script>');
    const appTag = html.indexOf('<script type="module" src="/index.tsx">');
    expect(themeTag).toBeGreaterThan(-1);
    expect(appTag).toBeGreaterThan(themeTag);
    expect(html.slice(0, html.indexOf('</head>'))).toContain('/theme-boot.js');
  });

  it('only animates the branded pulse when the user allows motion', () => {
    const css = read('index.css');
    const rule = /@media \(prefers-reduced-motion: no-preference\) \{\s*\.pq-brand-pulse \{ animation: pq-brand-pulse 2s /;
    expect(css).toMatch(rule);
    // Outside that media query the class carries no animation at all.
    const withoutGuarded = css.replace(rule, '');
    expect(withoutGuarded).not.toMatch(/\.pq-brand-pulse\s*\{[^}]*animation/);
    expect(loader).toContain('const PULSE_PERIOD_MS = 2000;');
  });
});

describe('public/theme-boot.js', () => {
  const script = read('public/theme-boot.js');

  // A tiny fake of the DOM/timer surface the script touches.
  const boot = ({
    path = '/',
    theme = null as string | null,
    lang = null as string | null,
    storageThrows = false,
    reactMounted = false,
  } = {}) => {
    const classes = new Set<string>();
    const timers: Array<() => void> = [];
    let timeoutMs = 0;
    const errorListeners: Array<(event: unknown) => void> = [];
    let reloads = 0;
    type FakeEl = { tag: string; className: string; textContent: string; type?: string;
      attrs: Record<string, string>; children: FakeEl[]; listeners: Record<string, () => void>;
      setAttribute(k: string, v: string): void; appendChild(c: FakeEl): void;
      addEventListener(t: string, fn: () => void): void };
    const el = (tag: string): FakeEl => ({
      tag, className: '', textContent: '', attrs: {}, children: [], listeners: {},
      setAttribute(k, v) { this.attrs[k] = v; },
      appendChild(c) { this.children.push(c); },
      addEventListener(t, fn) { this.listeners[t] = fn; },
    });
    const root = { child: reactMounted ? 'react-ui' as unknown : 'boot-frame' as unknown };
    const bootFrame = { parentNode: { replaceChild: (next: unknown) => { root.child = next; } } };
    runInNewContext(script, {
      window: {
        location: { pathname: path, reload: () => { reloads += 1; } },
        localStorage: {
          getItem: (key: string) => {
            if (storageThrows) throw new Error('blocked');
            return key === 'theme' ? theme : key === 'parqueen_lang' ? lang : null;
          },
        },
        addEventListener: (type: string, fn: (event: unknown) => void, capture: boolean) => {
          if (type === 'error' && capture) errorListeners.push(fn);
        },
        setTimeout: (fn: () => void, ms: number) => { timers.push(fn); timeoutMs = ms; },
      },
      document: {
        documentElement: { classList: { add: (c: string) => classes.add(c) } },
        createElement: el,
        querySelector: (selector: string) =>
          selector === '#root > [data-pq-boot]' && root.child === 'boot-frame' ? bootFrame : null,
      },
    });
    return {
      dark: classes.has('dark'),
      timeoutMs,
      fireTimeout: () => timers.forEach(fn => fn()),
      fireError: (tagName: string) => errorListeners.forEach(fn => fn({ target: { tagName } })),
      recovery: () => (typeof root.child === 'object' ? root.child as FakeEl : null),
      reloads: () => reloads,
    };
  };

  it("mirrors App.tsx: dark unless the user saved 'light'", () => {
    expect(read('App.tsx')).toContain("return localStorage.getItem('theme') || 'dark';");
    expect(boot().dark).toBe(true);
    expect(boot({ theme: 'dark' }).dark).toBe(true);
    expect(boot({ theme: 'light' }).dark).toBe(false);
    expect(boot({ storageThrows: true }).dark).toBe(true);
  });

  it('leaves public legal pages light, exactly as before (they never mount App)', () => {
    const legalRoutes = read('utils/legalRoutes.ts');
    const routeKeys = [...legalRoutes.matchAll(/^\s+'(\/[a-z-]+)': \{ document:/gm)].map(m => m[1]).sort();
    const listed = JSON.parse(
      (script.match(/publicLegalPaths = (\[[^\]]*\])/)?.[1] ?? '[]').replace(/'/g, '"'),
    ).sort();
    expect(routeKeys.length).toBeGreaterThan(0);
    expect(listed).toEqual(routeKeys);
    for (const path of routeKeys) {
      expect(boot({ path }).dark).toBe(false);
      expect(boot({ path: `${path}/` }).dark).toBe(false);
    }
  });

  it('never leaves users behind the logo: a stalled boot becomes the startup recovery', () => {
    const run = boot();
    expect(run.timeoutMs).toBe(15000);
    expect(run.recovery()).toBeNull();
    run.fireTimeout();
    const panel = run.recovery()!;
    expect(panel.attrs.role).toBe('alert');
    expect(panel.children.map(c => c.textContent)).toEqual([
      'ParQueen couldn’t finish starting.',
      'Check your connection and try again.',
      'Try Again',
    ]);
    panel.children[2].listeners.click();
    expect(run.reloads()).toBe(1);
  });

  it('shows the recovery at once when the app bundle fails to load, but ignores image errors', () => {
    const run = boot();
    run.fireError('IMG');
    expect(run.recovery()).toBeNull();
    run.fireError('SCRIPT');
    expect(run.recovery()?.attrs.role).toBe('alert');
  });

  it('does nothing once React has replaced the boot frame', () => {
    const run = boot({ reactMounted: true });
    run.fireTimeout();
    run.fireError('SCRIPT');
    expect(run.recovery()).toBeNull();
  });

  it('uses the saved language and the same copy and classes as AuthStartupRecovery', () => {
    const es = boot({ lang: 'es' });
    es.fireTimeout();
    expect(es.recovery()!.children.map(c => c.textContent)).toEqual([
      'ParQueen no pudo terminar de iniciarse.',
      'Revisa tu conexión e inténtalo de nuevo.',
      'Intentar de nuevo',
    ]);
    const en = read('i18n/en.ts');
    const esDict = read('i18n/es.ts');
    expect(en).toContain("'startup.auth_timeout_title': 'ParQueen couldn’t finish starting.'");
    expect(esDict).toContain("'startup.auth_timeout_body': 'Revisa tu conexión e inténtalo de nuevo.'");
    // Tailwind does not scan public/, so every class must also appear in source it does scan.
    const recovery = read('components/AuthStartupRecovery.tsx');
    const panel = boot();
    panel.fireTimeout();
    const node = panel.recovery()!;
    for (const className of [node.className, ...node.children.map(c => c.className)]) {
      expect(recovery).toContain(className);
    }
  });
});

describe('native launch screen (Android)', () => {
  const res = 'android/app/src/main/res';
  const styles = read(`${res}/values/styles.xml`);
  const darkBg = read('index.css').match(/\.dark \{[^}]*--color-bg:\s*(#[0-9a-fA-F]{6})/)?.[1]?.toLowerCase();

  it('shows the ParQueen logo on the app background via AndroidX core-splashscreen, not the Capacitor placeholder', () => {
    const launch = styles.match(/<style name="AppTheme\.NoActionBarLaunch"[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? '';
    expect(launch).toContain('<item name="windowSplashScreenAnimatedIcon">@drawable/pq_splash_logo</item>');
    expect(launch).toContain('<item name="windowSplashScreenBackground">@color/pq_launch_background</item>');
    expect(launch).toContain('<item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>');
    expect(launch).not.toContain('@drawable/splash');
    expect(statSync(join(ROOT, `${res}/drawable-nodpi/pq_splash_logo.png`)).size).toBeGreaterThan(1000);
    for (const dir of readdirSync(join(ROOT, res))) {
      expect(readdirSync(join(ROOT, res, dir)), `${dir} still ships Capacitor's placeholder splash.png`).not.toContain('splash.png');
    }
  });

  it('uses the dark app background everywhere before the first web frame', () => {
    expect(darkBg).toBe('#050d1c');
    expect(read(`${res}/values/pq_launch.xml`).toLowerCase()).toContain(`<color name="pq_launch_background">${darkBg}</color>`);
    const app = styles.match(/<style name="AppTheme\.NoActionBar"[^>]*>([\s\S]*?)<\/style>/)?.[1] ?? '';
    expect(app).toContain('<item name="android:windowBackground">@color/pq_launch_background</item>');
    const capacitor = read('capacitor.config.ts').toLowerCase().replace(/\s+/g, ' ');
    expect(capacitor).toContain(`android: { backgroundcolor: '${darkBg}', }`);
  });
});
