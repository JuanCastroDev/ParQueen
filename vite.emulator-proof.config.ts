import { defineConfig } from 'vitest/config';

// Isolated emulator proofs. The default unit suite excludes these files
// because they require a Firestore emulator that is not the PR #369 suite.
export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
    include: [
      'functions/curbIntelligence/androidReleaseGate.emulator.test.js',
      'functions/adminStreetScheduleRead.emulator.test.js',
      'firestore.rules.streetRulesCandidate.test.ts',
    ],
  },
});
