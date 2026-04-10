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
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary', 'lcov', 'json-summary'],
      reportsDirectory: './coverage',
      reportOnFailure: true,
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.test.ts',
        'src/test-setup.ts',
        'src/test-db-helper.ts',
        'src/core/db/migrations/**',
      ],
      // Phase 0 coverage gates. Aggregate-wide floors, not per-file. The
      // roadmap specifies "≥ 70% on routes" — baseline measured 2026-04-10
      // shows routes at 84.11% and overall at 79.05% lines, so the floor
      // holds comfortably. Tighten to per-file thresholds or lift to 75%+
      // in a follow-up once outlier routes (llm-admin, llm-embeddings,
      // knowledge-admin, llm-ask) get backfilled.
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 60,
        statements: 70,
      },
    },
  },
});
