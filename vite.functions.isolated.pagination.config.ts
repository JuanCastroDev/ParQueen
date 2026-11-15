// Second isolated pass (t697u): large-pagination proofs whose spots onCreate
// trigger backlog must not overlap the timing-sensitive suites in
// vite.functions.isolated.config.ts. run-functions-isolated-ci.mjs runs it last.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['functions/deletedUserClaimRelease.pagination.emulator.integration.test.js'],
    testTimeout: 120000,
    hookTimeout: 120000,
    maxWorkers: 1,
    retry: 0,
  },
});
