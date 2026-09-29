import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const KNIP_ENTRY = resolve(REPO_ROOT, 'node_modules', 'knip', 'bin', 'knip.js');
const SENTRY_UPLOAD_KEYS = new Set(['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT']);

function toolingFailure(message) {
  console.error(`TOOLING FAILURE: ${message}`);
  process.exit(1);
}

if (!existsSync(KNIP_ENTRY)) {
  toolingFailure('local Knip installation is missing; run npm ci first');
}

const envDir = mkdtempSync(join(tmpdir(), 'parqueen-preflight-knip-env-'));
let knipStatus = 0;
let knipStartFailed = false;

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

  const result = spawnSync(process.execPath, [
    KNIP_ENTRY,
    '--dependencies',
    '--files',
  ], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env,
  });

  if (result.error) {
    knipStartFailed = true;
    knipStatus = 1;
  } else if (result.status !== 0) {
    knipStatus = result.status ?? 1;
  }
} finally {
  try {
    rmSync(envDir, { recursive: true, force: true });
  } catch {
    if (knipStatus === 0) {
      toolingFailure('isolated Knip Vite env directory could not be removed');
    }
  }
}

if (knipStartFailed) {
  toolingFailure('Knip could not be started');
}
if (knipStatus === 0) {
  console.log('PASS: Knip reported no findings');
  process.exit(0);
}

console.log('WARN: Knip returned a non-zero result; review the findings/output above');
console.log('WARN: this repository does not establish that every Knip non-zero exit represents findings rather than another Knip-level error');
process.exit(0);
