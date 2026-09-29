import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SHA_PATTERN = /^[0-9a-f]{4,40}$/i;

function fail(message) {
  console.error(`BLOCKED: ${message}`);
  process.exit(1);
}

function git(args) {
  return execFileSync('git', args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function readExpectedSha(argv) {
  const index = argv.indexOf('--expected-sha');
  if (index === -1 || index === argv.length - 1) {
    console.error('BLOCKED: --expected-sha is required. Usage: node scripts/release-preflight/check-git-identity.mjs --expected-sha <sha>');
    process.exit(1);
  }
  return argv[index + 1];
}

function resolveCommit(sha) {
  if (!SHA_PATTERN.test(sha)) {
    fail('expected SHA must be a hexadecimal commit id, not a branch, tag, or symbolic ref');
  }
  try {
    return git(['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`]);
  } catch {
    fail(`expected SHA cannot be resolved to a commit: ${sha}`);
  }
}

const expectedInput = readExpectedSha(process.argv.slice(2));
const expectedSha = resolveCommit(expectedInput);

let status;
try {
  status = git(['status', '--porcelain']);
} catch {
  fail('git status --porcelain failed');
}

if (status.length > 0) {
  console.error('BLOCKED: worktree is dirty');
  console.error(status);
  process.exit(1);
}

let head;
try {
  head = git(['rev-parse', 'HEAD']);
} catch {
  fail('git rev-parse HEAD failed');
}

if (expectedSha !== head) {
  console.error('BLOCKED: HEAD does not match the expected SHA');
  console.error(`HEAD: ${head}`);
  console.error(`Expected SHA: ${expectedSha}`);
  process.exit(1);
}

console.log('PASS: Git identity');
console.log(`HEAD: ${head}`);
console.log('Worktree: clean');
console.log('Expected SHA: matched');
