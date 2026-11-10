import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const config = resolve(root, 'firebase.late-commit-emulator.json');
if (!existsSync(config)) {
  console.error('missing isolated emulator config');
  process.exit(1);
}

const env = {
  ...process.env,
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:18210',
  PARQUEEN_LATE_COMMIT_EMULATOR: '1',
};
delete env.GCLOUD_PROJECT;

const command = `npx firebase emulators:exec --only firestore --project demo-parkqueen-late-commit --config "${config}" "npx vitest run functions/canonicalCurbLateCommit.emulator.test.js"`;
const result = spawnSync(command, { cwd: root, env, stdio: 'inherit', shell: true });
process.exit(result.status ?? 1);