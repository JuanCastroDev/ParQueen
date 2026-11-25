import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BASELINES_FILE,
  EXPECTED_CHECKS,
  REVIEWED_PACKAGE_SCRIPT_CHANGES,
  VERIFIER_FILES,
  baselinesPath,
  checkVerifierRecord,
  codeqlFindings,
  collectEvidence,
  disposition,
  failedTests,
  isLifecycleScript,
  packageJsonViolation,
  parseNameStatus,
  parseOutcomes,
  scopeViolations,
  semanticViolation,
  subjectEvidence,
  validateInputs,
} from './release-exact-sha.mjs';
import { decisionForPath } from './provenance-change-guard.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, 'release-exact-sha.mjs');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const T1 = '1'.repeat(40);
const T2 = '2'.repeat(40);
const allow = { baselines: [{ sha: A }] };
const entries = paths => paths.map(p => ({ status: 'M', path: p }));
const noBlob = () => null;
const sha = v => createHash('sha256').update(v).digest('hex');
const root = mkdtempSync(path.join(tmpdir(), 'pq-exact-sha-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('input validation', () => {
  it('accepts full SHAs, a release/ branch and an approved baseline', () => {
    expect(validateInputs({ releaseSha: B, releaseBranch: 'release/narrow-three-feature-20261125', baselineSha: A }, allow).errors).toEqual([]);
  });

  it('rejects short or uppercase SHAs, non-release branches, unknown baselines and equal commits', () => {
    const errs = input => validateInputs(input, allow).errors.join('|');
    expect(errs({ releaseSha: 'abc123', releaseBranch: 'release/x', baselineSha: A })).toMatch(/release_sha/);
    expect(errs({ releaseSha: B.toUpperCase(), releaseBranch: 'release/x', baselineSha: A })).toMatch(/release_sha/);
    for (const branch of ['main', 'feature/x', 'release/', 'release/../main', 'release/x.lock', 'release/a b']) {
      expect(errs({ releaseSha: B, releaseBranch: branch, baselineSha: A })).toMatch(/release_branch/);
    }
    expect(errs({ releaseSha: B, releaseBranch: 'release/x', baselineSha: 'c'.repeat(40) })).toMatch(/not an approved/);
    expect(errs({ releaseSha: A, releaseBranch: 'release/x', baselineSha: A })).toMatch(/same commit/);
  });

  it('ships exactly the verified live baseline with a complete reviewed verifier binding', () => {
    const file = JSON.parse(readFileSync(BASELINES_FILE, 'utf8'));
    expect(file.baselines.map(b => [b.sha, b.hostingVersion])).toEqual([
      ['a7d53cc8ef2738331cb5d9c8394b21b8cb3ecaab', 'f8a02be15a2e22ca'],
    ]);
    const { historical, currentPolicy } = file.baselines[0].verifier;
    for (const f of VERIFIER_FILES) {
      expect(historical[f].blob).toMatch(/^[0-9a-f]{40}$/);
      expect(historical[f].sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(currentPolicy[f].sha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(historical['scripts/ci/provenance-change-guard.mjs'].blob).toBe('7b0b0eea1626a7b84c0b83cf69c76335e2243ebe');
  });

  it('pins the current trusted policy to the guard in this checkout (LF bytes)', () => {
    const file = JSON.parse(readFileSync(BASELINES_FILE, 'utf8'));
    for (const f of VERIFIER_FILES) {
      const lf = readFileSync(path.join(HERE, path.basename(f)), 'utf8').replace(/\r\n/g, '\n');
      expect(sha(lf), f).toBe(file.baselines[0].verifier.currentPolicy[f].sha256);
    }
  });

  it('ignores the local record and policy overrides inside GitHub Actions', () => {
    expect(baselinesPath({ GITHUB_ACTIONS: 'true', PARQUEEN_RELEASE_BASELINES: '/tmp/evil.json' })).toBe(BASELINES_FILE);
    expect(baselinesPath({ PARQUEEN_RELEASE_BASELINES: 'x.json' })).toBe(path.resolve('x.json'));
  });
});

describe('workflow provenance policy', () => {
  it('classifies the exact-SHA workflow and its helper as provenance-critical', () => {
    expect(decisionForPath('.github/workflows/release-exact-sha-verify.yml')).toBe('critical');
    expect(decisionForPath('scripts/ci/release-exact-sha.mjs')).toBe('critical');
    expect(decisionForPath('scripts/ci/release-production-baselines.json')).toBe('critical');
  });
});

describe('scope policy', () => {
  it('rejects backend, rules, CI policy, runtime source, S7, claim/handoff, Street Intelligence, install and verification config paths', () => {
    const blocked = [
      'functions/index.js', 'functions/package-lock.json', 'firestore.rules', 'storage.rules', 'firestore.indexes.json',
      'firestore.interim.rules', 'firebase.interim-rules.json', '.firebaserc', 'data/runtime-source/x.json',
      'scripts/ci/provenance-change-guard.mjs', '.github/workflows/pr-gate.yml', '.github/workflows/release-exact-sha-verify.yml',
      'scripts/release-preflight/run-all.mjs', 'test-fixtures/production-baseline/x.rules', 'utils/s7Locks.ts',
      'views/street-parking/useInterestFlow.ts', 'views/street-parking/claimSpotCallable.ts',
      'views/street-parking/completeHandoffSuccessCallable.ts', 'views/street-parking/activeIncomingClaim.ts',
      'utils/canonicalCurbClient.ts', 'utils/streetIntelligence.ts', 'views/street-parking/StreetIntelligenceCard.tsx',
      'package-lock.json', '.npmrc', '.yarnrc.yml', 'android/app/google-services.json', 'vite.config.ts',
      'vite.rules.config.ts', 'playwright.config.ts', 'productionBuildConfig.ts', 'sentryRelease.ts', 'tsconfig.json',
      '.gitleaks.toml', '.gitleaksignore',
    ];
    expect(scopeViolations(entries(blocked), noBlob).map(v => v.path)).toEqual(blocked);
  });

  it('allows the narrow release surface', () => {
    const allowed = [
      'App.tsx', 'views/onboarding-v2/OnboardingV2View.tsx', 'views/LocationPromptView.tsx', 'views/sign-scanner/SignScannerView.tsx',
      'views/street-parking/HeaderBar.tsx', 'views/street-parking/types.ts', 'views/StreetParkingView.tsx', 'utils/geolocation.ts',
      'components/LoadingScreen.tsx', 'public/theme-boot.js', 'index.html', 'i18n/en.ts', 'i18n/streetIntelligenceSafetyCopy.test.ts',
      'views/admin/StreetIntelligenceHealthPage.tsx', 'capacitor.config.ts', 'android/app/src/main/java/app/parqueen/MainActivity.java',
      '.env.production', 'knip.json', 'e2e/smoke.spec.ts',
    ];
    expect(scopeViolations(entries(allowed), noBlob)).toEqual([]);
  });

  it('checks both sides of a rename and rejects renaming a semantic file', () => {
    expect(scopeViolations(parseNameStatus('R100\tfunctions/old.js\tutils/new.ts\n').entries, noBlob).map(v => v.path)).toEqual(['functions/old.js']);
    expect(scopeViolations(parseNameStatus('R090\tpackage.json\tpkg.json\n').entries, noBlob).map(v => v.why)).toContain('package.json was renamed');
  });

  it('fails closed on unparseable name-status output', () => {
    expect(parseNameStatus('M\n').error).toBeTruthy();
    expect(parseNameStatus('R100\tonly-one\n').error).toBeTruthy();
  });

  it('allows firebase.json only when hosting.headers change', () => {
    const base = JSON.stringify({ hosting: { public: 'dist', headers: [] }, functions: { source: 'functions' } });
    const headers = JSON.stringify({ hosting: { public: 'dist', headers: [{ source: '/theme-boot.js' }] }, functions: { source: 'functions' } });
    const predeploy = JSON.stringify({ hosting: { public: 'dist', headers: [] }, functions: { source: 'functions', predeploy: ['x'] } });
    const hostingPredeploy = JSON.stringify({ hosting: { public: 'dist', headers: [], predeploy: ['npm run x'] }, functions: { source: 'functions' } });
    expect(semanticViolation('firebase.json', base, headers)).toBeNull();
    expect(semanticViolation('firebase.json', base, predeploy)).toMatch(/more than hosting.headers/);
    expect(semanticViolation('firebase.json', base, hostingPredeploy)).toMatch(/more than hosting.headers/);
    expect(semanticViolation('firebase.json', base, '{')).toMatch(/not valid JSON/);
  });
});

describe('package.json lifecycle and script scope', () => {
  const [reviewedName] = Object.keys(REVIEWED_PACKAGE_SCRIPT_CHANGES);
  // Real before/after strings are not stored here; build a pair whose hashes match the reviewed record.
  const narrow = JSON.parse(spawnSync('git', ['show', '4617e1bcb3fd21b96a265fd83eaef7000fe0228c:package.json'], { cwd: HERE, encoding: 'utf8' }).stdout || 'null');
  const baseline = JSON.parse(spawnSync('git', ['show', 'a7d53cc8ef2738331cb5d9c8394b21b8cb3ecaab:package.json'], { cwd: HERE, encoding: 'utf8' }).stdout || 'null');
  const pkg = (scripts = {}, top = {}) => ({ name: 'x', scripts: { build: 'vite build', test: 'vitest', ...scripts }, dependencies: { react: '18' }, ...top });

  it('treats npm lifecycle hooks and pre/post scripts as lifecycle', () => {
    for (const n of ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'postpack', 'prepublishOnly', 'prebuild', 'postbuild', 'pretest', 'postci']) {
      expect(isLifecycleScript(n), n).toBe(true);
    }
    expect(isLifecycleScript('build')).toBe(false);
    expect(Object.keys(REVIEWED_PACKAGE_SCRIPT_CHANGES).some(isLifecycleScript)).toBe(false);
  });

  it('fails closed on added, changed or removed lifecycle scripts', () => {
    const base = pkg({ prepare: 'husky' });
    for (const [name, value] of [['preinstall', 'node x'], ['install', 'node x'], ['postinstall', 'node x'], ['prebuild', 'node x'], ['postbuild', 'node x'], ['prepack', 'x']]) {
      expect(packageJsonViolation(base, pkg({ prepare: 'husky', [name]: value })), name).toMatch(new RegExp(`lifecycle script ${name}`));
    }
    expect(packageJsonViolation(base, pkg({ prepare: 'node evil.js' }))).toMatch(/lifecycle script prepare/);
    expect(packageJsonViolation(base, pkg({}))).toMatch(/lifecycle script prepare/);
  });

  it('fails closed on unreviewed script, dependency and other top-level changes', () => {
    expect(packageJsonViolation(pkg(), pkg({ lint: 'eslint .' }))).toMatch(/unreviewed script lint/);
    expect(packageJsonViolation(pkg(), pkg({ build: 'echo skip' }))).toMatch(/unreviewed script build/);
    expect(packageJsonViolation(pkg(), pkg({}, { dependencies: { react: '19' } }))).toMatch(/changes dependencies/);
    expect(packageJsonViolation(pkg(), pkg({}, { overrides: { x: '1' } }))).toMatch(/changes overrides/);
    expect(packageJsonViolation(pkg(), pkg({}, { workspaces: ['a'] }))).toMatch(/changes workspaces/);
    expect(packageJsonViolation(pkg(), pkg({}, { type: 'module' }))).toMatch(/changes type/);
  });

  it('allows only the reviewed script change, with exactly the reviewed values', () => {
    expect(packageJsonViolation(pkg({ [reviewedName]: 'old' }), pkg({ [reviewedName]: 'new' }))).toMatch(/unreviewed script/);
  });

  it.skipIf(!narrow || !baseline)('accepts the narrow candidate package.json against a7d53cc', () => {
    expect(packageJsonViolation(baseline, narrow)).toBeNull();
    expect(packageJsonViolation(baseline, { ...narrow, scripts: { ...narrow.scripts, postinstall: 'node x' } })).toMatch(/lifecycle/);
  });
});

describe('CodeQL gate', () => {
  it('counts only results located in files the release changes', () => {
    const sarif = [{ runs: [{ results: [
      { ruleId: 'js/a', level: 'error', locations: [{ physicalLocation: { artifactLocation: { uri: 'views/x.tsx' }, region: { startLine: 3 } } }] },
      { ruleId: 'js/b', locations: [{ physicalLocation: { artifactLocation: { uri: 'functions/y.js' } } }] },
    ] }] }];
    const r = codeqlFindings(sarif, ['views/x.tsx', 'App.tsx']);
    expect(r.total).toBe(2);
    expect(r.inChanged).toEqual([{ rule: 'js/a', level: 'error', file: 'views/x.tsx', line: 3 }]);
  });
});

describe('outcome parsing', () => {
  const full = codes => EXPECTED_CHECKS.map(c => `${c}\t${codes?.[c] ?? 0}`).join('\n') + '\n';
  it('accepts exactly the expected checks', () => {
    expect(parseOutcomes(full()).errors).toEqual([]);
  });
  it('rejects missing, unexpected, duplicate and malformed outcomes', () => {
    expect(parseOutcomes(full().replace('typecheck\t0\n', '')).errors).toContain('missing check typecheck');
    expect(parseOutcomes(full() + 'deploy\t0\n').errors).toContain('unexpected check deploy');
    expect(parseOutcomes(full() + 'typecheck\t0\n').errors).toContain('duplicate check typecheck');
    expect(parseOutcomes(full().replace('e2e\t0', 'e2e\tsuccess')).errors.join()).toMatch(/malformed/);
    expect(parseOutcomes(full().replace('e2e\t0', 'e2e\t2')).errors.join()).toMatch(/malformed/);
    expect(parseOutcomes('').errors.length).toBe(EXPECTED_CHECKS.length);
  });
});

describe('disposition is fail-closed', () => {
  const vitestOk = { numTotalTests: 10, numFailedTests: 0, testResults: [] };
  const subject = (head, tree, codes = {}, failed = []) => ({
    head, tree, errors: [],
    outcomes: Object.fromEntries(EXPECTED_CHECKS.map(c => [c, codes[c] ?? 0])),
    vitest: failed.length ? { numTotalTests: 10, numFailedTests: failed.length } : vitestOk,
    failedTests: failed,
  });
  const good = () => ({
    auth: { ok: true, releaseSha: B, releaseTree: T1, baselineSha: A, baselineTree: T2 },
    provenance: { ok: true },
    branchUnchanged: true,
    release: subject(B, T1),
    baseline: subject(A, T2),
    gitleaks: { code: 0 },
    codeql: { 'javascript-typescript': { code: 0 }, actions: { code: 0 } },
  });

  it('passes only with complete evidence for both subjects and every check green', () => {
    expect(disposition(good())).toEqual({ result: 'PASS', reasons: [] });
  });

  it('never passes without the baseline', () => {
    const d = disposition({ ...good(), baseline: null });
    expect(d.result).toBe('FAIL');
    expect(d.reasons).toContain('baseline evidence is missing');
  });

  it('fails on identity, provenance, branch, secret-scan or CodeQL gaps', () => {
    expect(disposition({ ...good(), release: { ...subject(B, T1), head: A } }).result).toBe('FAIL');
    expect(disposition({ ...good(), baseline: { ...subject(A, T2), tree: T1 } }).result).toBe('FAIL');
    expect(disposition({ ...good(), auth: null }).result).toBe('FAIL');
    expect(disposition({ ...good(), provenance: null }).result).toBe('FAIL');
    expect(disposition({ ...good(), branchUnchanged: false }).result).toBe('FAIL');
    expect(disposition({ ...good(), gitleaks: { error: 'missing' } }).result).toBe('FAIL');
    expect(disposition({ ...good(), gitleaks: { code: 1 } }).result).toBe('FAIL');
    expect(disposition({ ...good(), codeql: { 'javascript-typescript': { code: 0 } } }).result).toBe('FAIL');
  });

  it('fails when a subject reports evidence errors (incomplete or unknown outcomes)', () => {
    expect(disposition({ ...good(), release: { ...subject(B, T1), errors: ['missing check e2e'] } }).result).toBe('FAIL');
    expect(disposition({ ...good(), baseline: { ...subject(A, T2), errors: ['unexpected check deploy'] } }).result).toBe('FAIL');
  });

  it('fails when unit tests "pass" without a real report', () => {
    expect(disposition({ ...good(), release: { ...subject(B, T1), vitest: null } }).result).toBe('FAIL');
    expect(disposition({ ...good(), release: { ...subject(B, T1), vitest: { numTotalTests: 0, numFailedTests: 0 } } }).result).toBe('FAIL');
  });

  it('blocks shared failures, fails new ones and fails uncomparable unit-test failures', () => {
    const shared = ['a > x'];
    expect(disposition({ ...good(), release: subject(B, T1, { 'unit-tests': 1 }, shared), baseline: subject(A, T2, { 'unit-tests': 1 }, shared) }).result).toBe('BLOCKED');
    expect(disposition({ ...good(), release: subject(B, T1, { e2e: 1 }), baseline: subject(A, T2, { e2e: 1 }) }).result).toBe('BLOCKED');
    const fresh = disposition({ ...good(), release: subject(B, T1, { 'unit-tests': 1 }, ['a > x', 'b > new']), baseline: subject(A, T2, { 'unit-tests': 1 }, shared) });
    expect(fresh.result).toBe('FAIL');
    expect(fresh.reasons.join()).toContain('b > new');
    expect(disposition({ ...good(), release: subject(B, T1, { 'unit-tests': 1 }), baseline: subject(A, T2) }).result).toBe('FAIL');
    expect(disposition({ ...good(), release: subject(B, T1, { e2e: 1 }) }).result).toBe('FAIL');
  });

  it('names failing tests relative to the repository', () => {
    expect(failedTests({ testResults: [
      { name: '/home/runner/work/ParQueen/ParQueen/functions/a.test.js', status: 'failed', assertionResults: [{ status: 'failed', ancestorTitles: ['S'], title: 't' }] },
      { name: 'C:\\w\\utils\\b.test.ts', status: 'failed', assertionResults: [] },
    ] })).toEqual(['functions/a.test.js > S > t', 'utils/b.test.ts [suite]']);
  });
});

describe('partial artifact downloads', () => {
  const lay = (dir, files) => {
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, p)), { recursive: true });
      writeFileSync(path.join(dir, p), text);
    }
  };
  const outcomes = EXPECTED_CHECKS.map(c => `${c}\t0`).join('\n') + '\n';
  const vitest = JSON.stringify({ numTotalTests: 5, numFailedTests: 0, testResults: [] });
  const complete = {
    'authorize/authorize.json': JSON.stringify({ ok: true, releaseSha: B, releaseTree: T1, baselineSha: A, baselineTree: T2 }),
    'authorize/provenance.json': JSON.stringify({ ok: true }),
    'verify-release/head.txt': `${B}\n`, 'verify-release/tree.txt': `${T1}\n`, 'verify-release/outcomes.tsv': outcomes, 'verify-release/vitest.json': vitest,
    'verify-baseline/head.txt': `${A}\n`, 'verify-baseline/tree.txt': `${T2}\n`, 'verify-baseline/outcomes.tsv': outcomes, 'verify-baseline/vitest.json': vitest,
    'gitleaks/exit.txt': '0\n', 'codeql-javascript-typescript/exit.txt': '0\n', 'codeql-actions/exit.txt': '0\n',
  };
  const decide = omit => {
    const dir = mkdtempSync(path.join(root, 'ev-'));
    lay(dir, Object.fromEntries(Object.entries(complete).filter(([p]) => !omit.some(o => p.startsWith(o)))));
    return disposition(collectEvidence(dir, { BRANCH_UNCHANGED: 'true' }));
  };

  it('passes with every artifact present', () => {
    expect(decide([]).result).toBe('PASS');
  });

  it.each([
    ['verify-baseline/'], ['verify-release/'], ['verify-release/head.txt'], ['verify-baseline/tree.txt'],
    ['verify-release/outcomes.tsv'], ['verify-release/vitest.json'], ['authorize/authorize.json'], ['authorize/provenance.json'],
    ['gitleaks/'], ['codeql-actions/'], ['codeql-javascript-typescript/'],
  ])('fails when %s did not download', omit => {
    expect(decide([omit]).result).toBe('FAIL');
  });

  it('fails when the branch re-check did not succeed', () => {
    const dir = mkdtempSync(path.join(root, 'ev-'));
    lay(dir, complete);
    expect(disposition(collectEvidence(dir, { BRANCH_UNCHANGED: 'false' })).result).toBe('FAIL');
  });

  it('reports subject evidence errors precisely', () => {
    const dir = mkdtempSync(path.join(root, 'subj-'));
    lay(dir, { 'head.txt': 'nope', 'outcomes.tsv': 'e2e\t0\n' });
    const s = subjectEvidence(dir);
    expect(s.errors).toEqual(expect.arrayContaining(['head.txt is missing or malformed', 'tree.txt is missing or malformed', 'missing check typecheck']));
  });
});

// ── Real git: authorization and the historical-verifier transition ─────────────────────────────
const gitEnv = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
const run = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...gitEnv } });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
const childEnv = extra => ({ ...process.env, GITHUB_ACTIONS: '', GITHUB_OUTPUT: '', GITHUB_EVENT_NAME: '', PARQUEEN_PROVENANCE_SIGNING_KEY: '', ...extra });

function makeRepo(name) {
  const dir = path.join(root, name);
  const origin = `${dir}.git`;
  run(['init', '-q', '--bare', origin], root);
  run(['init', '-q', '-b', 'main', dir], root);
  run(['config', 'core.autocrlf', 'false'], dir);
  run(['remote', 'add', 'origin', origin], dir);
  const write = (file, text) => { mkdirSync(path.dirname(path.join(dir, file)), { recursive: true }); writeFileSync(path.join(dir, file), text); };
  const commit = msg => { run(['add', '-A'], dir); run(['commit', '-q', '-m', msg], dir); return run(['rev-parse', 'HEAD'], dir); };
  return { dir, write, commit };
}

describe('authorize against real git repositories', () => {
  const repo = makeRepo('auth');
  repo.write('App.tsx', 'base\n');
  repo.write('firebase.json', JSON.stringify({ hosting: { public: 'dist', headers: [] } }));
  const baseline = repo.commit('base');
  repo.write('App.tsx', 'feature\n');
  repo.write('firebase.json', JSON.stringify({ hosting: { public: 'dist', headers: [{ source: '/theme-boot.js' }] } }));
  const release = repo.commit('feature');
  run(['checkout', '-q', '-b', 'scope-bad'], repo.dir);
  repo.write('functions/index.js', 'x\n');
  const bad = repo.commit('backend');
  run(['push', '-q', 'origin', `${release}:refs/heads/release/good`, `${bad}:refs/heads/release/bad`, `${baseline}:refs/heads/main`], repo.dir);
  const allowlist = path.join(root, 'auth-baselines.json');
  writeFileSync(allowlist, JSON.stringify({ baselines: [{ sha: baseline }] }));

  const authorize = (releaseSha, branch) => {
    const out = mkdtempSync(path.join(root, 'out-'));
    const r = spawnSync(process.execPath, [SCRIPT, 'authorize'], {
      cwd: repo.dir, encoding: 'utf8',
      env: childEnv({ RELEASE_SHA: releaseSha, RELEASE_BRANCH: branch, BASELINE_SHA: baseline, OUT_DIR: out, PARQUEEN_RELEASE_BASELINES: allowlist }),
    });
    return { code: r.status, text: r.stdout + r.stderr, record: JSON.parse(readFileSync(path.join(out, 'authorize.json'), 'utf8')) };
  };

  it('authorizes the exact branch head and records commit, tree and inventory', () => {
    const r = authorize(release, 'release/good');
    expect(r.code).toBe(0);
    expect(r.record).toMatchObject({ ok: true, releaseSha: release, baselineSha: baseline, changedFiles: 2, violations: [] });
    expect(r.record.releaseTree).toBe(run(['rev-parse', `${release}^{tree}`], repo.dir));
  });

  it('fails closed when the branch points elsewhere, is missing, or the release leaves scope', () => {
    expect(authorize(release, 'release/bad').text).toMatch(/points to .* not the authorized/);
    expect(authorize(release, 'release/missing').text).toMatch(/not on origin/);
    const scoped = authorize(bad, 'release/bad');
    expect(scoped.code).toBe(1);
    expect(scoped.record.violations).toEqual([{ path: 'functions/index.js', why: 'Cloud Functions source or dependencies' }]);
  });

  it('fails closed when the baseline is not an ancestor', () => {
    run(['checkout', '-q', '--orphan', 'other'], repo.dir);
    repo.write('App.tsx', 'unrelated\n');
    const unrelated = repo.commit('unrelated');
    run(['push', '-q', 'origin', `${unrelated}:refs/heads/release/unrelated`], repo.dir);
    expect(authorize(unrelated, 'release/unrelated').text).toMatch(/not an ancestor/);
  });
});

describe('historical verifier binding (transition)', () => {
  // The baseline carries an OLDER guard: today's guard without the exact-SHA workflow policy entry.
  const current = Object.fromEntries(VERIFIER_FILES.map(f => [f, readFileSync(path.join(HERE, path.basename(f)))]));
  const olderGuard = Buffer.from(current['scripts/ci/provenance-change-guard.mjs'].toString('utf8')
    .split(/\r?\n/).filter(l => !l.includes("'.github/workflows/release-exact-sha-verify.yml'") && !l.includes('Defines exact-SHA release evidence')).join('\n'));
  const repo = makeRepo('hist');
  repo.write('App.tsx', 'base\n');
  repo.write('scripts/ci/provenance-change-guard.mjs', olderGuard);
  repo.write('scripts/ci/provenance-evidence.mjs', current['scripts/ci/provenance-evidence.mjs']);
  repo.write('scripts/ci/provenance-trust-anchor.json', current['scripts/ci/provenance-trust-anchor.json']);
  const baseline = repo.commit('baseline with older verifier');
  repo.write('App.tsx', 'feature\n');
  const clean = repo.commit('client change');
  repo.write('.github/workflows/release-exact-sha-verify.yml', 'name: x\n');
  const policy = repo.commit('touches the exact-SHA workflow');
  run(['checkout', '-q', '-b', 'backend', clean], repo.dir);
  repo.write('functions/x.js', 'x\n');
  const backend = repo.commit('backend');

  const record = overrides => ({
    sha: baseline,
    verifier: {
      historical: Object.fromEntries(VERIFIER_FILES.map(f => [f, {
        blob: run(['rev-parse', `${baseline}:${f}`], repo.dir),
        sha256: sha(f.endsWith('change-guard.mjs') ? olderGuard : current[f]),
      }])),
      currentPolicy: Object.fromEntries(VERIFIER_FILES.map(f => [f, { sha256: sha(current[f]) }])),
      ...overrides,
    },
  });
  const provenance = (releaseSha, rec) => {
    const file = path.join(mkdtempSync(path.join(root, 'rec-')), 'baselines.json');
    writeFileSync(file, JSON.stringify({ baselines: [rec] }));
    const out = mkdtempSync(path.join(root, 'prov-'));
    const r = spawnSync(process.execPath, [SCRIPT, 'provenance'], {
      cwd: repo.dir, encoding: 'utf8',
      env: childEnv({ RELEASE_SHA: releaseSha, BASELINE_SHA: baseline, OUT_DIR: out, PARQUEEN_RELEASE_BASELINES: file }),
    });
    const result = existsSync(path.join(out, 'provenance.json')) ? JSON.parse(readFileSync(path.join(out, 'provenance.json'), 'utf8')) : null;
    return { code: r.status, text: r.stdout + r.stderr, result };
  };

  it('passes when the reviewed historical verifier and the current policy both clear the diff', () => {
    const r = provenance(clean, record());
    expect(r.text).toContain('PROVENANCE_PASS');
    expect(r.code).toBe(0);
    expect(r.result).toMatchObject({ ok: true, historicalVerifier: { pass: true }, currentPolicy: { pass: true, notClear: [] } });
  });

  it('rejects a baseline verifier that is not the reviewed version', () => {
    const rec = record();
    rec.verifier.historical['scripts/ci/provenance-change-guard.mjs'].sha256 = 'f'.repeat(64);
    expect(provenance(clean, rec).text).toMatch(/not the reviewed historical verifier/);
    const rec2 = record();
    rec2.verifier.historical['scripts/ci/provenance-evidence.mjs'].blob = 'e'.repeat(40);
    expect(provenance(clean, rec2).code).toBe(1);
  });

  it('rejects a current policy that changed since review', () => {
    const rec = record();
    rec.verifier.currentPolicy['scripts/ci/provenance-change-guard.mjs'].sha256 = '0'.repeat(64);
    expect(provenance(clean, rec).text).toMatch(/not the reviewed trusted policy/);
  });

  it('fails closed when the current policy is stricter than the historical verifier', () => {
    const r = provenance(policy, record());
    expect(r.code).toBe(1);
    expect(r.result.historicalVerifier.pass).toBe(true);
    expect(r.result.currentPolicy.notClear).toEqual([{ file: '.github/workflows/release-exact-sha-verify.yml', decision: 'critical' }]);
  });

  it('fails closed on a provenance-critical path, with no founder-evidence route', () => {
    const r = provenance(backend, record());
    expect(r.code).toBe(1);
    expect(r.result.historicalVerifier.pass).toBe(false);
    expect(r.result.currentPolicy.notClear.map(c => c.file)).toEqual(['functions/x.js']);
  });

  it('rejects a record without a reviewed verifier binding', () => {
    expect(checkVerifierRecord({ sha: baseline }, () => null, () => null).length).toBe(VERIFIER_FILES.length);
  });
});
