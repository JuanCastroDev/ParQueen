import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    fileParallelism: false,
    maxWorkers: 1,
    testTimeout: 120000,
    hookTimeout: 120000,
    setupFiles: ['./functions/isolatedEmulatorGuard.setup.cjs'],
    include: ['functions/*.integration.test.js'],
    exclude: [
      'functions/melvilleCanonicalPersistence.integration.test.js',
      'functions/waitlist.integration.test.js',
      'functions/generateEmailOTP.integration.test.js',
    ],
  },
});
