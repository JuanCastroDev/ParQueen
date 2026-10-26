// Changed-file guard for private 26C provenance.
//
// The general PR suite may omit only
// functions/curbIntelligence/provenanceAndConflict.test.cjs.
// Provenance-critical implementation, source admission, runtime artifacts,
// outcome indexes, release authority, and the files that define this policy
// fail closed. GitHub Actions cannot execute the genuine successor, so this
// guard must not report a successful private check.
//
// If the changed-file set cannot be determined, the result is fail closed.
// This CI test-scope policy requires independent Security/QA acceptance
// before merge.

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const PRIVATE_SUITE = 'functions/curbIntelligence/provenanceAndConflict.test.cjs';

const POLICY_FILES = new Set([
  'scripts/ci/general-pr-suite.mjs',
  'scripts/ci/private-provenance-suite.mjs',
  'scripts/ci/provenance-change-guard.mjs',
  '.github/workflows/pr-gate.yml',
  '.github/workflows/unit-tests.yml',
  '.github/workflows/provenance-change-guard.yml',
]);

const INDEX_WIRING = /runtimeSourceArtifact|attachOwnerPilot|localRuntimeDependencies|productionAuthoritative|certificationStatus|releaseCertification|successorRelease|ownerApproval|PINNED_ARTIFACT/;

function normalize(file) {
  return file.replace(/\\/g, '/').replace(/^\.\//, '');
}

function isPortableCurbTest(file) {
  if (file === PRIVATE_SUITE) return false;
  if (file.startsWith('functions/curbIntelligence/fixtures/')) return true;
  return /^functions\/curbIntelligence\/.*\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
}

export function decisionForPath(file, patchText) {
  const path = normalize(file);
  if (!path || path.includes('\0')) return 'undetermined';
  if (POLICY_FILES.has(path) || path.startsWith('scripts/ci/')) return 'critical';
  if (path === PRIVATE_SUITE) return 'critical';
  if (path.startsWith('data/runtime-source/')) return 'critical';
  if (path.startsWith('functions/curbIntelligence/') && !isPortableCurbTest(path)) return 'critical';
  if (path === 'functions/index.js') {
    if (!patchText) return 'undetermined';
    return INDEX_WIRING.test(patchText) ? 'critical' : 'clear';
  }
  return 'clear';
}

function failClosed(reason, paths = []) {
  console.error('PROVENANCE_GUARD: FAIL_CLOSED');
  console.error(reason);
  for (const path of paths) console.error(`CRITICAL ${path}`);
  console.error('PRIVATE_PROVENANCE_VERIFICATION_REQUIRED');
  console.error('GitHub Actions has no genuine 26C successor. No private check was recorded.');
  console.error('CI test-scope policy requires independent Security/QA acceptance before merge.');
  process.exit(1);
}

function pass(files) {
  console.log('PROVENANCE_GUARD: PASS');
  console.log('No provenance-critical path changed.');
  console.log(`GENERAL_PR_SUITE_EXCLUSION: ${PRIVATE_SUITE}`);
  console.log('Private 26C evidence is not required for this diff.');
  console.log(`Changed files: ${files.length}`);
  process.exit(0);
}

function git(args) {
  return spawnSync('git', args, { encoding: 'utf8' });
}

function changedPathsFromDiff(base, head) {
  for (const sha of [base, head]) {
    if (!/^[0-9a-f]{40}$/i.test(sha)) return { error: 'base or head is not a full commit SHA' };
    const present = git(['cat-file', '-e', `${sha}^{commit}`]);
    if (present.status !== 0) {
      const pull = process.env.PR_NUMBER;
      if (!pull || !/^[0-9]+$/.test(pull)) return { error: 'changed commits are not available' };
      const fetched = git(['fetch', '--no-tags', 'origin', `pull/${pull}/head`]);
      if (fetched.status !== 0) return { error: 'the pull request head could not be fetched' };
      const again = git(['cat-file', '-e', `${sha}^{commit}`]);
      if (again.status !== 0) return { error: 'changed commits are not available after fetch' };
    }
  }
  const names = git(['diff', '--name-status', '--find-renames', `${base}...${head}`]);
  if (names.status !== 0) return { error: 'git diff could not be read' };
  const files = [];
  for (const line of names.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts[0].startsWith('R') || parts[0].startsWith('C')) {
      if (!parts[1] || !parts[2]) return { error: 'a rename could not be classified' };
      files.push(normalize(parts[1]), normalize(parts[2]));
    } else if (parts[1]) {
      files.push(normalize(parts[1]));
    } else {
      return { error: 'a changed path could not be classified' };
    }
  }
  if (files.length === 0) return { error: 'the changed-file set is empty' };
  return { files: [...new Set(files)] };
}

function patchFor(base, head, file) {
  const diff = git(['diff', '--unified=0', `${base}...${head}`, '--', file]);
  if (diff.status !== 0) return null;
  return diff.stdout;
}

function filesFromArgs(argv) {
  const files = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--file') continue;
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) return { error: 'a --file value is missing' };
    files.push(normalize(value));
    i += 1;
  }
  if (files.length === 0) return { error: 'no changed files were provided' };
  return { files };
}

function main() {
  const event = process.env.GITHUB_EVENT_NAME || '';
  if (event === 'workflow_dispatch') {
    failClosed('workflow_dispatch has no pull-request diff');
  }

  const explicit = process.argv.includes('--file');
  let files;
  let base = '';
  let head = '';
  if (explicit) {
    const parsed = filesFromArgs(process.argv.slice(2));
    if (parsed.error) failClosed(parsed.error);
    files = parsed.files;
  } else {
    base = process.env.PR_BASE_SHA || '';
    head = process.env.PR_HEAD_SHA || '';
    if (!base || !head) failClosed('pull request base and head are required');
    const parsed = changedPathsFromDiff(base, head);
    if (parsed.error) failClosed(parsed.error);
    files = parsed.files;
  }

  const critical = [];
  for (const file of files) {
    const patch = file === 'functions/index.js' && base && head ? patchFor(base, head, file) : null;
    const decision = decisionForPath(file, file === 'functions/index.js' ? patch : undefined);
    if (decision === 'undetermined') failClosed(`classification failed for ${file}`, [file]);
    if (decision === 'critical') critical.push(file);
  }
  if (critical.length > 0) {
    failClosed('provenance-critical paths changed without private successor verification', critical);
  }
  pass(files);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
