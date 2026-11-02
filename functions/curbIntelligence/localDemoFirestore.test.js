import { describe, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { openDemoFirestore } = require('./localDemoFirestore');

const demoEnv = {
  GCLOUD_PROJECT: 'demo-parkqueen-functions-test',
  FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
};

describe('local demo Firestore guard', () => {
  it('refuses a client when the emulator host is missing', () => {
    const open = vi.fn(() => {
      throw new Error('client created');
    });
    expect(openDemoFirestore({
      GCLOUD_PROJECT: 'demo-parkqueen-functions-test',
    }, open)).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it('refuses a client for the production project and for any other host', () => {
    const open = vi.fn(() => {
      throw new Error('client created');
    });
    expect(openDemoFirestore({
      GCLOUD_PROJECT: 'parkqueen-46475363-ccf36',
      FIRESTORE_EMULATOR_HOST: '127.0.0.1:8080',
    }, open)).toBeNull();
    expect(openDemoFirestore({
      GCLOUD_PROJECT: 'demo-parkqueen-functions-test',
      FIRESTORE_EMULATOR_HOST: 'firestore.googleapis.com',
    }, open)).toBeNull();
    expect(open).not.toHaveBeenCalled();
  });

  it('opens a client only after the demo host is verified', () => {
    const open = vi.fn(demo => ({ projectId: demo.projectId }));
    expect(openDemoFirestore(demoEnv, open)).toEqual({
      projectId: 'demo-parkqueen-functions-test',
    });
    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith({
      projectId: 'demo-parkqueen-functions-test',
      host: '127.0.0.1:8080',
    });
  });
});
