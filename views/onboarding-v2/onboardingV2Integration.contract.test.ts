// Source contracts for the Onboarding 2.0 integration (same style as StreetParkingView.streetIntel.test.tsx).
// They pin the routing, rollback and privacy rules that App.tsx is too large to render in a unit test.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ONBOARDING_V2_ENABLED } from '../../utils/onboardingFlags';

const root = join(__dirname, '..', '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8').replace(/\r\n/g, '\n');
const app = read('App.tsx');
const map = read('views/StreetParkingView.tsx');
const database = read('database.ts');

const between = (source: string, startText: string, endText: string): string => {
  const start = source.indexOf(startText);
  const end = source.indexOf(endText, start + startText.length);
  expect(start, startText).toBeGreaterThan(-1);
  expect(end, endText).toBeGreaterThan(start);
  return source.slice(start, end);
};

describe('rollback flag', () => {
  it('is off unless VITE_ONBOARDING_V2=1 is set at build time (legacy onboarding by default)', () => {
    expect(import.meta.env.VITE_ONBOARDING_V2).not.toBe('1');
    expect(ONBOARDING_V2_ENABLED).toBe(false);
    expect(read('utils/onboardingFlags.ts')).toContain("import.meta.env.VITE_ONBOARDING_V2 === '1'");
  });

  it('keeps the legacy OnboardingView and the vehicle step as the flag-off path', () => {
    const onboardingCase = between(app, 'case AppView.ONBOARDING:', 'case AppView.CREATE_ACCOUNT:');
    expect(onboardingCase).toContain('if (ONBOARDING_V2_ENABLED)');
    expect(onboardingCase).toContain('<OnboardingV2View');
    expect(onboardingCase).toContain('return <OnboardingView');
    const nameComplete = between(app, 'const handleNameComplete', 'const handleSaveProfile');
    expect(nameComplete).toContain("httpsCallable(functions, 'claimUsername')({ username })");
    expect(nameComplete).toMatch(/} else {\s+setVehicleOnboarding\(true\);\s+setCurrentView\(AppView\.EDIT_VEHICLE\);/);
  });

  it('loads Onboarding 2.0 lazily so the map engine and story stay out of the first-paint bundle', () => {
    expect(app).toContain("const OnboardingV2View = lazy(() => import('./views/onboarding-v2/OnboardingV2View')");
    expect(app).not.toMatch(/import \{ OnboardingV2View \}/);
    const view = read('views/onboarding-v2/OnboardingV2View.tsx');
    expect(view).not.toMatch(/mapbox|leaflet|StreetParkingView|firebase/);
  });
});

describe('signup with Onboarding 2.0', () => {
  it('skips the mandatory vehicle step and keeps username ownership on the server', () => {
    const nameComplete = between(app, 'const handleNameComplete', 'const handleSaveProfile');
    const v2 = between(nameComplete, 'if (ONBOARDING_V2_ENABLED) {', '} else {');
    expect(v2).toContain('shouldShowPrimer(locationAccess) ? AppView.LOCATION_PROMPT : AppView.MAP');
    expect(v2).not.toContain('EDIT_VEHICLE');
    expect(nameComplete.indexOf("'claimUsername'")).toBeLessThan(nameComplete.indexOf('ONBOARDING_V2_ENABLED'));
  });

  it('a chosen intention is saved locally then routes to the existing phone sign-up', () => {
    const v2 = between(app, 'return <OnboardingV2View', '/>;');
    expect(v2).toContain("initialState={onboardingReturn === 'choose' ? 'choose' : 'welcome'}");
    expect(v2).toContain('savePendingIntent(intent)');
    expect(v2).toContain("localStorage.setItem('hasSeenOnboarding', '1')");
    expect(v2).toContain('setCurrentView(AppView.CREATE_ACCOUNT)');
    const account = between(v2, 'onAccount={() => {', '}}');
    expect(account).toContain('clearPendingIntent()');
  });

  it('Create account offers Back to the choices only when it was reached from them', () => {
    const create = between(app, 'case AppView.CREATE_ACCOUNT:', 'case AppView.VERIFY_PHONE:');
    expect(create).toContain("onBack={ONBOARDING_V2_ENABLED && onboardingReturn === 'choose' ? () => setCurrentView(AppView.ONBOARDING) : undefined}");
    expect(app).toContain("returnToOnboarding: ONBOARDING_V2_ENABLED && state.onboardingReturn === 'choose'");
  });
});

describe('intention consumption on the map', () => {
  it('binds to the signed-in account and is taken only on MAP, after deep links', () => {
    const effects = between(app, '// Onboarding 2.0 intention: local navigation context only', 'const queue = createNotificationIntentQueue(');
    expect(effects).toContain('bindPendingIntent(uid)');
    expect(effects).toContain("if (!uid || currentView !== AppView.MAP) return;");
    expect(effects).toMatch(/if \(pendingSpotId \|\| pendingMyCarOpen\) \{\s+clearPendingIntent\(\);/);
    expect(effects).toContain('takePendingIntent(uid)');
    expect(effects).toContain('setMapOnboardingIntent(null)');
  });

  it('a valid actionable notification clears the intention; a generic one does not', () => {
    const ping = between(app, 'openPing: spotId => {', 'openMyCar:');
    expect(ping).toContain('clearPendingIntent()');
    expect(ping).toContain('setMapOnboardingIntent(null)');
    const car = between(app, 'openMyCar: () => {', 'openNotifications:');
    expect(car).toContain('clearPendingIntent()');
    const generic = between(app, 'openNotifications: () => {', '});');
    expect(generic).not.toContain('clearPendingIntent');
  });

  it('the map receives the intention only with no pending deep link', () => {
    expect(app).toContain('onboardingIntent={ONBOARDING_V2_ENABLED && !pendingSpotId && !pendingMyCarOpen ? mapOnboardingIntent : null}');
    expect(app).toContain('suppressAutoTour={ONBOARDING_V2_ENABLED}');
  });

  it("'leave' opens the existing Ping composer through the primary action and never publishes", () => {
    const effect = between(map, 'if (!onboardingIntent || !mapReady || !user?.id) return;', 'onOnboardingIntentHandled?.();');
    expect(effect).toContain("if (onboardingIntent === 'leave') handlePrimaryMapAction();");
    expect(effect).toContain("else if (onboardingIntent === 'explore') setExploreChipVisible(true);");
    expect(effect).toContain('if (selectedItem || stackGroup || isSpotModalOpen) return;');
    expect(effect).not.toMatch(/addDoc|setDoc|updateDoc|httpsCallable|publish|createSpot|reportSpot/i);
    const primary = between(map, 'const handlePrimaryMapAction = () => {', '// Replaces the floating');
    expect(primary).toContain('setSpotModalOpen(true)');
    expect(primary).not.toMatch(/addDoc|setDoc|httpsCallable/);
  });

  it("'explore' only offers the tour; the first-run tour no longer starts by itself", () => {
    const chip = between(map, '{exploreChipVisible && !showTour && !vehicleHintVisible && mapPrimaryNavigationVisible && (', '{showTour && <AppTour');
    expect(chip).toContain('setShowTour(true)');
    expect(chip).toContain("t('map.explore_chip_dismiss')");
    expect(map).toMatch(/if \(suppressAutoTour\) return;/);
  });
});

describe('D22 vehicle-details suggestion', () => {
  it('reads the counter from the server before publishing, only for new Pings under the flag', () => {
    const save = between(map, 'const handleSaveSpot = async', 'const onSaveError');
    expect(save).toContain('const isNewPublication = !selectedItem;');
    expect(save).toContain("getDocFromServer(doc(db, 'users', user.id))");
    expect(save.indexOf('getDocFromServer')).toBeLessThan(save.indexOf('const onSaveSuccess'));
    expect(save).toContain('.catch(() => null)');
  });

  it('shows only from the success path and never blocks or alters the Ping', () => {
    const successAll = between(map, 'const onSaveSuccess = () => {', 'const onSaveError');
    expect(successAll).toContain('if (ONBOARDING_V2_ENABLED && isNewPublication)');
    const success = between(successAll, 'if (ONBOARDING_V2_ENABLED && isNewPublication)', '};');
    expect(success).toContain('markVehicleHintShown()');
    expect(success).not.toMatch(/await|setDoc|updateDoc|commitPingCreate/);
    const card = between(map, '{vehicleHintVisible && mapPrimaryNavigationVisible && (', '{exploreChipVisible');
    expect(card).toContain('role="status"');
    expect(card).toContain('setView(AppView.EDIT_VEHICLE)');
    expect(card).toContain("t('map.vehicle_hint_dismiss')");
  });
});

describe('founder S20 QA fixes (welcome dots, transition, lower composition)', () => {
  const css = read('views/onboarding-v2/onboardingV2.css');
  const view = read('views/onboarding-v2/OnboardingV2View.tsx');
  const welcome = read('views/onboarding-v2/WelcomeScreen.tsx');
  const scene = read('views/onboarding-v2/NeighborhoodScene.tsx');

  it('the welcome has no leftover carousel progress dots', () => {
    expect(welcome).not.toContain('h-[8px] w-8'); expect(welcome).not.toContain('[0, 1, 2].map');
    expect(welcome).toContain('obv2-get-started');
    expect(welcome).toContain('obv2-welcome-account');
  });

  it('under the welcome the street already shows its first story frame, so nothing pops in after the dissolve', () => {
    expect(css).toContain('.pq-obv2.from-welcome .p-arrive, .pq-obv2.from-welcome .brand-hero { display: none; }');
    expect(css).not.toContain('.pq-obv2.from-welcome .p-arrive, .pq-obv2.from-welcome .brand-hero { visibility: hidden; }');
    expect(css).toContain('.pq-obv2.from-welcome .brand-mini { visibility: visible; opacity: 1; transition: none; }');
    expect(css).toContain('.pq-obv2.from-welcome.s-arrive .scrim-top');
    expect(css).toContain('.obv2-welcome.leaving > * { opacity: 0 !important; animation: none !important;');
    expect(view).toContain("const overlayState: StoryState = welcome !== 'hidden' ? 'demo' : state;");
    expect(view).toContain("hidden={state === 'arrive' && welcome === 'hidden'}");
  });

  it('the street continues below its frame (same camera, nothing stretched) and the scrim covers the real art edge', () => {
    expect(scene).toContain("import envForeSvg from '../../assets/onboarding-v2/env-fore.svg';");
    expect(css).toContain('.pq-obv2 .art > .layer-fore { top: 600px; bottom: auto; height: 300px; }');
    const layout = read('views/onboarding-v2/onboardingV2Layout.ts');
    expect(layout).toContain('export const ART_BOTTOM = SCENE_HEIGHT + 300;');
    const fore = read('assets/onboarding-v2/env-fore.svg');
    expect(fore.startsWith('<svg')).toBe(true); expect(fore).toContain('viewBox="0 600 390 300"');
  });

  it('the caption block keeps the longest caption height, so nothing jumps when captions change', () => {
    expect(css).toContain('.pq-obv2 > .p-demo .caption { min-height: max(calc(62px * var(--ts, 1)), var(--cap-h, 0px)); }');
    expect(view).toContain("'--cap-h'");
  });
});

describe('sign-out and deletion', () => {
  it('logout clears the intention with all account state, keeping only device preferences', () => {
    const logout = between(database, 'export const logoutUser', 'await signOut(auth);');
    expect(logout).toContain('localStorage.clear()');
    expect(logout).toContain("ONBOARDING_V2_ENABLED ? localStorage.getItem('parqueen_lang') : null");
    expect(logout).toContain("ONBOARDING_V2_ENABLED ? localStorage.getItem('hasSeenOnboarding') : null");
    expect(logout).not.toContain('parqueen_onboarding_intent');
  });

  it('account deletion keeps only theme and language, so the intention is removed', () => {
    const clear = between(app, 'const clearLocalAccountState = () => {', '};');
    expect(clear).toContain('localStorage.clear()');
    expect(clear).not.toContain('onboarding_intent');
  });
});
