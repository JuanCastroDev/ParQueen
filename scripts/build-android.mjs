import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const viteEntry = resolve(repoRoot, 'node_modules', 'vite', 'bin', 'vite.js');

if (!existsSync(viteEntry)) {
  console.error('BLOCKED: local Vite installation is missing; run npm ci first');
  process.exit(1);
}

const result = spawnSync(process.execPath, [viteEntry, 'build', ...process.argv.slice(2)], {
  cwd: repoRoot,
  env: { ...process.env, PARQUEEN_ANDROID_BUILD: '1' },
  stdio: 'inherit',
});

if (result.error) {
  console.error('BLOCKED: Android web-asset build could not be started');
  process.exit(1);
}

process.exit(result.status ?? 1);
