'use strict';

// M12 of the deletedUserClaimRelease matrix, moved verbatim into its own file
// (t697u). The 1,050 seeded Pings fire spots onCreate triggers whose backlog
// outlives the test, so this file runs in a separate vitest pass after the
// main isolated suite (vite.functions.isolated.pagination.config.ts).
require('./isolatedEmulatorGuard').assertIsolatedEmulator({ services: ['firestore'] });

const PROJECT = 'demo-parkqueen-parking-fence-iso';
const host = process.env.FIRESTORE_EMULATOR_HOST || '';
if (process.env.GCLOUD_PROJECT !== PROJECT || host === '' || host.endsWith(':8080')) {
  throw new Error('Refusing deletion release pagination proof outside the isolated project and port');
}

const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { releaseClaimsOfDeletedUser } = require('./deletedUserClaimRelease');

if (getApps().length === 0) initializeApp({ projectId: PROJECT });
const db = getFirestore();

const GEN_A = 'a2'.repeat(32);
let seq = 0;

function tag(label) {
  seq += 1;
  return `${label}_${Date.now().toString(36)}${String(seq).padStart(4, '0')}`;
}
const future = () => Timestamp.fromMillis(Date.now() + 3_600_000);
const past = () => Timestamp.fromMillis(Date.now() - 3_600_000);
const spotRef = (id) => db.doc(`spots/${id}`);

function claimedBy(uid, extra = {}) {
  return {
    finderId: 'finder_matrix',
    status: 'interested',
    interestedUserId: uid,
    interestedUserName: 'Alice',
    interestedUserVehicleColor: 'red',
    interestedUserVehicleType: 'sedan',
    interestedUserVehicleBrand: 'Honda',
    interestedUserTitle: 'Newcomer',
    claimState: 'heading',
    claimStartedAt: Timestamp.fromMillis(Date.now() - 60_000),
    etaMinutes: 4,
    interestExpiresAt: future(),
    claimGenerationId: GEN_A,
    expiresAt: future(),
    reportedAt: future(),
    address: 'kept',
    ...extra,
  };
}

async function seedMany(uid, n, make) {
  const ids = [];
  for (let i = 0; i < n; i += 450) {
    const batch = db.batch();
    for (let j = i; j < Math.min(n, i + 450); j++) {
      const id = tag(`bulk${j}`);
      ids.push(id);
      batch.set(spotRef(id), make(j));
    }
    await batch.commit();
  }
  return ids;
}

async function remaining(uid) {
  return (await db.collection('spots').where('interestedUserId', '==', uid).get()).size;
}

describe('releaseClaimsOfDeletedUser large pagination on the isolated emulator', () => {
  it('M12 large paginated cleanup drains 1,050 Pings; the page bound fails closed', async () => {
    const a = tag('a');
    await seedMany(a, 1050, (j) => claimedBy(a, j % 3 === 0 ? { expiresAt: past() }
      : j % 3 === 1 ? { status: 'occupied', claimState: 'arrived_pending_outcome' } : {}));
    const counts = await releaseClaimsOfDeletedUser(db, a, { concurrency: 25 });
    expect(counts).toEqual({ reopen: 350, release: 350, scrub: 350, skip: 0, gone: 0 });
    expect(await remaining(a)).toBe(0);

    const c = tag('c');
    await seedMany(c, 5, () => claimedBy(c));
    await expect(releaseClaimsOfDeletedUser(db, c, { pageSize: 2, maxPages: 2 })).rejects.toThrow('did not converge');
    expect(await remaining(c)).toBe(1);
    await releaseClaimsOfDeletedUser(db, c, { pageSize: 2 });
    expect(await remaining(c)).toBe(0);
  }, 240000);

});
