// Exact-SHA release verification helper. Runs only from the trusted main checkout
// (.github/workflows/release-exact-sha-verify.yml). It never executes code from the release
// commit: it reads that commit as git data, applies the release scope policy, and later turns the
// verify jobs' recorded outcomes into one PASS / FAIL / BLOCKED disposition.
//
//   node scripts/ci/release-exact-sha.mjs authorize   (env RELEASE_SHA, RELEASE_BRANCH, BASELINE_SHA, OUT_DIR)
//   node scripts/ci/release-exact-sha.mjs recheck     (env RELEASE_SHA, RELEASE_BRANCH)
//   node scripts/ci/release-exact-sha.mjs codeql      (env SARIF_DIR, CHANGED_FILES)
//   node scripts/ci/release-exact-sha.mjs report      (env EVIDENCE_DIR, OUT_DIR, plus run identity)
//
// A green result applies only to the exact release commit, tree, baseline and workflow revision
// it records. It is not the required PR Gate check and does not authorize a deployment.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const BASELINES_FILE = path.join(MODULE_DIR, 'release-production-baselines.json');

// Local tests may point at a fixture allowlist. Inside GitHub Actions only the reviewed file counts.
export function baselinesPath(env = process.env) {
  if (env.GITHUB_ACTIONS === 'true') return BASELINES_FILE;
  return env.PARQUEEN_RELEASE_BASELINES ? path.resolve(env.PARQUEEN_RELEASE_BASELINES) : BASELINES_FILE;
}

export const FULL_SHA = /^[0-9a-f]{40}$/;
export const RELEASE_BRANCH = /^release\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,80})?$/;

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
  { test: p => p === 'android/app/google-services.json' || p.startsWith('ios/App/App/GoogleService-Info'), why: 'native Firebase credentials' },
  // The verification itself must not be weakened by the commit it verifies.
  { test: p => /^(vite|vitest)[^/]*\.config\.[cm]?[jt]s$/.test(p) || /^playwright\.config\.[cm]?[jt]s$/.test(p), why: 'test or build verification config' },
  { test: p => /^tsconfig[^/]*\.json$/.test(p), why: 'TypeScript verification config' },
  { test: p => /^\.gitleaks(\.toml|ignore)$/.test(p), why: 'secret-scan config' },
];

// package.json scripts that the verification workflow runs. They must be byte-identical.
export const GATE_SCRIPTS = [
  'build', 'verify:posthog:release', 'test:e2e', 'test:functions', 'test:functions:isolated',
  'test:rules', 'test:rules:unit', 'test:storage:rules', 'test:storage:rules:unit',
];

// Files that may change only in the narrow way described.
export const SEMANTIC = {
  'firebase.json': 'only hosting.headers may change',
  'package.json': 'dependencies, devDependencies, optionalDependencies, overrides, engines and gate scripts must not change',
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
  if (file === 'package.json') {
    for (const key of ['dependencies', 'devDependencies', 'optionalDependencies', 'overrides', 'engines']) {
      if (stableJson(before[key] ?? null) !== stableJson(after[key] ?? null)) return `package.json changes ${key}`;
    }
    for (const script of GATE_SCRIPTS) {
      if ((before.scripts?.[script] ?? null) !== (after.scripts?.[script] ?? null)) return `package.json changes gate script ${script}`;
    }
    return null;
  }
  return null;
}

export function scopeViolations(entries, readBlob) {
  const violations = [];
  for (const entry of entries) {
    for (const p of [entry.path, entry.from].filter(Boolean)) {
      const rule = FORBIDDEN.find(r => r.test(p));
      if (rule) violations.push({ path: p, why: rule.why });
    }
    if (SEMANTIC[entry.path]) {
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
    encoding: opts.buffer ? undefined : 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
  return { status: res.status, stdout: res.stdout, stderr: String(res.stderr || '') };
}

function fail(reason, out) {
  console.error('RELEASE_EXACT_SHA: FAIL_CLOSED');
  console.error(reason);
  if (out) writeFileSync(path.join(out, 'authorize.json'), JSON.stringify({ ok: false, reason }, null, 1));
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

export function authorize(env = process.env) {
  const out = env.OUT_DIR || '.';
  mkdirSync(out, { recursive: true });
  const releaseSha = String(env.RELEASE_SHA || '');
  const releaseBranch = String(env.RELEASE_BRANCH || '');
  const baselineSha = String(env.BASELINE_SHA || '');
  const baselines = JSON.parse(readFileSync(baselinesPath(env), 'utf8'));
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
    changedFilesSha256: createHash('sha256').update(diff.stdout.replace(/\r\n/g, '\n')).digest('hex'),
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

export function parseOutcomes(text) {
  return Object.fromEntries(String(text || '').split(/\r?\n/).filter(Boolean).map(l => l.split('\t')).map(([k, v]) => [k, Number(v)]));
}

// PASS only when every release check passed. A release-only failure is FAIL. A failure that the
// baseline shares under the same CI is BLOCKED: it needs an explicit founder disposition.
export function disposition({ authorizeOk, branchUnchanged, release, baseline, gitleaks, codeql }) {
  const reasons = [];
  if (!authorizeOk) return { result: 'FAIL', reasons: ['authorization or scope check failed'] };
  if (!branchUnchanged) return { result: 'FAIL', reasons: ['release branch moved during verification'] };
  if (gitleaks !== 0) reasons.push(`FAIL secret scan exit ${gitleaks}`);
  for (const [lang, code] of Object.entries(codeql || {})) if (code !== 0) reasons.push(`FAIL CodeQL ${lang} exit ${code}`);
  if (!release) return { result: 'FAIL', reasons: [...reasons, 'release verification produced no outcomes'] };
  let shared = 0;
  for (const [check, code] of Object.entries(release.outcomes)) {
    if (code === 0) continue;
    const base = baseline?.outcomes?.[check];
    if (check === 'unit-tests' && baseline) {
      const baseFailed = new Set(baseline.failedTests || []);
      const newFails = (release.failedTests || []).filter(t => !baseFailed.has(t));
      if (newFails.length || !(release.failedTests || []).length) reasons.push(`FAIL unit-tests: ${newFails.length ? newFails.join('; ') : 'exited non-zero without a test failure'}`);
      else { shared += 1; reasons.push(`BLOCKED unit-tests: ${release.failedTests.length} failure(s) also fail on the baseline`); }
    } else if (base !== undefined && base !== 0) {
      shared += 1;
      reasons.push(`BLOCKED ${check}: also fails on the baseline (exit ${base})`);
    } else {
      reasons.push(`FAIL ${check} exit ${code}`);
    }
  }
  if (reasons.some(r => r.startsWith('FAIL'))) return { result: 'FAIL', reasons };
  if (shared) return { result: 'BLOCKED', reasons };
  return { result: 'PASS', reasons: [] };
}

function readJson(file, fallback = null) {
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function subjectEvidence(dir) {
  if (!existsSync(dir)) return null;
  return {
    head: readFileSync(path.join(dir, 'head.txt'), 'utf8').trim(),
    tree: readFileSync(path.join(dir, 'tree.txt'), 'utf8').trim(),
    outcomes: parseOutcomes(readFileSync(path.join(dir, 'outcomes.tsv'), 'utf8')),
    failedTests: failedTests(readJson(path.join(dir, 'vitest.json'), {})),
    manifest: existsSync(path.join(dir, 'dist-manifest.sha256')) ? readFileSync(path.join(dir, 'dist-manifest.sha256'), 'utf8') : '',
  };
}

export function report(env = process.env) {
  const ev = env.EVIDENCE_DIR;
  const out = env.OUT_DIR || '.';
  mkdirSync(out, { recursive: true });
  const auth = readJson(path.join(ev, 'authorize', 'authorize.json'), { ok: false });
  const release = subjectEvidence(path.join(ev, 'verify-release'));
  const baseline = subjectEvidence(path.join(ev, 'verify-baseline'));
  const codeql = {};
  for (const lang of ['javascript-typescript', 'actions']) {
    const f = path.join(ev, `codeql-${lang}`, 'exit.txt');
    codeql[lang] = existsSync(f) ? Number(readFileSync(f, 'utf8').trim()) : 1;
  }
  const gitleaksFile = path.join(ev, 'gitleaks', 'exit.txt');
  const gitleaks = existsSync(gitleaksFile) ? Number(readFileSync(gitleaksFile, 'utf8').trim()) : 1;
  const identityOk = release && release.head === auth.releaseSha && release.tree === auth.releaseTree
    && (!baseline || (baseline.head === auth.baselineSha && baseline.tree === auth.baselineTree));
  const decision = disposition({
    authorizeOk: auth.ok && identityOk,
    branchUnchanged: env.BRANCH_UNCHANGED === 'true',
    release, baseline, gitleaks, codeql,
  });
  const manifestSha = release?.manifest ? createHash('sha256').update(release.manifest).digest('hex') : null;
  const evidence = {
    kind: 'ParQueen isolated exact-SHA release verification (NOT the required PR Gate check)',
    disposition: decision.result,
    reasons: decision.reasons,
    workflow: { ref: env.WORKFLOW_REF, sha: env.WORKFLOW_SHA, runId: env.RUN_ID, runAttempt: env.RUN_ATTEMPT, runUrl: env.RUN_URL, actor: env.ACTOR },
    release: { sha: auth.releaseSha, branch: auth.releaseBranch, tree: auth.releaseTree },
    baseline: { sha: auth.baselineSha, tree: auth.baselineTree, record: auth.baselineRecord },
    changedFiles: { count: auth.changedFiles, sha256: auth.changedFilesSha256, violations: auth.violations },
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
    `| Item | Value |`, `| --- | --- |`,
    `| Release | \`${auth.releaseSha}\` on \`${auth.releaseBranch}\` |`,
    `| Release tree | \`${auth.releaseTree}\` |`,
    `| Baseline | \`${auth.baselineSha}\` (tree \`${auth.baselineTree}\`) |`,
    `| Workflow | \`${env.WORKFLOW_REF}\` @ \`${env.WORKFLOW_SHA}\` run ${env.RUN_ID}.${env.RUN_ATTEMPT} |`,
    `| Changed files | ${auth.changedFiles} (name-status sha256 \`${auth.changedFilesSha256}\`) |`,
    `| CI build manifest sha256 | \`${manifestSha}\` |`,
    '',
    '| Check | Release | Baseline |', '| --- | --- | --- |',
    ...Object.keys(release?.outcomes || {}).map(k => `| ${k} | ${release.outcomes[k]} | ${baseline?.outcomes?.[k] ?? 'n/a'} |`),
    `| secret scan (gitleaks, baseline..release) | ${gitleaks} | n/a |`,
    ...Object.entries(codeql).map(([k, v]) => `| CodeQL ${k} (changed files) | ${v} | n/a |`),
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
  const commands = { authorize, recheck, codeql: codeqlGate, report };
  if (!commands[command]) fail(`unknown command ${command}`);
  commands[command]();
}
