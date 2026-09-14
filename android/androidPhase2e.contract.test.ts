import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');

const ENFORCED_CALLABLES = [
  'deleteChat',
  'sendMessage',
  'updateDisplayName',
  'adminReadView',
  'checkHydrantDistance',
];

describe('Android Phase 2E App Check contracts', () => {
  it('registers the Application installer and AppCheckBridge plugin before the Capacitor bridge starts', () => {
    const activity = read('./app/src/main/java/app/parqueen/MainActivity.java');
    const manifest = read('./app/src/main/AndroidManifest.xml');
    const application = read('./app/src/main/java/app/parqueen/ParQueenApplication.java');
    expect(manifest).toContain('android:name=".ParQueenApplication"');
    expect(application).toContain('AppCheckProviderInstaller.install(this)');
    expect(application).toContain('super.onCreate()');
    expect(application.indexOf('super.onCreate()'))
      .toBeLessThan(application.indexOf('AppCheckProviderInstaller.install(this)'));
    expect(activity).toContain('registerPlugin(AppCheckBridgePlugin.class)');
    expect(activity.indexOf('registerPlugin(AppCheckBridgePlugin.class)'))
      .toBeLessThan(activity.indexOf('super.onCreate(savedInstanceState)'));
  });

  it('selects DebugAppCheckProviderFactory only when BuildConfig.DEBUG is true', () => {
    const installer = read('./app/src/main/java/app/parqueen/AppCheckProviderInstaller.java');
    expect(installer).toContain('if (BuildConfig.DEBUG)');
    expect(installer).toContain('DebugAppCheckProviderFactory.getInstance()');
    expect(installer).toContain('PlayIntegrityAppCheckProviderFactory.getInstance()');
    const debugIdx = installer.indexOf('DebugAppCheckProviderFactory.getInstance()');
    const releaseIdx = installer.indexOf('PlayIntegrityAppCheckProviderFactory.getInstance()');
    const debugGuardIdx = installer.lastIndexOf('BuildConfig.DEBUG', debugIdx);
    expect(debugGuardIdx).toBeGreaterThan(-1);
    expect(debugGuardIdx).toBeLessThan(debugIdx);
    expect(debugIdx).toBeLessThan(releaseIdx);
    expect(installer).not.toContain('Recaptcha');
    expect(installer).not.toContain('reCAPTCHA');
  });

  it('returns the real AppCheckToken token and expireTimeMillis without inventing TTL', () => {
    const plugin = read('./app/src/main/java/app/parqueen/AppCheckBridgePlugin.java');
    expect(plugin).toContain('FirebaseAppCheck.getInstance()');
    expect(plugin).toContain('getAppCheckToken(false)');
    expect(plugin).toContain('appCheckToken.getToken()');
    expect(plugin).toContain('appCheckToken.getExpireTimeMillis()');
    expect(plugin).toContain('result.put("token", token)');
    expect(plugin).toContain('result.put("expireTimeMillis", appCheckToken.getExpireTimeMillis())');
    expect(plugin).not.toMatch(/3600\s*\*\s*1000/);
    expect(plugin).not.toMatch(/System\.currentTimeMillis\(\)\s*\+/);
  });

  it('installs the native provider in Application.onCreate and plugin load before getToken', () => {
    const plugin = read('./app/src/main/java/app/parqueen/AppCheckBridgePlugin.java');
    const loadIdx = plugin.indexOf('AppCheckProviderInstaller.install(getContext())');
    const getTokenIdx = plugin.indexOf('public void getToken');
    expect(loadIdx).toBeGreaterThan(-1);
    expect(plugin).toContain('public void load()');
    expect(loadIdx).toBeLessThan(getTokenIdx);
  });

  it('never logs token contents from ParQueen App Check code', () => {
    const plugin = read('./app/src/main/java/app/parqueen/AppCheckBridgePlugin.java');
    const installer = read('./app/src/main/java/app/parqueen/AppCheckProviderInstaller.java');
    const js = [
      read(new URL('../utils/appCheck.ts', import.meta.url)),
      read(new URL('../utils/appCheckNative.ts', import.meta.url)),
      read(new URL('../firebaseConfig.ts', import.meta.url)),
    ].join('\n');
    const native = `${plugin}\n${installer}`;
    expect(native).not.toMatch(/Log\.\w+\([^;]*getToken\(\)/);
    expect(native).not.toMatch(/Log\.\w+\([^;]*appCheckToken/);
    expect(native).not.toMatch(/Log\.\w+\([^;]*\.getToken\(\)/);
    expect(native).not.toContain('Enter this debug secret');
    expect(js).not.toMatch(/console\.(log|debug|info|warn|error)\([^)]*token/i);
    expect(js).not.toMatch(/console\.(log|debug|info|warn|error)\([^)]*expireTimeMillis/);
  });

  it('adds App Check through the existing Firebase BoM without pinning a second version', () => {
    const gradle = read('./app/build.gradle');
    expect(gradle).toContain("implementation platform('com.google.firebase:firebase-bom:33.16.0')");
    expect(gradle).toContain("implementation 'com.google.firebase:firebase-appcheck-playintegrity'");
    expect(gradle).toContain("implementation 'com.google.firebase:firebase-appcheck-debug'");
    expect(gradle).not.toMatch(/firebase-appcheck-playintegrity:\d/);
    expect(gradle).not.toMatch(/firebase-appcheck-debug:\d/);
    expect(gradle).toContain('buildConfig = true');
    expect(gradle).not.toMatch(/implementation ['"]com\.google\.firebase:firebase-messaging/);
    const variables = read('./variables.gradle');
    expect(variables).toContain("firebaseMessagingVersion = '25.0.1'");
  });

  it('does not add @capacitor-firebase/app-check or change Android permissions', () => {
    const manifest = read('./app/src/main/AndroidManifest.xml');
    const pkg = read(new URL('../package.json', import.meta.url));
    expect(pkg).not.toContain('@capacitor-firebase/app-check');
    expect(pkg).toMatch(/"firebase":\s*"\^10\.8\.0"/);
    expect(manifest).toContain('android.permission.INTERNET');
    expect(manifest).toContain('android.permission.ACCESS_COARSE_LOCATION');
    expect(manifest).toContain('android.permission.ACCESS_FINE_LOCATION');
    expect(manifest).toContain('android.permission.POST_NOTIFICATIONS');
    expect(manifest).not.toMatch(/uses-permission[^>]*android.permission.CAMERA/);
    expect(manifest).not.toMatch(/uses-permission[^>]*READ_EXTERNAL_STORAGE/);
    expect(manifest).not.toMatch(/uses-permission[^>]*WRITE_EXTERNAL_STORAGE/);
    expect(manifest).not.toMatch(/uses-permission[^>]*READ_MEDIA_IMAGES/);
    expect(manifest).not.toMatch(/uses-permission[^>]*ACCESS_BACKGROUND_LOCATION/);
  });

  it('does not change Cloud Functions App Check enforcement', () => {
    const functions = read(new URL('../functions/index.js', import.meta.url));
    expect(functions.match(/enforceAppCheck:\s*true/g) || []).toHaveLength(5);
    for (const name of ENFORCED_CALLABLES) {
      const start = functions.indexOf(`exports.${name} = onCall(`);
      expect(start, name).toBeGreaterThan(-1);
      expect(functions.slice(start, start + 2500)).toMatch(/enforceAppCheck:\s*true/);
    }
  });
});
