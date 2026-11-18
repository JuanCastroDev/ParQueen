// Anti-downgrade guard for the three waitlist functions (joinWaitlist, confirmWaitlist, unsubscribeWaitlist).
//
// Production runs the hardened waitlist code. A deploy from a source without it would silently replace it, so any
// deploy that can reach those functions must come from a source that still carries every protection below.
//
// Two ways it runs:
//   * firebase.json `functions.predeploy` (no arguments): the Firebase CLI runs it before every deploy that includes
//     functions from this checkout. The hook cannot see `--only`, so it treats every functions deploy as one that can
//     reach the waitlist functions. Deploys of other functions pass as long as the waitlist source is intact.
//   * By hand, to check a selection: node scripts/release-preflight/waitlist-deploy-guard.mjs
//       --project <id> [--only "<same value as firebase --only>"] [--source <repo root>]
//
// Exit 0 = allowed, 2 = refused. Read-only, no network, no credentials. Failure messages name a check id only;
// docs/WAITLIST.md describes the behaviour each one protects.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PROTECTED = ['joinWaitlist', 'confirmWaitlist', 'unsubscribeWaitlist'];

/** The protected functions a `--only` value could reach. Conservative: no value (a full deploy), `functions`, a
 *  codebase, a group or a prefix of a protected name all count. */
export function selectedProtected(only) {
  if (only === undefined || only.trim() === '') return [...PROTECTED];
  const hit = new Set();
  for (const raw of only.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (raw === 'functions') PROTECTED.forEach((p) => hit.add(p));
    else if (raw.startsWith('functions:')) {
      const parts = raw.slice('functions:'.length).split(':'); // [name] or [codebase, name]
      const name = parts.length > 1 ? parts.slice(1).join(':') : parts[0];
      if (parts.length === 1 && name === 'default') PROTECTED.forEach((p) => hit.add(p));
      for (const p of PROTECTED) if (name === '' || p === name || p.startsWith(name) || name.split(/[.-]/)[0] === p) hit.add(p);
    }
  }
  return [...hit];
}

/** Ids of the protections the source lacks (empty = intact). */
export function missingProtections(root) {
  const w = join(root, 'functions', 'waitlist.js'), x = join(root, 'functions', 'index.js');
  if (!existsSync(w) || !existsSync(x)) return ['W0'];
  const src = readFileSync(w, 'utf8').replace(/\r\n/g, '\n'), index = readFileSync(x, 'utf8').replace(/\r\n/g, '\n');
  const body = (name) => {
    const a = src.indexOf(`async function ${name}(`);
    if (a < 0) return null;
    const b = src.slice(a + 1).search(/\n(?:async )?function /);
    return b < 0 ? src.slice(a) : src.slice(a, a + 1 + b);
  };
  const before = (text, first, second) => { const i = text.indexOf(first), j = text.indexOf(second); return i >= 0 && j >= 0 && i < j; };
  const join_ = body('handleJoin'), confirm = body('handleConfirm'), unsub = body('handleUnsubscribe');
  if (!join_ || !confirm || !unsub) return ['W0'];
  const opts = index.slice(index.indexOf('const WAITLIST_HTTP_OPTIONS'), index.indexOf('exports.joinWaitlist'));
  const checks = {
    W1: before(join_, 'deps.verifyTurnstile(', 'withinClientLimit('),
    W2: /const GLOBAL_JOIN_LIMIT = \{ limit: 300, windowSec: 600 \};/.test(src) && join_.includes("'waitlistJoinAll', GLOBAL_JOIN_LIMIT"),
    W3: before(join_, 'deps.verifyTurnstile(', "'waitlistJoinAll'"),
    W4: before(confirm, ".where('confirmTokenHash'", 'withinClientLimit('),
    W5: before(unsub, 'UNSUBSCRIBE_TOKEN_COLLECTION).doc(hashConfirmToken(token)).get()', 'withinClientLimit('),
    W6: /function clientNetwork\(ip\)/.test(src) && src.includes('.update(clientNetwork(ip))'),
    W7: opts.length > 0 && /maxInstances:\s*20\b/.test(opts),
  };
  return Object.entries(checks).filter(([, ok]) => !ok).map(([id]) => id);
}

/** The guard's decision for one invocation. Returns { ok, message }. */
export function decide({ project, only, source }) {
  if (!project) return { ok: false, message: 'no Firebase project: name it explicitly (--project, or GCLOUD_PROJECT from the Firebase CLI)' };
  if (!source || !existsSync(source)) return { ok: false, message: 'the source directory is missing' };
  const hit = selectedProtected(only);
  if (!hit.length) return { ok: true, message: `allowed (the selection excludes ${PROTECTED.join(', ')})` };
  const missing = missingProtections(source);
  if (missing.length) {
    return { ok: false, message: `REFUSED: this deploy can reach ${hit.join(', ')} in ${project}, and the source lacks required waitlist protections (${missing.join(', ')}). Deploying it would replace the production behaviour. Deploy from a source that carries them; see docs/WAITLIST.md.` };
  }
  return { ok: true, message: `allowed (${hit.join(', ')} can be reached; the source carries the waitlist protections)` };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
  const hook = process.argv.length <= 2;
  const result = decide({
    project: hook ? process.env.GCLOUD_PROJECT : arg('--project'),
    only: hook ? undefined : arg('--only'),
    source: hook ? (process.env.PROJECT_DIR || process.cwd()) : (arg('--source') || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')),
  });
  (result.ok ? console.log : console.error)(`waitlist-deploy-guard: ${result.message}`);
  process.exit(result.ok ? 0 : 2);
}
