'use strict';

const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { localDemoSession, localFunction3cAllowed } = require('./localGeosupportTransport');
const {
  loadOfficialLionPrimary,
  readOfficialLionIndexAdmission,
  readOfficialLionPrimary,
} = require('./officialLionPrimaryTopology');

// One id per process. A later request in this process sees the same id and catalog.
const workerId = randomUUID();

function localLionPrewarmEnabled(env = process.env) {
  return env?.CURB_LOCAL_LION_PREWARM === 'on'
    && env?.CURB_OFFICIAL_LION_PRIMARY === 'local'
    && localFunction3cAllowed(env)
    && localDemoSession(env);
}

function notePrewarm(env, fields) {
  if (env?.FUNCTIONS_EMULATOR !== 'true' || env?.GCLOUD_PROJECT !== 'demo-parkqueen-functions-test') return;
  try {
    console.log(JSON.stringify({
      record: 'parqueen_local_lion_prewarm',
      workerId,
      pid: process.pid,
      ...fields,
    }));
  } catch { /* a log never changes admission */ }
}

function catalogReady(sealed) {
  if (!sealed || sealed.productionAuthoritative !== false || sealed.certificationStatus !== 'NOT_CERTIFIED') {
    return false;
  }
  return readOfficialLionIndexAdmission(sealed) === true;
}

async function prewarmOfficialLionPrimary(env = process.env) {
  const started = performance.now();
  if (!localLionPrewarmEnabled(env)) {
    return { skipped: true, outcome: 'skipped', workerId, pid: process.pid, catalog: null };
  }
  notePrewarm(env, { phase: 'start' });
  let admitted = null;
  try {
    admitted = await loadOfficialLionPrimary(env);
  } catch {
    const elapsedMs = Math.max(0, Math.round(performance.now() - started));
    notePrewarm(env, {
      phase: 'finish',
      outcome: 'failed',
      digestValidated: false,
      catalogReady: false,
      productionAuthoritative: false,
      elapsedMs,
    });
    return { skipped: false, outcome: 'failed', workerId, pid: process.pid, catalog: null, elapsedMs };
  }
  const sealed = readOfficialLionPrimary(admitted);
  const ready = catalogReady(sealed);
  const elapsedMs = Math.max(0, Math.round(performance.now() - started));
  const outcome = ready ? 'admitted' : (sealed ? 'unavailable' : 'closed');
  notePrewarm(env, {
    phase: 'finish',
    outcome,
    digestValidated: sealed != null,
    catalogReady: ready,
    productionAuthoritative: false,
    certificationStatus: sealed?.certificationStatus || null,
    elapsedMs,
  });
  return {
    skipped: false,
    outcome,
    workerId,
    pid: process.pid,
    catalog: sealed,
    catalogReady: ready,
    elapsedMs,
  };
}

function localWorkerIdentity() {
  return { workerId, pid: process.pid };
}

module.exports = {
  localLionPrewarmEnabled,
  localWorkerIdentity,
  prewarmOfficialLionPrimary,
};
