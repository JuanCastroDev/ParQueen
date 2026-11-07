'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const guard = require('./isolatedEmulatorGuard');

const valid = {
  GCLOUD_PROJECT: 'demo-parkqueen-s7-fn-iso',
  S7_ISOLATED_PROJECT: 'demo-parkqueen-s7-fn-iso',
  GOOGLE_CLOUD_PROJECT: 'demo-parkqueen-s7-fn-iso',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8282',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9098',
  FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9298',
  S7_FUNCTIONS_EMULATOR_HOST: '127.0.0.1:5002',
};

function accept(env) {
  assert.equal(guard.assertIsolatedEmulator({}, env).projectId, valid.GCLOUD_PROJECT);
}

function reject(env) {
  assert.throws(() => guard.assertIsolatedEmulator({}, env));
}

test('the guard module does not load Firebase', () => {
  const source = fs.readFileSync(path.join(__dirname, 'isolatedEmulatorGuard.js'), 'utf8');
  assert.equal(source.includes('firebase'), false);
  assert.equal(Object.keys(require.cache).some((key) => key.includes('firebase-admin')), false);
});

test('a valid isolated configuration is accepted', () => {
  accept(valid);
  assert.deepEqual(guard.emulatorEndpoint('firestore', valid), { host: '127.0.0.1', port: 8282 });
});

test('missing service hosts are rejected', () => {
  for (const name of Object.values(guard.SERVICES)) {
    const env = { ...valid };
    delete env[name];
    reject(env);
  }
});

test('live-demo ports and non-loopback hosts are rejected', () => {
  reject({ ...valid, FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080' });
  reject({ ...valid, FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099' });
  reject({ ...valid, FIREBASE_STORAGE_EMULATOR_HOST: '127.0.0.1:9199' });
  reject({ ...valid, S7_FUNCTIONS_EMULATOR_HOST: '127.0.0.1:5001' });
  reject({ ...valid, FIRESTORE_EMULATOR_HOST: '10.0.0.8:8282' });
  reject({ ...valid, FIRESTORE_EMULATOR_HOST: 'localhost' });
});

test('production, live demo, mismatched projects, and live credentials are rejected', () => {
  reject({ ...valid, GCLOUD_PROJECT: guard.PRODUCTION_PROJECT, S7_ISOLATED_PROJECT: guard.PRODUCTION_PROJECT, GOOGLE_CLOUD_PROJECT: guard.PRODUCTION_PROJECT });
  reject({ ...valid, GCLOUD_PROJECT: guard.LIVE_DEMO_PROJECT, S7_ISOLATED_PROJECT: guard.LIVE_DEMO_PROJECT, GOOGLE_CLOUD_PROJECT: guard.LIVE_DEMO_PROJECT });
  reject({ ...valid, S7_ISOLATED_PROJECT: 'demo-parkqueen-other' });
  assert.throws(() => guard.assertIsolatedEmulator({
    credentialFileExists: () => true,
  }, { ...valid, GOOGLE_APPLICATION_CREDENTIALS: 'C:\\credential.json' }));
  assert.throws(() => guard.assertIsolatedEmulator({
    credentialFileExists: (file) => file.endsWith('application_default_credentials.json'),
  }, { ...valid, APPDATA: 'C:\\Users\\example\\AppData\\Roaming' }));
  assert.throws(() => guard.assertIsolatedEmulator({}, {
    ...valid,
    FIREBASE_CONFIG: '{"private_key":"blocked"}',
  }));
  accept({ ...valid, GOOGLE_APPLICATION_CREDENTIALS: 'C:\\missing-isolated-sentinel.json' });
});

test('integration files call the guard before Firebase initialization', () => {
  const excluded = new Set([
    'melvilleCanonicalPersistence.integration.test.js',
    'waitlist.integration.test.js',
    'generateEmailOTP.integration.test.js',
  ]);
  const files = fs.readdirSync(__dirname)
    .filter((name) => name.endsWith('.integration.test.js') && !excluded.has(name));
  assert.ok(files.length >= 6);
  for (const name of files) {
    const source = fs.readFileSync(path.join(__dirname, name), 'utf8');
    const guardAt = source.indexOf("require('./isolatedEmulatorGuard').assertIsolatedEmulator()");
    assert.ok(guardAt >= 0, name);
    for (const marker of ["require('firebase-admin/app')", "require('./index.js')", 'initializeApp(']) {
      const at = source.indexOf(marker);
      if (at >= 0) assert.ok(guardAt < at, `${name} reaches ${marker} before the guard`);
    }
  }
});

test('a rejected configuration exits before a Firebase package can be loaded', () => {
  const script = `
    require('./isolatedEmulatorGuard').assertIsolatedEmulator();
    require('firebase-admin/app');
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd: __dirname,
    env: { ...process.env, GCLOUD_PROJECT: guard.PRODUCTION_PROJECT, S7_ISOLATED_PROJECT: guard.PRODUCTION_PROJECT },
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /Refusing emulator project/);
  assert.equal(`${result.stderr}\n${result.stdout}`.includes('firebase-admin'), false);
});
