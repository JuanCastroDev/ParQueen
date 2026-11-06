'use strict';

const path = require('node:path');

const PROJECT = 'demo-parkqueen-s7-fn-iso';
const SENTINEL = 'C:/Users/jayca/AppData/Local/ParQueen/s7-fn-iso-no-adc.json';

// Names the emulator and Node need from the parent. Matched without regard to case.
// Credential, token, proxy, and preload variables are intentionally absent.
const PARENT_ALLOWLIST = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'SYSTEMDRIVE',
  'COMSPEC',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'USERDOMAIN',
  'OS',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
  'PROCESSOR_IDENTIFIER',
  'PROGRAMFILES',
  'PROGRAMFILES(X86)',
  'COMMONPROGRAMFILES',
  'COMMONPROGRAMFILES(X86)',
  'PROGRAMDATA',
  'DRIVERDATA',
  'JAVA_HOME',
];

function buildEmulatorEnv(parent = process.env) {
  const env = {};
  const wanted = new Set(PARENT_ALLOWLIST.map((name) => name.toLowerCase()));
  for (const key of Object.keys(parent)) {
    if (wanted.has(key.toLowerCase()) && typeof parent[key] === 'string') env[key] = parent[key];
  }
  env.GCLOUD_PROJECT = PROJECT;
  env.GOOGLE_CLOUD_PROJECT = PROJECT;
  env.S7_ISOLATED_PROJECT = PROJECT;
  env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8282';
  env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9098';
  env.FIREBASE_STORAGE_EMULATOR_HOST = '127.0.0.1:9298';
  env.S7_FUNCTIONS_EMULATOR_HOST = '127.0.0.1:5002';
  env.FIREBASE_EMULATOR_HUB = '127.0.0.1:4403';
  env.GOOGLE_APPLICATION_CREDENTIALS = SENTINEL;
  return env;
}

function buildTestEnv(parent = process.env, guardFile = path.join(__dirname, 'isolatedNetworkGuard.js')) {
  const env = buildEmulatorEnv(parent);
  env.NODE_OPTIONS = `--require ${guardFile}`;
  return env;
}

module.exports = {
  PROJECT,
  SENTINEL,
  PARENT_ALLOWLIST,
  buildEmulatorEnv,
  buildTestEnv,
};
