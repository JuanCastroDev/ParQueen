import { spawnSync } from 'node:child_process';
import { createHash, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ARTIFACT_SHA256,
  ARTIFACT_SIZE,
  EVIDENCE_CLASS,
  EVIDENCE_REF_PREFIX,
  EVIDENCE_SCHEMA,
  REPOSITORY,
  RUNNER_PATH,
  SUITE_PATH,
  TRUST_ANCHOR_SCHEMA,
  canonicalize,
  loadTrustAnchor,
  signFounderPayload,
  verifyFounderEvidence,
} from './provenance-evidence.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const guard = path.join(here, 'provenance-change-guard.mjs');
const signer = path.join(here, 'provenance-evidence.mjs');
const FIXED_NOW = new Date('2026-10-27T18:00:00.000Z');

function git(cwd, args, encoding = 'utf8') {
  const result = spawnSync('git', [
    '-c', 'user.name=provenance-guard-test',
    '-c', 'user.email=provenance-guard-test@example.com',
    '-c', 'commit.gpgsign=false',
    '-c', 'core.autocrlf=false',
    ...args,
  ], { cwd, encoding });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  return encoding === 'utf8' ? result.stdout.trim() : result.stdout;
}

function writeRepoFile(dir, file, contents) {
  const full = path.join(dir, file);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents);
  return full;
}

function makeKey(id = 'founder-test', status = 'active') {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    id,
    privateKey,
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    status,
  };
}

function anchorWith(keys) {
  return loadTrustAnchor(JSON.stringify({
    schema: TRUST_ANCHOR_SCHEMA,
    repository: REPOSITORY,
    founderIdentity: 'parqueen-founder',
    keys: keys.map((key) => ({ id: key.id, publicKey: key.publicKey, status: key.status })),
  }));
}

function basePayload(overrides = {}) {
  const executedAt = FIXED_NOW.toISOString();
  return {
    schema: EVIDENCE_SCHEMA,
    evidenceClass: EVIDENCE_CLASS,
    repository: REPOSITORY,
    head: 'a'.repeat(40),
    tree: 'b'.repeat(40),
    base: 'c'.repeat(40),
    criticalPaths: ['functions/index.js'],
    runner: { path: RUNNER_PATH, sha256: 'd'.repeat(64) },
    suite: { path: SUITE_PATH, sha256: 'e'.repeat(64) },
    artifact: { size: ARTIFACT_SIZE, sha256: ARTIFACT_SHA256 },
    tests: { executed: 11, passed: 11, failed: 0, skipped: 0, exitCode: 0 },
    founderIdentity: 'parqueen-founder',
    executedAt,
    attestationId: 'attestation-local-01',
    expiresAt: new Date(FIXED_NOW.getTime() + 24 * 60 * 60 * 1000).toISOString(),
    ...overrides,
  };
}

function contextFor(payload, anchor, overrides = {}) {
  return {
    head: payload.head,
    tree: payload.tree,
    base: payload.base,
    criticalPaths: payload.criticalPaths,
    runnerSha256: payload.runner.sha256,
    suiteSha256: payload.suite.sha256,
    trustAnchor: anchor,
    now: FIXED_NOW,
    ...overrides,
  };
}

function documentText(payload, key) {
  return JSON.stringify(signFounderPayload(payload, key.privateKey, key.id));
}

function sealRaw(payload, key) {
  const signature = sign(null, Buffer.from(canonicalize(payload), 'utf8'), key.privateKey);
  return JSON.stringify({
    schema: EVIDENCE_SCHEMA,
    evidenceClass: EVIDENCE_CLASS,
    keyId: key.id,
    payload,
    signature: signature.toString('base64'),
  });
}

function expectRejected(payload, key, anchor, overrides, reason) {
  const verdict = verifyFounderEvidence(documentText(payload, key), contextFor(payload, anchor, overrides));
  expect(verdict.ok).toBe(false);
  expect(verdict.reason).toBe(reason);
}

function cleanEnv(env = {}) {
  const child = { ...process.env, ...env };
  for (const key of [
    'GITHUB_ACTIONS', 'GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_ENTERPRISE_TOKEN',
    'PR_NUMBER', 'PR_BASE_SHA', 'PR_HEAD_SHA', 'GITHUB_EVENT_NAME', 'PARQUEEN_PROVENANCE_TRUST_ANCHOR',
    'PARQUEEN_PROVENANCE_SUCCESSOR', 'PARQUEEN_PROVENANCE_SIGNING_KEY',
  ]) {
    if (!(key in env)) delete child[key];
  }
  return child;
}

function runGuard(cwd, env = {}) {
  return spawnSync(process.execPath, [guard], {
    cwd,
    encoding: 'utf8',
    env: cleanEnv(env),
  });
}

function publish(dir, head, text, extra = []) {
  const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], {
    cwd: dir,
    input: text,
    encoding: 'utf8',
  });
  if (blob.status !== 0) throw new Error(blob.stderr || 'hash-object failed');
  let treeInput = `100644 blob ${blob.stdout.trim()}\tevidence.json\n`;
  for (const file of extra) {
    const extraBlob = spawnSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: dir,
      input: file.text,
      encoding: 'utf8',
    });
    if (extraBlob.status !== 0) throw new Error(extraBlob.stderr || 'hash-object failed');
    treeInput += `100644 blob ${extraBlob.stdout.trim()}\t${file.path}\n`;
  }
  const tree = spawnSync('git', ['mktree'], { cwd: dir, input: treeInput, encoding: 'utf8' });
  if (tree.status !== 0) throw new Error(tree.stderr || 'mktree failed');
  const commit = spawnSync('git', [
    '-c', 'user.name=provenance-guard-test',
    '-c', 'user.email=provenance-guard-test@example.com',
    'commit-tree', tree.stdout.trim(), '-m', 'founder evidence',
  ], { cwd: dir, encoding: 'utf8' });
  if (commit.status !== 0) throw new Error(commit.stderr || 'commit-tree failed');
  const updated = spawnSync('git', ['update-ref', `${EVIDENCE_REF_PREFIX}${head}`, commit.stdout.trim()], {
    cwd: dir,
    encoding: 'utf8',
  });
  if (updated.status !== 0) throw new Error(updated.stderr || 'update-ref failed');
  return commit.stdout.trim();
}

function blobSha(dir, commit, file) {
  const data = git(dir, ['cat-file', 'blob', `${commit}:${file}`], 'buffer');
  return createHash('sha256').update(data).digest('hex');
}

function criticalRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), 'parqueen-evidence-'));
  git(dir, ['init', '-b', 'main']);
  writeRepoFile(dir, RUNNER_PATH, 'runner-bytes\n');
  writeRepoFile(dir, SUITE_PATH, 'suite-bytes\n');
  git(dir, ['add', '--', RUNNER_PATH, SUITE_PATH]);
  git(dir, ['commit', '-m', 'base']);
  const base = git(dir, ['rev-parse', 'HEAD']);
  writeRepoFile(dir, 'functions/index.js', 'export {}\n');
  git(dir, ['add', '--', 'functions/index.js']);
  git(dir, ['commit', '-m', 'critical']);
  const head = git(dir, ['rev-parse', 'HEAD']);
  const tree = git(dir, ['rev-parse', `${head}^{tree}`]);
  const hashes = {
    runner: blobSha(dir, head, RUNNER_PATH),
    suite: blobSha(dir, head, SUITE_PATH),
  };
  return { dir, base, head, tree, hashes };
}

function payloadFromRepo(fixture, overrides = {}) {
  const now = new Date();
  return {
    payload: {
      schema: EVIDENCE_SCHEMA,
      evidenceClass: EVIDENCE_CLASS,
      repository: REPOSITORY,
      head: fixture.head,
      tree: fixture.tree,
      base: fixture.base,
      criticalPaths: ['functions/index.js'],
      runner: { path: RUNNER_PATH, sha256: fixture.hashes.runner },
      suite: { path: SUITE_PATH, sha256: fixture.hashes.suite },
      artifact: { size: ARTIFACT_SIZE, sha256: ARTIFACT_SHA256 },
      tests: { executed: 11, passed: 11, failed: 0, skipped: 0, exitCode: 0 },
      founderIdentity: 'parqueen-founder',
      executedAt: now.toISOString(),
      attestationId: 'attestation-repo-01',
      expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
      ...overrides,
    },
    now,
  };
}

function writeOwnerOnly(file, contents) {
  const handle = openSync(file, 'wx', 0o600);
  try {
    writeFileSync(handle, contents);
  } finally {
    closeSync(handle);
  }
}

function writeAnchorFile(keys) {
  const dir = mkdtempSync(path.join(tmpdir(), 'parqueen-anchor-'));
  const file = path.join(dir, 'anchor.json');
  const anchor = anchorWith(keys);
  writeOwnerOnly(file, `${JSON.stringify({
    schema: anchor.schema,
    repository: anchor.repository,
    founderIdentity: anchor.founderIdentity,
    keys: anchor.keys,
  })}\n`);
  return file;
}

function removeAnchorFile(file) {
  rmSync(path.dirname(file), { recursive: true, force: true });
}

describe('founder evidence document', () => {
  it('creates a temporary trust anchor inside a private directory', () => {
    const file = writeAnchorFile([makeKey()]);
    try {
      expect(path.basename(file)).toBe('anchor.json');
      expect(path.dirname(file)).not.toBe(tmpdir());
      expect(readFileSync(file, 'utf8')).not.toContain('PRIVATE KEY');
      expect(() => openSync(file, 'wx', 0o600)).toThrow();
    } finally {
      removeAnchorFile(file);
    }
  });

  it('binds the runner contract without executing the private suite', () => {
    const runner = readFileSync(path.join(repo, RUNNER_PATH), 'utf8');
    expect(runner).toContain(String(ARTIFACT_SIZE));
    expect(runner).toContain(ARTIFACT_SHA256);
    const source = readFileSync(signer, 'utf8');
    expect(source).not.toContain('generateKeyPair');
    expect(source).not.toContain('PARQUEEN_PROVENANCE_SUCCESSOR');
    expect(source).not.toContain("import('./provenance-change-guard.mjs')");
    expect(source).not.toContain("from './provenance-change-guard.mjs'");
    const anchor = loadTrustAnchor(readFileSync(path.join(here, 'provenance-trust-anchor.json'), 'utf8'));
    expect(anchor.schema).toBe(TRUST_ANCHOR_SCHEMA);
    expect(anchor.repository).toBe(REPOSITORY);
    expect(anchor.founderIdentity).toBe('parqueen-founder');
    expect(anchor.keys.map((entry) => ({ id: entry.id, status: entry.status }))).toEqual([
      { id: 'parqueen-founder-20261027', status: 'revoked' },
      { id: 'parqueen-founder-20261028-r1', status: 'active' },
    ]);
    expect(anchor.keys.filter((entry) => entry.status === 'active')).toHaveLength(1);
    expect(anchor.keys.filter((entry) => entry.status === 'revoked')).toHaveLength(1);
    for (const entry of anchor.keys) {
      expect(entry.publicKey).toContain('BEGIN PUBLIC KEY');
      expect(entry.publicKey).not.toContain('PRIVATE KEY');
      expect(createPublicKey(entry.publicKey).asymmetricKeyType).toBe('ed25519');
    }
    const active = anchor.keys.find((entry) => entry.id === 'parqueen-founder-20261028-r1');
    const der = createPublicKey(active.publicKey).export({ type: 'spki', format: 'der' });
    expect(createHash('sha256').update(der).digest('hex')).toBe('3bce3690dc775b6b9423cc59a8493c19fdd1a661ffd91054b4b90e0e50d73607');
    const payload = basePayload();
    const revokedNamed = makeKey('parqueen-founder-20261027');
    expect(verifyFounderEvidence(documentText(payload, revokedNamed), contextFor(payload, anchor)).reason).toBe('revoked-key');
    const unknown = makeKey('unknown-founder-key');
    expect(verifyFounderEvidence(documentText(payload, unknown), contextFor(payload, anchor)).reason).toBe('unknown-key');
    expect(verifyFounderEvidence('{', contextFor(payload, anchor)).reason).toBe('malformed');
    expect(process.env.PARQUEEN_PROVENANCE_SIGNING_KEY ?? '').toBe('');
    expect(JSON.stringify(anchor)).not.toContain('PRIVATE KEY');
  });

  it('accepts one exact founder-signed claim', () => {
    const key = makeKey();
    const anchor = anchorWith([key]);
    const payload = basePayload();
    const verdict = verifyFounderEvidence(documentText(payload, key), contextFor(payload, anchor));
    expect(verdict).toMatchObject({
      ok: true,
      evidenceClass: 'FOUNDER-EXECUTED',
      attestationId: payload.attestationId,
      head: payload.head,
    });
  });

  it('rejects a forged signature, an unknown key, a revoked key, and a missing signature', () => {
    const key = makeKey();
    const other = makeKey('other-founder');
    const anchor = anchorWith([key]);
    const payload = basePayload();
    const forged = JSON.parse(documentText(payload, key));
    forged.signature = JSON.parse(documentText(basePayload({ attestationId: 'attestation-other-1' }), other)).signature;
    expect(verifyFounderEvidence(JSON.stringify(forged), contextFor(payload, anchor)).reason).toBe('invalid-signature');
    expect(verifyFounderEvidence(documentText(payload, key), contextFor(payload, anchorWith([other]))).reason).toBe('unknown-key');
    expect(verifyFounderEvidence(documentText(payload, key), contextFor(payload, anchorWith([]))).reason).toBe('unknown-key');
    expect(verifyFounderEvidence(documentText(payload, key), contextFor(payload, anchorWith([makeKey(key.id, 'revoked')]))).reason).toBe('revoked-key');
    const unsigned = JSON.parse(documentText(payload, key));
    unsigned.signature = '';
    expect(verifyFounderEvidence(JSON.stringify(unsigned), contextFor(payload, anchor)).reason).toBe('unsigned');
  });

  it('rejects replay onto another commit, tree, base, or critical path set', () => {
    const key = makeKey();
    const anchor = anchorWith([key]);
    const payload = basePayload();
    expectRejected(payload, key, anchor, { head: 'f'.repeat(40) }, 'head-mismatch');
    expectRejected(payload, key, anchor, { tree: 'f'.repeat(40) }, 'tree-mismatch');
    expectRejected(payload, key, anchor, { base: 'f'.repeat(40) }, 'base-mismatch');
    expectRejected(payload, key, anchor, { criticalPaths: ['functions/productAccess.js'] }, 'critical-path-mismatch');
  });

  it('rejects a modified runner or suite blob, an expired claim, and a bad test result', () => {
    const key = makeKey();
    const anchor = anchorWith([key]);
    const payload = basePayload();
    expectRejected(payload, key, anchor, { runnerSha256: 'f'.repeat(64) }, 'runner-mismatch');
    expectRejected(payload, key, anchor, { suiteSha256: 'f'.repeat(64) }, 'suite-mismatch');
    const expired = basePayload({
      executedAt: '2026-10-01T00:00:00.000Z',
      expiresAt: '2026-10-02T00:00:00.000Z',
    });
    expect(verifyFounderEvidence(documentText(expired, key), contextFor(expired, anchor)).reason).toBe('expired');
    const tooLong = basePayload({
      expiresAt: new Date(FIXED_NOW.getTime() + 31 * 24 * 60 * 60 * 1000).toISOString(),
    });
    expect(verifyFounderEvidence(documentText(tooLong, key), contextFor(tooLong, anchor)).reason).toBe('lifetime-exceeded');
    const badTests = basePayload();
    badTests.tests = { ...badTests.tests, passed: 10, failed: 1 };
    expect(verifyFounderEvidence(sealRaw(badTests, key), contextFor(badTests, anchor)).reason).toBe('test-result-mismatch');
  });

  it('rejects malformed, duplicate, and non-founder claims', () => {
    const key = makeKey();
    const anchor = anchorWith([key]);
    const payload = basePayload();
    expect(verifyFounderEvidence('{', contextFor(payload, anchor)).reason).toBe('malformed');
    expect(verifyFounderEvidence('[]', contextFor(payload, anchor)).reason).toBe('ambiguous');
    expect(verifyFounderEvidence(`${documentText(payload, key)}{}`, contextFor(payload, anchor)).reason).toBe('malformed');
    const duplicated = basePayload({ criticalPaths: ['functions/index.js', 'functions/index.js'] });
    expect(verifyFounderEvidence(sealRaw(duplicated, key), contextFor(payload, anchor)).reason).toBe('ambiguous');
    const relabeled = basePayload({ evidenceClass: 'INDEPENDENT' });
    expect(verifyFounderEvidence(sealRaw(relabeled, key), contextFor(payload, anchor)).reason).toBe('evidence-class-mismatch');
    const withPath = basePayload();
    withPath.artifact = { ...withPath.artifact, path: 'secret.bin' };
    expect(verifyFounderEvidence(sealRaw(withPath, key), contextFor(payload, anchor)).reason).toBe('malformed');
    const duplicatedKeys = documentText(payload, key).replace(
      '"evidenceClass":"FOUNDER-EXECUTED"',
      '"evidenceClass":"FOUNDER-EXECUTED","evidenceClass":"FOUNDER-EXECUTED"',
    );
    expect(verifyFounderEvidence(duplicatedKeys, contextFor(payload, anchor)).reason).toBe('duplicate-keys');
    const ambiguousNumber = documentText(payload, key).replace('45710043', '45710043.0');
    expect(verifyFounderEvidence(ambiguousNumber, contextFor(payload, anchor)).reason).toBe('ambiguous-encoding');
    expect(() => loadTrustAnchor(JSON.stringify({
      schema: TRUST_ANCHOR_SCHEMA,
      repository: REPOSITORY,
      founderIdentity: 'parqueen-founder',
      keys: [{ id: 'founder-test', publicKey: '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----', status: 'active' }],
    }))).toThrow('trust anchor rejected');
  });
});

describe('founder evidence guard', () => {
  it('keeps a critical change fail closed when evidence is missing or only a worktree file', () => {
    const fixture = criticalRepo();
    try {
      const missing = runGuard(fixture.dir, {
        GITHUB_EVENT_NAME: 'pull_request',
        PR_BASE_SHA: fixture.base,
        PR_HEAD_SHA: fixture.head,
      });
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('PROVENANCE_GUARD: FAIL_CLOSED');
      expect(missing.stderr).toContain('founder evidence missing');
      expect(missing.stderr).toContain('CRITICAL functions/index.js');
      expect(missing.stderr).toContain('PRIVATE_PROVENANCE_VERIFICATION_REQUIRED');
      expect(missing.stderr).toContain('No private check was recorded.');
      expect(missing.stdout).not.toContain('SIGNED_FOUNDER_EVIDENCE_ACCEPTED');

      const key = makeKey();
      const planted = documentText(payloadFromRepo(fixture).payload, key);
      writeRepoFile(fixture.dir, 'evidence.json', planted);
      const plantedResult = runGuard(fixture.dir, {
        GITHUB_EVENT_NAME: 'pull_request',
        PR_BASE_SHA: fixture.base,
        PR_HEAD_SHA: fixture.head,
      });
      expect(plantedResult.status).toBe(1);
      expect(plantedResult.stderr).toContain('founder evidence missing');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('accepts valid signed evidence and rejects a forged document for the same commit', () => {
    const fixture = criticalRepo();
    const key = makeKey();
    const anchorFile = writeAnchorFile([key]);
    try {
      const { payload } = payloadFromRepo(fixture);
      publish(fixture.dir, fixture.head, documentText(payload, key));
      const accepted = runGuard(fixture.dir, {
        GITHUB_EVENT_NAME: 'pull_request',
        PR_BASE_SHA: fixture.base,
        PR_HEAD_SHA: fixture.head,
        PARQUEEN_PROVENANCE_TRUST_ANCHOR: anchorFile,
      });
      expect(accepted.status).toBe(0);
      expect(accepted.stdout).toContain('PROVENANCE_GUARD: SIGNED_FOUNDER_EVIDENCE_ACCEPTED');
      expect(accepted.stdout).toContain('Evidence class: FOUNDER-EXECUTED');
      expect(accepted.stdout).toContain('GitHub Actions did not execute the private provenance suite.');
      expect(accepted.stdout).not.toContain('PROVENANCE_GUARD: PASS');
      expect(accepted.stderr).not.toContain('PRIVATE PROVENANCE SUITE');

      const forged = JSON.parse(documentText(payload, key));
      forged.signature = Buffer.alloc(64, 7).toString('base64');
      publish(fixture.dir, fixture.head, JSON.stringify(forged));
      const rejected = runGuard(fixture.dir, {
        GITHUB_EVENT_NAME: 'pull_request',
        PR_BASE_SHA: fixture.base,
        PR_HEAD_SHA: fixture.head,
        PARQUEEN_PROVENANCE_TRUST_ANCHOR: anchorFile,
      });
      expect(rejected.status).toBe(1);
      expect(rejected.stderr).toContain('founder evidence rejected: invalid-signature');
      expect(rejected.stdout).not.toContain('SIGNED_FOUNDER_EVIDENCE_ACCEPTED');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
      removeAnchorFile(anchorFile);
    }
  });

  it('rejects replay, a modified runner blob, expiration, and revocation', () => {
    const fixture = criticalRepo();
    const key = makeKey();
    const anchorFile = writeAnchorFile([key]);
    const revokedFile = writeAnchorFile([makeKey(key.id, 'revoked')]);
    try {
      const replay = payloadFromRepo(fixture, { head: fixture.base }).payload;
      publish(fixture.dir, fixture.head, documentText(replay, key));
      const replayed = runGuard(fixture.dir, {
        GITHUB_EVENT_NAME: 'pull_request',
        PR_BASE_SHA: fixture.base,
        PR_HEAD_SHA: fixture.head,
        PARQUEEN_PROVENANCE_TRUST_ANCHOR: anchorFile,
      });
      expect(replayed.stderr).toContain('head-mismatch');

      const tampered = payloadFromRepo(fixture, {
        runner: { path: RUNNER_PATH, sha256: 'f'.repeat(64) },
      }).payload;
      publish(fixture.dir, fixture.head, documentText(tampered, key));
      const runner = runGuard(fixture.dir, {
        GITHUB_EVENT_NAME: 'pull_request',
        PR_BASE_SHA: fixture.base,
        PR_HEAD_SHA: fixture.head,
        PARQUEEN_PROVENANCE_TRUST_ANCHOR: anchorFile,
      });
      expect(runner.stderr).toContain('runner-mismatch');

      const stale = payloadFromRepo(fixture, {
        executedAt: '2026-10-01T00:00:00.000Z',
        expiresAt: '2026-10-02T00:00:00.000Z',
      }).payload;
      publish(fixture.dir, fixture.head, documentText(stale, key));
      const expired = runGuard(fixture.dir, {
        GITHUB_EVENT_NAME: 'pull_request',
        PR_BASE_SHA: fixture.base,
        PR_HEAD_SHA: fixture.head,
        PARQUEEN_PROVENANCE_TRUST_ANCHOR: anchorFile,
      });
      expect(expired.stderr).toContain('expired');

      publish(fixture.dir, fixture.head, documentText(payloadFromRepo(fixture).payload, key));
      const revoked = runGuard(fixture.dir, {
        GITHUB_EVENT_NAME: 'pull_request',
        PR_BASE_SHA: fixture.base,
        PR_HEAD_SHA: fixture.head,
        PARQUEEN_PROVENANCE_TRUST_ANCHOR: revokedFile,
      });
      expect(revoked.status).toBe(1);
      expect(revoked.stderr).toContain('revoked-key');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
      removeAnchorFile(anchorFile);
      removeAnchorFile(revokedFile);
    }
  });

  it('rejects an ambiguous ref and a trust anchor planted in the pull request', () => {
    const fixture = criticalRepo();
    const attacker = makeKey('attacker-key');
    try {
      git(fixture.dir, ['update-ref', `${EVIDENCE_REF_PREFIX}${fixture.head}`, fixture.head]);
      const ambiguous = runGuard(fixture.dir, {
        GITHUB_EVENT_NAME: 'pull_request',
        PR_BASE_SHA: fixture.base,
        PR_HEAD_SHA: fixture.head,
      });
      expect(ambiguous.stderr).toContain('founder evidence rejected: unexpected-tree');

      const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], {
        cwd: fixture.dir,
        input: '{"not":"a commit"}',
        encoding: 'utf8',
      });
      git(fixture.dir, ['update-ref', `${EVIDENCE_REF_PREFIX}${fixture.head}`, blob.stdout.trim()]);
      const wrongObject = runGuard(fixture.dir, {
        GITHUB_EVENT_NAME: 'pull_request',
        PR_BASE_SHA: fixture.base,
        PR_HEAD_SHA: fixture.head,
      });
      expect(wrongObject.stderr).toContain('founder evidence rejected: wrong-object');

      git(fixture.dir, ['update-ref', '-d', `${EVIDENCE_REF_PREFIX}${fixture.head}`]);
      writeRepoFile(fixture.dir, 'scripts/ci/provenance-trust-anchor.json', JSON.stringify({
        schema: TRUST_ANCHOR_SCHEMA,
        repository: REPOSITORY,
        founderIdentity: 'parqueen-founder',
        keys: [{ id: attacker.id, publicKey: attacker.publicKey, status: 'active' }],
      }));
      publish(fixture.dir, fixture.head, documentText(payloadFromRepo(fixture).payload, attacker), [
        { path: 'extra.json', text: '{}\n' },
      ]);
      const extraTree = runGuard(fixture.dir, {
        GITHUB_EVENT_NAME: 'pull_request',
        PR_BASE_SHA: fixture.base,
        PR_HEAD_SHA: fixture.head,
      });
      expect(extraTree.stderr).toContain('founder evidence rejected: unexpected-tree');

      git(fixture.dir, ['update-ref', '-d', `${EVIDENCE_REF_PREFIX}${fixture.head}`]);
      publish(fixture.dir, fixture.head, documentText(payloadFromRepo(fixture).payload, attacker));
      const planted = runGuard(fixture.dir, {
        GITHUB_EVENT_NAME: 'pull_request',
        PR_BASE_SHA: fixture.base,
        PR_HEAD_SHA: fixture.head,
      });
      expect(planted.status).toBe(1);
      expect(planted.stderr).toContain('unknown-key');
      expect(planted.stdout).not.toContain('SIGNED_FOUNDER_EVIDENCE_ACCEPTED');
    } finally {
      rmSync(fixture.dir, { recursive: true, force: true });
    }
  });

  it('fails closed when the running verifier differs from the base commit and still passes a clear diff', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'parqueen-verifier-'));
    try {
      git(dir, ['init', '-b', 'main']);
      for (const file of [
        'scripts/ci/provenance-change-guard.mjs',
        'scripts/ci/provenance-evidence.mjs',
        'scripts/ci/provenance-trust-anchor.json',
      ]) {
        writeRepoFile(dir, file, 'replacement verifier\n');
      }
      git(dir, ['add', '--', 'scripts/ci']);
      git(dir, ['commit', '-m', 'stub verifier']);
      const base = git(dir, ['rev-parse', 'HEAD']);
      writeRepoFile(dir, 'README.txt', 'clear\n');
      git(dir, ['add', '--', 'README.txt']);
      git(dir, ['commit', '-m', 'clear']);
      const head = git(dir, ['rev-parse', 'HEAD']);
      const mismatch = runGuard(dir, {
        GITHUB_EVENT_NAME: 'pull_request',
        PR_BASE_SHA: base,
        PR_HEAD_SHA: head,
      });
      expect(mismatch.status).toBe(1);
      expect(mismatch.stderr).toContain('running verifier does not match the trusted base commit');
      expect(mismatch.stdout).not.toContain('PROVENANCE_GUARD: PASS');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }

    const matching = mkdtempSync(path.join(tmpdir(), 'parqueen-verifier-match-'));
    try {
      git(matching, ['init', '-b', 'main']);
      for (const file of [
        'scripts/ci/provenance-change-guard.mjs',
        'scripts/ci/provenance-evidence.mjs',
        'scripts/ci/provenance-trust-anchor.json',
      ]) {
        writeRepoFile(matching, file, readFileSync(path.join(repo, file)));
      }
      git(matching, ['add', '--', 'scripts/ci']);
      git(matching, ['commit', '-m', 'trusted verifier']);
      const base = git(matching, ['rev-parse', 'HEAD']);
      writeRepoFile(matching, 'views/street-parking/handoffReachability.regression.test.ts', 'export {}\n');
      git(matching, ['add', '--', 'views/street-parking/handoffReachability.regression.test.ts']);
      git(matching, ['commit', '-m', 'clear']);
      const head = git(matching, ['rev-parse', 'HEAD']);
      const passed = runGuard(matching, {
        GITHUB_EVENT_NAME: 'pull_request',
        PR_BASE_SHA: base,
        PR_HEAD_SHA: head,
      });
      expect(passed.status).toBe(0);
      expect(passed.stdout).toContain('PROVENANCE_GUARD: PASS');
      expect(passed.stdout).toContain('Private 26C evidence is not required for this diff.');
    } finally {
      rmSync(matching, { recursive: true, force: true });
    }
  });
});

describe('local signing command and workflow binding', () => {
  const signArgs = (fixture, key, outPath) => [
    '--head', fixture.head, '--base', fixture.base,
    '--out', outPath, '--key-id', key.id,
    '--executed', '11', '--passed', '11', '--failed', '0', '--skipped', '0', '--exit-code', '0',
    '--attestation-id', 'attestation-cli-0001',
  ];

  it('prohibits real signing before the signer is on main and never reads a key from argv', () => {
    const missingKey = path.join(tmpdir(), 'parqueen-missing-signing-key.pem');
    const prohibited = spawnSync(process.execPath, [
      signer, 'sign', '--head', 'a'.repeat(40), '--base', 'b'.repeat(40),
      '--out', path.join(tmpdir(), 'parqueen-evidence-out.json'), '--key-id', 'founder-test',
      '--executed', '11', '--passed', '11', '--failed', '0', '--skipped', '0', '--exit-code', '0',
    ], {
      cwd: repo,
      encoding: 'utf8',
      env: cleanEnv({ PARQUEEN_PROVENANCE_SIGNING_KEY: missingKey }),
    });
    expect(prohibited.status).toBe(1);
    expect(prohibited.stdout ?? '').not.toContain('FOUNDER_EVIDENCE_SIGNED');
    expect(prohibited.stderr).toMatch(/real signing is prohibited|running signer does not match main|an active trusted key id is required/);
    expect(prohibited.stderr).not.toContain('could not be read');
    expect(prohibited.stderr).not.toContain(missingKey);
    expect(prohibited.stdout ?? '').not.toContain(missingKey);

    const commandLine = spawnSync(process.execPath, [
      signer, 'sign', '--key', missingKey, '--head', 'a'.repeat(40), '--base', 'b'.repeat(40),
      '--out', path.join(tmpdir(), 'parqueen-evidence-out.json'), '--key-id', 'founder-test',
      '--executed', '11', '--passed', '11', '--failed', '0', '--skipped', '0', '--exit-code', '0',
    ], { cwd: repo, encoding: 'utf8', env: cleanEnv() });
    expect(commandLine.status).toBe(1);
    expect(commandLine.stderr).toContain('must not be passed on the command line');
    expect(commandLine.stderr).not.toContain('could not be read');

    const actions = spawnSync(process.execPath, [signer, 'sign'], {
      encoding: 'utf8',
      env: cleanEnv({ GITHUB_ACTIONS: 'true' }),
    });
    expect(actions.status).toBe(1);
    expect(actions.stderr).toContain('local-only');
  });

  it('signs from the main snapshot and does not load a dirty worktree module', () => {
    const key = makeKey();
    const anchor = {
      schema: TRUST_ANCHOR_SCHEMA,
      repository: REPOSITORY,
      founderIdentity: 'parqueen-founder',
      keys: [{ id: key.id, publicKey: key.publicKey, status: 'active' }],
    };
    const dir = mkdtempSync(path.join(tmpdir(), 'parqueen-trusted-sign-'));
    const secretDir = mkdtempSync(path.join(tmpdir(), 'parqueen-test-key-'));
    const keyPath = path.join(secretDir, 'signing-key.pem');
    const outPath = path.join(secretDir, 'evidence.json');
    const marker = path.join(dir, 'untrusted-module-loaded');
    writeOwnerOnly(keyPath, key.privateKey.export({ type: 'pkcs8', format: 'pem' }));
    expect(path.dirname(keyPath)).toBe(secretDir);
    expect(path.dirname(keyPath)).not.toBe(tmpdir());
    expect(path.dirname(outPath)).toBe(secretDir);
    try {
      git(dir, ['init', '-b', 'main']);
      writeRepoFile(dir, RUNNER_PATH, 'runner-bytes\n');
      writeRepoFile(dir, SUITE_PATH, 'suite-bytes\n');
      writeRepoFile(dir, 'scripts/ci/provenance-evidence.mjs', readFileSync(signer));
      writeRepoFile(dir, 'scripts/ci/provenance-change-guard.mjs', readFileSync(guard));
      writeRepoFile(dir, 'scripts/ci/provenance-trust-anchor.json', `${JSON.stringify(anchor)}\n`);
      git(dir, ['add', '--', '.']);
      git(dir, ['commit', '-m', 'trusted signer']);
      const base = git(dir, ['rev-parse', 'HEAD']);
      writeRepoFile(dir, 'functions/index.js', 'export {}\n');
      git(dir, ['add', '--', 'functions/index.js']);
      git(dir, ['commit', '-m', 'critical']);
      const head = git(dir, ['rev-parse', 'HEAD']);
      writeRepoFile(dir, 'scripts/ci/provenance-change-guard.mjs', `
        import { writeFileSync } from 'node:fs';
        writeFileSync(${JSON.stringify(marker)}, 'loaded');
        export function decisionForPath() { return 'clear'; }
        export function pathsFromNameStatus() { return { files: [] }; }
      `);
      const localSigner = path.join(dir, 'scripts/ci/provenance-evidence.mjs');
      const missing = spawnSync(process.execPath, [localSigner, 'sign', ...signArgs({ head, base }, key, outPath)], {
        cwd: dir,
        encoding: 'utf8',
        env: cleanEnv(),
      });
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain('does not generate a key');
      expect(missing.stderr).not.toContain('PRIVATE KEY');

      const signed = spawnSync(process.execPath, [localSigner, 'sign', ...signArgs({ head, base }, key, outPath)], {
        cwd: dir,
        encoding: 'utf8',
        env: cleanEnv({ PARQUEEN_PROVENANCE_SIGNING_KEY: keyPath }),
      });
      expect(signed.status, signed.stderr).toBe(0);
      expect(signed.stdout).toContain('FOUNDER_EVIDENCE_SIGNED');
      expect(signed.stdout).toContain('FOUNDER-EXECUTED');
      expect(signed.stdout).toContain('did not run the private provenance suite');
      expect(signed.stdout).not.toContain(keyPath);
      expect(signed.stderr).not.toContain(keyPath);
      const evidence = readFileSync(outPath, 'utf8');
      expect(evidence).not.toContain('PRIVATE KEY');
      expect(evidence).not.toContain(keyPath);
      expect(existsSync(marker)).toBe(false);
      publish(dir, head, evidence);
      git(dir, ['checkout', 'HEAD', '--', 'scripts/ci/provenance-change-guard.mjs']);
      const accepted = spawnSync(process.execPath, [path.join(dir, 'scripts/ci/provenance-change-guard.mjs')], {
        cwd: dir,
        encoding: 'utf8',
        env: cleanEnv({
          GITHUB_EVENT_NAME: 'pull_request',
          PR_BASE_SHA: base,
          PR_HEAD_SHA: head,
        }),
      });
      expect(accepted.status, accepted.stderr).toBe(0);
      expect(accepted.stdout).toContain('PROVENANCE_GUARD: SIGNED_FOUNDER_EVIDENCE_ACCEPTED');
      expect(accepted.stdout).toContain('attestation attestation-cli-0001');
      expect(accepted.stdout).toMatch(/evidenceCommit [0-9a-f]{40}/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(secretDir, { recursive: true, force: true });
    }
  });

  it('keeps both provenance workflows on the trusted base verifier', () => {
    const durable = readFileSync(path.join(repo, '.github/workflows/provenance-change-guard.yml'), 'utf8');
    const gate = readFileSync(path.join(repo, '.github/workflows/pr-gate.yml'), 'utf8');
    for (const workflow of [durable, gate]) {
      expect(workflow).toContain('contents: read');
      expect(workflow).toContain('refs/parqueen-provenance/evidence/');
      expect(workflow).toContain('git archive "$base"');
      expect(workflow).toContain('scripts/ci/provenance-change-guard.mjs');
      expect(workflow).toContain('scripts/ci/provenance-evidence.mjs');
      expect(workflow).toContain('scripts/ci/provenance-trust-anchor.json');
      expect(workflow).not.toContain('PARQUEEN_PROVENANCE_SUCCESSOR');
    }
    expect(durable).toContain('pull_request_target:');
    expect(durable).toContain('ref: ${{ github.event.pull_request.base.sha }}');
    expect(durable).toContain('persist-credentials: false');
    const bootstrap = readFileSync(path.join(here, 'PROVENANCE_FOUNDER_EVIDENCE_BOOTSTRAP.md'), 'utf8');
    expect(bootstrap).toContain('25926302');
    expect(bootstrap).toContain('not mergeable');
    expect(bootstrap).toContain('FOUNDER-EXECUTED');
    expect(bootstrap).toContain('bypass_actors');
    expect(bootstrap).toContain('current_user_can_bypass');
    expect(bootstrap).toContain('never');
    expect(bootstrap).toContain('pull_request');
    expect(bootstrap).toContain('remote compatibility probe remains necessary');
    expect(bootstrap).toContain('evidence.json');
  });

  it('limits this change to the governance files', () => {
    const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: repo,
      encoding: 'utf8',
    });
    const allowed = [
      '.github/workflows/pr-gate.yml',
      '.github/workflows/provenance-change-guard.yml',
      'scripts/ci/PROVENANCE_FOUNDER_EVIDENCE_BOOTSTRAP.md',
      'scripts/ci/general-pr-suite.mjs',
      'scripts/ci/provenance-change-guard.mjs',
      'scripts/ci/provenance-evidence.mjs',
      'scripts/ci/provenance-evidence.test.mjs',
      'scripts/ci/provenance-trust-anchor.json',
    ];
    const files = status.stdout.split(/\r?\n/).filter(Boolean).map((line) => line.slice(3).replace(/\\/g, '/'));
    expect(files.every((file) => allowed.includes(file))).toBe(true);
  });
});
