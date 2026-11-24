import { createRequire } from 'node:module';
import { afterEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawn } = require('node:child_process');
const {
  evaluateOfficialLionRelationship,
  openApprovedLionArchive,
  readOfficialLionIndexAdmission,
} = require('./officialLionPrimaryTopology');

const ARCHIVE = 'C:/Users/jayca/AppData/Local/ParQueen/street-intel-qa-sources/lion-26b/nyclion_26b.zip';
const liveArchive = existsSync(ARCHIVE) && existsSync(`${ARCHIVE}.relationship-index`);

const demoEnv = {
  FUNCTIONS_EMULATOR: 'true',
  CURB_LOCAL_LION_PREWARM: 'on',
  CURB_LOCAL_FUNCTION3C: 'local',
  CURB_OFFICIAL_LION_PRIMARY: 'local',
  GCLOUD_PROJECT: 'demo-parkqueen-functions-test',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
  K_REVISION: '1',
  CURB_LION_PRIMARY_ARCHIVE: ARCHIVE,
};

function loadPrewarm() {
  vi.resetModules();
  return require('./localLionPrewarm');
}

function runNode(script, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', script], {
      cwd: join(__dirname, '..'),
      env: { ...process.env, ...env },
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', chunk => { stderr += chunk.toString('utf8'); });
    child.on('error', reject);
    child.on('exit', status => resolve({ status, stdout, stderr }));
  });
}

const MELVILLE_GEOMETRY = Object.freeze({
  type: 'MultiLineString',
  coordinates: [[[-73.869399076566, 40.841629393257], [-73.870996446086, 40.84311966193]]],
});

function melvilleRecord(overrides = {}) {
  return {
    sourceVersion: { resourceId: 'inkn-q76z', version: '1793494484:1744725948' },
    geometry: MELVILLE_GEOMETRY,
    leftBlockFaceId: '1522611401',
    rightBlockFaceId: '1522607000',
    sourceNative: {
      physicalid: '98053', b5sc: '250420', boroughcode: '2', streetwidth: '24',
    },
    ...overrides,
  };
}

function melvillePacket() {
  const segment = (physicalId, segmentId, street, streetCode, nodeIdFrom, nodeIdTo, left, right) => ({
    physicalId, segmentId, street, streetCode, nodeIdFrom, nodeIdTo,
    leftBlockFaceId: left, rightBlockFaceId: right, geometry: MELVILLE_GEOMETRY,
  });
  return {
    segments: [
      segment('98053', '0085847', 'MELVILLE STREET', '250420', '0052416', '0048539', '1522611401', '1522607000'),
      segment('40573', '0085848', 'VAN NEST AVENUE', '271120', '0052416', '0052431', '1522611960', '1522602777'),
      segment('40574', '0085843', 'VAN NEST AVENUE', '271120', '0052413', '0052416', '1522604786', '1522602779'),
      segment('56255', '0079542', 'MORRIS PARK AVENUE', '252220', '0048536', '0048539', '1522605705', '1522604784'),
      segment('56254', '0079547', 'MORRIS PARK AVENUE', '252220', '0048539', '0052429', '1522605705', '1522607001'),
    ],
    nodeNames: [
      { nodeId: '0052416', name: ' VAN NEST AVE' },
      { nodeId: '0052416', name: ' MELVILLE ST' },
      { nodeId: '0048539', name: ' MORRIS PARK AVE' },
      { nodeId: '0048539', name: ' MELVILLE ST' },
    ],
  };
}

describe('LION readiness is index admission, not a rejected relationship', () => {
  const rejected = [
    ['missing CSCL fields', { sourceNative: { physicalid: '98053' } }],
    ['source-version conflict', melvilleRecord({ sourceVersion: { resourceId: 'other', version: '1' } })],
    ['wrong block faces', melvilleRecord({ leftBlockFaceId: '1522611402' })],
    ['geometry mismatch', melvilleRecord({
      geometry: {
        type: 'MultiLineString',
        coordinates: [[[-73.80, 40.70], [-73.81, 40.71]]],
      },
    })],
  ];

  it.each(rejected)('does not treat a %s result as catalog readiness', (_label, input) => {
    const result = evaluateOfficialLionRelationship(input, melvillePacket());
    expect(result.ok).toBe(false);
    expect(readOfficialLionIndexAdmission(result)).toBe(false);
  });

  it('does not treat an unavailable source or a forged admission flag as readiness', () => {
    expect(readOfficialLionIndexAdmission(null)).toBe(false);
    expect(readOfficialLionIndexAdmission({
      ok: false,
      reason: 'lion_primary_unavailable',
    })).toBe(false);
    expect(readOfficialLionIndexAdmission({
      ok: true,
      certificationStatus: 'NOT_CERTIFIED',
      productionAuthoritative: false,
      indexAdmitted: true,
      relationshipsFor: async () => new Map(),
    })).toBe(false);
  });

  it('keeps a reviewed Melville relationship distinct from index admission', () => {
    const reconciled = evaluateOfficialLionRelationship(melvilleRecord(), melvillePacket());
    expect(reconciled).toMatchObject({
      ok: true,
      onStreet: 'MELVILLE STREET',
      segmentId: '0085847',
      productionAuthoritative: false,
      certificationStatus: 'NOT_CERTIFIED',
    });
    expect(readOfficialLionIndexAdmission(reconciled)).toBe(false);
  });
});

describe('local LION prewarm gate', () => {
  const directories = [];

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.useRealTimers();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it('does not read an archive when the flag is unset', async () => {
    const childProcess = require('node:child_process');
    const spawnSpy = vi.spyOn(childProcess, 'spawn');
    const spawnSyncSpy = vi.spyOn(childProcess, 'spawnSync');
    const openSpy = vi.spyOn(require('node:fs'), 'openSync');
    const { prewarmOfficialLionPrimary } = loadPrewarm();
    const result = await prewarmOfficialLionPrimary({ ...demoEnv, CURB_LOCAL_LION_PREWARM: 'off' });
    expect(result).toMatchObject({ skipped: true, outcome: 'skipped', catalog: null });
    expect(openSpy).not.toHaveBeenCalled();
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(spawnSyncSpy).not.toHaveBeenCalled();
  });

  it('rejects a production project, a wrong host, and a wrong revision', async () => {
    const openSpy = vi.spyOn(require('node:fs'), 'openSync');
    const { localLionPrewarmEnabled, prewarmOfficialLionPrimary } = loadPrewarm();
    const cases = [
      { ...demoEnv, GCLOUD_PROJECT: 'parkqueen-46475363-ccf36' },
      { ...demoEnv, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8180' },
      { ...demoEnv, FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9098' },
      { ...demoEnv, K_REVISION: '2' },
      { ...demoEnv, FUNCTIONS_EMULATOR: 'false' },
      { ...demoEnv, CURB_LOCAL_FUNCTION3C: 'off' },
      { ...demoEnv, CURB_OFFICIAL_LION_PRIMARY: 'off' },
    ];
    for (const env of cases) {
      expect(localLionPrewarmEnabled(env)).toBe(false);
      const result = await prewarmOfficialLionPrimary(env);
      expect(result.outcome).toBe('skipped');
    }
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('fails closed for a missing or incorrect archive and does not grant authority', async () => {
    const childProcess = require('node:child_process');
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network refused'));
    const spawnSpy = vi.spyOn(childProcess, 'spawn');
    const directory = mkdtempSync(join(tmpdir(), 'lion-prewarm-bad-'));
    directories.push(directory);
    const missing = join(directory, 'missing.zip');
    const incorrect = join(directory, 'incorrect.zip');
    writeFileSync(incorrect, 'not the official archive');
    const { prewarmOfficialLionPrimary } = loadPrewarm();
    const missingResult = await prewarmOfficialLionPrimary({
      ...demoEnv,
      CURB_LION_PRIMARY_ARCHIVE: missing,
    });
    const incorrectResult = await prewarmOfficialLionPrimary({
      ...demoEnv,
      CURB_LION_PRIMARY_ARCHIVE: incorrect,
    });
    expect(missingResult).toMatchObject({ outcome: 'closed', catalog: null, catalogReady: false });
    expect(incorrectResult).toMatchObject({ outcome: 'closed', catalog: null, catalogReady: false });
    expect(incorrectResult.catalog?.productionAuthoritative).not.toBe(true);
    expect(spawnSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports an index failure without turning it into source authority', async () => {
    if (!liveArchive) return;
    const directory = mkdtempSync(join(tmpdir(), 'lion-prewarm-no-index-'));
    directories.push(directory);
    const copy = join(directory, 'nyclion_26b.zip');
    linkSync(ARCHIVE, copy);
    const { prewarmOfficialLionPrimary } = loadPrewarm();
    const result = await prewarmOfficialLionPrimary({
      ...demoEnv,
      CURB_LION_PRIMARY_ARCHIVE: copy,
    });
    expect(result.outcome).toBe('unavailable');
    expect(result.catalogReady).toBe(false);
    expect(result.catalog.productionAuthoritative).toBe(false);
    expect(result.catalog.certificationStatus).toBe('NOT_CERTIFIED');
    const relationships = await result.catalog.relationshipsFor([
      { sourceNative: { physicalid: '98053' } },
    ]);
    expect([...relationships.values()][0]).toMatchObject({
      ok: false,
      reason: 'lion_primary_unavailable',
    });
    expect(readOfficialLionIndexAdmission(result.catalog)).toBe(false);
    expect(readOfficialLionIndexAdmission([...relationships.values()][0])).toBe(false);
  });

  it('keeps a thrown loader from rejecting and does not log the archive path', async () => {
    for (const name of ['./localLionPrewarm', './officialLionPrimaryTopology']) {
      delete require.cache[require.resolve(name)];
    }
    const topologyPath = require.resolve('./officialLionPrimaryTopology');
    require.cache[topologyPath] = {
      id: topologyPath,
      filename: topologyPath,
      loaded: true,
      exports: {
        loadOfficialLionPrimary: async () => {
          throw new Error('C:\\secret\\nyclion_26b.zip failed');
        },
        readOfficialLionPrimary: () => null,
      },
    };
    const logs = [];
    vi.spyOn(console, 'log').mockImplementation(line => logs.push(String(line)));
    const { prewarmOfficialLionPrimary } = require('./localLionPrewarm');
    const result = await prewarmOfficialLionPrimary(demoEnv);
    expect(result).toMatchObject({ outcome: 'failed', catalog: null });
    expect(logs.join('\n')).not.toContain('nyclion');
    expect(logs.join('\n')).not.toContain('secret');
    expect(logs.join('\n')).toContain('"outcome":"failed"');
    delete require.cache[require.resolve('./localLionPrewarm')];
    delete require.cache[topologyPath];
  });

  it('registers prewarm only inside the existing onInit callback', () => {
    const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
    expect(source.match(/onInit\(/g)).toHaveLength(1);
    const body = source.slice(source.indexOf('onInit(async () => {'), source.indexOf('function stableId'));
    expect(body).toContain('canonicalV2ModuleLoader.initialize()');
    expect(body).toContain("process.env.CURB_LOCAL_LION_PREWARM !== 'on'");
    expect(body.indexOf("CURB_LOCAL_LION_PREWARM !== 'on'")).toBeLessThan(body.indexOf('localLionPrewarm'));
    expect(body).toContain('await prewarmOfficialLionPrimary()');
    expect(body).not.toMatch(/docker|startGeosupport|spawn\(/);
  });
});

describe('same-process LION catalog reuse', () => {
  it('uses one worker id and the same admitted catalog for a later load', async () => {
    if (!liveArchive) return;
    const script = `
      const { prewarmOfficialLionPrimary, localWorkerIdentity } = require('./curbIntelligence/localLionPrewarm');
      const { loadOfficialLionPrimary } = require('./curbIntelligence/officialLionPrimaryTopology');
      const env = JSON.parse(process.env.PREWARM_ENV);
      (async () => {
        const { readOfficialLionIndexAdmission } = require('./curbIntelligence/officialLionPrimaryTopology');
        const first = await prewarmOfficialLionPrimary(env);
        const loaded = await loadOfficialLionPrimary(env);
        const second = await prewarmOfficialLionPrimary(env);
        const partial = await first.catalog.relationshipsFor([
          { sourceNative: { physicalid: '98053' } },
        ]);
        const partialResult = [...partial.values()][0];
        process.stdout.write(JSON.stringify({
          workerId: localWorkerIdentity().workerId,
          pid: process.pid,
          outcome: first.outcome,
          catalogReady: first.catalogReady,
          elapsedMs: first.elapsedMs,
          productionAuthoritative: first.catalog && first.catalog.productionAuthoritative,
          certificationStatus: first.catalog && first.catalog.certificationStatus,
          sameAsLoad: first.catalog === loaded,
          sameAsSecondPrewarm: first.catalog === second.catalog,
          indexAdmitted: readOfficialLionIndexAdmission(first.catalog),
          partialRelationshipOk: partialResult.ok === true,
          partialReason: partialResult.reason || null,
          partialIsReady: readOfficialLionIndexAdmission(partialResult),
        }));
      })().catch(error => {
        process.stderr.write(error.stack);
        process.exit(1);
      });
    `;
    const parent = loadPrewarm().localWorkerIdentity();
    const result = await runNode(script, { PREWARM_ENV: JSON.stringify(demoEnv) });
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout.trim().split(/\r?\n/).pop());
    expect(report.pid).not.toBe(parent.pid);
    expect(report.workerId).not.toBe(parent.workerId);
    expect(report.outcome).toBe('admitted');
    expect(report.catalogReady).toBe(true);
    expect(report.productionAuthoritative).toBe(false);
    expect(report.certificationStatus).toBe('NOT_CERTIFIED');
    expect(report.sameAsLoad).toBe(true);
    expect(report.sameAsSecondPrewarm).toBe(true);
    expect(report.indexAdmitted).toBe(true);
    expect(report.partialRelationshipOk).toBe(false);
    expect(report.partialReason).not.toBe('lion_primary_unavailable');
    expect(report.partialIsReady).toBe(false);
    expect(report.elapsedMs).toBeGreaterThan(0);
    expect(result.stdout).not.toContain(ARCHIVE);
  }, 20000);

  it('awaits async onInit before the first wrapped callable and does not repeat it', async () => {
    const script = `
      const { onInit } = require('firebase-functions/core');
      const { onCall } = require('firebase-functions/v2/https');
      const order = [];
      onInit(async () => {
        order.push('init-start');
        await new Promise(resolve => setTimeout(resolve, 15));
        order.push('init-end');
      });
      const fn = onCall(() => {
        order.push('handler');
        return { ok: true };
      });
      (async () => {
        await fn.run({});
        await fn.run({});
        process.stdout.write(JSON.stringify({ order }));
      })().catch(error => {
        process.stderr.write(error.stack);
        process.exit(1);
      });
    `;
    const result = await runNode(script);
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).order).toEqual([
      'init-start',
      'init-end',
      'handler',
      'handler',
    ]);
  });
});
