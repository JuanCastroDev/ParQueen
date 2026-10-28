// Founder-signed provenance evidence.
//
// The signature is Ed25519 over the canonical payload bytes, using Node's
// built-in crypto. The claim class is FOUNDER-EXECUTED. This module does not
// run the private suite, does not read the genuine successor, and does not
// generate a signing key.

import { spawnSync } from 'node:child_process';
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  verify,
} from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPOSITORY = 'JuanCastroDev/ParQueen';
export const EVIDENCE_SCHEMA = 'parqueen-founder-provenance-evidence/v1';
export const TRUST_ANCHOR_SCHEMA = 'parqueen-provenance-trust-anchor/v1';
export const EVIDENCE_CLASS = 'FOUNDER-EXECUTED';
export const EVIDENCE_REF_PREFIX = 'refs/parqueen-provenance/evidence/';
export const EVIDENCE_FILE = 'evidence.json';
export const SIGNING_KEY_ENV = 'PARQUEEN_PROVENANCE_SIGNING_KEY';
export const SIGNING_PROHIBITED = 'real signing is prohibited until the reviewed governance signer is on main';
export const RUNNER_PATH = 'scripts/ci/private-provenance-suite.mjs';
export const SUITE_PATH = 'functions/curbIntelligence/provenanceAndConflict.test.cjs';
export const ARTIFACT_SIZE = 45710043;
export const ARTIFACT_SHA256 = 'e1ca91f7ba05e874449f168242509908ab7d587be3fc7f3352c66c0851cbc225';
export const REQUIRED_TESTS = Object.freeze({
  executed: 11,
  passed: 11,
  failed: 0,
  skipped: 0,
  exitCode: 0,
});
export const MAX_EVIDENCE_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
export const MAX_EVIDENCE_BYTES = 65536;

const PAYLOAD_FIELDS = [
  'artifact',
  'attestationId',
  'base',
  'criticalPaths',
  'evidenceClass',
  'executedAt',
  'expiresAt',
  'founderIdentity',
  'head',
  'repository',
  'runner',
  'schema',
  'suite',
  'tests',
  'tree',
];
const WRAPPER_FIELDS = ['evidenceClass', 'keyId', 'payload', 'schema', 'signature'];
const ANCHOR_FIELDS = ['founderIdentity', 'keys', 'repository', 'schema'];
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ID_TEXT = /^[A-Za-z0-9._:-]{8,80}$/;
const KEY_ID = /^[A-Za-z0-9._:-]{1,64}$/;
const FOUNDER_ID = /^[a-z0-9.-]{1,80}$/;

function sameKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

export function canonicalize(value) {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('malformed');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`).join(',')}}`;
  }
  throw new Error('malformed');
}

function parseTime(value) {
  if (typeof value !== 'string' || !ISO_TIME.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function decodeSignature(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 64 || bytes.toString('base64') !== value) return null;
  return bytes;
}

function strictError(reason) {
  const error = new Error(reason);
  error.reason = reason;
  return error;
}

export function parseStrictJson(text) {
  const input = String(text);
  let index = 0;

  function skip() {
    while (input[index] === ' ' || input[index] === '\n' || input[index] === '\r' || input[index] === '\t') index += 1;
  }

  function parseString() {
    const start = index;
    if (input[index] !== '"') throw strictError('malformed');
    index += 1;
    let closed = false;
    while (index < input.length) {
      const char = input[index];
      if (char === '"') {
        index += 1;
        closed = true;
        break;
      }
      if (char === '\\') {
        index += 1;
        const escaped = input[index];
        if (escaped === undefined) throw strictError('malformed');
        if ('"\\/bfnrt'.includes(escaped)) {
          index += 1;
          continue;
        }
        if (escaped === 'u' && /^[0-9a-fA-F]{4}$/.test(input.slice(index + 1, index + 5))) {
          index += 5;
          continue;
        }
        throw strictError('malformed');
      }
      if (char < ' ') throw strictError('malformed');
      index += 1;
    }
    if (!closed) throw strictError('malformed');
    const raw = input.slice(start, index);
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      throw strictError('malformed');
    }
    if (raw !== JSON.stringify(value)) throw strictError('ambiguous-encoding');
    return value;
  }

  function parseNumber() {
    const start = index;
    if (input[index] === '-') index += 1;
    if (input[index] === '0') index += 1;
    else if (input[index] >= '1' && input[index] <= '9') {
      while (input[index] >= '0' && input[index] <= '9') index += 1;
    } else {
      throw strictError('malformed');
    }
    if (input[index] === '.') {
      index += 1;
      if (!(input[index] >= '0' && input[index] <= '9')) throw strictError('malformed');
      while (input[index] >= '0' && input[index] <= '9') index += 1;
    }
    if (input[index] === 'e' || input[index] === 'E') {
      index += 1;
      if (input[index] === '+' || input[index] === '-') index += 1;
      if (!(input[index] >= '0' && input[index] <= '9')) throw strictError('malformed');
      while (input[index] >= '0' && input[index] <= '9') index += 1;
    }
    const raw = input.slice(start, index);
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      throw strictError('malformed');
    }
    if (raw !== JSON.stringify(value)) throw strictError('ambiguous-encoding');
    return value;
  }

  function parseLiteral(literal, value) {
    if (input.slice(index, index + literal.length) !== literal) throw strictError('malformed');
    index += literal.length;
    return value;
  }

  function parseArray() {
    index += 1;
    const values = [];
    skip();
    if (input[index] === ']') {
      index += 1;
      return values;
    }
    while (true) {
      values.push(parseValue());
      skip();
      if (input[index] === ',') {
        index += 1;
        continue;
      }
      if (input[index] === ']') {
        index += 1;
        return values;
      }
      throw strictError('malformed');
    }
  }

  function parseObject() {
    index += 1;
    const object = Object.create(null);
    skip();
    if (input[index] === '}') {
      index += 1;
      return object;
    }
    while (true) {
      skip();
      if (input[index] !== '"') throw strictError('malformed');
      const key = parseString();
      if (Object.hasOwn(object, key)) throw strictError('duplicate-keys');
      skip();
      if (input[index] !== ':') throw strictError('malformed');
      index += 1;
      object[key] = parseValue();
      skip();
      if (input[index] === ',') {
        index += 1;
        continue;
      }
      if (input[index] === '}') {
        index += 1;
        return object;
      }
      throw strictError('malformed');
    }
  }

  function parseValue() {
    skip();
    const char = input[index];
    if (char === '{') return parseObject();
    if (char === '[') return parseArray();
    if (char === '"') return parseString();
    if (char === 't') return parseLiteral('true', true);
    if (char === 'f') return parseLiteral('false', false);
    if (char === 'n') return parseLiteral('null', null);
    if (char === '-' || (char >= '0' && char <= '9')) return parseNumber();
    throw strictError('malformed');
  }

  skip();
  if (index >= input.length) throw strictError('malformed');
  const value = parseValue();
  skip();
  if (index !== input.length) throw strictError('malformed');
  return value;
}

export function loadTrustAnchor(text) {
  let parsed;
  try {
    parsed = parseStrictJson(String(text));
  } catch {
    throw new Error('trust anchor rejected');
  }
  if (!sameKeys(parsed, ANCHOR_FIELDS)) throw new Error('trust anchor rejected');
  if (parsed.schema !== TRUST_ANCHOR_SCHEMA) throw new Error('trust anchor rejected');
  if (parsed.repository !== REPOSITORY) throw new Error('trust anchor rejected');
  if (typeof parsed.founderIdentity !== 'string' || !FOUNDER_ID.test(parsed.founderIdentity)) {
    throw new Error('trust anchor rejected');
  }
  if (!Array.isArray(parsed.keys)) throw new Error('trust anchor rejected');
  const seen = new Set();
  const keys = parsed.keys.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('trust anchor rejected');
    const fields = Object.keys(entry);
    if (fields.length !== 3 || !['id', 'publicKey', 'status'].every((field) => fields.includes(field))) {
      throw new Error('trust anchor rejected');
    }
    if (typeof entry.id !== 'string' || !KEY_ID.test(entry.id) || seen.has(entry.id)) {
      throw new Error('trust anchor rejected');
    }
    seen.add(entry.id);
    if (typeof entry.publicKey !== 'string' || !entry.publicKey.includes('BEGIN PUBLIC KEY')) {
      throw new Error('trust anchor rejected');
    }
    if (entry.publicKey.includes('PRIVATE KEY')) throw new Error('trust anchor rejected');
    if (entry.status !== 'active' && entry.status !== 'revoked') throw new Error('trust anchor rejected');
    return { id: entry.id, publicKey: entry.publicKey, status: entry.status };
  });
  return {
    schema: parsed.schema,
    repository: parsed.repository,
    founderIdentity: parsed.founderIdentity,
    keys,
  };
}

function reject(reason) {
  return { ok: false, reason };
}

function checkPayloadShape(payload) {
  if (!sameKeys(payload, PAYLOAD_FIELDS)) return 'malformed';
  if (payload.schema !== EVIDENCE_SCHEMA || payload.evidenceClass !== EVIDENCE_CLASS) {
    return 'evidence-class-mismatch';
  }
  if (payload.repository !== REPOSITORY) return 'repository-mismatch';
  if (typeof payload.founderIdentity !== 'string' || !FOUNDER_ID.test(payload.founderIdentity)) {
    return 'malformed';
  }
  if (![payload.head, payload.tree, payload.base].every((value) => typeof value === 'string' && SHA40.test(value))) {
    return 'malformed';
  }
  if (typeof payload.attestationId !== 'string' || !ID_TEXT.test(payload.attestationId)) return 'malformed';
  if (!Array.isArray(payload.criticalPaths) || payload.criticalPaths.some((item) => typeof item !== 'string' || !item)) {
    return 'malformed';
  }
  const sorted = [...payload.criticalPaths].sort();
  if (payload.criticalPaths.some((item, index) => item !== sorted[index])) return 'ambiguous';
  if (new Set(payload.criticalPaths).size !== payload.criticalPaths.length) return 'ambiguous';
  if (!sameKeys(payload.runner, ['path', 'sha256']) || payload.runner.path !== RUNNER_PATH) return 'malformed';
  if (!sameKeys(payload.suite, ['path', 'sha256']) || payload.suite.path !== SUITE_PATH) return 'malformed';
  if (!SHA256.test(payload.runner.sha256) || !SHA256.test(payload.suite.sha256)) return 'malformed';
  if (!sameKeys(payload.artifact, ['sha256', 'size'])) return 'malformed';
  if (payload.artifact.size !== ARTIFACT_SIZE || payload.artifact.sha256 !== ARTIFACT_SHA256) {
    return 'artifact-mismatch';
  }
  if (!sameKeys(payload.tests, ['executed', 'exitCode', 'failed', 'passed', 'skipped'])) return 'malformed';
  for (const [field, expected] of Object.entries(REQUIRED_TESTS)) {
    if (payload.tests[field] !== expected) return 'test-result-mismatch';
  }
  if (parseTime(payload.executedAt) === null || parseTime(payload.expiresAt) === null) return 'malformed';
  return null;
}

export function verifyFounderEvidence(documentText, expected) {
  const text = String(documentText ?? '');
  if (!text || text.charCodeAt(0) === 0xfeff || Buffer.byteLength(text, 'utf8') > MAX_EVIDENCE_BYTES) {
    return reject('malformed');
  }
  let document;
  try {
    document = parseStrictJson(text);
  } catch (error) {
    return reject(error?.reason === 'duplicate-keys' || error?.reason === 'ambiguous-encoding' ? error.reason : 'malformed');
  }
  if (Array.isArray(document)) return reject('ambiguous');
  if (!sameKeys(document, WRAPPER_FIELDS)) return reject('malformed');
  if (document.schema !== EVIDENCE_SCHEMA) return reject('malformed');
  if (document.evidenceClass !== EVIDENCE_CLASS) return reject('evidence-class-mismatch');
  if (typeof document.keyId !== 'string' || !KEY_ID.test(document.keyId)) return reject('malformed');
  if (document.signature == null || document.signature === '') return reject('unsigned');
  const signature = decodeSignature(document.signature);
  if (!signature) return reject('malformed');
  const shape = checkPayloadShape(document.payload);
  if (shape) return reject(shape);

  const anchor = expected?.trustAnchor;
  if (!anchor || anchor.repository !== REPOSITORY || !Array.isArray(anchor.keys)) return reject('unknown-key');
  if (document.payload.founderIdentity !== anchor.founderIdentity) return reject('founder-mismatch');
  const key = anchor.keys.find((entry) => entry.id === document.keyId);
  if (!key) return reject('unknown-key');
  if (key.status === 'revoked') return reject('revoked-key');
  if (key.status !== 'active') return reject('unknown-key');

  let publicKey;
  try {
    publicKey = createPublicKey(key.publicKey);
  } catch {
    return reject('unknown-key');
  }
  let signedBytes;
  try {
    signedBytes = Buffer.from(canonicalize(document.payload), 'utf8');
  } catch {
    return reject('malformed');
  }
  if (!verify(null, signedBytes, publicKey, signature)) return reject('invalid-signature');

  const executedAt = parseTime(document.payload.executedAt);
  const expiresAt = parseTime(document.payload.expiresAt);
  const now = expected.now instanceof Date ? expected.now.getTime() : Number(expected.now);
  if (!Number.isFinite(now)) return reject('malformed');
  if (executedAt > now + 5 * 60 * 1000) return reject('malformed');
  if (expiresAt <= executedAt) return reject('malformed');
  if (expiresAt - executedAt > MAX_EVIDENCE_LIFETIME_MS) return reject('lifetime-exceeded');
  if (now >= expiresAt) return reject('expired');

  if (document.payload.head !== String(expected.head || '').toLowerCase()) return reject('head-mismatch');
  if (document.payload.tree !== String(expected.tree || '').toLowerCase()) return reject('tree-mismatch');
  if (document.payload.base !== String(expected.base || '').toLowerCase()) return reject('base-mismatch');
  const critical = [...(expected.criticalPaths || [])].sort();
  if (JSON.stringify(document.payload.criticalPaths) !== JSON.stringify(critical)) {
    return reject('critical-path-mismatch');
  }
  if (document.payload.runner.sha256 !== expected.runnerSha256) return reject('runner-mismatch');
  if (document.payload.suite.sha256 !== expected.suiteSha256) return reject('suite-mismatch');
  return {
    ok: true,
    attestationId: document.payload.attestationId,
    evidenceClass: EVIDENCE_CLASS,
    head: document.payload.head,
  };
}

export function signFounderPayload(payload, privateKey, keyId) {
  const shape = checkPayloadShape(payload);
  if (shape) throw new Error(shape);
  if (typeof keyId !== 'string' || !KEY_ID.test(keyId)) throw new Error('malformed');
  const keyObject = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  const signature = sign(null, Buffer.from(canonicalize(payload), 'utf8'), keyObject);
  return {
    schema: EVIDENCE_SCHEMA,
    evidenceClass: EVIDENCE_CLASS,
    keyId,
    payload,
    signature: signature.toString('base64'),
  };
}

function git(args, cwd) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function refuse(message) {
  const error = new Error(message);
  error.reason = message;
  throw error;
}

function insideRepository(filePath, cwd) {
  const top = git(['rev-parse', '--show-toplevel'], cwd);
  if (top.status !== 0) return false;
  const root = path.resolve(top.stdout.trim());
  const resolved = path.resolve(cwd, filePath);
  const relative = path.relative(root, resolved);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function argValue(argv, flag) {
  const index = argv.indexOf(flag);
  if (index === -1) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) fail(`missing value for ${flag}`);
  return value;
}

function hashBlob(cwd, commit, filePath) {
  const data = spawnSync('git', ['cat-file', 'blob', `${commit}:${filePath}`], {
    cwd,
    encoding: 'buffer',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
  if (data.status !== 0) refuse(`unable to hash ${filePath} at the head commit`);
  return createHash('sha256').update(data.stdout).digest('hex');
}

function catBlob(cwd, commit, filePath) {
  const data = spawnSync('git', ['cat-file', 'blob', `${commit}:${filePath}`], {
    cwd,
    encoding: 'buffer',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  });
  if (data.status !== 0) return null;
  return data.stdout;
}

function trustedMainCommit(cwd) {
  const local = git(['rev-parse', '--verify', 'refs/heads/main'], cwd);
  const origin = git(['rev-parse', '--verify', 'origin/main'], cwd);
  const localSha = local.status === 0 ? local.stdout.trim() : '';
  const originSha = origin.status === 0 ? origin.stdout.trim() : '';
  if (localSha && originSha && localSha !== originSha) {
    fail('local main and origin/main differ; real signing is prohibited');
  }
  const sha = localSha || originSha;
  if (!SHA40.test(sha)) fail(SIGNING_PROHIBITED);
  return sha;
}

async function signCommand(argv) {
  if (process.env.GITHUB_ACTIONS === 'true') {
    fail('the signing command is local-only and refuses to run in GitHub Actions');
  }
  if (argv.includes('--key') || argv.includes('--trust-anchor')) {
    fail('the signing key path and trust anchor must not be passed on the command line');
  }
  const head = argValue(argv, '--head');
  const base = argValue(argv, '--base');
  const outPath = argValue(argv, '--out');
  const keyId = argValue(argv, '--key-id');
  if (!head || !SHA40.test(head)) fail('head must be a 40-character SHA');
  if (!base || !SHA40.test(base)) fail('base must be a 40-character SHA');
  if (!outPath) fail('an output path outside the repository is required');
  if (!keyId) fail('an active trusted key id is required');
  const counts = {
    executed: argValue(argv, '--executed'),
    passed: argValue(argv, '--passed'),
    failed: argValue(argv, '--failed'),
    skipped: argValue(argv, '--skipped'),
    exitCode: argValue(argv, '--exit-code'),
  };
  for (const [field, expected] of Object.entries(REQUIRED_TESTS)) {
    if (counts[field] === null || String(expected) !== counts[field]) {
      fail(`the observed ${field} result must be ${expected}; this command does not invent a pass`);
    }
  }

  const cwd = process.cwd();
  if (insideRepository(outPath, cwd)) fail('evidence output must stay outside the repository');
  const mainSha = trustedMainCommit(cwd);
  const running = readFileSync(fileURLToPath(import.meta.url));
  const trustedEvidence = catBlob(cwd, mainSha, 'scripts/ci/provenance-evidence.mjs');
  const trustedGuard = catBlob(cwd, mainSha, 'scripts/ci/provenance-change-guard.mjs');
  const trustedAnchor = catBlob(cwd, mainSha, 'scripts/ci/provenance-trust-anchor.json');
  if (!trustedEvidence || !trustedGuard || !trustedAnchor) fail(SIGNING_PROHIBITED);
  if (!running.equals(trustedEvidence)) fail('running signer does not match main');

  const keyPath = process.env[SIGNING_KEY_ENV] || '';
  delete process.env[SIGNING_KEY_ENV];
  if (!keyPath) fail('a signing key path is required; this command does not generate a key');
  if (insideRepository(keyPath, cwd)) fail('the signing key must stay outside the repository');

  const snapshot = mkdtempSync(path.join(tmpdir(), 'parqueen-trusted-signer-'));
  try {
    const guardPath = path.join(snapshot, 'provenance-change-guard.mjs');
    writeFileSync(path.join(snapshot, 'provenance-evidence.mjs'), trustedEvidence);
    writeFileSync(guardPath, trustedGuard);
    writeFileSync(path.join(snapshot, 'provenance-trust-anchor.json'), trustedAnchor);
    const trusted = await import(pathToFileURL(guardPath).href);
    const anchor = loadTrustAnchor(trustedAnchor.toString('utf8'));
    if (!anchor.keys.some((entry) => entry.id === keyId && entry.status === 'active')) {
      refuse('an active trusted key id is required');
    }
    let privatePem;
    try {
      privatePem = readFileSync(keyPath, 'utf8');
    } catch {
      refuse('the signing key could not be read');
    }
    if (!privatePem.includes('PRIVATE KEY')) refuse('the signing key could not be read');

    const tree = git(['rev-parse', `${head}^{tree}`], cwd);
    if (tree.status !== 0 || !SHA40.test(tree.stdout.trim())) refuse('the head tree could not be read');
    const names = git(['diff', '--name-status', '--find-renames', `${base}...${head}`], cwd);
    if (names.status !== 0) refuse('the changed-file set could not be read');
    const parsed = trusted.pathsFromNameStatus(names.stdout);
    if (parsed.error) refuse(parsed.error);
    const criticalPaths = [];
    for (const file of parsed.files) {
      const decision = trusted.decisionForPath(file);
      if (decision === 'undetermined') refuse(`classification failed for ${file}`);
      if (decision === 'critical') criticalPaths.push(file);
    }
    criticalPaths.sort();
    if (criticalPaths.length === 0) refuse('there is no provenance-critical change to sign');
    const executedAt = argValue(argv, '--executed-at') || new Date().toISOString();
    const expiresAt = argValue(argv, '--expires-at')
      || new Date(Date.parse(executedAt) + 14 * 24 * 60 * 60 * 1000).toISOString();
    const payload = {
      schema: EVIDENCE_SCHEMA,
      evidenceClass: EVIDENCE_CLASS,
      repository: REPOSITORY,
      head,
      tree: tree.stdout.trim(),
      base,
      criticalPaths,
      runner: { path: RUNNER_PATH, sha256: hashBlob(cwd, head, RUNNER_PATH) },
      suite: { path: SUITE_PATH, sha256: hashBlob(cwd, head, SUITE_PATH) },
      artifact: { size: ARTIFACT_SIZE, sha256: ARTIFACT_SHA256 },
      tests: { ...REQUIRED_TESTS },
      founderIdentity: anchor.founderIdentity,
      executedAt,
      attestationId: argValue(argv, '--attestation-id') || randomUUID(),
      expiresAt,
    };
    const signed = signFounderPayload(payload, privatePem, keyId);
    writeFileSync(outPath, `${JSON.stringify(signed, null, 2)}\n`);
    console.log('FOUNDER_EVIDENCE_SIGNED');
    console.log('Evidence class: FOUNDER-EXECUTED');
    console.log('This command did not run the private provenance suite.');
    console.log(`attestation ${signed.payload.attestationId}`);
    console.log(`head ${head}`);
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  if (command !== 'sign') {
    fail('usage: set PARQUEEN_PROVENANCE_SIGNING_KEY outside the repository, then node scripts/ci/provenance-evidence.mjs sign --head <sha> --base <sha> --out <path> --key-id <id> --executed 11 --passed 11 --failed 0 --skipped 0 --exit-code 0');
  }
  signCommand(process.argv.slice(3)).catch((error) => fail(error.reason || error.message || 'signing failed'));
}
