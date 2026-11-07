'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { buildEmulatorEnv, buildTestEnv, PROJECT, SENTINEL } = require('./isolatedProcessEnv');

function parent() {
  return {
    PATH: 'C:\\Windows\\system32',
    SystemRoot: 'C:\\Windows',
    TEMP: 'C:\\Temp',
    JAVA_HOME: 'C:\\Java',
    GCLOUD_PROJECT: 'parkqueen-46475363-ccf36',
    GOOGLE_CLOUD_PROJECT: 'demo-parkqueen-functions-test',
    FIREBASE_CONFIG: '{"private_key":"blocked"}',
    FIREBASE_TOKEN: 'blocked-token',
    GOOGLE_OAUTH_ACCESS_TOKEN: 'blocked-oauth',
    GOOGLE_APPLICATION_CREDENTIALS: 'C:\\real-adc.json',
    CLOUDSDK_AUTH_ACCESS_TOKEN: 'blocked-gcloud',
    CLOUDSDK_CONFIG: 'C:\\gcloud-config',
    NODE_OPTIONS: '--require C:\\evil-preload.js',
    HTTP_PROXY: 'http://203.0.113.10:8080',
    HTTPS_PROXY: 'http://203.0.113.10:8443',
    AWS_SECRET_ACCESS_KEY: 'blocked-aws',
    AZURE_CLIENT_SECRET: 'blocked-azure',
    GEMINI_API_KEY: 'blocked-gemini',
    SENDGRID_API_KEY: 'blocked-sendgrid',
  };
}

test('the emulator environment keeps the allowlist and replaces credentials', () => {
  const env = buildEmulatorEnv(parent());
  assert.equal(env.PATH, 'C:\\Windows\\system32');
  assert.equal(env.SystemRoot, 'C:\\Windows');
  assert.equal(env.TEMP, 'C:\\Temp');
  assert.equal(env.JAVA_HOME, 'C:\\Java');
  assert.equal(env.GCLOUD_PROJECT, PROJECT);
  assert.equal(env.GOOGLE_CLOUD_PROJECT, PROJECT);
  assert.equal(env.S7_ISOLATED_PROJECT, PROJECT);
  assert.equal(env.FIRESTORE_EMULATOR_HOST, '127.0.0.1:8282');
  assert.equal(env.FIREBASE_AUTH_EMULATOR_HOST, '127.0.0.1:9098');
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, SENTINEL);
  for (const name of [
    'FIREBASE_CONFIG', 'FIREBASE_TOKEN', 'GOOGLE_OAUTH_ACCESS_TOKEN', 'CLOUDSDK_AUTH_ACCESS_TOKEN',
    'CLOUDSDK_CONFIG', 'NODE_OPTIONS', 'HTTP_PROXY', 'HTTPS_PROXY', 'AWS_SECRET_ACCESS_KEY',
    'AZURE_CLIENT_SECRET', 'GEMINI_API_KEY', 'SENDGRID_API_KEY',
  ]) {
    assert.equal(env[name], undefined, name);
  }
});

test('the test environment sets the network preload and ignores a parent preload', () => {
  const env = buildTestEnv(parent(), 'C:\\isolated\\isolatedNetworkGuard.js');
  assert.equal(env.NODE_OPTIONS, '--require C:\\isolated\\isolatedNetworkGuard.js');
  assert.equal(env.GCLOUD_PROJECT, PROJECT);
  assert.doesNotMatch(env.NODE_OPTIONS, /evil-preload/);
});
