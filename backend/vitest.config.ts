import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/test-setup.ts'],
    testTimeout: 30_000,
    // Run test files sequentially to avoid DB conflicts
    // (multiple test files share the same PostgreSQL database)
    fileParallelism: false,
  },
});
