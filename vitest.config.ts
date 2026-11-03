import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Test against the shared package's source, not a stale build.
    alias: { '@smb/shared': resolve(import.meta.dirname, 'packages/shared/src/index.ts') },
  },
  test: {
    include: ['apps/**/*.test.ts', 'packages/**/*.test.ts', 'tests/unit/**/*.test.ts'],
    environment: 'node',
  },
});
