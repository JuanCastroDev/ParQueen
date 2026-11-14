'use strict';

// S7 T2 lock-writer inventory guard (t684u). Static, offline.
//
// Pins every source file that names users/{uid}/activeIncomingClaims/current
// and every call that can create or update that lock. A new writer, a new
// lock write in an existing file, a batch/create/update lock write, or a
// rules match that could reach the lock path fails here and must be added to
// the t684u inventory with its F1 argument (same commit establishes or
// validates the named Ping as interested by the owner) and an emulator test
// (s7T2LockWriterF1.emulator.integration.test.js).

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', 'test-fixtures', 'lib', '.firebase', 'ios', 'android', 'public']);
const SOURCE = /\.(?:js|cjs|mjs|ts|tsx|jsx)$/;
const TEST = /\.(?:test|spec)\.|\.integration\.|__tests__|[\\/]test[\\/]|[\\/]tests[\\/]/;
const LOCK_TOKEN = /activeIncomingClaims|ACTIVE_INCOMING_CLAIM_COLLECTION|activeIncomingClaimRef\(/;

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(path.join(dir, entry.name), out);
    } else if (SOURCE.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const sources = walk(ROOT, []).map((p) => ({ file: rel(p), text: fs.readFileSync(p, 'utf8') }))
  .filter(({ file }) => !TEST.test(file));

// Files that reference the lock path (readers, deleters and writers).
const LOCK_FILES = [
  'functions/activeIncomingClaim.js',
  'functions/activeIncomingClaimLogic.js',
  'functions/cancelClaim.js',
  'functions/claimSpot.js',
  'functions/index.js',
  'functions/orphanGenerationCleanup.js',
  'views/street-parking/activeIncomingClaim.ts',
  'views/street-parking/cancelClaimTransaction.ts',
  'views/street-parking/completeTerminalHandoff.ts',
  'views/street-parking/recoverActiveClaim.ts',
].sort();

// The only lock create/update calls (t684u inventory W1..W3).
const LOCK_SETS = {
  'functions/claimSpot.js': 1, // W1 claimSpot: tx.update(spotRef, claimPatch) + tx.set(lockRef) in one transaction
  'functions/activeIncomingClaim.js': 1, // W2 reconcileUserClaims: tx.get(claim.ref) + pingHoldsActiveClaim, then tx.set(lockRef)
  'views/street-parking/activeIncomingClaim.ts': 1, // W3 acquireActiveIncomingClaim (Oct 16 client, Rules lockAgreesWithSpotAfter)
};

// Files whose lockRef is not the claim lock, and those definitions.
const OTHER_LOCKREF_FILES = ['functions/index.js', 'functions/suspensionAccess.js'];
const OTHER_LOCKREF_DEFS = ["db.doc('adminRoleLock/singleton')", 'suspensionLockRef(userId)'];

function between(text, startMarker, endMarker) {
  const a = text.indexOf(startMarker);
  expect(a).toBeGreaterThanOrEqual(0);
  const b = text.indexOf(endMarker, a);
  expect(b).toBeGreaterThan(a);
  return text.slice(a, b);
}

describe('S7 lock-writer inventory (t684u)', () => {
  it('INVENTORY-1: exactly the pinned source files reference the activeIncomingClaims lock', () => {
    const found = sources.filter(({ text }) => LOCK_TOKEN.test(text)).map(({ file }) => file).sort();
    expect(found).toEqual(LOCK_FILES);
  });

  it('INVENTORY-2: the only lock create/update calls are the pinned W1..W3; no batch, create or update writes the lock', () => {
    const counts = {};
    for (const { file, text } of sources) {
      const n = (text.match(/\.set\(\s*lockRef\b/g) || []).length;
      const defs = [...text.matchAll(/const lockRef = ([^;]+);/g)].map((m) => m[1].trim());
      if (defs.some((d) => /activeIncomingClaim/.test(d))) {
        // Every lockRef in a claim-lock file is the claim lock.
        for (const d of defs) expect({ file, def: d, claimLock: /activeIncomingClaim/.test(d) }).toEqual({ file, def: d, claimLock: true });
        if (n) counts[file] = n;
      } else if (n) {
        // Unrelated locks named lockRef (admin role lock, suspension lock).
        expect({ file, known: OTHER_LOCKREF_FILES.includes(file) }).toEqual({ file, known: true });
        for (const d of defs) expect({ file, def: d, known: OTHER_LOCKREF_DEFS.includes(d) }).toEqual({ file, def: d, known: true });
      }
      expect({ file, other: /\.(?:create|update)\(\s*lockRef\b/.test(text) }).toEqual({ file, other: false });
      expect({ file, setDocLock: /setDoc\(\s*(?:lockRef|activeIncomingClaimRef)/.test(text) }).toEqual({ file, setDocLock: false });
      if (LOCK_TOKEN.test(text)) {
        // Batches in lock files (functions/index.js sweepers and deleteAccount
        // release) write only query-result Ping documents (d.ref), never a lock.
        for (const m of text.matchAll(/\bbatch\.(set|update|create|delete)\(\s*([^,)]+)/g)) {
          expect({ file, op: m[1], target: m[2].trim() }).toEqual({ file, op: m[1], target: 'd.ref' });
        }
        expect({ file, writeBatch: /writeBatch\(/.test(text) }).toEqual({ file, writeBatch: false });
        expect({ file, direct: /activeIncomingClaim(?:s'|Ref\([^)]*\))\s*\)?\s*\.(?:set|update|create)\(/.test(text) }).toEqual({ file, direct: false });
      }
    }
    expect(counts).toEqual(LOCK_SETS);
  });

  it('INVENTORY-3: each writer sets the lock only in the transaction that reads (and for W1/W3 claims) the named Ping', () => {
    const claimSpot = fs.readFileSync(path.join(__dirname, 'claimSpot.js'), 'utf8');
    const w1 = between(claimSpot, 'async function claimSpot(', 'function spotStillThisGeneration(');
    expect(w1).toContain('db.runTransaction(async (tx) =>');
    expect(w1).toContain('const spotSnap = await tx.get(spotRef);');
    expect(w1).toMatch(/tx\.update\(spotRef, patch\);\s*tx\.set\(lockRef, \{\s*spotId: input\.spotId,/);
    expect(w1).toContain('else if (!spotIsClaimable(spot, uid)) outcome = \'unavailable\';');
    expect(w1).toContain('!sameTime(record.spotUpdateTime, spotSnap.updateTime)');

    const lockModule = fs.readFileSync(path.join(__dirname, 'activeIncomingClaim.js'), 'utf8');
    const w2 = between(lockModule, 'async function reconcileUserClaims(', 'async function writeRolloutStatus(');
    expect(w2).toContain('return db.runTransaction(async (tx) => {');
    expect(w2).toContain('const snap = await tx.get(claim.ref);');
    expect(w2).toContain('if (!pingHoldsActiveClaim(spot, uid)) continue;');
    expect(w2).toMatch(/tx\.set\(lockRef, \{\s*spotId: keep\.spotId,/);
    const logic = fs.readFileSync(path.join(__dirname, 'activeIncomingClaimLogic.js'), 'utf8');
    expect(between(logic, 'function pingHoldsActiveClaim(', '\n}\n')).toMatch(/spot\.status === 'interested'\s*&& spot\.interestedUserId === uid/);

    const clientWriter = fs.readFileSync(path.join(ROOT, 'views/street-parking/activeIncomingClaim.ts'), 'utf8');
    const w3 = between(clientWriter, 'export async function acquireActiveIncomingClaim(', 'export async function markClaimArrived(');
    expect(w3).toContain('return runTransaction(db, async (tx) => {');
    expect(w3).toContain('const spotSnap = await tx.get(spotRef);');
    expect(w3).toMatch(/tx\.update\(spotRef, \{ \.\.\.fields, claimState, claimStartedAt \}\);\s*tx\.set\(lockRef, \{\s*spotId: params\.spotId,/);
  });

  it('INVENTORY-4: in every ruleset exactly one match reaches the lock, it has no recursive wildcard, and create/update require lockAgreesWithSpotAfter', () => {
    for (const file of [
      'test-fixtures/production-baseline/deployed-firestore-134a97cf.rules',
      'test-fixtures/interim-candidate/firestore.interim-legacy-hardened.rules',
      'firestore.rules',
    ]) {
      const rules = fs.readFileSync(path.join(ROOT, file), 'utf8');
      expect({ file, n: (rules.match(/match \/activeIncomingClaims\/\{claimId\}/g) || []).length }).toEqual({ file, n: 1 });
      // Recursive wildcards may only end in a named collection other than the lock's.
      for (const m of rules.matchAll(/match (\S*=\*\*\S*) \{/g)) {
        expect({ file, match: m[1], lockReachable: !/\/[A-Za-z]+\/\{[A-Za-z]+\}$/.test(m[1]) || /activeIncomingClaims/.test(m[1]) })
          .toEqual({ file, match: m[1], lockReachable: false });
      }
      const users = between(rules, 'match /users/{userId} {', 'match /pingCreateRate/{rateId}');
      expect({ file, wildcard: /\{[A-Za-z]+=\*\*\}|match \/\{[A-Za-z]+\}\/\{[A-Za-z]+\}/.test(users) }).toEqual({ file, wildcard: false });
      const block = between(rules, 'match /activeIncomingClaims/{claimId} {', 'allow delete:');
      expect(block).toMatch(/allow create, update: if [\s\S]*&& lockAgreesWithSpotAfter\(request\.resource\.data\)/);
      expect(block).toContain("claimId == 'current'");
      expect(block).toContain('request.auth.uid == userId');
      const fn = between(rules, 'function lockAgreesWithSpotAfter(data) {', '\n    }\n');
      for (const clause of ['existsAfter(path)', "spot.status == 'interested'", 'spot.interestedUserId == request.auth.uid', 'spot.claimStartedAt == data.claimStartedAt']) {
        expect({ file, clause, present: fn.includes(clause) }).toEqual({ file, clause, present: true });
      }
    }
  });
});
