import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['functions/melvilleCanonicalPersistence.integration.test.js'],
    testTimeout: 180000,
    hookTimeout: 120000,
    fileParallelism: false,
  },
});
