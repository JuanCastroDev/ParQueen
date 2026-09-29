import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const VITE_ENTRY = resolve(REPO_ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
const SENTRY_UPLOAD_KEYS = new Set(['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT']);

function fail(message, code = 1) {
  console.error(`BLOCKED: ${message}`);
  process.exit(code);
}

if (!existsSync(VITE_ENTRY)) {
  fail('local Vite installation is missing; run npm ci first');
}

const envDir = mkdtempSync(join(tmpdir(), 'parqueen-preflight-vite-env-'));
let buildStatus = 0;
let buildStartFailed = false;

try {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (SENTRY_UPLOAD_KEYS.has(key.toUpperCase())) {
      delete env[key];
    }
  }
  env.PARQUEEN_CONFIG_CONTRACT_TEST = '1';
  env.PARQUEEN_VITE_ENV_DIR = envDir;
  env.VITE_MAPBOX_TOKEN = 'pk.configured';

  const result = spawnSync(process.execPath, [VITE_ENTRY, 'build'], {
    cwd: REPO_ROOT,
    env,
    stdio: 'inherit',
  });

  if (result.error) {
    buildStartFailed = true;
    buildStatus = 1;
  } else if (result.status !== 0) {
    buildStatus = result.status ?? 1;
  }
} finally {
  try {
    rmSync(envDir, { recursive: true, force: true });
  } catch {
    if (buildStatus === 0) {
      fail('isolated Vite env directory could not be removed');
    }
  }
}

if (buildStartFailed) {
  fail('production build could not be started');
}
if (buildStatus !== 0) {
  fail('production build failed', buildStatus);
}

console.log('PASS: isolated production build');
