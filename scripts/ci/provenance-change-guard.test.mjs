import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decisionForPath, pathsFromNameStatus } from './provenance-change-guard.mjs';

const guard = fileURLToPath(new URL('./provenance-change-guard.mjs', import.meta.url));
const repo = path.resolve(path.dirname(guard), '../..');
const HARNESS_FILES = [
  'views/street-parking/handoffReachability.regression.test.ts',
  'views/street-parking/handoffHarnessTeardown.regression.test.ts',
];

function guardEnv(env = {}) {
  const childEnv = { ...process.env, ...env };
  for (const key of ['PR_BASE_SHA', 'PR_HEAD_SHA', 'PR_NUMBER', 'GITHUB_EVENT_NAME']) {
    if (!(key in env)) delete childEnv[key];
  }
  for (const key of ['PR_NUMBER', 'GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_ENTERPRISE_TOKEN']) {
    delete childEnv[key];
  }
  return childEnv;
}

function runGuard(args = [], env = {}, cwd = repo) {
  return spawnSync(process.execPath, [guard, ...args], {
    cwd,
    env: guardEnv(env),
    encoding: 'utf8',
  });
}

function gitIn(cwd, args) {
  const result = spawnSync('git', [
    '-c', 'user.name=provenance-guard-test',
    '-c', 'user.email=provenance-guard-test@example.com',
    '-c', 'commit.gpgsign=false',
    ...args,
  ], {
    cwd,
    encoding: 'utf8',
    env: guardEnv(),
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function withSyntheticRepo(run) {
  const dir = mkdtempSync(path.join(tmpdir(), 'parqueen-guard-'));
  try {
    gitIn(dir, ['init', '-b', 'main']);
    writeFileSync(path.join(dir, 'README.txt'), 'harmless fixture\n');
    gitIn(dir, ['add', '--', 'README.txt']);
    gitIn(dir, ['commit', '-m', 'base']);
    const base = gitIn(dir, ['rev-parse', 'HEAD']);
    run(dir, base);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('provenance change classification', () => {
  it('treats every functions/index.js change as critical', () => {
    for (const patch of [
      " sourceCertification: 'CERTIFIED'",
      ' dependencies.resolveCanonicalCurb = replacement',
      ' const unchanged = 1;',
      '',
      null,
    ]) {
      expect(decisionForPath('functions/index.js', patch)).toBe('critical');
    }
  });

  it('treats Functions implementation files as critical, including outside curbIntelligence', () => {
    expect(decisionForPath('functions/newReleaseSwitch.js')).toBe('critical');
    expect(decisionForPath('functions/curbIntelligence/runtimeSourceArtifact.js')).toBe('critical');
    expect(decisionForPath('functions/curbIntelligence/canonicalCurbOrchestrator.js')).toBe('critical');
    expect(decisionForPath('functions/testHelper.js')).toBe('critical');
    expect(decisionForPath('Functions/newReleaseSwitch.js')).toBe('critical');
  });

  it('keeps private provenance and CI policy critical', () => {
    expect(decisionForPath('functions/curbIntelligence/provenanceAndConflict.test.cjs')).toBe('critical');
    expect(decisionForPath('scripts/ci/provenance-change-guard.mjs')).toBe('critical');
    expect(decisionForPath('scripts/ci/general-pr-suite.mjs')).toBe('critical');
    expect(decisionForPath('.github/workflows/pr-gate.yml')).toBe('critical');
    expect(decisionForPath('data/runtime-source/runtime-source-artifact.json')).toBe('critical');
  });

  it('keeps recognized portable tests and the public fixture non-critical', () => {
    expect(decisionForPath('functions/curbIntelligence/streetContextDryRun.test.js')).toBe('clear');
    expect(decisionForPath('functions/curbIntelligence/runtimeSourceArtifact.test.js')).toBe('clear');
    expect(decisionForPath('functions/streetIntelRefresh.test.js')).toBe('clear');
    expect(decisionForPath('functions/curbIntelligence/fixtures/si-block-association-02-physicalid-5.json')).toBe('clear');
    expect(decisionForPath('utils/rateLimiter.test.ts')).toBe('clear');
    expect(decisionForPath('views/street-parking/handoffReachability.regression.test.ts')).toBe('clear');
    expect(decisionForPath('views/street-parking/handoffHarnessTeardown.regression.test.ts')).toBe('clear');
  });

  it('fails closed on an unreadable path', () => {
    expect(decisionForPath('')).toBe('undetermined');
    expect(decisionForPath('functions/index.js\0')).toBe('undetermined');
    expect(decisionForPath('"functions/newReleaseSwitch.js"')).toBe('undetermined');
  });

  it('classifies added, deleted, and renamed implementation paths', () => {
    const added = pathsFromNameStatus('A\tfunctions/newReleaseSwitch.js\n');
    expect(added.files).toEqual(['functions/newReleaseSwitch.js']);
    expect(decisionForPath(added.files[0])).toBe('critical');

    const deleted = pathsFromNameStatus('D\tfunctions/index.js\n');
    expect(decisionForPath(deleted.files[0])).toBe('critical');

    const renamed = pathsFromNameStatus(
      'R100\tfunctions/curbIntelligence/streetContextDryRun.test.js\tfunctions/newReleaseSwitch.js\n',
    );
    expect(renamed.files).toEqual([
      'functions/curbIntelligence/streetContextDryRun.test.js',
      'functions/newReleaseSwitch.js',
    ]);
    expect(renamed.files.some((file) => decisionForPath(file) === 'critical')).toBe(true);

    const copied = pathsFromNameStatus(
      'C050\tfunctions/curbIntelligence/runtimeSourceArtifact.js\tfunctions/newReleaseSwitch.js\n',
    );
    expect(copied.files.every((file) => decisionForPath(file) === 'critical')).toBe(true);
  });

  it('fails closed when a diff cannot be classified', () => {
    expect(pathsFromNameStatus('').error).toBeTruthy();
    expect(pathsFromNameStatus('R100\tfunctions/index.js\n').error).toBeTruthy();
    expect(pathsFromNameStatus('NOTAB\n').error).toBeTruthy();
  });
});

describe('provenance change guard command', () => {
  it('fails closed when the diff is missing', () => {
    const result = runGuard();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('PROVENANCE_GUARD: FAIL_CLOSED');
    expect(result.stderr).toContain('PRIVATE_PROVENANCE_VERIFICATION_REQUIRED');
    expect(result.stdout).not.toContain('PROVENANCE_GUARD: PASS');
  });

  it('fails closed for workflow_dispatch and an unreadable file argument', () => {
    const dispatched = runGuard([], {
      GITHUB_EVENT_NAME: 'workflow_dispatch',
    });
    expect(dispatched.status).toBe(1);
    expect(dispatched.stderr).toContain('FAIL_CLOSED');

    const missing = runGuard(['--file']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('FAIL_CLOSED');

    const quoted = runGuard(['--file', '"functions/newReleaseSwitch.js"']);
    expect(quoted.status).toBe(1);
    expect(quoted.stderr).toContain('FAIL_CLOSED');
    expect(quoted.stderr).toContain('classification failed');
  });

  it('fails closed for the confirmed index and new-module bypasses', () => {
    const result = runGuard([
      '--file', 'functions/index.js',
      '--file', 'functions/newReleaseSwitch.js',
      '--file', 'functions/curbIntelligence/runtimeSourceArtifact.js',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CRITICAL functions/index.js');
    expect(result.stderr).toContain('CRITICAL functions/newReleaseSwitch.js');
    expect(result.stderr).toContain('CRITICAL functions/curbIntelligence/runtimeSourceArtifact.js');
    expect(result.stderr).toContain('No private check was recorded.');
    expect(result.stdout).not.toContain('PROVENANCE_GUARD: PASS');
  });

  it('passes a two-file harness diff through the real git classifier', () => {
    withSyntheticRepo((dir, base) => {
      for (const file of HARNESS_FILES) {
        const full = path.join(dir, file);
        mkdirSync(path.dirname(full), { recursive: true });
        writeFileSync(full, 'export {}\n');
      }
      gitIn(dir, ['add', '--', ...HARNESS_FILES]);
      gitIn(dir, ['commit', '-m', 'harness']);
      const head = gitIn(dir, ['rev-parse', 'HEAD']);
      const names = gitIn(dir, ['diff', '--name-only', `${base}...${head}`]);
      expect(names.split(/\r?\n/).filter(Boolean).sort()).toEqual([...HARNESS_FILES].sort());

      const harness = runGuard([], {
        GITHUB_EVENT_NAME: 'pull_request',
        PR_BASE_SHA: base,
        PR_HEAD_SHA: head,
      }, dir);
      expect(harness.status).toBe(0);
      expect(harness.stdout).toContain('PROVENANCE_GUARD: PASS');
      expect(harness.stdout).toContain('GENERAL_PR_SUITE_EXCLUSION: functions/curbIntelligence/provenanceAndConflict.test.cjs');
    });
  });

  it('fails closed when a synthetic diff modifies functions/index.js', () => {
    withSyntheticRepo((dir, base) => {
      const index = path.join(dir, 'functions', 'index.js');
      mkdirSync(path.dirname(index), { recursive: true });
      writeFileSync(index, 'export {}\n');
      gitIn(dir, ['add', '--', 'functions/index.js']);
      gitIn(dir, ['commit', '-m', 'add index']);
      const added = gitIn(dir, ['rev-parse', 'HEAD']);
      writeFileSync(index, 'export const marker = 1;\n');
      gitIn(dir, ['add', '--', 'functions/index.js']);
      gitIn(dir, ['commit', '-m', 'modify index']);
      const head = gitIn(dir, ['rev-parse', 'HEAD']);
      const names = gitIn(dir, ['diff', '--name-only', `${added}...${head}`]);
      expect(names.trim()).toBe('functions/index.js');

      const result = runGuard([], {
        GITHUB_EVENT_NAME: 'pull_request',
        PR_BASE_SHA: added,
        PR_HEAD_SHA: head,
      }, dir);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('PROVENANCE_GUARD: FAIL_CLOSED');
      expect(result.stderr).toContain('PRIVATE_PROVENANCE_VERIFICATION_REQUIRED');
      expect(result.stderr).toContain('CRITICAL functions/index.js');
      expect(result.stdout).not.toContain('PROVENANCE_GUARD: PASS');
      expect(base).toMatch(/^[0-9a-f]{40}$/);
    });
  });

  it('keeps a portable test non-critical on the command path', () => {
    const portable = runGuard([
      '--file', 'functions/curbIntelligence/streetContextDryRun.test.js',
      '--file', 'functions/curbIntelligence/fixtures/si-block-association-02-physicalid-5.json',
      '--file', 'views/street-parking/handoffReachability.regression.test.ts',
      '--file', 'views/street-parking/handoffHarnessTeardown.regression.test.ts',
    ]);
    expect(portable.status).toBe(0);
    expect(portable.stdout).toContain('PROVENANCE_GUARD: PASS');
  });
});
