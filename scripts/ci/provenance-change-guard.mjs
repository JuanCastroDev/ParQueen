// Changed-file guard for private 26C provenance.
//
// The general PR suite may omit only
// functions/curbIntelligence/provenanceAndConflict.test.cjs.
// Provenance-critical implementation, source admission, runtime artifacts,
// outcome indexes, release authority, and the files that define this policy
// fail closed. Any change to functions/index.js is critical. A Functions
// implementation file is critical wherever it lives under functions/, including
// a newly named module outside curbIntelligence. Recognized portable tests and
// the public curb fixture directory stay non-critical. Patch keywords are not
// a classification. GitHub Actions cannot execute the genuine successor, so this
// guard must not report a successful private check. A provenance-critical
// diff passes only when founder-signed FOUNDER-EXECUTED evidence verifies
// for this exact commit. That result is SIGNED_FOUNDER_EVIDENCE_ACCEPTED.
// The trust anchor and this script are the copies that are executing, which
// the pull_request_target job takes from the base branch. Evidence is read
// as data from refs/parqueen-provenance/evidence/<head>. A pull request
// cannot supply the trust anchor or replace the verifier that approves it.
//
// If the changed-file set cannot be determined, the result is fail closed.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  EVIDENCE_FILE,
  EVIDENCE_REF_PREFIX,
  RUNNER_PATH,
  SUITE_PATH,
  loadTrustAnchor,
  verifyFounderEvidence,
} from './provenance-evidence.mjs';

export const PRIVATE_SUITE = 'functions/curbIntelligence/provenanceAndConflict.test.cjs';

const POLICY_FILES = new Set([
  'scripts/ci/general-pr-suite.mjs',
  'scripts/ci/private-provenance-suite.mjs',
  'scripts/ci/provenance-change-guard.mjs',
  'scripts/ci/provenance-evidence.mjs',
  'scripts/ci/provenance-trust-anchor.json',
  'scripts/ci/PROVENANCE_FOUNDER_EVIDENCE_BOOTSTRAP.md',
  '.github/workflows/pr-gate.yml',
  '.github/workflows/unit-tests.yml',
  '.github/workflows/provenance-change-guard.yml',
]);

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
const TRUSTED_VERIFIER_FILES = [
  'scripts/ci/provenance-change-guard.mjs',
  'scripts/ci/provenance-evidence.mjs',
  'scripts/ci/provenance-trust-anchor.json',
];

const PORTABLE_FUNCTIONS_TEST = /^functions\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/i;

function normalize(file) {
  return String(file ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

function isPortableFunctionsPath(file) {
  if (file === PRIVATE_SUITE) return false;
  if (file.startsWith('functions/curbIntelligence/fixtures/')) return true;
  return PORTABLE_FUNCTIONS_TEST.test(file);
}

export function decisionForPath(file) {
  const path = normalize(file);
  if (!path || path.includes('\0') || path.includes('"')) return 'undetermined';
  if (POLICY_FILES.has(path) || path.startsWith('scripts/ci/')) return 'critical';
  if (path === PRIVATE_SUITE) return 'critical';
  if (path.startsWith('data/runtime-source/')) return 'critical';
  if (path.toLowerCase().startsWith('functions/')) {
    return isPortableFunctionsPath(path) ? 'clear' : 'critical';
  }
  return 'clear';
}

export function pathsFromNameStatus(text) {
  const files = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0] || '';
    if (status.startsWith('R') || status.startsWith('C')) {
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

function failClosed(reason, paths = []) {
  console.error('PROVENANCE_GUARD: FAIL_CLOSED');
  console.error(reason);
  for (const path of paths) console.error(`CRITICAL ${path}`);
  console.error('PRIVATE_PROVENANCE_VERIFICATION_REQUIRED');
  console.error('GitHub Actions has no genuine 26C successor. No private check was recorded.');
  console.error('Founder-signed FOUNDER-EXECUTED evidence is required before a provenance-critical change can pass.');
  process.exit(1);
}

function acceptFounderEvidence(verdict) {
  console.log('PROVENANCE_GUARD: SIGNED_FOUNDER_EVIDENCE_ACCEPTED');
  console.log('Evidence class: FOUNDER-EXECUTED');
  console.log('GitHub Actions did not execute the private provenance suite.');
  console.log(`head ${verdict.head}`);
  console.log(`evidenceCommit ${verdict.evidenceCommit}`);
  console.log(`attestation ${verdict.attestationId}`);
  process.exit(0);
}

function pass(files) {
  console.log('PROVENANCE_GUARD: PASS');
  console.log('No provenance-critical path changed.');
  console.log(`GENERAL_PR_SUITE_EXCLUSION: ${PRIVATE_SUITE}`);
  console.log('Private 26C evidence is not required for this diff.');
  console.log(`Changed files: ${files.length}`);
  process.exit(0);
}

function gitEnv() {
  return { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
}

function git(args) {
  return spawnSync('git', args, { encoding: 'utf8', env: gitEnv() });
}

function gitBuffer(args) {
  return spawnSync('git', args, { encoding: 'buffer', env: gitEnv() });
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
  return pathsFromNameStatus(names.stdout);
}

function sha256Buffer(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function verifierBindingError(base) {
  const present = TRUSTED_VERIFIER_FILES.map((file) => git(['cat-file', '-e', `${base}:${file}`]).status === 0);
  if (present.every((item) => !item)) return null;
  if (present.some((item) => !item)) return 'trusted verifier set on the base commit is incomplete';
  const running = {
    'scripts/ci/provenance-change-guard.mjs': readFileSync(fileURLToPath(import.meta.url)),
    'scripts/ci/provenance-evidence.mjs': readFileSync(path.join(MODULE_DIR, 'provenance-evidence.mjs')),
    'scripts/ci/provenance-trust-anchor.json': readFileSync(path.join(MODULE_DIR, 'provenance-trust-anchor.json')),
  };
  for (const file of TRUSTED_VERIFIER_FILES) {
    const blob = gitBuffer(['cat-file', 'blob', `${base}:${file}`]);
    if (blob.status !== 0) return 'trusted verifier blob could not be read';
    if (sha256Buffer(running[file]) !== sha256Buffer(blob.stdout)) {
      return 'running verifier does not match the trusted base commit';
    }
  }
  return null;
}

function blobSha256(commit, filePath) {
  const data = gitBuffer(['cat-file', 'blob', `${commit}:${filePath}`]);
  if (data.status !== 0) return { error: `missing blob ${filePath}` };
  return { sha256: sha256Buffer(data.stdout) };
}

function resolveTrustAnchor() {
  const bundled = path.join(MODULE_DIR, 'provenance-trust-anchor.json');
  if (process.env.GITHUB_ACTIONS === 'true') return { path: bundled };
  const override = process.env.PARQUEEN_PROVENANCE_TRUST_ANCHOR;
  if (!override) return { path: bundled };
  const resolved = path.resolve(override);
  const top = git(['rev-parse', '--show-toplevel']);
  if (top.status === 0) {
    const root = path.resolve(top.stdout.trim());
    const relative = path.relative(root, resolved);
    if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
      return { error: 'a pull-request trust anchor was rejected' };
    }
  }
  return { path: resolved };
}

function readEvidenceText(head) {
  if (!/^[0-9a-f]{40}$/.test(head)) return { error: 'malformed' };
  const ref = `${EVIDENCE_REF_PREFIX}${head}`;
  const readCommit = () => {
    const type = git(['cat-file', '-t', ref]);
    if (type.status !== 0) return { missing: true };
    if (type.stdout.trim() !== 'commit') return { error: 'wrong-object' };
    const commit = git(['rev-parse', ref]);
    const tree = git(['rev-parse', `${ref}^{tree}`]);
    if (commit.status !== 0 || tree.status !== 0) return { error: 'malformed' };
    const evidenceCommit = commit.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(evidenceCommit)) return { error: 'malformed' };
    const listing = git(['ls-tree', '-r', tree.stdout.trim()]);
    if (listing.status !== 0) return { error: 'malformed' };
    const lines = listing.stdout.split(/\r?\n/).filter(Boolean);
    if (lines.length !== 1) return { error: 'unexpected-tree' };
    const match = new RegExp(`^100644 blob ([0-9a-f]{40})\\t${EVIDENCE_FILE}$`).exec(lines[0]);
    if (!match) return { error: 'unexpected-tree' };
    const data = gitBuffer(['cat-file', 'blob', match[1]]);
    if (data.status !== 0) return { error: 'malformed' };
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(data.stdout);
    } catch {
      return { error: 'malformed' };
    }
    return { text, evidenceCommit };
  };
  const local = readCommit();
  if (Object.hasOwn(local, 'text') || local.error) return local;
  const fetched = git(['fetch', '--no-tags', 'origin', `${ref}:${ref}`]);
  if (fetched.status !== 0) return { error: 'missing' };
  const after = readCommit();
  if (Object.hasOwn(after, 'text')) return after;
  return { error: after.error || 'missing' };
}

function evaluateFounderEvidence(base, head, critical) {
  const evidence = readEvidenceText(head);
  if (evidence.error === 'missing') return { error: 'founder evidence missing' };
  if (evidence.error) return { error: `founder evidence rejected: ${evidence.error}` };
  const tree = git(['rev-parse', `${head}^{tree}`]);
  if (tree.status !== 0 || !/^[0-9a-f]{40}$/.test(tree.stdout.trim())) {
    return { error: 'founder evidence rejected: malformed' };
  }
  const runner = blobSha256(head, RUNNER_PATH);
  if (runner.error) return { error: 'founder evidence rejected: runner-mismatch' };
  const suite = blobSha256(head, SUITE_PATH);
  if (suite.error) return { error: 'founder evidence rejected: suite-mismatch' };
  const anchorPath = resolveTrustAnchor();
  if (anchorPath.error) return { error: anchorPath.error };
  let trustAnchor;
  try {
    trustAnchor = loadTrustAnchor(readFileSync(anchorPath.path, 'utf8'));
  } catch {
    return { error: 'founder evidence rejected: unknown-key' };
  }
  const verdict = verifyFounderEvidence(evidence.text, {
    head,
    tree: tree.stdout.trim(),
    base,
    criticalPaths: [...critical].sort(),
    runnerSha256: runner.sha256,
    suiteSha256: suite.sha256,
    trustAnchor,
    now: new Date(),
  });
  if (!verdict.ok) return { error: `founder evidence rejected: ${verdict.reason}` };
  return { ok: true, verdict: { ...verdict, evidenceCommit: evidence.evidenceCommit } };
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
    base = String(process.env.PR_BASE_SHA || '').toLowerCase();
    head = String(process.env.PR_HEAD_SHA || '').toLowerCase();
    if (!base || !head) failClosed('pull request base and head are required');
    const binding = verifierBindingError(base);
    if (binding) failClosed(binding);
    const parsed = changedPathsFromDiff(base, head);
    if (parsed.error) failClosed(parsed.error);
    files = parsed.files;
  }

  const critical = [];
  for (const file of files) {
    const decision = decisionForPath(file);
    if (decision === 'undetermined') failClosed(`classification failed for ${file}`, [file]);
    if (decision === 'critical') critical.push(file);
  }
  if (critical.length > 0) {
    if (!base || !head) {
      failClosed('provenance-critical paths changed without founder-signed evidence', critical);
    }
    const decision = evaluateFounderEvidence(base, head, critical);
    if (!decision.ok) failClosed(decision.error, critical);
    acceptFounderEvidence(decision.verdict);
  }
  pass(files);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
