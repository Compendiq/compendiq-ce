import { defineConfig } from 'vitest/config';

// Local config so `npx vitest run --config scripts/vitest.config.ts` can
// exercise the pure helpers in scripts/perf-graph-bench.ts (issue #380).
// The bench script lives outside the backend/frontend workspaces so the
// existing `src/**/*.test.ts` includes never pick it up.
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['scripts/**/*.test.ts'],
  },
});
