import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  BASELINES_FILE,
  baselinesPath,
  codeqlFindings,
  disposition,
  failedTests,
  parseNameStatus,
  scopeViolations,
  semanticViolation,
  validateInputs,
} from './release-exact-sha.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'release-exact-sha.mjs');
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const allow = { baselines: [{ sha: A }] };
const entries = paths => paths.map(p => ({ status: 'M', path: p }));
const noBlob = () => null;

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

  it('ships exactly the verified live baseline', () => {
    const file = JSON.parse(readFileSync(BASELINES_FILE, 'utf8'));
    expect(file.baselines.map(b => [b.sha, b.hostingVersion])).toEqual([
      ['a7d53cc8ef2738331cb5d9c8394b21b8cb3ecaab', 'f8a02be15a2e22ca'],
    ]);
  });

  it('ignores the local allowlist override inside GitHub Actions', () => {
    expect(baselinesPath({ GITHUB_ACTIONS: 'true', PARQUEEN_RELEASE_BASELINES: '/tmp/evil.json' })).toBe(BASELINES_FILE);
    expect(baselinesPath({ PARQUEEN_RELEASE_BASELINES: 'x.json' })).toBe(path.resolve('x.json'));
  });
});

describe('scope policy', () => {
  it('rejects backend, rules, CI policy, runtime source, S7, claim/handoff and Street Intelligence paths', () => {
    const blocked = [
      'functions/index.js', 'functions/package-lock.json', 'firestore.rules', 'storage.rules', 'firestore.indexes.json',
      'firestore.interim.rules', 'firebase.interim-rules.json', '.firebaserc', 'data/runtime-source/x.json',
      'scripts/ci/provenance-change-guard.mjs', '.github/workflows/pr-gate.yml', 'scripts/release-preflight/run-all.mjs',
      'test-fixtures/production-baseline/x.rules', 'utils/s7Locks.ts', 'views/street-parking/useInterestFlow.ts',
      'views/street-parking/claimSpotCallable.ts', 'views/street-parking/completeHandoffSuccessCallable.ts',
      'views/street-parking/activeIncomingClaim.ts', 'utils/canonicalCurbClient.ts', 'utils/streetIntelligence.ts',
      'views/street-parking/StreetIntelligenceCard.tsx', 'package-lock.json', 'android/app/google-services.json',
      'vite.config.ts', 'vite.rules.config.ts', 'playwright.config.ts', 'tsconfig.json', '.gitleaks.toml', '.gitleaksignore',
    ];
    const hits = scopeViolations(entries(blocked), noBlob).map(v => v.path);
    expect(hits).toEqual(blocked);
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

  it('checks both sides of a rename', () => {
    const parsed = parseNameStatus('R100\tfunctions/old.js\tutils/new.ts\n');
    expect(scopeViolations(parsed.entries, noBlob).map(v => v.path)).toEqual(['functions/old.js']);
  });

  it('fails closed on unparseable name-status output', () => {
    expect(parseNameStatus('M\n').error).toBeTruthy();
    expect(parseNameStatus('R100\tonly-one\n').error).toBeTruthy();
  });

  it('allows firebase.json only when hosting.headers change', () => {
    const base = JSON.stringify({ hosting: { public: 'dist', headers: [] }, functions: { source: 'functions' } });
    const headers = JSON.stringify({ hosting: { public: 'dist', headers: [{ source: '/theme-boot.js' }] }, functions: { source: 'functions' } });
    const predeploy = JSON.stringify({ hosting: { public: 'dist', headers: [] }, functions: { source: 'functions', predeploy: ['x'] } });
    const rewrite = JSON.stringify({ hosting: { public: 'dist', headers: [], rewrites: [{ source: '**' }] }, functions: { source: 'functions' } });
    expect(semanticViolation('firebase.json', base, headers)).toBeNull();
    expect(semanticViolation('firebase.json', base, predeploy)).toMatch(/more than hosting.headers/);
    expect(semanticViolation('firebase.json', base, rewrite)).toMatch(/more than hosting.headers/);
    expect(semanticViolation('firebase.json', base, '{')).toMatch(/not valid JSON/);
  });

  it('allows package.json script edits but not dependency or gate-script changes', () => {
    const pkg = extra => JSON.stringify({ scripts: { build: 'vite build', 'test:street-intel': 'a', ...extra.scripts }, dependencies: { react: '18' }, ...extra.top });
    expect(semanticViolation('package.json', pkg({}), pkg({ scripts: { 'test:street-intel': 'b' } }))).toBeNull();
    expect(semanticViolation('package.json', pkg({}), pkg({ scripts: { build: 'echo skip' } }))).toMatch(/gate script build/);
    expect(semanticViolation('package.json', pkg({}), pkg({ top: { dependencies: { react: '19' } } }))).toMatch(/dependencies/);
    expect(semanticViolation('package.json', pkg({}), pkg({ top: { overrides: { x: '1' } } }))).toMatch(/overrides/);
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

describe('disposition', () => {
  const ok = { outcomes: { 'npm-ci': 0, 'unit-tests': 0, typecheck: 0 }, failedTests: [] };
  const base = { authorizeOk: true, branchUnchanged: true, gitleaks: 0, codeql: { 'javascript-typescript': 0, actions: 0 } };

  it('passes only when every release check passed', () => {
    expect(disposition({ ...base, release: ok, baseline: ok }).result).toBe('PASS');
  });

  it('fails on a release-only failure, a moved branch, a scope failure, a secret or a CodeQL finding', () => {
    expect(disposition({ ...base, release: { ...ok, outcomes: { ...ok.outcomes, typecheck: 1 } }, baseline: ok }).result).toBe('FAIL');
    expect(disposition({ ...base, branchUnchanged: false, release: ok, baseline: ok }).result).toBe('FAIL');
    expect(disposition({ ...base, authorizeOk: false, release: ok, baseline: ok }).result).toBe('FAIL');
    expect(disposition({ ...base, gitleaks: 1, release: ok, baseline: ok }).result).toBe('FAIL');
    expect(disposition({ ...base, codeql: { actions: 1 }, release: ok, baseline: ok }).result).toBe('FAIL');
    expect(disposition({ ...base, release: null, baseline: ok }).result).toBe('FAIL');
  });

  it('blocks (never passes) when a failure is shared with the baseline, and fails on any new test', () => {
    const shared = { outcomes: { ...ok.outcomes, 'unit-tests': 1 }, failedTests: ['a > x'] };
    expect(disposition({ ...base, release: shared, baseline: shared }).result).toBe('BLOCKED');
    const extra = { outcomes: shared.outcomes, failedTests: ['a > x', 'b > new'] };
    const d = disposition({ ...base, release: extra, baseline: shared });
    expect(d.result).toBe('FAIL');
    expect(d.reasons.join(' ')).toContain('b > new');
    const noTests = { outcomes: shared.outcomes, failedTests: [] };
    expect(disposition({ ...base, release: noTests, baseline: shared }).result).toBe('FAIL');
  });

  it('names failing tests relative to the repository', () => {
    expect(failedTests({ testResults: [
      { name: '/home/runner/work/ParQueen/ParQueen/functions/a.test.js', status: 'failed', assertionResults: [{ status: 'failed', ancestorTitles: ['S'], title: 't' }] },
      { name: 'C:\\w\\utils\\b.test.ts', status: 'failed', assertionResults: [] },
    ] })).toEqual(['functions/a.test.js > S > t', 'utils/b.test.ts [suite]']);
  });
});

describe('authorize against real git repositories', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'pq-exact-sha-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const run = (args, cwd) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const origin = path.join(root, 'origin.git');
  const work = path.join(root, 'work');
  run(['init', '-q', '--bare', origin], root);
  run(['init', '-q', '-b', 'main', work], root);
  run(['config', 'core.autocrlf', 'false'], work);
  const write = (file, text) => { mkdirSync(path.dirname(path.join(work, file)), { recursive: true }); writeFileSync(path.join(work, file), text); };
  write('App.tsx', 'base\n');
  write('firebase.json', JSON.stringify({ hosting: { public: 'dist', headers: [] } }));
  run(['add', '-A'], work); run(['commit', '-q', '-m', 'base'], work);
  const baseline = run(['rev-parse', 'HEAD'], work);
  write('App.tsx', 'feature\n');
  write('firebase.json', JSON.stringify({ hosting: { public: 'dist', headers: [{ source: '/theme-boot.js' }] } }));
  run(['add', '-A'], work); run(['commit', '-q', '-m', 'feature'], work);
  const release = run(['rev-parse', 'HEAD'], work);
  run(['checkout', '-q', '-b', 'scope-bad'], work);
  write('functions/index.js', 'x\n');
  run(['add', '-A'], work); run(['commit', '-q', '-m', 'backend'], work);
  const bad = run(['rev-parse', 'HEAD'], work);
  run(['remote', 'add', 'origin', origin], work);
  run(['push', '-q', 'origin', `${release}:refs/heads/release/good`, `${bad}:refs/heads/release/bad`, `${baseline}:refs/heads/main`], work);
  const allowlist = path.join(root, 'baselines.json');
  writeFileSync(allowlist, JSON.stringify({ baselines: [{ sha: baseline }] }));

  const authorize = (releaseSha, branch, extra = {}) => {
    const out = mkdtempSync(path.join(root, 'out-'));
    const r = spawnSync(process.execPath, [SCRIPT, 'authorize'], {
      cwd: work,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_ACTIONS: '', GITHUB_OUTPUT: '', RELEASE_SHA: releaseSha, RELEASE_BRANCH: branch, BASELINE_SHA: baseline, OUT_DIR: out, PARQUEEN_RELEASE_BASELINES: allowlist, ...extra },
    });
    return { code: r.status, text: r.stdout + r.stderr, record: JSON.parse(readFileSync(path.join(out, 'authorize.json'), 'utf8')) };
  };

  it('authorizes the exact branch head and records commit, tree and inventory', () => {
    const r = authorize(release, 'release/good');
    expect(r.code).toBe(0);
    expect(r.text).toContain(`RELEASE_EXACT_SHA: AUTHORIZED ${release}`);
    expect(r.record).toMatchObject({ ok: true, releaseSha: release, baselineSha: baseline, changedFiles: 2, violations: [] });
    expect(r.record.releaseTree).toBe(run(['rev-parse', `${release}^{tree}`], work));
  });

  it('fails closed when the branch points elsewhere, is missing, or the release leaves scope', () => {
    expect(authorize(release, 'release/bad').text).toMatch(/points to .* not the authorized/);
    expect(authorize(release, 'release/missing').text).toMatch(/not on origin/);
    const scoped = authorize(bad, 'release/bad');
    expect(scoped.code).toBe(1);
    expect(scoped.record.violations).toEqual([{ path: 'functions/index.js', why: 'Cloud Functions source or dependencies' }]);
  });

  it('fails closed when the baseline is not an ancestor', () => {
    run(['checkout', '-q', '--orphan', 'other'], work);
    write('App.tsx', 'unrelated\n');
    run(['add', '-A'], work); run(['commit', '-q', '-m', 'unrelated'], work);
    const unrelated = run(['rev-parse', 'HEAD'], work);
    run(['push', '-q', 'origin', `${unrelated}:refs/heads/release/unrelated`], work);
    expect(authorize(unrelated, 'release/unrelated').text).toMatch(/not an ancestor/);
  });
});
