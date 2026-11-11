import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: [
      'functions/deletionFenceReconciliation.integration.test.js',
      'functions/parkingCallableDeletionFence.emulator.integration.test.js',
      'functions/parkingCallablePostReadRace.emulator.integration.test.js',
      'functions/s7MixedVersion.legacyClaims.emulator.integration.test.js',
      'functions/s7MixedVersion.candidateDeletion.emulator.integration.test.js',
      'functions/s7MixedVersion.deployedBaseline.emulator.integration.test.js',
    ],
    testTimeout: 120000,
    hookTimeout: 120000,
    maxWorkers: 1,
    retry: 0,
  },
});
