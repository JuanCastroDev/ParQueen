import { defineConfig } from 'vitest/config';

// Candidate rules run in full. The original suite stays unmodified and is
// filtered to the two A1-15-30P controls so the other historical cases are
// not treated as the candidate contract.
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
          testNamePattern: 'A1-15-30P',
        },
      },
    ],
  },
});
