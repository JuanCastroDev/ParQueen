'use strict';

// S7 T2 lock-writer invariant F1 (t684u). Emulator behavior tests.
//
// F1: a lock users/{uid}/activeIncomingClaims/current naming Ping S is
// committed only by a commit that also establishes or validates S as
// interested by uid. The inventory of writers is pinned statically in
// s7LockWriterInventory.test.js. This file checks each writer's behavior:
//   LW-1  claimSpot (server, Admin SDK): the lock and the Ping claim are one
//         commit (same update time, agreeing fields); a Ping change after
//         prepare leaves no lock.
//   LW-2  reconcileActiveIncomingClaims -> reconcileUserClaims (scheduled
//         server repair): a lock is written only for a Ping that its own
//         transaction reads as interested by the owner. Ping not rewritten.
//   LW-3  reconcile fired while a T2-G3 recovery is paused after its empty
//         lock query: reconcile cannot name the available Ping.
//   LW-4  F2: a conditional (lastUpdateTime) Admin write that claims S for B
//         fired while the recovery is paused, then reconcile: never two
//         holders, every lock naming S belongs to S's holder.
//   LW-5  client lock create/update under deployed, interim (#332 candidate
//         daf120c6) and head rules: re-pointing an existing lock at an
//         available Ping, or naming a Ping held by someone else, is denied,
//         standalone and during a paused recovery; positive control allowed.
//         Every denial is checked not to come from the expression limit.
// RACE-4 (t683u file) stays a CHARACTERIZATION: an arbitrary Admin SDK write
// is outside F1 and this file does not claim otherwise. Nothing here relies on
// Firestore preventing phantom inserts into a query range.

require('./isolatedEmulatorGuard').assertIsolatedEmulator({ services: ['firestore'] });

const ISOLATED = 'demo-parkqueen-parking-fence-iso';
const host = process.env.FIRESTORE_EMULATOR_HOST || '';
if (process.env.GCLOUD_PROJECT !== ISOLATED || host === '' || host.endsWith(':8080')) {
  throw new Error('Refusing lock-writer F1 proof outside the isolated emulator');
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
const { reconcileActiveIncomingClaims } = require('./activeIncomingClaim');

const RULESETS = [
  { key: 'deployed', file: 'test-fixtures/production-baseline/deployed-firestore-134a97cf.rules', sha256: '134a97cf8e25f2f8848ff4d2c0ff65ff5dd83434f1690901b4ba7dffe403810b' },
  { key: 'interim', file: 'test-fixtures/interim-candidate/firestore.interim-legacy-hardened.rules', sha256: 'c1508fa02a15fff9b3a2d4a965d40254f540c7c69ffe5aed6405c0a6bb090400' },
  { key: 'head', file: 'firestore.rules', sha256: null },
];

const G1 = '6e'.repeat(32);
let mint = 0;
let sequence = 0;
const envs = {};
let server = null;

function sleep(ms) { return new Promise((resolve) => { setTimeout(resolve, ms); }); }
function log(record) { console.log(JSON.stringify({ t684u: true, ...record })); }

function classifyDenial(message) {
  if (/maximum of \d+ expressions to evaluate has been reached/i.test(message)) return 'evaluation-limit';
  if (/evaluation error at L\d+/i.test(message)) return 'evaluation-error';
  if (/false for '[a-z]+' @ L\d+/.test(message)) return 'clean-false';
  return 'other';
}

function ids(label) {
  sequence += 1;
  const n = String(sequence).padStart(12, '0');
  return {
    a: `lwA_${label}_${n}`, b: `lwB_${label}_${n}`, z: `lwZ_${label}_${n}`, finder: `lwF_${label}_${n}`,
    s: `lwS_${label}_${n}`, s2: `lwS2_${label}_${n}`, s3: `lwS3_${label}_${n}`,
    attemptA: `efefefef-efef-4fef-8fef-${n}`,
  };
}

function serverDeps(db, extra = {}) {
  return {
    db,
    now: () => Timestamp.now(),
    checkRateLimit: async () => {},
    // Fill bytes 0x10..0x5f: never equal to G1 (0x6e).
    randomBytes: () => { mint += 1; return Buffer.alloc(32, 0x10 + (mint % 0x50)); },
    ...extra,
  };
}

function profile(name) { return { status: 'Active', productAccessBlocked: false, username: name, fullName: name, crowns: 0 }; }

function availableSpot(finder, extra = {}) {
  return {
    finderId: finder, finderName: 'bea', address: '1 Writer Way', lat: 40.7, lng: -74.0, type: 'free',
    status: 'available', pingMode: 'now',
    reportedAt: Timestamp.fromMillis(Date.now() + 60_000), expiresAt: Timestamp.fromMillis(Date.now() + 20 * 60_000),
    ...extra,
  };
}

function interestedSpot(finder, uid, started, extra = {}) {
  return availableSpot(finder, { status: 'interested', interestedUserId: uid, claimState: 'heading', claimStartedAt: started, etaMinutes: 4, ...extra });
}

async function seed(db, row, spots) {
  await db.collection('activeIncomingClaimRollout').doc('status').set({ enforced: true, locklessCount: 0, duplicateUserCount: 0, duplicatePingCount: 0 });
  for (const [uid, name] of [[row.a, 'ada'], [row.b, 'bob'], [row.z, 'zed'], [row.finder, 'bea']]) {
    await db.collection('users').doc(uid).set(profile(name));
  }
  for (const [id, data] of Object.entries(spots)) await db.collection('spots').doc(id).set(data);
}

function claimReq(uid, spotId, attemptId) {
  return { auth: { uid }, data: { spotId, attemptId, mode: 'immediate', etaMinutes: 4, recoverLeftoverGeneration: true } };
}

async function settle(promise) {
  try { return { ok: true, value: await promise }; } catch (error) {
    const message = String(error && error.message);
    return { ok: false, code: error && error.code ? String(error.code) : 'error', reason: classifyDenial(message), message: message.slice(0, 300) };
  }
}

const lockRef = (db, uid) => db.collection('users').doc(uid).collection('activeIncomingClaims').doc('current');

async function locksNaming(db, spotId) {
  const snap = await db.collectionGroup('activeIncomingClaims').where('spotId', '==', spotId).get();
  return snap.docs.map((doc) => ({ owner: doc.ref.parent.parent.id, createTime: doc.createTime, ...doc.data() }));
}

// F1 check over every lock naming the listed Pings.
async function assertF1(db, spotIds) {
  for (const spotId of spotIds) {
    const spot = (await db.collection('spots').doc(spotId).get()).data() || {};
    for (const lock of await locksNaming(db, spotId)) {
      expect({ spotId, owner: lock.owner, status: spot.status, holder: spot.interestedUserId })
        .toEqual({ spotId, owner: lock.owner, status: 'interested', holder: lock.owner });
    }
  }
}

async function raceAfterEmptyQuery(db, row, competitor, holdMs = 1500) {
  let fired = null;
  let settledDuringHold = false;
  let queryCalls = 0;
  const deps = serverDeps(db, {
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

beforeAll(async () => {
  for (let i = 0; i < 300; i += 1) {
    if (Buffer.alloc(32, 0x10 + (i % 0x50)).toString('hex') === G1) throw new Error('mint fixture collides with G1');
  }
  server = getFirestore(initializeApp({ projectId: 'demo-parkqueen-s7-t684u-server' }, 't684u-server'));
  for (const set of RULESETS) {
    const projectId = `demo-parkqueen-s7-t684u-${set.key}`;
    const bytes = fs.readFileSync(path.join(__dirname, '..', set.file));
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (set.sha256 && digest !== set.sha256) throw new Error(`${set.file} digest mismatch: ${digest}`);
    const rules = await initializeTestEnvironment({ projectId, firestore: { host: emulatorHost, port: emulatorPort, rules: bytes.toString('utf8') } });
    envs[set.key] = { set, rules, db: getFirestore(initializeApp({ projectId }, `t684u-${set.key}`)) };
    log({ ruleset: set.key, file: set.file, sha256: digest });
  }
});

afterAll(async () => {
  for (const env of Object.values(envs)) await env.rules.cleanup();
});

describe('F1 server writer claimSpot (functions/claimSpot.js)', () => {
  it('SECURITY LW-1: the lock and the Ping claim commit together with agreeing fields; a Ping change after prepare leaves no lock', async () => {
    const row = ids('lw1');
    await seed(server, row, { [row.s]: availableSpot(row.finder), [row.s2]: availableSpot(row.finder) });
    const prepared = await prepareClaimIntent(claimReq(row.a, row.s, row.attemptA), serverDeps(server));
    expect(prepared.state).toBe('prepared');
    const claimed = await claimSpot(claimReq(row.a, row.s, row.attemptA), serverDeps(server));
    expect(claimed.outcome).toBe('claimed');
    const spotSnap = await server.collection('spots').doc(row.s).get();
    const lockSnap = await lockRef(server, row.a).get();
    const spot = spotSnap.data();
    const lock = lockSnap.data();
    expect(lockSnap.updateTime.isEqual(spotSnap.updateTime)).toBe(true);
    expect(lock.spotId).toBe(row.s);
    expect(spot.status).toBe('interested');
    expect(spot.interestedUserId).toBe(row.a);
    expect(lock.claimStartedAt.isEqual(spot.claimStartedAt)).toBe(true);
    expect(lock.claimGenerationId).toBe(spot.claimGenerationId);
    expect(lock.claimState).toBe(spot.claimState);

    // A Ping change after prepare: Z holds S2 by the time A's claim runs.
    const attemptA2 = `${row.attemptA.slice(0, -4)}aaaa`;
    expect((await prepareClaimIntent(claimReq(row.b, row.s2, attemptA2), serverDeps(server))).state).toBe('prepared');
    await server.collection('spots').doc(row.s2).update({ status: 'interested', interestedUserId: row.z, claimState: 'heading', claimStartedAt: Timestamp.now() });
    const stale = await claimSpot(claimReq(row.b, row.s2, attemptA2), serverDeps(server));
    expect(stale.outcome).toBe('stale_precondition');
    expect((await lockRef(server, row.b).get()).exists).toBe(false);
    await assertF1(server, [row.s]);
    log({ case: 'LW-1', sameCommit: true, staleOutcome: stale.outcome });
  });
});

describe('F1 server writer reconcileUserClaims (functions/activeIncomingClaim.js)', () => {
  it('SECURITY LW-2: reconcile writes a lock only for a Ping its own transaction reads as interested by the owner, and does not rewrite the Ping', async () => {
    const row = ids('lw2');
    const started = Timestamp.fromMillis(Date.now() - 45_000);
    await seed(server, row, {
      [row.s]: interestedSpot(row.finder, row.a, started, { claimGenerationId: G1 }),
      // Stale claimant fields on an available Ping: not interested, no lock.
      [row.s2]: availableSpot(row.finder, { interestedUserId: row.b, claimStartedAt: started }),
    });
    const before = await server.collection('spots').doc(row.s).get();
    const result = await reconcileActiveIncomingClaims(server, Timestamp.now());
    const after = await server.collection('spots').doc(row.s).get();
    const lock = (await lockRef(server, row.a).get()).data();
    expect(lock.spotId).toBe(row.s);
    expect(lock.claimStartedAt.isEqual(started)).toBe(true);
    expect(lock.claimGenerationId).toBe(G1);
    expect(after.updateTime.isEqual(before.updateTime)).toBe(true);
    expect((await lockRef(server, row.b).get()).exists).toBe(false);
    expect(await locksNaming(server, row.s2)).toEqual([]);
    await assertF1(server, [row.s, row.s2]);
    log({ case: 'LW-2', locksEstablished: result.locksEstablished, pingRewritten: false });
  });

  it('SECURITY LW-3: reconcile fired after a recovery\'s empty lock query cannot name the available Ping; one holder', async () => {
    const row = ids('lw3');
    await seed(server, row, { [row.s]: availableSpot(row.finder, { claimGenerationId: G1 }) });
    expect((await prepareClaimIntent(claimReq(row.a, row.s, row.attemptA), serverDeps(server))).state).toBe('prepared');
    const race = await raceAfterEmptyQuery(server, row, () => reconcileActiveIncomingClaims(server, Timestamp.now()));
    expect(race.a.ok).toBe(true);
    expect(race.a.value.outcome).toBe('claimed');
    expect(race.other.ok).toBe(true);
    expect((await locksNaming(server, row.s)).map((l) => l.owner)).toEqual([row.a]);
    await assertF1(server, [row.s]);
    log({ case: 'LW-3', a: race.a.value.outcome, reconcileSettledDuringHold: race.settledDuringHold, queryCalls: race.queryCalls });
  });

  it('SECURITY LW-4: a Ping change committed while recovery is paused (conditional Admin claim for B, then reconcile) never yields two holders', async () => {
    const row = ids('lw4');
    await seed(server, row, { [row.s]: availableSpot(row.finder, { claimGenerationId: G1 }) });
    expect((await prepareClaimIntent(claimReq(row.a, row.s, row.attemptA), serverDeps(server))).state).toBe('prepared');
    const spotRef = server.collection('spots').doc(row.s);
    const readBefore = await spotRef.get();
    const bStarted = Timestamp.fromMillis(Date.now() - 1_000);
    let bWrite = null;
    const race = await raceAfterEmptyQuery(server, row, async () => {
      bWrite = await settle(spotRef.update(
        { status: 'interested', interestedUserId: row.b, claimState: 'heading', claimStartedAt: bStarted },
        { lastUpdateTime: readBefore.updateTime },
      ));
      return reconcileActiveIncomingClaims(server, Timestamp.now());
    }, 3000);
    const spot = (await spotRef.get()).data();
    const locks = await locksNaming(server, row.s);
    const aClaimed = race.a.ok && race.a.value.outcome === 'claimed';
    const bCommitted = bWrite && bWrite.ok;
    expect(aClaimed && bCommitted).toBe(false);
    expect(aClaimed || bCommitted).toBe(true);
    expect(locks.length).toBe(1);
    expect(locks[0].owner).toBe(spot.interestedUserId);
    if (bCommitted) expect(race.a.value.outcome).toBe('stale_precondition');
    await assertF1(server, [row.s]);
    log({
      case: 'LW-4',
      a: race.a.ok ? race.a.value.outcome : race.a.code,
      bWrite: bWrite ? (bWrite.ok ? 'committed' : bWrite.code) : null,
      holder: spot.interestedUserId === row.a ? 'A' : spot.interestedUserId === row.b ? 'B' : 'other',
      competitorSettledDuringHold: race.settledDuringHold,
      queryCalls: race.queryCalls,
    });
  });
});

function clientLock(env, uid, spotId, claimStartedAt) {
  const db = env.rules.authenticatedContext(uid).firestore();
  return client.setDoc(client.doc(db, 'users', uid, 'activeIncomingClaims', 'current'), {
    spotId, claimStartedAt: claimStartedAt || client.Timestamp.now(), claimState: 'heading', updatedAt: client.Timestamp.now(),
  });
}

describe.each(RULESETS.map((set) => [set.key]))('F1 client lock writes under %s rules', (key) => {
  it(`SECURITY LW-5-${key}: a client cannot re-point its lock at an available Ping or name another user's Ping; positive control allowed; no denial is the expression limit`, async () => {
    const env = envs[key];
    const row = ids(`lw5${key}`);
    const startedB = Timestamp.fromMillis(Date.now() - 30_000);
    const startedZ = Timestamp.fromMillis(Date.now() - 20_000);
    await seed(env.db, row, {
      [row.s]: availableSpot(row.finder, { claimGenerationId: G1 }),
      [row.s2]: interestedSpot(row.finder, row.b, startedB),
      [row.s3]: interestedSpot(row.finder, row.z, startedZ),
    });
    await lockRef(env.db, row.b).set({ spotId: row.s2, claimStartedAt: startedB, claimState: 'heading', updatedAt: Timestamp.now() });
    const denials = {};
    denials.repointStandalone = await settle(clientLock(env, row.b, row.s));
    denials.nameOthersPing = await settle(clientLock(env, row.b, row.s3, client.Timestamp.fromMillis(startedZ.toMillis())));
    expect((await prepareClaimIntent(claimReq(row.a, row.s, row.attemptA), serverDeps(env.db))).state).toBe('prepared');
    const race = await raceAfterEmptyQuery(env.db, row, () => clientLock(env, row.b, row.s));
    denials.repointDuringRecovery = race.other;
    denials.nameRecoveredPing = await settle(clientLock(env, row.b, row.s));
    const control = await settle(clientLock(env, row.b, row.s2, client.Timestamp.fromMillis(startedB.toMillis())));
    log({ case: `LW-5-${key}`, a: race.a.ok ? race.a.value.outcome : race.a.code, control: control.ok, denials: Object.fromEntries(Object.entries(denials).map(([k, v]) => [k, v.ok ? 'ALLOWED' : `${v.code}:${v.reason}`])) });
    for (const [name, d] of Object.entries(denials)) {
      expect({ name, ok: d.ok, code: d.code }).toEqual({ name, ok: false, code: 'permission-denied' });
      expect({ name, reason: d.reason }).not.toEqual({ name, reason: 'evaluation-limit' });
    }
    expect(control).toEqual({ ok: true, value: undefined });
    expect(race.a.ok).toBe(true);
    expect(race.a.value.outcome).toBe('claimed');
    expect((await locksNaming(env.db, row.s)).map((l) => l.owner)).toEqual([row.a]);
    expect((await lockRef(env.db, row.b).get()).data().spotId).toBe(row.s2);
    await assertF1(env.db, [row.s, row.s2, row.s3]);
  });
});
