import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ANDROID_DEV_FLAGS, androidDevelopmentEnvironment } from './android-development-build.mjs';

describe('Android Onboarding 2.0 development build', () => {
  it('forces the new real onboarding, enables founder previews, and keeps QA/analytics off', () => {
    const inherited = {
      VITE_ONBOARDING_V2: '0',
      VITE_OBV2_PREVIEW: '0',
      VITE_OBV2_DIAG: '1',
      VITE_QA_AUTH: 'true',
      VITE_PARQUEEN_APPCHECK_QA: 'true',
      VITE_POSTHOG_ENABLED: 'true',
      VITE_PARQUEEN_DEMO_FIREBASE: 'local',
      VITE_PARQUEEN_STREET_INTEL_QA: 'app.parqueen.qa',
      PARQUEEN_STREET_INTEL_QA: 'app.parqueen.qa',
      VITE_MAPBOX_TOKEN: 'preserved-web-mapbox-token',
      VITE_MAPBOX_ANDROID_TOKEN: 'preserved-android-mapbox-token',
    };
    const prepared = androidDevelopmentEnvironment(inherited);
    expect(prepared).toEqual(expect.objectContaining(ANDROID_DEV_FLAGS));
    expect(prepared.VITE_MAPBOX_TOKEN).toBe(inherited.VITE_MAPBOX_TOKEN);
    expect(prepared.VITE_MAPBOX_ANDROID_TOKEN).toBe(inherited.VITE_MAPBOX_ANDROID_TOKEN);
    expect(inherited.VITE_ONBOARDING_V2).toBe('0'); // no mutation of the caller
  });

  it('fails closed if a PostHog release token was inherited', () => {
    expect(() => androidDevelopmentEnvironment({ VITE_POSTHOG_PROJECT_TOKEN: 'not-an-actual-token' }))
      .toThrow('PostHog project token is set');
  });

  it('rejects test-only Vite environment overrides', () => {
    expect(() => androidDevelopmentEnvironment({ PARQUEEN_CONFIG_CONTRACT_TEST: '1' }))
      .toThrow('test-only Vite environment override');
    expect(() => androidDevelopmentEnvironment({ PARQUEEN_VITE_ENV_DIR: 'fixture-env' }))
      .toThrow('test-only Vite environment override');
  });

  it('invokes only fixed build commands without an indirect command wrapper', () => {
    const runner = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'android-development-build.mjs'), 'utf8');
    expect(runner).toContain("spawnSync('cmd.exe', ['/d', '/c', 'npm.cmd', 'run', 'cap:sync:android']");
    expect(runner).toContain("spawnSync('npm', ['run', 'cap:sync:android']");
    expect(runner).toContain("spawnSync('cmd.exe', ['/d', '/c', 'gradlew.bat', ':app:assembleDebug']");
    expect(runner).toContain("spawnSync('./gradlew', [':app:assembleDebug']");
    expect(runner).not.toContain('process.env.ComSpec');
    expect(runner).not.toContain('process.env.npm_execpath');
    expect(runner).not.toContain('shell: true');
    expect(runner).not.toContain('run(command, args');
  });

  it('leaves the existing production and Android sync commands unchanged', () => {
    const pkg = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));
    expect(pkg.scripts['android:dev:sync']).toBe('node scripts/android-development-build.mjs --sync-only');
    expect(pkg.scripts['android:dev:apk']).toBe('node scripts/android-development-build.mjs');
    expect(pkg.scripts['cap:sync:android']).toBe('npm run build:android && npm run verify:posthog:release && npx cap sync android');
    expect(pkg.scripts['build:android']).toBe('node scripts/build-android.mjs');
  });
});
