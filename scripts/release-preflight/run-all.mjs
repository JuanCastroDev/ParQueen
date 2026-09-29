import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SHA_PATTERN = /^[0-9a-f]{4,40}$/i;
const FULL_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const REPO = 'JuanCastroDev/ParQueen';

const GIT_IDENTITY = resolve(REPO_ROOT, 'scripts', 'release-preflight', 'check-git-identity.mjs');
const FUNCTIONS_WRAPPER = resolve(REPO_ROOT, 'scripts', 'release-preflight', 'run-functions-integration.mjs');
const ROOT_TESTS = resolve(REPO_ROOT, 'scripts', 'release-preflight', 'run-root-tests.mjs');
const KNIP_WRAPPER = resolve(REPO_ROOT, 'scripts', 'release-preflight', 'run-knip.mjs');
const TSC_ENTRY = resolve(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

const results = [];

function record(stage, classification) {
  results.push({ stage, classification });
}

function printSummary() {
  console.log('');
  console.log('Release preflight summary');
  for (const row of results) {
    console.log(`${row.classification}: ${row.stage}`);
  }
}

function stop(code) {
  printSummary();
  process.exit(code);
}

function block(stage, message) {
  record(stage, 'BLOCKED');
  console.error(`BLOCKED: ${message}`);
  stop(1);
}

function toolingFailure(stage, message) {
  record(stage, 'TOOLING FAILURE');
  console.error(`TOOLING FAILURE: ${message}`);
  stop(1);
}

function readExpectedSha(argv) {
  const index = argv.indexOf('--expected-sha');
  if (index === -1 || index === argv.length - 1) {
    console.error('BLOCKED: --expected-sha is required. Usage: node scripts/release-preflight/run-all.mjs --expected-sha <sha>');
    process.exit(1);
  }
  const sha = argv[index + 1];
  if (!SHA_PATTERN.test(sha)) {
    console.error('BLOCKED: --expected-sha must be a hexadecimal commit id');
    process.exit(1);
  }
  let resolved;
  try {
    resolved = execFileSync('git', [
      'rev-parse',
      '--verify',
      '--end-of-options',
      `${sha}^{commit}`,
    ], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    console.error('BLOCKED: --expected-sha does not resolve to a commit');
    process.exit(1);
  }
  if (!FULL_SHA_PATTERN.test(resolved)) {
    console.error('BLOCKED: --expected-sha does not resolve to a commit');
    process.exit(1);
  }
  return resolved;
}

function requireNpmExecPath() {
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath || !existsSync(npmExecPath)) {
    console.error('BLOCKED: npm CLI path is unavailable; run this orchestrator through the npm script');
    process.exit(1);
  }
  return npmExecPath;
}

function runNode(script, args = []) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: process.env,
  });
}

function runNpm(npmExecPath, args) {
  return spawnSync(process.execPath, [npmExecPath, ...args], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: process.env,
  });
}

function requireZero(stage, result, failureMessage) {
  if (result.error) {
    toolingFailure(stage, failureMessage);
  }
  if (result.status !== 0) {
    block(stage, failureMessage);
  }
  record(stage, 'PASS');
}

function findGhExe() {
  let listed;
  try {
    listed = execFileSync('where.exe', ['gh'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  return listed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.toLowerCase().endsWith('gh.exe')) || null;
}

function listWorkflowRuns(ghExe, workflowName, expectedSha) {
  const result = spawnSync(ghExe, [
    'run', 'list',
    '--repo', REPO,
    '--workflow', workflowName,
    '--commit', expectedSha,
    '--limit', '50',
    '--json', 'headSha,status,conclusion,workflowName',
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: process.env,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  if (result.error || result.status !== 0) {
    return null;
  }
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function hasExactSuccess(runs, workflowName, expectedSha) {
  return runs.some((run) =>
    run.workflowName === workflowName
    && run.headSha === expectedSha
    && run.status === 'completed'
    && run.conclusion === 'success');
}

function reportStaticStages() {
  record('ast-grep', 'MANUAL');
  console.log('MANUAL: ast-grep — repo has CLI/script but no deterministic repository rules.');
  record('Maestro', 'MANUAL');
  console.log('MANUAL: Maestro — seven flows exist but no repo-backed runner/CI/device contract.');
  record('Android native', 'EXCLUDED');
  console.log('EXCLUDED: Android native — native project exists, but generic Windows preflight has no formalized debug Gradle gate and release signing is external.');
  record('iOS native', 'EXCLUDED');
  console.log('EXCLUDED: iOS native — Xcode build cannot run on Windows.');
  record('OSV', 'EXCLUDED');
  record('Semgrep', 'EXCLUDED');
  record('Trivy', 'EXCLUDED');
  console.log('EXCLUDED: OSV, Semgrep, and Trivy — no repository-backed dependency, config, script, or workflow.');
}

const expectedSha = readExpectedSha(process.argv.slice(2));
const npmExecPath = requireNpmExecPath();

console.log('STAGE: Git identity');
requireZero(
  'Git identity',
  runNode(GIT_IDENTITY, ['--expected-sha', expectedSha]),
  'Git identity gate failed',
);

console.log('STAGE: npm ci root');
requireZero(
  'npm ci root',
  runNpm(npmExecPath, ['ci']),
  'npm ci failed',
);

console.log('STAGE: npm ci functions');
requireZero(
  'npm ci functions',
  runNpm(npmExecPath, ['ci', '--prefix', 'functions']),
  'npm ci --prefix functions failed',
);

console.log('STAGE: TypeScript');
if (!existsSync(TSC_ENTRY)) {
  toolingFailure('TypeScript', 'local TypeScript installation is missing; run npm ci first');
}
requireZero(
  'TypeScript',
  runNode(TSC_ENTRY, ['--noEmit']),
  'TypeScript check failed',
);

console.log('STAGE: Root production audit');
requireZero(
  'Root production audit',
  runNpm(npmExecPath, ['audit', '--omit=dev']),
  'root production audit failed',
);

console.log('STAGE: Functions production audit');
requireZero(
  'Functions production audit',
  runNpm(npmExecPath, ['audit', '--omit=dev', '--prefix', 'functions']),
  'Functions production audit failed',
);

console.log('STAGE: Firestore rules');
requireZero(
  'Firestore rules',
  runNpm(npmExecPath, ['run', 'test:rules']),
  'Firestore rules gate failed',
);

console.log('STAGE: Storage rules');
requireZero(
  'Storage rules',
  runNpm(npmExecPath, ['run', 'test:storage:rules']),
  'Storage rules gate failed',
);

console.log('STAGE: Functions integration');
requireZero(
  'Functions integration',
  runNode(FUNCTIONS_WRAPPER),
  'Functions integration gate failed',
);

console.log('STAGE: Isolated production build and deterministic root tests');
const rootTests = runNode(ROOT_TESTS);
if (rootTests.error) {
  toolingFailure('Isolated production build', 'isolated production build or deterministic root tests could not be started');
}
if (rootTests.status !== 0) {
  record('Deterministic root tests', 'BLOCKED');
  block('Isolated production build', 'isolated production build or deterministic root tests failed');
}
record('Isolated production build', 'PASS');
record('Deterministic root tests', 'PASS');

console.log('STAGE: Knip');
const knip = runNode(KNIP_WRAPPER);
if (knip.error || knip.status !== 0) {
  toolingFailure('Knip', 'Knip preflight signal could not run');
}
record('Knip', 'WARN/PASS signal');

console.log('STAGE: Full dev audit');
const devAudit = runNpm(npmExecPath, ['audit']);
if (devAudit.error) {
  toolingFailure('Full dev audit', 'full dependency audit could not be started');
}
if (devAudit.status === 0) {
  record('Full dev audit', 'PASS');
} else {
  console.log('WARN: full dependency audit returned non-zero; production audits already passed');
  record('Full dev audit', 'WARN');
}

reportStaticStages();

console.log('STAGE: Secret scan and PR Gate');
const ghExe = findGhExe();
if (!ghExe) {
  block('Secret scan', 'GitHub remote evidence could not be verified');
}

const secretRuns = listWorkflowRuns(ghExe, 'Secret scan', expectedSha);
if (!secretRuns) {
  block('Secret scan', 'GitHub remote evidence could not be verified');
}
if (!hasExactSuccess(secretRuns, 'Secret scan', expectedSha)) {
  block('Secret scan', `successful Secret scan evidence is missing for exact SHA ${expectedSha}`);
}
record('Secret scan', 'PASS');

const gateRuns = listWorkflowRuns(ghExe, 'PR Gate', expectedSha);
if (!gateRuns) {
  block('PR Gate', 'GitHub remote evidence could not be verified');
}
if (!hasExactSuccess(gateRuns, 'PR Gate', expectedSha)) {
  block('PR Gate', `successful PR Gate evidence is missing for exact SHA ${expectedSha}`);
}
record('PR Gate', 'PASS');

stop(0);
