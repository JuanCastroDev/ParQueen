import { defineConfig } from 'vitest/config';

// These suites call rulesFirestorePort() and refuse the live demo port 8080.
// CI starts them with firebase.s7-fn-iso.json, not firebase.json.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    fileParallelism: false,
    include: [
      'firestore.rules.ping-delete.test.ts',
      'firestore.rules.carLocation.review.test.ts',
    ],
  },
});
