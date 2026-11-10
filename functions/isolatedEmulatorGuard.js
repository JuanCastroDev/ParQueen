'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PRODUCTION_PROJECT = 'parkqueen-46475363-ccf36';
const LIVE_DEMO_PROJECT = 'demo-parkqueen-functions-test';
const FORBIDDEN_PORTS = new Set(['8080', '9099', '9199', '5001', '4400', '4500']);
const SERVICES = Object.freeze({
  firestore: 'FIRESTORE_EMULATOR_HOST',
  auth: 'FIREBASE_AUTH_EMULATOR_HOST',
  storage: 'FIREBASE_STORAGE_EMULATOR_HOST',
  functions: 'S7_FUNCTIONS_EMULATOR_HOST',
});

function assertIsolatedEmulator(options = {}, env = process.env) {
  const services = options.services || Object.keys(SERVICES);
  const project = readProject(env);
  for (const service of services) {
    if (!Object.prototype.hasOwnProperty.call(SERVICES, service)) {
      throw new Error(`Unknown emulator service ${service}`);
    }
    parseEndpoint(env[SERVICES[service]], SERVICES[service]);
  }
  assertNoLiveCredentials(env, options.credentialFileExists || fs.existsSync);
  return { projectId: project };
}

function ambientCredentialPath(env = process.env) {
  if (!env.APPDATA) return '';
  return path.join(env.APPDATA, 'gcloud', 'application_default_credentials.json');
}

function assertNoLiveCredentials(env, exists) {
  if (typeof env.FIREBASE_CONFIG === 'string' && env.FIREBASE_CONFIG.includes('private_key')) {
    throw new Error('FIREBASE_CONFIG contains a private key');
  }
  const configured = typeof env.GOOGLE_APPLICATION_CREDENTIALS === 'string'
    ? env.GOOGLE_APPLICATION_CREDENTIALS.trim() : '';
  if (configured) {
    if (exists(configured)) throw new Error('GOOGLE_APPLICATION_CREDENTIALS points at a credential file');
    return;
  }
  const ambient = ambientCredentialPath(env);
  if (ambient && exists(ambient)) {
    throw new Error('Ambient application default credentials are available');
  }
}

function emulatorEndpoint(service, env = process.env) {
  assertIsolatedEmulator({ services: [service] }, env);
  return parseEndpoint(env[SERVICES[service]], SERVICES[service]);
}

function emulatorOrigin(service, env = process.env) {
  const endpoint = emulatorEndpoint(service, env);
  return `http://${endpoint.host}:${endpoint.port}`;
}

function readProject(env) {
  const project = typeof env.GCLOUD_PROJECT === 'string' ? env.GCLOUD_PROJECT.trim() : '';
  const declared = typeof env.S7_ISOLATED_PROJECT === 'string' ? env.S7_ISOLATED_PROJECT.trim() : '';
  if (!project || !declared || project !== declared) {
    throw new Error('GCLOUD_PROJECT and S7_ISOLATED_PROJECT must be the same explicit demo project');
  }
  if (env.GOOGLE_CLOUD_PROJECT && env.GOOGLE_CLOUD_PROJECT.trim() !== project) {
    throw new Error('GOOGLE_CLOUD_PROJECT does not match the isolated project');
  }
  if (project === PRODUCTION_PROJECT || project === LIVE_DEMO_PROJECT) {
    throw new Error(`Refusing emulator project ${project}`);
  }
  if (!/^demo-[a-z0-9-]+$/.test(project)) {
    throw new Error('Isolated tests require a demo- project id');
  }
  return project;
}

function parseEndpoint(raw, label) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    throw new Error(`${label} is required`);
  }
  const match = /^(127\.0\.0\.1|localhost):(\d+)$/.exec(raw.trim());
  if (!match) {
    throw new Error(`${label} must be a loopback host:port`);
  }
  if (FORBIDDEN_PORTS.has(match[2])) {
    throw new Error(`${label} uses a live-demo port`);
  }
  return { host: match[1], port: Number(match[2]) };
}

module.exports = {
  PRODUCTION_PROJECT,
  LIVE_DEMO_PROJECT,
  FORBIDDEN_PORTS,
  SERVICES,
  assertIsolatedEmulator,
  emulatorEndpoint,
  emulatorOrigin,
};
