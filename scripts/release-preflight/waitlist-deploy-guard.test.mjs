// Waitlist anti-downgrade guard. Weakened sources are built in a temp directory from the real files, one change
// each, so no vulnerable copy is ever committed.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { decide, missingProtections, selectedProtected } from './waitlist-deploy-guard.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD = join(ROOT, 'scripts', 'release-preflight', 'waitlist-deploy-guard.mjs');
const P = 'parkqueen-46475363-ccf36';
const WAITLIST = readFileSync(join(ROOT, 'functions', 'waitlist.js'), 'utf8').replace(/\r\n/g, '\n');
const INDEX = readFileSync(join(ROOT, 'functions', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
const temps = [];
afterAll(() => temps.forEach((d) => rmSync(d, { recursive: true, force: true })));

function source({ waitlist = WAITLIST, index = INDEX } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'waitlist-guard-'));
  temps.push(dir);
  mkdirSync(join(dir, 'functions'));
  if (waitlist !== null) writeFileSync(join(dir, 'functions', 'waitlist.js'), waitlist);
  writeFileSync(join(dir, 'functions', 'index.js'), index);
  return dir;
}
const change = (text, from, to) => {
  expect(text.includes(from), `fixture anchor missing: ${from}`).toBe(true);
  return text.replace(from, to);
};

describe('waitlist deploy guard: source', () => {
  it('the source in this repository carries every protection', () => {
    expect(missingProtections(ROOT)).toEqual([]);
  });

  it.each([
    ['W1', { waitlist: change(WAITLIST, 'deps.verifyTurnstile(', 'deps.skipped(') }],
    ['W2', { waitlist: change(WAITLIST, 'limit: 300, windowSec: 600', 'limit: 3000, windowSec: 600') }],
    ['W4', { waitlist: change(WAITLIST, ".where('confirmTokenHash'", ".where('other'") }],
    ['W5', { waitlist: change(WAITLIST, 'UNSUBSCRIBE_TOKEN_COLLECTION).doc(hashConfirmToken(token)).get()', 'UNSUBSCRIBE_TOKEN_COLLECTION).doc(token).get()') }],
    ['W6', { waitlist: change(WAITLIST, 'function clientNetwork(ip)', 'function clientAddress(ip)') }],
    ['W7', { index: change(INDEX, 'maxInstances: 20,', 'maxInstances: 100,') }],
    ['W0', { waitlist: null }],
  ])('a source without %s is refused', (id, files) => {
    const dir = source(files);
    expect(missingProtections(dir)).toContain(id);
    expect(decide({ project: P, only: 'functions', source: dir }).ok).toBe(false);
  });

  it('a refusal names check ids, not how the protections work', () => {
    const { message } = decide({ project: P, only: undefined, source: source({ waitlist: change(WAITLIST, 'limit: 300, windowSec: 600', 'limit: 3000, windowSec: 600') }) });
    expect(message).toMatch(/REFUSED.*W2/);
    expect(message).not.toMatch(/turnstile|ip|ipv6|limit|token|rate|header/i);
  });
});

describe('waitlist deploy guard: selection', () => {
  const weak = () => source({ index: change(INDEX, 'maxInstances: 20,', 'maxInstances: 100,') });

  it('unrelated functions, hosting and rules pass even when the waitlist source is weakened', () => {
    for (const only of ['functions:claimSpot,functions:cancelClaim', 'functions:deleteAccount', 'hosting', 'firestore:rules']) {
      expect(decide({ project: P, only, source: weak() }).ok, only).toBe(true);
    }
  });

  it.each([undefined, '', 'functions', 'functions:default', 'functions:joinWaitlist', 'functions:join', 'functions:default:confirmWaitlist', 'functions:claimSpot,functions:unsubscribeWaitlist'])(
    'selection %s reaches a waitlist function', (only) => {
      expect(selectedProtected(only).length).toBeGreaterThan(0);
      expect(decide({ project: P, only, source: weak() }).ok).toBe(false);
    });

  it('the intact source may deploy all three', () => {
    expect(decide({ project: P, only: 'functions:joinWaitlist,functions:confirmWaitlist,functions:unsubscribeWaitlist', source: ROOT }).ok).toBe(true);
  });

  it('no project is refused', () => {
    expect(decide({ project: undefined, only: 'functions:claimSpot', source: ROOT }).ok).toBe(false);
  });
});

describe('waitlist deploy guard: Firebase CLI predeploy hook', () => {
  const run = (projectDir, project = P) => spawnSync(process.execPath, [GUARD], { encoding: 'utf8', env: { ...process.env, GCLOUD_PROJECT: project, PROJECT_DIR: projectDir } });

  it('firebase.json runs the guard before every functions deploy', () => {
    const fn = JSON.parse(readFileSync(join(ROOT, 'firebase.json'), 'utf8')).functions;
    const predeploy = [].concat(...[].concat(fn).map((f) => f.predeploy || []));
    expect(predeploy.some((cmd) => cmd.includes('scripts/release-preflight/waitlist-deploy-guard.mjs'))).toBe(true);
  });

  it('allows this repository and refuses a weakened copy, as the CLI would run it', () => {
    expect(run(ROOT).status).toBe(0);
    const refused = run(source({ waitlist: change(WAITLIST, 'function clientNetwork(ip)', 'function clientAddress(ip)') }));
    expect(refused.status).toBe(2);
    expect(refused.stderr).toMatch(/REFUSED.*W6/);
  });

  it('refuses when the CLI names no project', () => {
    expect(run(ROOT, '').status).toBe(2);
  });
});
