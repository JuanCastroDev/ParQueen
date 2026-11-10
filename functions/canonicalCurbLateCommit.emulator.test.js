import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp, FieldValue } = require('firebase-admin/firestore');
const { persistCanonicalCurb } = require('./curbIntelligence/canonicalCurbPersistence');
const { createRequestDeadline } = require('./curbIntelligence/requestDeadline');
const { resolveCanonicalCurb } = require('./curbIntelligence/canonicalCurbResolver');
const { createPrivateBlockfaceResolver } = require('./curbIntelligence/privateBlockfaceResolver');
const { proveCanonicalCurbIdentity } = require('./curbIntelligence/canonicalCurbIdentityProof');
const { publicCurbKey } = require('./curbIntelligence/canonicalCurbIdentity');

const enabled = process.env.PARQUEEN_LATE_COMMIT_EMULATOR === '1';
const host = process.env.FIRESTORE_EMULATOR_HOST || '';

describe.skipIf(!enabled)('canonical curb late-commit emulator', () => {
  it('resolves serverTimestamp at commit time and excludes a physically late write', async () => {
    if (!host.startsWith('127.0.0.1:') || host.endsWith(':8080')) {
      throw new Error(`Refusing emulator host ${host}`);
    }
    if (getApps().length === 0) initializeApp({ projectId: 'demo-parkqueen-late-commit' });
    const firestore = getFirestore();
    let delayMs = 0;
    const db = {
      doc: (path) => firestore.doc(path),
      collection: (path) => firestore.collection(path),
      runTransaction: (fn) => firestore.runTransaction(async (tx) => {
        if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
        return fn(tx);
      }),
    };
    const row = {
      globalid: 'private-global', physicalid: 'private-physical', b5sc: 'private-b5sc',
      l_blockfaceid: '1000000001', r_blockfaceid: '1000000002', boroughcode: '2', rw_type: '1',
      full_street_name: 'MARAN PLACE', street_name: 'MARAN PLACE', stname_label: 'MARAN PL',
      streetwidth: '34', from_level_code: '13', to_level_code: '13', status: '2', nonped: '', accessible: '',
      from_street: 'WHITE PLAINS ROAD', to_street: 'LURTING AVENUE',
      the_geom: { type: 'MultiLineString', coordinates: [[[-74, 40.7], [-73.999, 40.7]]] },
    };
    const fetchFn = async (url) => ({
      ok: true,
      json: async () => (String(url).includes('/api/views/')
        ? { id: 'inkn-q76z', rowsUpdatedAt: 1767225600, viewLastModified: 1767225660 }
        : [row]),
    });
    const topologyResult = await resolveCanonicalCurb({
      lat: 40.70005, lng: -73.9999, accuracyMeters: 1, sampleCount: 3, consistencyMeters: 1,
    }, { fetchFn, requestNonce: 'late-commit-emulator' });
    const body = {
      ok: true,
      officialBlockFaceId: topologyResult.identity.officialBlockFaceId,
      normalizedStreetNames: {
        onStreet: 'MARAN PLACE', crossStreetOne: 'WHITE PLAINS ROAD', crossStreetTwo: 'LURTING AVENUE',
      },
      returnCode: '00', reasonCode: ' ',
      sourceVersion: { geosupportRelease: '26C', geosupportVersion: '26.3' },
    };
    const identityProof = await proveCanonicalCurbIdentity(topologyResult, {
      blockfaceResolver: createPrivateBlockfaceResolver({
        mode: 'shadow', serviceUrl: 'https://parqueen-test-resolver-uc.a.run.app',
        getIdToken: async () => 'synthetic-token',
        transport: async () => ({ status: 200, text: async () => JSON.stringify(body) }),
      }),
    });
    const deadline = createRequestDeadline({ startedAt: Date.now() - 7_550, budgetMs: 8_000 });
    delayMs = 350;
    const result = await persistCanonicalCurb({
      db,
      Timestamp,
      FieldValue,
      topologyResult,
      identityProof,
      selectedRules: { rules: [] },
      signal: deadline.signal,
      deadlineAt: deadline.deadlineAt,
      persistToken: deadline.persistToken,
      persistAllowed: deadline.persistAllowed,
    });
    const key = publicCurbKey(topologyResult.identity);
    const published = await firestore.doc(`streetSegments/${key}`).get();
    expect(result.success).toBe(false);
    expect(published.exists).toBe(false);
    deadline.dispose();
  }, 20_000);
});