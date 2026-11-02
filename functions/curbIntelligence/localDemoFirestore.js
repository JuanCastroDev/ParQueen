'use strict';

const DEMO_PROJECT_ID = 'demo-parkqueen-functions-test';
const DEMO_FIRESTORE_HOST = '127.0.0.1:8080';

function localDemoFirestoreEnv(env = process.env) {
  const projectId = typeof env.GCLOUD_PROJECT === 'string' ? env.GCLOUD_PROJECT.trim() : '';
  const host = env.FIRESTORE_EMULATOR_HOST;
  if (host !== DEMO_FIRESTORE_HOST || projectId !== DEMO_PROJECT_ID) return null;
  return { projectId, host };
}

function openDemoFirestore(env, open) {
  const demo = localDemoFirestoreEnv(env);
  if (!demo || typeof open !== 'function') return null;
  return open(demo);
}

module.exports = {
  DEMO_PROJECT_ID,
  DEMO_FIRESTORE_HOST,
  localDemoFirestoreEnv,
  openDemoFirestore,
};
