import { describe, expect, it, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { classifyStreetIntelligence } from '../utils/streetIntelligencePresentation';
import { computeSafeUntil } from '../utils/streetIntelligence';

const require = createRequire(import.meta.url);
const { initializeApp, getApps } = require('firebase-admin/app');
const { getFirestore, Timestamp } = require('firebase-admin/firestore');
const { openDemoFirestore } = require('./curbIntelligence/localDemoFirestore');
const { loadOfficialLionPrimary, readOfficialLionPrimary } = require('./curbIntelligence/officialLionPrimaryTopology');
const { resolveCanonicalCurb } = require('./curbIntelligence/canonicalCurbResolver');
const { runCanonicalCurbOrchestrator } = require('./curbIntelligence/canonicalCurbOrchestrator');
const { persistCanonicalCurb } = require('./curbIntelligence/canonicalCurbPersistence');
const { createPrivateBlockfaceResolver } = require('./curbIntelligence/privateBlockfaceResolver');
const { proveCanonicalCurbIdentity } = require('./curbIntelligence/canonicalCurbIdentityProof');
const { loadCanonicalRules } = require('./curbIntelligence/canonicalRuleSources');

const ARCHIVE = process.env.CURB_LION_PRIMARY_ARCHIVE || '';
const GDAL = process.env.CURB_LION_GDAL_MODULE || '';
const IMAGE = process.env.CURB_LOCAL_GEOSUPPORT_IMAGE || '';
const SERVICE = process.env.CURB_LOCAL_GEOSUPPORT_SERVICE || '';
const SERVICE_URL = 'https://local-demo-disabled.run.app';
const GEOMETRY = [[[-73.869399076566, 40.841629393257], [-73.870996446086, 40.84311966193]]];
const PRESENTATION_NOW = new Date('2026-11-04T16:00:00.000Z');

const db = openDemoFirestore(process.env, ({ projectId }) => {
  if (projectId !== 'demo-parkqueen-functions-test') {
    throw new Error(`Refusing Firestore client for project ${projectId}`);
  }
  if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8080') {
    throw new Error('Refusing Firestore client because the emulator host changed');
  }
  if (getApps().length === 0) initializeApp({ projectId });
  return getFirestore();
});
if (!db) throw new Error('Refusing to create a Firestore client without the local demo emulator');

const responses = new Map();
const fetchLog = [];
let geosupport = null;
let admitted = null;
let blockfaceResolver = null;

function dockerBin() {
  const configured = process.env.CURB_LOCAL_DOCKER_BIN;
  if (typeof configured === 'string' && configured.trim() && existsSync(configured.trim())) {
    return configured.trim();
  }
  const standard = 'C:/Program Files/Docker/Docker/resources/bin/docker.exe';
  return existsSync(standard) ? standard : 'docker';
}

function offset(meters) {
  const line = GEOMETRY[0];
  const mid = [(line[0][0] + line[1][0]) / 2, (line[0][1] + line[1][1]) / 2];
  const dx = line[1][0] - line[0][0];
  const dy = line[1][1] - line[0][1];
  const length = Math.hypot(dx, dy);
  const ux = -dy / length;
  const uy = dx / length;
  const dLat = meters / 111320;
  const dLng = meters / (111320 * Math.cos(mid[1] * Math.PI / 180));
  return {
    left: { lat: mid[1] + uy * dLat, lng: mid[0] + ux * dLng },
    right: { lat: mid[1] - uy * dLat, lng: mid[0] - ux * dLng },
  };
}

function requestFor(point) {
  return {
    protocolVersion: 2,
    location: { ...point, accuracyMeters: 1, sampleCount: 3, consistencyMeters: 1 },
  };
}

async function fetchFn(url, init = {}) {
  const method = init.method || 'GET';
  const key = `${method} ${String(url)}`;
  if (method === 'GET' && responses.has(key)) {
    const body = responses.get(key);
    fetchLog.push(`hit ${key.slice(0, 120)}`);
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
  }
  fetchLog.push(`miss ${key.slice(0, 120)}`);
  const response = await globalThis.fetch(url, init);
  if (method === 'GET' && response.ok) {
    const body = await response.text();
    responses.set(key, body);
    return { ok: true, status: response.status, json: async () => JSON.parse(body), text: async () => body };
  }
  return response;
}

function startGeosupport() {
  const script = [
    'import json, sys',
    'from resolver_service.native_adapter import Geosupport26CAdapter',
    'from resolver_service.service import ResolverService',
    'service = ResolverService(Geosupport26CAdapter())',
    'for line in sys.stdin:',
    '    line = line.strip()',
    '    if not line: continue',
    '    result = service.resolve_payload(json.loads(line))',
    '    sys.stdout.write("PARQUEEN_GEO " + json.dumps({"status": result.status_code, "payload": result.payload}) + "\\n")',
    '    sys.stdout.flush()',
  ].join('\n');
  const child = spawn(dockerBin(), [
    'run', '-i', '--rm', '-v', `${SERVICE}:/app`, '-w', '/app', IMAGE,
    'python', '-u', '-c', script,
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buffer = '';
  let stderr = '';
  const waiters = [];
  const failWaiters = error => {
    while (waiters.length) waiters.shift().reject(error);
  };
  child.stdout.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.startsWith('PARQUEEN_GEO ')) {
        const waiter = waiters.shift();
        if (waiter) waiter.resolve(JSON.parse(line.slice('PARQUEEN_GEO '.length)));
      }
      newline = buffer.indexOf('\n');
    }
  });
  child.stderr.on('data', chunk => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-2000);
  });
  child.on('exit', code => failWaiters(new Error(`Function 3C exited ${code}: ${stderr}`)));
  child.on('error', error => failWaiters(error));
  let chain = Promise.resolve();
  const lookup = tuple => {
    const run = chain.then(() => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Function 3C timed out: ${stderr}`)), 30000);
      waiters.push({
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      child.stdin.write(`${JSON.stringify(tuple)}\n`);
    }));
    chain = run.then(() => {}, () => {});
    return run;
  };
  return { child, lookup };
}

const geoResults = [];

function realResolver() {
  return createPrivateBlockfaceResolver({
    mode: 'shadow',
    serviceUrl: SERVICE_URL,
    getIdToken: async () => 'local-geosupport',
    transport: async request => {
      const tuple = JSON.parse(request.body);
      const result = await geosupport.lookup(tuple);
      geoResults.push({ tuple, status: result.status, payload: result.payload });
      return { status: result.status, text: async () => JSON.stringify(result.payload) };
    },
  });
}

function dependencies(extra = {}) {
  return {
    db,
    Timestamp,
    fetchFn,
    getSocrataToken: () => '',
    officialLionPrimary: admitted,
    blockfaceResolver,
    ...extra,
  };
}

function failingDb() {
  return {
    doc: path => db.doc(path),
    batch() {
      const batch = db.batch();
      return {
        set(ref, value) { batch.set(ref, value); return this; },
        commit: async () => { throw new Error('emulator write failed'); },
      };
    },
  };
}

async function storedDocuments() {
  const [identities, segments, rules] = await Promise.all([
    db.collection('curbIdentities').get(),
    db.collection('streetSegments').get(),
    db.collectionGroup('streetRules').get(),
  ]);
  return { identities, segments, rules };
}

async function assertNoWrites() {
  const stored = await storedDocuments();
  expect(stored.identities.empty).toBe(true);
  expect(stored.segments.empty).toBe(true);
  expect(stored.rules.empty).toBe(true);
}

describe('Melville canonical persistence on the local demo emulator', () => {
  afterAll(() => {
    geosupport?.child.stdin.end();
    geosupport?.child.kill();
  });

  it('persists both proven faces, reuses the exact identity, and keeps the schedules apart', async () => {
    expect(getApps()[0].options.projectId).toBe('demo-parkqueen-functions-test');
    expect(process.env.FIRESTORE_EMULATOR_HOST).toBe('127.0.0.1:8080');
    await assertNoWrites();

    const forged = { state: 'SUPPORTED', identity: { officialBlockFaceId: '1522611401' } };
    const denied = await persistCanonicalCurb({
      db, Timestamp, topologyResult: forged, identityProof: { state: 'IDENTITY_PROVEN' }, selectedRules: { rules: [] },
    });
    expect(denied).toMatchObject({ success: false, reason: 'authority_invalid' });
    await assertNoWrites();

    process.env.FUNCTIONS_EMULATOR = 'true';
    process.env.GCLOUD_PROJECT = 'demo-parkqueen-functions-test';
    process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
    process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
    process.env.K_REVISION = '1';
    process.env.CURB_OFFICIAL_LION_PRIMARY = 'local';
    process.env.CURB_LION_PRIMARY_ARCHIVE = ARCHIVE;
    process.env.CURB_LION_GDAL_MODULE = GDAL;
    admitted = await loadOfficialLionPrimary();
    expect(readOfficialLionPrimary(admitted)?.ok).toBe(true);
    geosupport = startGeosupport();
    const warmed = await geosupport.lookup({
      borough: 'BRONX',
      onStreet: 'MELVILLE STREET',
      crossStreetOne: 'VAN NEST AVENUE',
      crossStreetTwo: 'MORRIS PARK AVENUE',
      compassDirection: 'W',
    });
    expect(warmed.status, JSON.stringify(warmed)).toBe(200);
    expect(warmed.payload?.officialBlockFaceId, JSON.stringify(warmed.payload)).toBe('1522611401');

    const sides = offset(5);
    const leftResolution = await resolveCanonicalCurb({
      ...sides.left, accuracyMeters: 1, sampleCount: 3, consistencyMeters: 1,
    }, { fetchFn, getSocrataToken: () => '', officialLionPrimary: admitted });
    expect(leftResolution.state).toBe('SUPPORTED');
    const oppositeBlockFaceId = leftResolution.identity.officialBlockFaceId === '1522611401'
      ? '1522607000' : '1522611401';

    const unavailable = await runCanonicalCurbOrchestrator(requestFor(sides.left), dependencies({
      officialLionPrimary: null,
      blockfaceResolver: createPrivateBlockfaceResolver({ mode: 'shadow', serviceUrl: '' }),
    }));
    expect(unavailable.status).not.toBe('high_confidence');
    await assertNoWrites();

    const missingProof = await runCanonicalCurbOrchestrator(requestFor(sides.left), dependencies({
      blockfaceResolver: createPrivateBlockfaceResolver({ mode: 'shadow', serviceUrl: '' }),
    }));
    expect(missingProof).toMatchObject({ status: 'unsupported' });
    expect(missingProof.status).not.toBe('high_confidence');
    await assertNoWrites();

    const invalidProof = await runCanonicalCurbOrchestrator(requestFor(sides.left), dependencies({
      blockfaceResolver: createPrivateBlockfaceResolver({
        mode: 'shadow',
        serviceUrl: SERVICE_URL,
        getIdToken: async () => 'local-geosupport',
        transport: async () => ({ status: 500, text: async () => '' }),
      }),
    }));
    expect(invalidProof.status).not.toBe('high_confidence');
    await assertNoWrites();

    const conflicting = await runCanonicalCurbOrchestrator(requestFor(sides.left), dependencies({
      blockfaceResolver: createPrivateBlockfaceResolver({
        mode: 'shadow',
        serviceUrl: SERVICE_URL,
        getIdToken: async () => 'local-geosupport',
        transport: async () => ({
          status: 200,
          text: async () => JSON.stringify({
            ok: true,
            officialBlockFaceId: oppositeBlockFaceId,
            normalizedStreetNames: {
              onStreet: 'MELVILLE STREET',
              crossStreetOne: 'VAN NEST AVENUE',
              crossStreetTwo: 'MORRIS PARK AVENUE',
            },
            returnCode: '00',
            reasonCode: ' ',
            sourceVersion: { geosupportRelease: '26C', geosupportVersion: '26.3' },
          }),
        }),
      }),
    }));
    expect(conflicting.status).not.toBe('high_confidence');
    await assertNoWrites();

    blockfaceResolver = realResolver();
    const directProof = await proveCanonicalCurbIdentity(leftResolution, { blockfaceResolver });
    expect(directProof, JSON.stringify(geoResults)).toMatchObject({ state: 'IDENTITY_PROVEN' });
    const warmedRules = await loadCanonicalRules(leftResolution.identity, dependencies());
    expect(warmedRules.selected?.cleaning, JSON.stringify(warmedRules.sources?.dot)).toBeTruthy();
    fetchLog.length = 0;
    const writeStarted = Date.now();
    const writeFailure = await runCanonicalCurbOrchestrator(requestFor(sides.left), dependencies({ db: failingDb() }));
    const writeMs = Date.now() - writeStarted;
    expect(writeFailure, JSON.stringify({ writeMs, fetchLog })).toMatchObject({
      status: 'unsupported', reason: 'source_unavailable',
    });
    await assertNoWrites();
    fetchLog.length = 0;

    const faces = [];
    for (const point of [sides.left, sides.right]) {
      const events = [];
      const started = Date.now();
      const response = await runCanonicalCurbOrchestrator(requestFor(point), dependencies({
        telemetry: { emit: (event, payload) => events.push({ event, payload }) },
      }));
      const elapsedMs = Date.now() - started;
      expect(response, JSON.stringify({ elapsedMs, response, events })).toMatchObject({
        protocolVersion: 2,
        status: 'high_confidence',
        ruleSummary: { cleaningAvailable: true },
      });
      expect(events.some(event => event.event === 'curb_resolution_high' && event.payload.cacheHit === false)).toBe(true);
      const key = response.segmentId;
      const [identitySnap, segmentSnap, rulesSnap] = await Promise.all([
        db.doc(`curbIdentities/${key}`).get(),
        db.doc(`streetSegments/${key}`).get(),
        db.collection(`streetSegments/${key}/streetRules`).get(),
      ]);
      expect(identitySnap.exists).toBe(true);
      expect(segmentSnap.exists).toBe(true);
      expect(rulesSnap.empty).toBe(false);
      faces.push({
        point,
        response,
        key,
        identity: identitySnap.data().identity,
        segment: segmentSnap.data(),
        rules: rulesSnap.docs.map(doc => doc.data()),
        updatedAt: segmentSnap.data().updatedAt.toMillis(),
      });
    }

    const west = faces.find(face => face.identity.officialBlockFaceId === '1522611401');
    const east = faces.find(face => face.identity.officialBlockFaceId === '1522607000');
    expect(west).toBeTruthy();
    expect(east).toBeTruthy();
    expect(west.key).not.toBe(east.key);
    expect(west.segment.sideLabel).toBe('West');
    expect(east.segment.sideLabel).toBe('East');
    expect(west.response.sideLabel).toBe('West');
    expect(east.response.sideLabel).toBe('East');

    const cleaning = rules => rules
      .filter(rule => rule.type === 'streetCleaning')
      .flatMap(rule => rule.schedules || []);
    expect(cleaning(west.rules)).toEqual([
      expect.objectContaining({ side: 'West', days: ['Mon', 'Thu'], startTime: '08:30', endTime: '10:00' }),
    ]);
    expect(cleaning(east.rules)).toEqual([
      expect.objectContaining({ side: 'East', days: ['Tue', 'Fri'], startTime: '08:30', endTime: '10:00' }),
    ]);

    const blockedReuse = await runCanonicalCurbOrchestrator(requestFor(west.point), dependencies({
      blockfaceResolver: createPrivateBlockfaceResolver({ mode: 'shadow', serviceUrl: '' }),
    }));
    expect(blockedReuse.status).not.toBe('high_confidence');
    const unchanged = await db.doc(`streetSegments/${west.key}`).get();
    expect(unchanged.data().updatedAt.toMillis()).toBe(west.updatedAt);

    const reuseEvents = [];
    const reuse = await runCanonicalCurbOrchestrator(requestFor(west.point), dependencies({
      telemetry: { emit: (event, payload) => reuseEvents.push({ event, payload }) },
    }));
    expect(reuse).toEqual(west.response);
    expect(reuseEvents.some(event => event.event === 'curb_resolution_high' && event.payload.cacheHit === true)).toBe(true);
    const reusedSegment = await db.doc(`streetSegments/${west.key}`).get();
    const reusedRules = await db.collection(`streetSegments/${west.key}/streetRules`).get();
    expect(reusedSegment.data().updatedAt.toMillis()).toBe(west.updatedAt);
    expect(reusedRules.size).toBe(west.rules.length);

    for (const face of [west, east]) {
      const presentation = classifyStreetIntelligence(face.segment, face.rules);
      expect(presentation.state).toBe('supported');
      const cardSchedules = face.rules
        .filter(rule => rule.type === 'streetCleaning' || !rule.type)
        .flatMap(rule => (rule.schedules || []).map(schedule => ({ ...schedule, type: 'streetCleaning' })));
      const shown = computeSafeUntil(cardSchedules, face.response.sideLabel, [], PRESENTATION_NOW);
      const opposite = computeSafeUntil(cardSchedules, face.response.sideLabel === 'West' ? 'East' : 'West', [], PRESENTATION_NOW);
      expect(shown.scheduleDescription).toBe(face.response.sideLabel === 'West'
        ? 'Mon & Thu · 8:30 AM–10 AM'
        : 'Tue & Fri · 8:30 AM–10 AM');
      expect(opposite.scheduleDescription).toBeNull();
    }
  });
});
