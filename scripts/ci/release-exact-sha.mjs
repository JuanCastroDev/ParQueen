// Exact-SHA release verification helper. Runs only from the trusted main checkout
// (.github/workflows/release-exact-sha-verify.yml). It never executes code from the release
// commit: it reads that commit as git data, applies the release scope policy, binds provenance
// to reviewed verifier digests, and turns the verify jobs' recorded outcomes into one
// PASS / FAIL / BLOCKED disposition.
//
//   node scripts/ci/release-exact-sha.mjs authorize   (env RELEASE_SHA, RELEASE_BRANCH, BASELINE_SHA, OUT_DIR)
//   node scripts/ci/release-exact-sha.mjs provenance  (env RELEASE_SHA, BASELINE_SHA, OUT_DIR)
//   node scripts/ci/release-exact-sha.mjs recheck     (env RELEASE_SHA, RELEASE_BRANCH)
//   node scripts/ci/release-exact-sha.mjs codeql      (env SARIF_DIR, CHANGED_FILES)
//   node scripts/ci/release-exact-sha.mjs report      (env EVIDENCE_DIR, OUT_DIR, BRANCH_UNCHANGED, run identity)
//
// A green result applies only to the exact release commit, tree, baseline and workflow revision
// it records. It is not the required PR Gate check and does not authorize a deployment.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const BASELINES_FILE = path.join(MODULE_DIR, 'release-production-baselines.json');

// Local tests may point at a fixture record. Inside GitHub Actions only the reviewed file counts.
export function baselinesPath(env = process.env) {
  if (env.GITHUB_ACTIONS === 'true') return BASELINES_FILE;
  return env.PARQUEEN_RELEASE_BASELINES ? path.resolve(env.PARQUEEN_RELEASE_BASELINES) : BASELINES_FILE;
}

export const FULL_SHA = /^[0-9a-f]{40}$/;
export const RELEASE_BRANCH = /^release\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,80})?$/;
export const VERIFIER_FILES = [
  'scripts/ci/provenance-change-guard.mjs',
  'scripts/ci/provenance-evidence.mjs',
  'scripts/ci/provenance-trust-anchor.json',
];

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

// Paths a narrow client release must never change. A hit is a scope violation, not a warning.
export const FORBIDDEN = [
  { test: p => p.startsWith('functions/'), why: 'Cloud Functions source or dependencies' },
  { test: p => /^(firestore|storage)\.rules$/.test(p), why: 'security rules' },
  { test: p => /^firestore\.(interim\.rules|indexes\.json)$/.test(p), why: 'Firestore rules or indexes' },
  { test: p => /^firebase\.[^/]*\.json$/.test(p) && p !== 'firebase.json', why: 'alternate Firebase deploy config' },
  { test: p => p === '.firebaserc', why: 'Firebase project targets' },
  { test: p => p.startsWith('data/runtime-source/'), why: 'runtime source artifacts' },
  { test: p => p.startsWith('scripts/ci/') || p.startsWith('.github/'), why: 'CI policy, workflows or verifier' },
  { test: p => p.startsWith('scripts/release-preflight/'), why: 'release preflight scripts' },
  { test: p => p.startsWith('test-fixtures/'), why: 'rules/baseline fixtures' },
  { test: p => /(^|\/)(s7|S7)[A-Za-z0-9_-]*\./.test(p) || /\/s7\//i.test(p), why: 'S7 lock work' },
  {
    test: p => p.startsWith('views/street-parking/')
      && /(claim|handoff|interest|lock|arrival|attestation)/i.test(path.posix.basename(p)),
    why: 'claim, handoff or lifecycle client',
  },
  // Street Intelligence client logic and the map's curb UI. Copy (i18n) and staff-only admin pages
  // are reviewed through the changed-file inventory instead.
  { test: p => /^(utils|services|hooks|views\/street-parking)\/[^/]*(curb|streetIntel|qaCurb)/i.test(p), why: 'Street Intelligence' },
  { test: p => /^(package-lock\.json|npm-shrinkwrap\.json)$/.test(p), why: 'root dependency lockfile' },
  { test: p => /^\.(npmrc|yarnrc(\.yml)?|pnpmfile\.cjs)$/.test(p) || p === 'pnpm-lock.yaml', why: 'package manager config (install hooks)' },
  { test: p => p === 'android/app/google-services.json' || p.startsWith('ios/App/App/GoogleService-Info'), why: 'native Firebase credentials' },
  // The verification itself must not be weakened by the commit it verifies.
  { test: p => /^(vite|vitest)[^/]*\.config\.[cm]?[jt]s$/.test(p) || /^playwright\.config\.[cm]?[jt]s$/.test(p), why: 'test or build verification config' },
  { test: p => /^(productionBuildConfig|sentryRelease)\.[cm]?[jt]s$/.test(p), why: 'production build guard' },
  { test: p => /^tsconfig[^/]*\.json$/.test(p), why: 'TypeScript verification config' },
  { test: p => /^\.gitleaks(\.toml|ignore)$/.test(p), why: 'secret-scan config' },
];

// npm runs these (and pre<x>/post<x> around any script it runs) without being asked.
export const LIFECYCLE_SCRIPTS = new Set([
  'preinstall', 'install', 'postinstall', 'prepare', 'preprepare', 'postprepare',
  'prepublish', 'prepublishOnly', 'prepack', 'postpack', 'dependencies',
]);
export const isLifecycleScript = name => LIFECYCLE_SCRIPTS.has(name) || /^(pre|post)/.test(name);

// The only package.json changes a release may carry: exact, reviewed before/after values (sha256
// of the script string). Everything else in package.json must be identical to the baseline.
export const REVIEWED_PACKAGE_SCRIPT_CHANGES = {
  // Sign Scanner retired utils/assistantTools.test.ts; this script now lists utils/savedSpot.test.ts.
  'test:street-intel': {
    before: 'a1cd2a7d77e0f9bed9a42e9983c6930625b5171a51700e9aabacd88c2a132d2a',
    after: 'f9f69ea50adf187e18aa9e8cbeef7557953b83cbfcec435c77950f066d032fc3',
  },
};

export function normalize(file) {
  return String(file ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
}

export function parseNameStatus(text) {
  const entries = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const status = parts[0] || '';
    if (/^[RC]/.test(status)) {
      if (!parts[1] || !parts[2]) return { error: `unparseable rename: ${line}` };
      entries.push({ status, path: normalize(parts[2]), from: normalize(parts[1]) });
    } else if (parts[1]) {
      entries.push({ status, path: normalize(parts[1]) });
    } else {
      return { error: `unparseable change: ${line}` };
    }
  }
  return { entries };
}

const stableJson = value => JSON.stringify(value, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]]))
  : v));

export function packageJsonViolation(before, after, reviewed = REVIEWED_PACKAGE_SCRIPT_CHANGES) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (key === 'scripts') continue;
    if (stableJson(before[key] ?? null) !== stableJson(after[key] ?? null)) return `package.json changes ${key}`;
  }
  const a = before.scripts || {};
  const b = after.scripts || {};
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (a[name] === b[name]) continue;
    if (isLifecycleScript(name)) return `package.json changes lifecycle script ${name}`;
    const approved = reviewed[name];
    const hash = v => (typeof v === 'string' ? sha256(v) : null);
    if (!approved || approved.before !== hash(a[name]) || approved.after !== hash(b[name])) {
      return `package.json changes unreviewed script ${name}`;
    }
  }
  return null;
}

export function semanticViolation(file, beforeText, afterText) {
  let before; let after;
  try {
    before = beforeText == null ? null : JSON.parse(beforeText);
    after = afterText == null ? null : JSON.parse(afterText);
  } catch {
    return `${file} is not valid JSON`;
  }
  if (!before || !after) return `${file} was added or removed`;
  if (file === 'firebase.json') {
    const strip = cfg => {
      const copy = structuredClone(cfg);
      const sites = Array.isArray(copy.hosting) ? copy.hosting : [copy.hosting];
      for (const site of sites) if (site) delete site.headers;
      return copy;
    };
    return stableJson(strip(before)) === stableJson(strip(after)) ? null : 'firebase.json changes more than hosting.headers';
  }
  if (file === 'package.json') return packageJsonViolation(before, after);
  return null;
}

export const SEMANTIC = new Set(['firebase.json', 'package.json']);

export function scopeViolations(entries, readBlob) {
  const violations = [];
  for (const entry of entries) {
    for (const p of [entry.path, entry.from].filter(Boolean)) {
      const rule = FORBIDDEN.find(r => r.test(p));
      if (rule) violations.push({ path: p, why: rule.why });
      if (SEMANTIC.has(p) && p !== entry.path) violations.push({ path: p, why: `${p} was renamed` });
    }
    if (SEMANTIC.has(entry.path)) {
      const problem = semanticViolation(entry.path, readBlob('baseline', entry.path), readBlob('release', entry.path));
      if (problem) violations.push({ path: entry.path, why: problem });
    }
  }
  return violations;
}

export function validateInputs({ releaseSha, releaseBranch, baselineSha }, baselines) {
  const errors = [];
  if (!FULL_SHA.test(releaseSha || '')) errors.push('release_sha must be a full lowercase 40-character SHA');
  if (!FULL_SHA.test(baselineSha || '')) errors.push('baseline_sha must be a full lowercase 40-character SHA');
  if (!RELEASE_BRANCH.test(releaseBranch || '') || /\.\.|\.lock$|\/$/.test(releaseBranch || '')) {
    errors.push('release_branch must be a release/... branch name');
  }
  if (releaseSha && releaseSha === baselineSha) errors.push('release and baseline are the same commit');
  const approved = (baselines?.baselines || []).find(b => b.sha === baselineSha);
  if (FULL_SHA.test(baselineSha || '') && !approved) errors.push('baseline_sha is not an approved production baseline');
  return { errors, approved: approved || null };
}

function git(args, opts = {}) {
  const res = spawnSync('git', args, {
    cwd: opts.cwd,
    encoding: opts.buffer ? undefined : 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
  return { status: res.status, stdout: res.stdout, stderr: String(res.stderr || '') };
}

function fail(reason, out, file = 'authorize.json') {
  console.error('RELEASE_EXACT_SHA: FAIL_CLOSED');
  console.error(reason);
  if (out) writeFileSync(path.join(out, file), JSON.stringify({ ok: false, reason }, null, 1));
  process.exit(1);
}

function remoteBranchSha(branch) {
  const res = git(['ls-remote', '--exit-code', 'origin', `refs/heads/${branch}`]);
  if (res.status !== 0) return { error: `release branch ${branch} is not on origin` };
  const lines = res.stdout.trim().split('\n').filter(Boolean);
  if (lines.length !== 1) return { error: 'release branch did not resolve to exactly one ref' };
  const [sha, ref] = lines[0].split('\t');
  if (ref !== `refs/heads/${branch}`) return { error: 'release branch resolved to a different ref' };
  return { sha };
}

function loadRecord(env, baselineSha) {
  const baselines = JSON.parse(readFileSync(baselinesPath(env), 'utf8'));
  return { baselines, record: (baselines.baselines || []).find(b => b.sha === baselineSha) || null };
}

export function authorize(env = process.env) {
  const out = env.OUT_DIR || '.';
  mkdirSync(out, { recursive: true });
  const releaseSha = String(env.RELEASE_SHA || '');
  const releaseBranch = String(env.RELEASE_BRANCH || '');
  const baselineSha = String(env.BASELINE_SHA || '');
  const { baselines } = loadRecord(env, baselineSha);
  const { errors, approved } = validateInputs({ releaseSha, releaseBranch, baselineSha }, baselines);
  if (errors.length) fail(errors.join('; '), out);

  const remote = remoteBranchSha(releaseBranch);
  if (remote.error) fail(remote.error, out);
  if (remote.sha !== releaseSha) fail(`release branch points to ${remote.sha}, not the authorized ${releaseSha}`, out);

  const local = 'refs/release-exact-sha/candidate';
  const fetched = git(['fetch', '--no-tags', '--no-write-fetch-head', 'origin', `+refs/heads/${releaseBranch}:${local}`]);
  if (fetched.status !== 0) fail('release branch could not be fetched from this repository', out);
  if (git(['rev-parse', '--verify', local]).stdout.trim() !== releaseSha) fail('fetched release ref moved during authorization', out);
  if (git(['cat-file', '-t', releaseSha]).stdout.trim() !== 'commit') fail('release SHA is not a commit', out);
  if (git(['cat-file', '-t', baselineSha]).stdout.trim() !== 'commit') fail('baseline SHA is not a commit in this repository', out);
  if (git(['merge-base', '--is-ancestor', baselineSha, releaseSha]).status !== 0) fail('baseline is not an ancestor of the release', out);
  const releaseTree = git(['rev-parse', `${releaseSha}^{tree}`]).stdout.trim();
  const baselineTree = git(['rev-parse', `${baselineSha}^{tree}`]).stdout.trim();
  if (!FULL_SHA.test(releaseTree) || !FULL_SHA.test(baselineTree)) fail('tree identity could not be read', out);

  const diff = git(['diff', '--name-status', '--find-renames', '--no-color', baselineSha, releaseSha]);
  if (diff.status !== 0) fail('changed-file set could not be read', out);
  const parsed = parseNameStatus(diff.stdout);
  if (parsed.error) fail(parsed.error, out);
  if (parsed.entries.length === 0) fail('release changes no files', out);

  const readBlob = (side, file) => {
    const res = git(['cat-file', 'blob', `${side === 'baseline' ? baselineSha : releaseSha}:${file}`]);
    return res.status === 0 ? res.stdout : null;
  };
  const violations = scopeViolations(parsed.entries, readBlob);

  const record = {
    ok: violations.length === 0,
    releaseSha,
    releaseBranch,
    releaseTree,
    baselineSha,
    baselineTree,
    baselineRecord: approved,
    changedFiles: parsed.entries.length,
    changedFilesSha256: sha256(diff.stdout.replace(/\r\n/g, '\n')),
    violations,
  };
  writeFileSync(path.join(out, 'changed-files.tsv'), diff.stdout);
  writeFileSync(path.join(out, 'changed-files.txt'), parsed.entries.map(e => e.path).join('\n') + '\n');
  writeFileSync(path.join(out, 'authorize.json'), JSON.stringify(record, null, 1));
  if (env.GITHUB_OUTPUT) {
    writeFileSync(env.GITHUB_OUTPUT, `release_tree=${releaseTree}\nbaseline_tree=${baselineTree}\n`, { flag: 'a' });
  }
  if (violations.length) {
    console.error('RELEASE_EXACT_SHA: SCOPE_VIOLATION');
    for (const v of violations) console.error(`SCOPE ${v.path}: ${v.why}`);
    process.exit(1);
  }
  console.log(`RELEASE_EXACT_SHA: AUTHORIZED ${releaseSha} tree ${releaseTree} baseline ${baselineSha} files ${parsed.entries.length}`);
}

// Provenance against a historical baseline, in two independent parts:
// 1. The baseline's own verifier, recognized only by the reviewed blob ids and sha256 digests in
//    release-production-baselines.json, classifies base...release and must report PASS.
// 2. The CURRENT trusted policy (main's verifier, itself pinned by reviewed digests) classifies the
//    same diff independently; every path must be clear.
// Any other verifier version, a changed current policy, or a critical path fails closed. The
// founder-evidence route is not available here: exact-SHA releases may not touch critical paths.
export function checkVerifierRecord(record, readHistorical, readCurrent) {
  const errors = [];
  const historical = record?.verifier?.historical || {};
  const current = record?.verifier?.currentPolicy || {};
  for (const file of VERIFIER_FILES) {
    const h = historical[file];
    const c = current[file];
    if (!h?.blob || !h?.sha256 || !c?.sha256) { errors.push(`no reviewed digest for ${file}`); continue; }
    const hist = readHistorical(file);
    if (!hist || hist.blob !== h.blob || sha256(hist.bytes) !== h.sha256) errors.push(`baseline ${file} is not the reviewed historical verifier`);
    const cur = readCurrent(file);
    if (!cur || sha256(cur) !== c.sha256) errors.push(`current ${file} is not the reviewed trusted policy`);
  }
  return errors;
}

export async function provenance(env = process.env) {
  const out = env.OUT_DIR || '.';
  mkdirSync(out, { recursive: true });
  const releaseSha = String(env.RELEASE_SHA || '');
  const baselineSha = String(env.BASELINE_SHA || '');
  if (!FULL_SHA.test(releaseSha) || !FULL_SHA.test(baselineSha)) fail('full release and baseline SHAs are required', out, 'provenance.json');
  const { record } = loadRecord(env, baselineSha);
  if (!record) fail('baseline_sha is not an approved production baseline', out, 'provenance.json');

  const readHistorical = file => {
    const blob = git(['rev-parse', `${baselineSha}:${file}`]).stdout.trim();
    const bytes = git(['cat-file', 'blob', `${baselineSha}:${file}`], { buffer: true });
    return bytes.status === 0 && FULL_SHA.test(blob) ? { blob, bytes: bytes.stdout } : null;
  };
  const policyDir = env.GITHUB_ACTIONS === 'true' ? MODULE_DIR : (env.PARQUEEN_RELEASE_POLICY_DIR || MODULE_DIR);
  const readCurrent = file => {
    const p = path.join(policyDir, path.basename(file));
    return existsSync(p) ? readFileSync(p) : null;
  };
  const errors = checkVerifierRecord(record, readHistorical, readCurrent);
  if (errors.length) fail(errors.join('; '), out, 'provenance.json');

  // 1. Historical verifier, run from exactly the reviewed bytes.
  const work = mkdtempSync(path.join(tmpdir(), 'pq-hist-verifier-'));
  let historical;
  try {
    for (const file of VERIFIER_FILES) {
      mkdirSync(path.join(work, path.dirname(file)), { recursive: true });
      writeFileSync(path.join(work, file), readHistorical(file).bytes);
    }
    const run = spawnSync(process.execPath, [path.join(work, 'scripts/ci/provenance-change-guard.mjs')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_EVENT_NAME: 'release_exact_sha',
        PR_BASE_SHA: baselineSha,
        PR_HEAD_SHA: releaseSha,
        PARQUEEN_PROVENANCE_SIGNING_KEY: '',
      },
    });
    historical = { status: run.status, output: `${run.stdout}${run.stderr}` };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  writeFileSync(path.join(out, 'provenance-historical.txt'), historical.output);
  const historicalPass = historical.status === 0 && historical.output.split(/\r?\n/).includes('PROVENANCE_GUARD: PASS');

  // 2. Independent classification under the current trusted policy.
  const guard = await import(pathToFileURL(path.join(policyDir, 'provenance-change-guard.mjs')).href);
  const diff = git(['diff', '--name-status', '--find-renames', `${baselineSha}...${releaseSha}`]);
  const parsed = diff.status === 0 ? guard.pathsFromNameStatus(diff.stdout) : { error: 'git diff could not be read' };
  const classified = parsed.error ? [] : parsed.files.map(f => ({ file: f, decision: guard.decisionForPath(f) }));
  const notClear = classified.filter(c => c.decision !== 'clear');
  const currentPass = !parsed.error && classified.length > 0 && notClear.length === 0;

  const result = {
    ok: historicalPass && currentPass,
    historicalVerifier: { pass: historicalPass, status: historical.status },
    currentPolicy: { pass: currentPass, files: classified.length, notClear, error: parsed.error || null },
    digests: record.verifier,
  };
  writeFileSync(path.join(out, 'provenance.json'), JSON.stringify(result, null, 1));
  if (!result.ok) {
    console.error('RELEASE_EXACT_SHA: PROVENANCE_FAIL_CLOSED');
    if (!historicalPass) console.error('historical verifier did not report PROVENANCE_GUARD: PASS');
    for (const c of notClear) console.error(`CURRENT_POLICY ${c.decision} ${c.file}`);
    if (parsed.error) console.error(parsed.error);
    process.exit(1);
  }
  console.log(`RELEASE_EXACT_SHA: PROVENANCE_PASS historical=PASS current=${classified.length} clear`);
}

export function recheck(env = process.env) {
  const remote = remoteBranchSha(String(env.RELEASE_BRANCH || ''));
  if (remote.error) fail(remote.error);
  if (remote.sha !== env.RELEASE_SHA) fail(`release branch moved to ${remote.sha} during verification`);
  console.log('RELEASE_EXACT_SHA: BRANCH_UNCHANGED');
}

function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap(name => {
    const p = path.join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

// CodeQL here runs on the exact commit with upload disabled, so "alerts in changed code" means
// results whose primary location is a file the release changes. Any such result fails.
export function codeqlFindings(sarifDocs, changed) {
  const set = new Set(changed.map(normalize));
  const all = [];
  for (const doc of sarifDocs) {
    for (const run of doc.runs || []) {
      for (const result of run.results || []) {
        const uri = normalize(result.locations?.[0]?.physicalLocation?.artifactLocation?.uri || '');
        all.push({ rule: result.ruleId, level: result.level || 'warning', file: uri, line: result.locations?.[0]?.physicalLocation?.region?.startLine });
      }
    }
  }
  return { total: all.length, inChanged: all.filter(r => set.has(r.file)) };
}

export function codeqlGate(env = process.env) {
  const docs = walk(env.SARIF_DIR || '.').filter(f => f.endsWith('.sarif')).map(f => JSON.parse(readFileSync(f, 'utf8')));
  if (docs.length === 0) fail('no CodeQL SARIF output was produced');
  const changed = readFileSync(env.CHANGED_FILES, 'utf8').split(/\r?\n/).filter(Boolean);
  const { total, inChanged } = codeqlFindings(docs, changed);
  console.log(`CODEQL results total=${total} in-changed-files=${inChanged.length}`);
  for (const r of inChanged) console.log(`CODEQL ${r.level} ${r.rule} ${r.file}:${r.line}`);
  process.exit(inChanged.length ? 1 : 0);
}

// The exact set of verify-job outcomes the workflow records, in order.
export const EXPECTED_CHECKS = [
  'npm-ci', 'functions-npm-ci', 'playwright-install', 'unit-tests', 'typecheck', 'production-build',
  'posthog-release', 'e2e', 'functions-npm10-ci', 'sharp-smoke', 'firebase-cli', 'functions-index-load',
  'functions-integration', 'functions-isolated', 'firestore-rules', 'analytics-consent-emulator', 'storage-rules',
];
export const CODEQL_LANGUAGES = ['javascript-typescript', 'actions'];

export function failedTests(vitestJson) {
  const failed = [];
  for (const file of vitestJson?.testResults || []) {
    const rel = normalize(file.name).replace(/^.*?\/(?=(functions|utils|views|components|scripts|i18n|services|e2e)\/)/, '');
    if (file.status === 'failed' && !(file.assertionResults || []).some(a => a.status === 'failed')) failed.push(`${rel} [suite]`);
    for (const a of file.assertionResults || []) {
      if (a.status === 'failed') failed.push(`${rel} > ${(a.ancestorTitles || []).concat(a.title).join(' > ')}`);
    }
  }
  return failed.sort();
}

// Strict: every line is `<expected check>\t<0|1>`, no duplicates, nothing missing, nothing extra.
export function parseOutcomes(text) {
  const outcomes = {};
  const errors = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line) continue;
    const m = /^([a-z0-9-]+)\t([01])$/.exec(line);
    if (!m) { errors.push(`malformed outcome line: ${JSON.stringify(line.slice(0, 80))}`); continue; }
    if (!EXPECTED_CHECKS.includes(m[1])) { errors.push(`unexpected check ${m[1]}`); continue; }
    if (m[1] in outcomes) { errors.push(`duplicate check ${m[1]}`); continue; }
    outcomes[m[1]] = Number(m[2]);
  }
  for (const name of EXPECTED_CHECKS) if (!(name in outcomes)) errors.push(`missing check ${name}`);
  return { outcomes, errors };
}

const readText = file => (existsSync(file) ? readFileSync(file, 'utf8') : null);

// `sha256sum` output for every file in dist/ ("<64 hex><two spaces or space+*>./<path>").
const MANIFEST_LINE = /^[0-9a-f]{64} [ *]\.\/\S(?:.*\S)?$/;

export function manifestErrors(text) {
  if (text == null) return ['dist-manifest.sha256 is missing after a successful production build'];
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length === 0) return ['dist-manifest.sha256 is empty after a successful production build'];
  const errors = [];
  const bad = lines.filter(l => !MANIFEST_LINE.test(l));
  if (bad.length) errors.push(`dist-manifest.sha256 has ${bad.length} malformed line(s)`);
  const paths = lines.filter(l => MANIFEST_LINE.test(l)).map(l => l.slice(66).replace(/^\*/, '').trim());
  if (new Set(paths).size !== paths.length) errors.push('dist-manifest.sha256 lists a path twice');
  if (!paths.includes('./index.html')) errors.push('dist-manifest.sha256 has no ./index.html entry');
  return errors;
}

// Test-report and build-artifact consistency for one subject. Applied to BOTH release and baseline.
// A recorded success needs real evidence; a recorded failure must not be contradicted by a clean report.
export function subjectIntegrityErrors(subject) {
  const errors = [];
  const tests = subject?.outcomes?.['unit-tests'];
  const v = subject?.vitest;
  if (tests === 0) {
    if (!v) errors.push('unit-tests passed without a valid vitest.json');
    else {
      if (!(Number.isInteger(v.numTotalTests) && v.numTotalTests > 0)) errors.push('vitest.json reports no tests');
      if (v.numFailedTests !== 0) errors.push('vitest.json reports failed tests while unit-tests passed');
      if (v.success === false) errors.push('vitest.json reports success=false while unit-tests passed');
      if ((subject.failedTests || []).length) errors.push('vitest.json lists failed tests while unit-tests passed');
    }
  } else if (tests === 1 && v && v.numFailedTests === 0 && !(subject.failedTests || []).length && v.success !== false) {
    errors.push('unit-tests failed but vitest.json reports a clean run');
  }
  if (subject?.outcomes?.['production-build'] === 0) errors.push(...manifestErrors(subject.manifest));
  return errors;
}

// Reads one verify job's evidence. Any missing or malformed part is an error, never a default.
export function subjectEvidence(dir) {
  const errors = [];
  if (!existsSync(dir)) return { errors: ['evidence directory is missing'] };
  const head = readText(path.join(dir, 'head.txt'))?.trim();
  const tree = readText(path.join(dir, 'tree.txt'))?.trim();
  if (!FULL_SHA.test(head || '')) errors.push('head.txt is missing or malformed');
  if (!FULL_SHA.test(tree || '')) errors.push('tree.txt is missing or malformed');
  const outcomesText = readText(path.join(dir, 'outcomes.tsv'));
  if (outcomesText == null) errors.push('outcomes.tsv is missing');
  const parsed = parseOutcomes(outcomesText ?? '');
  if (outcomesText != null) errors.push(...parsed.errors);
  let vitest = null;
  const vitestText = readText(path.join(dir, 'vitest.json'));
  if (vitestText != null) {
    try { vitest = JSON.parse(vitestText); } catch { errors.push('vitest.json is malformed'); }
  }
  const subject = {
    head, tree, errors,
    outcomes: parsed.outcomes,
    vitest,
    failedTests: vitest ? failedTests(vitest) : null,
    manifest: readText(path.join(dir, 'dist-manifest.sha256')),
  };
  errors.push(...subjectIntegrityErrors(subject));
  return subject;
}

function exitCode(file) {
  const text = readText(file);
  if (text == null) return { error: 'missing' };
  const m = /^\s*(\d+)\s*$/.exec(text);
  return m ? { code: Number(m[1]) } : { error: 'malformed' };
}

// PASS needs complete, consistent evidence for BOTH subjects and every mandatory check green.
// Anything missing, malformed or unknown is FAIL. A failure shared with the baseline under the
// same CI is BLOCKED (founder disposition required), never PASS.
export function disposition({ auth, provenance: prov, branchUnchanged, release, baseline, gitleaks, codeql }) {
  const fails = [];
  const blocked = [];
  if (!auth?.ok) fails.push('authorization or scope check failed or is missing');
  if (!prov?.ok) fails.push('provenance check failed or is missing');
  if (branchUnchanged !== true) fails.push('release branch head re-check did not succeed');
  for (const [label, subject, sha, tree] of [
    ['release', release, auth?.releaseSha, auth?.releaseTree],
    ['baseline', baseline, auth?.baselineSha, auth?.baselineTree],
  ]) {
    if (!subject) { fails.push(`${label} evidence is missing`); continue; }
    // Re-validated here so evidence assembled any other way gets the same checks.
    for (const e of new Set([...(subject.errors || []), ...subjectIntegrityErrors(subject)])) fails.push(`${label}: ${e}`);
    if (!FULL_SHA.test(sha || '') || subject.head !== sha) fails.push(`${label} commit identity does not match`);
    if (!FULL_SHA.test(tree || '') || subject.tree !== tree) fails.push(`${label} tree identity does not match`);
  }
  if (gitleaks?.code !== 0) fails.push(`secret scan ${gitleaks?.error ?? `exit ${gitleaks?.code}`}`);
  for (const lang of CODEQL_LANGUAGES) {
    const r = codeql?.[lang];
    if (r?.code !== 0) fails.push(`CodeQL ${lang} ${r?.error ?? `exit ${r?.code}`}`);
  }
  if (fails.length) return { result: 'FAIL', reasons: fails };

  for (const check of EXPECTED_CHECKS) {
    if (release.outcomes[check] === 0) continue;
    if (check === 'unit-tests') {
      if (!release.failedTests?.length || !baseline.failedTests) {
        fails.push('unit-tests failed without comparable per-test results');
        continue;
      }
      const shared = new Set(baseline.failedTests);
      const fresh = release.failedTests.filter(t => !shared.has(t));
      if (fresh.length) fails.push(`unit-tests new failures: ${fresh.join('; ')}`);
      else blocked.push(`unit-tests: ${release.failedTests.length} failure(s) also fail on the baseline`);
    } else if (baseline.outcomes[check] === 1) {
      blocked.push(`${check}: also fails on the baseline`);
    } else {
      fails.push(`${check} failed on the release only`);
    }
  }
  if (fails.length) return { result: 'FAIL', reasons: [...fails, ...blocked.map(b => `shared: ${b}`)] };
  if (blocked.length) return { result: 'BLOCKED', reasons: blocked };
  return { result: 'PASS', reasons: [] };
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; }
}

export function collectEvidence(ev, env = process.env) {
  return {
    auth: readJson(path.join(ev, 'authorize', 'authorize.json')),
    provenance: readJson(path.join(ev, 'authorize', 'provenance.json')),
    release: existsSync(path.join(ev, 'verify-release')) ? subjectEvidence(path.join(ev, 'verify-release')) : null,
    baseline: existsSync(path.join(ev, 'verify-baseline')) ? subjectEvidence(path.join(ev, 'verify-baseline')) : null,
    gitleaks: exitCode(path.join(ev, 'gitleaks', 'exit.txt')),
    codeql: Object.fromEntries(CODEQL_LANGUAGES.map(l => [l, exitCode(path.join(ev, `codeql-${l}`, 'exit.txt'))])),
    branchUnchanged: env.BRANCH_UNCHANGED === 'true',
  };
}

export function report(env = process.env) {
  const ev = env.EVIDENCE_DIR;
  const out = env.OUT_DIR || '.';
  mkdirSync(out, { recursive: true });
  const collected = collectEvidence(ev, env);
  const decision = disposition(collected);
  const { auth, release, baseline, gitleaks, codeql } = collected;
  // A digest is recorded only over a present, well-formed manifest; never over missing evidence.
  const manifestSha = release?.manifest != null && manifestErrors(release.manifest).length === 0 ? sha256(release.manifest) : null;
  const evidence = {
    kind: 'ParQueen isolated exact-SHA release verification (NOT the required PR Gate check)',
    disposition: decision.result,
    reasons: decision.reasons,
    workflow: { ref: env.WORKFLOW_REF, sha: env.WORKFLOW_SHA, runId: env.RUN_ID, runAttempt: env.RUN_ATTEMPT, runUrl: env.RUN_URL, actor: env.ACTOR },
    release: { sha: auth?.releaseSha, branch: auth?.releaseBranch, tree: auth?.releaseTree },
    baseline: { sha: auth?.baselineSha, tree: auth?.baselineTree, record: auth?.baselineRecord },
    changedFiles: { count: auth?.changedFiles, sha256: auth?.changedFilesSha256, violations: auth?.violations },
    provenance: collected.provenance,
    checks: { release: release?.outcomes, baseline: baseline?.outcomes, gitleaks, codeql },
    failedTests: { release: release?.failedTests, baseline: baseline?.failedTests },
    ciBuildManifestSha256: manifestSha,
    note: 'Valid only for the exact release SHA, tree, baseline and workflow revision above. The CI build uses CI configuration; a deployable artifact must be rebuilt from this tree with the approved production configuration and bound separately.',
  };
  writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 1));
  const lines = [
    `# Exact-SHA release verification: ${decision.result}`,
    '',
    'Isolated verification of one immutable commit. **Not** the required `gate` / `private provenance required` checks, and not a deployment authorization.',
    '',
    '| Item | Value |', '| --- | --- |',
    `| Release | \`${auth?.releaseSha}\` on \`${auth?.releaseBranch}\` |`,
    `| Release tree | \`${auth?.releaseTree}\` |`,
    `| Baseline | \`${auth?.baselineSha}\` (tree \`${auth?.baselineTree}\`) |`,
    `| Workflow | \`${env.WORKFLOW_REF}\` @ \`${env.WORKFLOW_SHA}\` run ${env.RUN_ID}.${env.RUN_ATTEMPT} |`,
    `| Changed files | ${auth?.changedFiles} (name-status sha256 \`${auth?.changedFilesSha256}\`) |`,
    `| Provenance | historical ${collected.provenance?.historicalVerifier?.pass ? 'PASS' : 'FAIL'}, current policy ${collected.provenance?.currentPolicy?.pass ? 'PASS' : 'FAIL'} |`,
    `| CI build manifest sha256 | \`${manifestSha}\` |`,
    '',
    '| Check | Release | Baseline |', '| --- | --- | --- |',
    ...EXPECTED_CHECKS.map(k => `| ${k} | ${release?.outcomes?.[k] ?? 'missing'} | ${baseline?.outcomes?.[k] ?? 'missing'} |`),
    `| secret scan (gitleaks, baseline..release) | ${gitleaks.code ?? gitleaks.error} | n/a |`,
    ...CODEQL_LANGUAGES.map(l => `| CodeQL ${l} (changed files) | ${codeql[l].code ?? codeql[l].error} | n/a |`),
    '',
    ...(decision.reasons.length ? ['Reasons:', ...decision.reasons.map(r => `- ${r}`)] : ['No failures.']),
  ];
  writeFileSync(path.join(out, 'evidence.md'), lines.join('\n') + '\n');
  if (env.GITHUB_STEP_SUMMARY) writeFileSync(env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n', { flag: 'a' });
  console.log(`RELEASE_EXACT_SHA: ${decision.result}`);
  process.exit(decision.result === 'PASS' ? 0 : 1);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  const command = process.argv[2];
  const commands = { authorize, provenance, recheck, codeql: codeqlGate, report };
  if (!commands[command]) fail(`unknown command ${command}`);
  await commands[command]();
}
