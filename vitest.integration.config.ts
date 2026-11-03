import { defineConfig } from 'vitest/config';

// Database integration tests. They need Docker (Testcontainers) or SMB_TEST_DATABASE_URL.
export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/integration/db/global-setup.ts'],
    fileParallelism: false, // every file rebuilds the same `smb` schema
    testTimeout: 30_000,
    hookTimeout: 180_000,
  },
});
