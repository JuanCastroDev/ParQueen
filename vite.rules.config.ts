import { defineConfig } from 'vitest/config';

// Candidate rules run in full. testNamePattern is not a per-project option
// in this Vitest version, so test:rules:unit applies A1-15-30P to
// original-30p on the command line. The original suite file is unchanged.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'candidate-rules',
          environment: 'node',
          globals: true,
          fileParallelism: false,
          include: [
            'firestore.rules.test.candidate-aware.ts',
            'firestore.rules.finder-notice.31ag.test.ts',
            'firestore.rules.ping-delete.test.ts',
            // Offline index-baseline guard; runs whenever firestore.indexes.json changes.
            'firestore.indexes.production-baseline.test.ts',
          ],
        },
      },
      {
        test: {
          name: 'original-30p',
          environment: 'node',
          globals: true,
          fileParallelism: false,
          include: ['firestore.rules.test.original-suite.ts'],
        },
      },
    ],
  },
});
