'use strict';

// S7 T2-G3 orphan-generation recovery race and ruleset proof (t683u).
//
// Question: claimSpot with recoverLeftoverGeneration runs
//   collectionGroup('activeIncomingClaims').where('spotId', '==', S).limit(1)
// inside its transaction and recovers S only when that query is empty. Can a
// competing actor create a lock naming S after the empty query and before the
// commit, so that two parties hold S?
//
// The argument under test (documented in claimSpot.js) does not depend on the
// query locking a range against phantom inserts. It depends on two facts:
//   F1  every lock writer that names S also needs S to read interested by the
//       lock owner in the same commit: Rules lockAgreesWithSpotAfter for
//       clients (deployed 134a97cf, #332 interim candidate, head), and an
//       in-transaction read of S for claimSpot and reconcileUserClaims;
//   F2  the recovering transaction reads S (available) and writes it, so any
//       commit that changes S conflicts with it (document-level transaction
//       isolation, and the prepared spotUpdateTime precondition).
// Tests below:
//   RACE-1  F1 for clients: a lock-only write naming an available S is denied
//           by each ruleset, standalone and while recovery is paused after its
//           empty query. Positive control: the same write succeeds when S is
//           interested by the writer.
//   RACE-2  a rules-bound Oct 16 direct claim of S fired after the empty query:
//           at most one party holds S, and every lock naming S belongs to the
//           stored claimant.
//   RACE-2b the same direct claim committed after prepare and before the
//           recovery transaction: the prepared spotUpdateTime makes recovery
//           stale_precondition.
//   RACE-3  a competing server recovery fired after the empty query: exactly
//           one claims.
//   RACE-4  CHARACTERIZATION ONLY: an Admin SDK lock-only insert (bypasses
//           Rules; not a production writer) after the empty query. Records how
//           this emulator handles a phantom insert. It is not part of the proof
//           and the emulator may differ from production.
//   RULES-1 client writes cannot change claimGenerationId or claimStartedAt on
//           a live claim under any ruleset, so a generation claim cannot be
//           downgraded into the legacy path and a legacy cycle id is fixed.
//
// Namespaces: demo-parkqueen-s7-t683u-{deployed,interim,head} on the isolated
// Firestore emulator. Rules are loaded per namespace with
// @firebase/rules-unit-testing. No function triggers are registered for these
// namespaces.

require('./isolatedEmulatorGuard').assertIsolatedEmulator({ services: ['firestore'] });

const ISOLATED = 'demo-parkqueen-parking-fence-iso';
const host = process.env.FIRESTORE_EMULATOR_HOST || '';
if (process.env.GCLOUD_PROJECT !== ISOLATED || host === '' || host.endsWith(':8080')) {
  throw new Error('Refusing T2-G3 race proof outside the isolated emulator');
}
const [emulatorHost, emulatorPortText] = host.split(':');
const emulatorPort = Number(emulatorPortText);

const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const client = require('firebase/firestore');
const { prepareClaimIntent, claimSpot } = require('./claimSpot');

const RULESETS = [
  {
    key: 'deployed',
    file: 'test-fixtures/production-baseline/deployed-firestore-134a97cf.rules',
    sha256: '134a97cf8e25f2f8848ff4d2c0ff65ff5dd83434f1690901b4ba7dffe403810b',
    directClaim: true,
  },
  {
    key: 'interim',
    file: 'test-fixtures/interim-candidate/firestore.interim-legacy-hardened.rules',
    sha256: 'c1508fa02a15fff9b3a2d4a965d40254f540c7c69ffe5aed6405c0a6bb090400',
    directClaim: true,
  },
  { key: 'head', file: 'firestore.rules', sha256: null, directClaim: false },
];

function readRules(set) {
  const bytes = fs.readFileSync(path.join(__dirname, '..', set.file));
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (set.sha256 && digest !== set.sha256) throw new Error(`${set.file} digest mismatch: ${digest}`);
  return { text: bytes.toString('utf8'), digest };
}

// t684u: a denial that comes from the 1,000-expression evaluation limit is not
// a clean rules decision and must not count as one. The #332 interim candidate
// (daf120c6) was reproduced in t684u to reach the limit on every denied spot
// update, so for that exact file the reason check is carried by the BLOCKER
// REASON-1 test below instead of the SECURITY tests.
const LIMIT_BLOCKED_SHA256 = new Set([
  'daf120c65921852785414c3baa570dd175ac98dc0861f0ac0e8336eb1ba71469',
]);

function denialReason(message) {
  if (/maximum of \d+ expressions to evaluate has been reached/i.test(message)) return 'evaluation-limit';
  if (/evaluation error at L\d+/i.test(message)) return 'evaluation-error';
  if (/false for '[a-z]+' @ L\d+/.test(message)) return 'clean-false';
  return 'other';
}

function limitBlocked(key) {
  const set = RULESETS.find((candidate) => candidate.key === key);
  return Boolean(set && set.sha256 && LIMIT_BLOCKED_SHA256.has(set.sha256));
}

function expectNotLimit(key, result) {
  if (result.ok || limitBlocked(key)) return;
  expect(denialReason(result.message || '')).not.toBe('evaluation-limit');
}

const G1 = '6e'.repeat(32);
let mint = 0;
let sequence = 0;
const envs = {};

function sleep(ms) { return new Promise((resolve) => { setTimeout(resolve, ms); }); }

function ids(label) {
  sequence += 1;
  const n = String(sequence).padStart(12, '0');
  return {
    a: `rcA_${label}_${n}`,
    b: `rcB_${label}_${n}`,
    z: `rcZ_${label}_${n}`,
    finder: `rcF_${label}_${n}`,
    s: `rcS_${label}_${n}`,
    s2: `rcS2_${label}_${n}`,
    attemptA: `abababab-abab-4bab-8bab-${n}`,
    attemptB: `cdcdcdcd-cdcd-4dcd-8dcd-${n}`,
  };
}

function serverDeps(db, extra = {}) {
  return {
    db,
    now: () => Timestamp.now(),
    checkRateLimit: async () => {},
    // Fill bytes 0x10..0x5f: never equal to G1 (0x6e); checked in beforeAll.
    randomBytes: () => { mint += 1; return Buffer.alloc(32, 0x10 + (mint % 0x50)); },
    ...extra,
  };
}

function profile(name) { return { status: 'Active', productAccessBlocked: false, username: name, fullName: name, crowns: 0 }; }

async function seed(env, row, spot) {
  const { db } = env;
  await db.collection('activeIncomingClaimRollout').doc('status').set({
    enforced: true, locklessCount: 0, duplicateUserCount: 0, duplicatePingCount: 0,
  });
  for (const [uid, name] of [[row.a, 'ada'], [row.b, 'bob'], [row.z, 'zed'], [row.finder, 'bea']]) {
    await db.collection('users').doc(uid).set(profile(name));
  }
  await db.collection('spots').doc(row.s).set(spot);
}

function availableSpot(finder, extra = {}) {
  return {
    finderId: finder,
    finderName: 'bea',
    address: '1 Race Way',
    lat: 40.7,
    lng: -74.0,
    type: 'free',
    status: 'available',
    pingMode: 'now',
    reportedAt: Timestamp.fromMillis(Date.now() + 60_000),
    expiresAt: Timestamp.fromMillis(Date.now() + 20 * 60_000),
    ...extra,
  };
}

function claimReq(uid, spotId, attemptId) {
  return { auth: { uid }, data: { spotId, attemptId, mode: 'immediate', etaMinutes: 4, recoverLeftoverGeneration: true } };
}

async function prepare(env, uid, spotId, attemptId) {
  const prepared = await prepareClaimIntent(claimReq(uid, spotId, attemptId), serverDeps(env.db));
  expect(prepared.state).toBe('prepared');
}

// Oct 16 direct claim (1ffeba94 acquireActiveIncomingClaim + useInterestFlow),
// without the optional identity display fields.
function directClaim(env, uid, spotId) {
  const db = env.rules.authenticatedContext(uid).firestore();
  const spotRef = client.doc(db, 'spots', spotId);
  const lockRef = client.doc(db, 'users', uid, 'activeIncomingClaims', 'current');
  return client.runTransaction(db, async (tx) => {
    const snap = await tx.get(spotRef);
    await tx.get(lockRef);
    if (!snap.exists()) throw new Error('missing');
    if (snap.data().status !== 'available') throw new Error('unavailable');
    const claimStartedAt = client.Timestamp.now();
    tx.update(spotRef, {
      status: 'interested',
      claimState: 'heading',
      interestedUserId: uid,
      claimStartedAt,
      etaMinutes: 4,
      interestExpiresAt: client.Timestamp.fromMillis(Date.now() + 9 * 60_000),
    });
    tx.set(lockRef, { spotId, claimStartedAt, claimState: 'heading', updatedAt: claimStartedAt });
    return 'claimed';
  });
}

// A lock write that does not touch the Ping.
function clientLockOnly(env, uid, spotId, claimStartedAt, claimState = 'heading') {
  const db = env.rules.authenticatedContext(uid).firestore();
  return client.setDoc(client.doc(db, 'users', uid, 'activeIncomingClaims', 'current'), {
    spotId,
    claimStartedAt: claimStartedAt || client.Timestamp.now(),
    claimState,
    updatedAt: client.Timestamp.now(),
  });
}

async function settle(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, code: error && error.code ? String(error.code) : 'error', message: String(error && error.message).slice(0, 300) };
  }
}

async function locksNaming(env, spotId) {
  const snap = await env.db.collectionGroup('activeIncomingClaims').where('spotId', '==', spotId).get();
  return snap.docs.map((doc) => ({ owner: doc.ref.parent.parent.id, ...doc.data() }));
}

async function spotData(env, spotId) {
  const snap = await env.db.collection('spots').doc(spotId).get();
  return snap.exists ? snap.data() : null;
}

// Runs A's recovery and fires `competitor` once, right after A's empty lock
// query, then holds A's transaction open for up to `holdMs` (or until the
// competitor settles). Returns A's result, the competitor result, and whether
// the competitor settled while A was still open.
async function raceAfterEmptyQuery(env, row, competitor, holdMs = 1500) {
  let fired = null;
  let settledDuringHold = false;
  let queryCalls = 0;
  const deps = serverDeps(env.db, {
    allowTestHooks: true,
    afterRecoveryQuery: async (empty) => {
      queryCalls += 1;
      if (fired || !empty) return;
      fired = settle(competitor());
      await Promise.race([fired.then(() => { settledDuringHold = true; }), sleep(holdMs)]);
    },
  });
  const a = await settle(claimSpot(claimReq(row.a, row.s, row.attemptA), deps));
  const other = fired ? await fired : null;
  return { a, other, settledDuringHold, queryCalls };
}

function log(record) { console.log(JSON.stringify({ t683u: true, ...record })); }

beforeAll(async () => {
  for (let i = 0; i < 300; i += 1) {
    const bytes = Buffer.alloc(32, 0x10 + (i % 0x50)).toString('hex');
    if (bytes === G1) throw new Error('mint fixture collides with G1');
  }
  for (const set of RULESETS) {
    const projectId = `demo-parkqueen-s7-t683u-${set.key}`;
    const rules = readRules(set);
    const rulesEnv = await initializeTestEnvironment({
      projectId,
      firestore: { host: emulatorHost, port: emulatorPort, rules: rules.text },
    });
    const app = initializeApp({ projectId }, `t683u-${set.key}`);
    envs[set.key] = { set, rules: rulesEnv, db: getFirestore(app), digest: rules.digest };
    log({ ruleset: set.key, file: set.file, sha256: rules.digest });
  }
});

afterAll(async () => {
  for (const env of Object.values(envs)) await env.rules.cleanup();
});

describe.each(RULESETS.map((set) => [set.key]))('T2-G3 orphan recovery race under %s rules', (key) => {
  it(`SECURITY RACE-1-${key}: a client lock naming an available Ping is denied, standalone and during a paused recovery; positive control succeeds`, async () => {
    const env = envs[key];
    const row = ids(`r1${key}`);
    await seed(env, row, availableSpot(row.finder, { claimGenerationId: G1 }));
    const standalone = await settle(clientLockOnly(env, row.b, row.s));
    expect(standalone.ok).toBe(false);
    expect(standalone.code).toBe('permission-denied');
    expectNotLimit(key, standalone);

    await prepare(env, row.a, row.s, row.attemptA);
    const race = await raceAfterEmptyQuery(env, row, () => clientLockOnly(env, row.b, row.s));
    expect(race.other.ok).toBe(false);
    expect(race.other.code).toBe('permission-denied');
    expectNotLimit(key, race.other);
    expect(race.a.ok).toBe(true);
    expect(race.a.value.outcome).toBe('claimed');
    const spot = await spotData(env, row.s);
    expect(spot.interestedUserId).toBe(row.a);
    expect(spot.claimGenerationId).not.toBe(G1);
    const locks = await locksNaming(env, row.s);
    expect(locks.map((lock) => lock.owner)).toEqual([row.a]);

    // Positive control: the writer's own interested Ping accepts the same lock shape.
    const started = Timestamp.fromMillis(Date.now() - 30_000);
    await env.db.collection('spots').doc(row.s2).set(availableSpot(row.finder, {
      status: 'interested', interestedUserId: row.b, claimState: 'heading', claimStartedAt: started,
    }));
    const control = await settle(clientLockOnly(env, row.b, row.s2, client.Timestamp.fromMillis(started.toMillis())));
    expect(control).toEqual({ ok: true, value: undefined });
    log({ case: `RACE-1-${key}`, standalone: standalone.code, during: race.other.code, a: race.a.value.outcome, queryCalls: race.queryCalls, control: control.ok });
  });

  it(`SECURITY RACE-2-${key}: a rules-bound direct claim fired after the empty query never yields two holders`, async () => {
    const env = envs[key];
    const row = ids(`r2${key}`);
    await seed(env, row, availableSpot(row.finder, { claimGenerationId: G1 }));
    // Controls: the same direct claim, standalone, on a plain available Ping
    // and on a Ping with a leftover generation (no race).
    await env.db.collection('spots').doc(row.s2).set(availableSpot(row.finder));
    const plain = await settle(directClaim(env, row.z, row.s2));
    const leftoverSpot = `${row.s2}_leftover`;
    await env.db.collection('spots').doc(leftoverSpot).set(availableSpot(row.finder, { claimGenerationId: G1 }));
    const leftover = await settle(directClaim(env, row.b, leftoverSpot));
    const leftoverAfter = await spotData(env, leftoverSpot);
    log({ case: `RACE-2-${key}-controls`, plain: plain.ok ? plain.value : `${plain.code}:${plain.message}`, leftover: leftover.ok ? leftover.value : `${leftover.code}:${leftover.message}`, leftoverInherited: leftoverAfter.claimGenerationId === G1 && leftoverAfter.interestedUserId === row.b });
    if (env.set.directClaim) expect(plain).toEqual({ ok: true, value: 'claimed' });
    else expect(plain.ok).toBe(false);
    expectNotLimit(key, plain);
    expectNotLimit(key, leftover);
    // B must hold no lock before the race (the control used B on another Ping).
    await env.db.collection('users').doc(row.b).collection('activeIncomingClaims').doc('current').delete();
    await env.db.collection('spots').doc(leftoverSpot).delete();
    await prepare(env, row.a, row.s, row.attemptA);
    const race = await raceAfterEmptyQuery(env, row, () => directClaim(env, row.b, row.s));
    const spot = await spotData(env, row.s);
    const locks = await locksNaming(env, row.s);
    const aClaimed = race.a.ok && race.a.value.outcome === 'claimed';
    const bClaimed = race.other.ok && race.other.value === 'claimed';
    expect(aClaimed && bClaimed).toBe(false);
    expect(locks.length).toBeLessThanOrEqual(1);
    expectNotLimit(key, race.other);
    if (aClaimed) {
      expect(spot.interestedUserId).toBe(row.a);
      expect(spot.claimGenerationId).not.toBe(G1);
    }
    if (bClaimed) expect(spot.interestedUserId).toBe(row.b);
    for (const lock of locks) expect(lock.owner).toBe(spot.interestedUserId);
    if (!aClaimed && !bClaimed) expect(spot.interestedUserId == null).toBe(true);
    log({
      case: `RACE-2-${key}`,
      a: race.a.ok ? race.a.value.outcome : race.a.code,
      b: race.other.ok ? race.other.value : race.other.code,
      bMessage: race.other.ok ? null : race.other.message,
      settledDuringHold: race.settledDuringHold,
      queryCalls: race.queryCalls,
      holder: spot.interestedUserId || null,
      generationIsLeftover: spot.claimGenerationId === G1,
      locks: locks.map((lock) => lock.owner === row.a ? 'A' : lock.owner === row.b ? 'B' : 'other'),
    });
  });

  it(`SECURITY RACE-2b-${key}: a direct claim that commits after prepare and before recovery makes recovery stale; one holder`, async () => {
    const env = envs[key];
    const row = ids(`r2b${key}`);
    await seed(env, row, availableSpot(row.finder, { claimGenerationId: G1 }));
    await prepare(env, row.a, row.s, row.attemptA);
    const b = await settle(directClaim(env, row.b, row.s));
    const a = await settle(claimSpot(claimReq(row.a, row.s, row.attemptA), serverDeps(env.db)));
    const spot = await spotData(env, row.s);
    const locks = await locksNaming(env, row.s);
    expect(a.ok).toBe(true);
    if (b.ok) {
      expect(a.value.outcome).toBe('stale_precondition');
      expect(spot.interestedUserId).toBe(row.b);
      expect(locks.map((lock) => lock.owner)).toEqual([row.b]);
    } else {
      expect(a.value.outcome).toBe('claimed');
      expect(locks.map((lock) => lock.owner)).toEqual([row.a]);
    }
    log({ case: `RACE-2b-${key}`, b: b.ok ? b.value : b.code, a: a.value.outcome, holder: spot.interestedUserId || null, generationIsLeftover: spot.claimGenerationId === G1 });
  });

  it(`SECURITY RACE-3-${key}: a competing server recovery fired after the empty query: exactly one claims`, async () => {
    const env = envs[key];
    const row = ids(`r3${key}`);
    await seed(env, row, availableSpot(row.finder, { claimGenerationId: G1 }));
    await prepare(env, row.a, row.s, row.attemptA);
    await prepare(env, row.b, row.s, row.attemptB);
    const race = await raceAfterEmptyQuery(env, row, () => claimSpot(claimReq(row.b, row.s, row.attemptB), serverDeps(env.db)));
    const outcomes = [race.a.ok ? race.a.value.outcome : race.a.code, race.other.ok ? race.other.value.outcome : race.other.code];
    expect(outcomes.filter((o) => o === 'claimed')).toHaveLength(1);
    const spot = await spotData(env, row.s);
    const winner = outcomes[0] === 'claimed' ? row.a : row.b;
    expect(spot.interestedUserId).toBe(winner);
    expect(spot.claimGenerationId).not.toBe(G1);
    expect((await locksNaming(env, row.s)).map((lock) => lock.owner)).toEqual([winner]);
    log({ case: `RACE-3-${key}`, outcomes, settledDuringHold: race.settledDuringHold, queryCalls: race.queryCalls });
  });
});

describe('T2-G3 phantom lock insert (CHARACTERIZATION, emulator only)', () => {
  it('CHARACTERIZATION RACE-4: an Admin SDK lock-only insert after the empty query (bypasses Rules; not a production writer)', async () => {
    const env = envs.deployed;
    const row = ids('r4');
    await seed(env, row, availableSpot(row.finder, { claimGenerationId: G1 }));
    await prepare(env, row.a, row.s, row.attemptA);
    const lockRef = env.db.collection('users').doc(row.z).collection('activeIncomingClaims').doc('current');
    const race = await raceAfterEmptyQuery(env, row, () => lockRef.set({
      spotId: row.s, claimStartedAt: Timestamp.now(), claimState: 'heading', updatedAt: Timestamp.now(),
    }), 3000);
    const spot = await spotData(env, row.s);
    const locks = await locksNaming(env, row.s);
    const record = {
      case: 'RACE-4',
      a: race.a.ok ? race.a.value.outcome : race.a.code,
      phantomWrite: race.other.ok ? 'committed' : race.other.code,
      phantomSettledWhileRecoveryOpen: race.settledDuringHold,
      recoveryQueryCalls: race.queryCalls,
      holder: spot.interestedUserId || null,
      locks: locks.map((lock) => (lock.owner === row.a ? 'A' : lock.owner === row.z ? 'Z' : 'other')).sort(),
    };
    log(record);
    // Only the invariants that hold for any phantom handling are asserted.
    expect(['claimed', 'refused_stale_generation']).toContain(record.a);
    if (record.a === 'claimed') expect(spot.interestedUserId).toBe(row.a);
  });
});

describe.each(RULESETS.map((set) => [set.key]))('T2 legacy identity is immutable for clients under %s rules', (key) => {
  it(`SECURITY RULES-1-${key}: no client can clear or set claimGenerationId, or rewrite claimStartedAt, on a live claim`, async () => {
    const env = envs[key];
    const row = ids(`ru${key}`);
    const started = Timestamp.fromMillis(Date.now() - 30_000);
    const genClaim = availableSpot(row.finder, {
      status: 'interested', interestedUserId: row.a, claimState: 'heading', claimStartedAt: started,
      claimGenerationId: G1, etaMinutes: 4,
    });
    await seed(env, row, genClaim);
    const legacyClaim = { ...genClaim };
    delete legacyClaim.claimGenerationId;
    await env.db.collection('spots').doc(row.s2).set(legacyClaim);
    const attempts = [];
    for (const [uid, label, eta] of [[row.a, 'claimant', 5], [row.finder, 'finder', 6], [row.b, 'other', 7]]) {
      const db = env.rules.authenticatedContext(uid).firestore();
      for (const [spotId, patch, what] of [
        [row.s, { claimGenerationId: null }, 'clearGeneration'],
        [row.s, { claimGenerationId: 'ab'.repeat(32) }, 'replaceGeneration'],
        [row.s2, { claimGenerationId: 'ab'.repeat(32) }, 'addGeneration'],
        [row.s2, { claimStartedAt: client.Timestamp.fromMillis(started.toMillis() + 1) }, 'rewriteClaimStartedAt'],
        [row.s2, { claimStartedAt: client.Timestamp.fromMillis(started.toMillis()), etaMinutes: eta }, 'echoClaimStartedAtWithEta'],
      ]) {
        const result = await settle(client.updateDoc(client.doc(db, 'spots', spotId), patch));
        attempts.push({ label, what, ok: result.ok, code: result.code || null, message: result.message || '' });
      }
    }
    log({ case: `RULES-1-${key}`, attempts: attempts.map((a) => `${a.label}:${a.what}:${a.ok ? 'ok' : a.code}`) });
    // Positive control: the claimant's ETA update that echoes the unchanged
    // claimStartedAt is allowed (Arm 2), so the denials above are identity
    // denials and not a harness failure.
    for (const attempt of attempts) {
      if (attempt.what === 'echoClaimStartedAtWithEta' && attempt.label === 'claimant') {
        expect(attempt).toMatchObject({ ok: true });
        continue;
      }
      expect(attempt).toMatchObject({ ok: false, code: 'permission-denied' });
      expectNotLimit(key, attempt);
    }
    const stillGen = await spotData(env, row.s);
    const stillLegacy = await spotData(env, row.s2);
    expect(stillGen.claimGenerationId).toBe(G1);
    expect(stillLegacy.claimGenerationId).toBeUndefined();
    expect(stillLegacy.claimStartedAt.isEqual(started)).toBe(true);
    expect(stillLegacy.etaMinutes).toBe(5);
  });
});

describe.each(RULESETS.map((set) => [set.key]))('T2 denial reasons under %s rules (t684u)', (key) => {
  const blocked = limitBlocked(key);
  const label = blocked
    ? `BLOCKER REASON-1-${key}: denials used by RACE-1, RACE-2 and RULES-1 are not expression-limit denials (expected to fail for #332 daf120c6, where every denied spot update reaches the 1,000-expression limit)`
    : `SECURITY REASON-1-${key}: denials used by RACE-1, RACE-2 and RULES-1 are not expression-limit denials`;
  (blocked ? it.fails : it)(label, async () => {
    const env = envs[key];
    const row = ids(`rr${key}`);
    const started = Timestamp.fromMillis(Date.now() - 30_000);
    await seed(env, row, availableSpot(row.finder, { claimGenerationId: G1 }));
    await env.db.collection('spots').doc(row.s2).set(availableSpot(row.finder, {
      status: 'interested', interestedUserId: row.a, claimState: 'heading', claimStartedAt: started,
      claimGenerationId: G1, etaMinutes: 4,
    }));
    const claimant = env.rules.authenticatedContext(row.a).firestore();
    const other = env.rules.authenticatedContext(row.b).firestore();
    const results = {
      lockOnly: await settle(clientLockOnly(env, row.b, row.s)),
      clearGeneration: await settle(client.updateDoc(client.doc(claimant, 'spots', row.s2), { claimGenerationId: null })),
      otherEta: await settle(client.updateDoc(client.doc(other, 'spots', row.s2), {
        claimStartedAt: client.Timestamp.fromMillis(started.toMillis()), etaMinutes: 7,
      })),
      directClaimLeftover: await settle(directClaim(env, row.b, row.s)),
    };
    const reasons = Object.fromEntries(Object.entries(results).map(([name, result]) => [
      name, result.ok ? 'allowed' : `${result.code}:${denialReason(result.message || '')}`,
    ]));
    log({ case: `REASON-1-${key}`, blocked, reasons });
    for (const name of ['lockOnly', 'clearGeneration', 'otherEta']) {
      expect(results[name]).toMatchObject({ ok: false, code: 'permission-denied' });
    }
    // Deployed rules still allow the leftover-generation direct claim (the known bypass).
    if (key !== 'deployed') expect(results.directClaimLeftover.ok).toBe(false);
    for (const result of Object.values(results)) {
      if (!result.ok) expect(denialReason(result.message || '')).not.toBe('evaluation-limit');
    }
  });
});
