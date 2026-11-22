// A repeatable local Android debug build that keeps Onboarding 2.0 enabled.
// Does not install onto devices, publish to Firebase, or create a store-release AAB.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID_ROOT = join(ROOT, 'android');

export const ANDROID_DEV_FLAGS = Object.freeze({
  VITE_ONBOARDING_V2: '1',
  // Founder-only previews remain available in a debug build, not an app-store build.
  VITE_OBV2_PREVIEW: '1',
  VITE_OBV2_DIAG: '0',
  VITE_QA_AUTH: 'false',
  VITE_PARQUEEN_APPCHECK_QA: 'false',
  VITE_POSTHOG_ENABLED: 'false',
  // Never accidentally switch the development APK to a demo backend or QA app ID.
  VITE_PARQUEEN_DEMO_FIREBASE: '',
  VITE_PARQUEEN_STREET_INTEL_QA: '',
  PARQUEEN_STREET_INTEL_QA: '',
});

export function androidDevelopmentEnvironment(inherited = process.env) {
  // The existing production build guard also checks these, but reject them
  // before invoking npm to avoid an ambiguous or partially built artifact.
  if (inherited.VITE_POSTHOG_PROJECT_TOKEN?.trim()) {
    throw new Error('Android development build blocked: PostHog project token is set.');
  }
  if (inherited.PARQUEEN_CONFIG_CONTRACT_TEST === '1' || inherited.PARQUEEN_VITE_ENV_DIR) {
    throw new Error('Android development build blocked: test-only Vite environment override is set.');
  }
  return { ...inherited, ...ANDROID_DEV_FLAGS };
}

function requireSuccess(result, stage) {
  if (result.error) {
    console.error(`Android development build blocked: ${stage} could not start.`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== '--sync-only')) {
    throw new Error('Usage: npm run android:dev:apk or npm run android:dev:sync');
  }

  const env = androidDevelopmentEnvironment();

  console.log('Android development build: Onboarding 2.0 ON, founder preview ON, QA auth/diagnostics/PostHog OFF.');
  // Use constant executable/argument arrays rather than passing through a generic
  // command-running wrapper or executable path supplied by the environment.
  if (process.platform === 'win32') {
    requireSuccess(
      spawnSync('cmd.exe', ['/d', '/c', 'npm.cmd', 'run', 'cap:sync:android'], {
        cwd: ROOT, env, stdio: 'inherit',
      }),
      'Capacitor Android sync',
    );
  } else {
    requireSuccess(
      spawnSync('npm', ['run', 'cap:sync:android'], {
        cwd: ROOT, env, stdio: 'inherit',
      }),
      'Capacitor Android sync',
    );
  }

  if (args[0] === '--sync-only') {
    console.log('Android development sync complete. No APK was packaged or installed.');
    return;
  }

  if (process.platform === 'win32') {
    requireSuccess(
      spawnSync('cmd.exe', ['/d', '/c', 'gradlew.bat', ':app:assembleDebug'], {
        cwd: ANDROID_ROOT, env, stdio: 'inherit',
      }),
      'Gradle debug APK',
    );
  } else {
    requireSuccess(
      spawnSync('./gradlew', [':app:assembleDebug'], {
        cwd: ANDROID_ROOT, env, stdio: 'inherit',
      }),
      'Gradle debug APK',
    );
  }

  console.log('Android debug APK assembled. No device installation or publication was performed.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Android development build blocked.');
    process.exitCode = 1;
  }
}
