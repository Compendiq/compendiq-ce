import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  // Root-level ignore: assets knip can't trace.
  ignore: [
    // lhci autorun's convention-based resolution of .lighthouserc.js
    // (consumed via `lighthouse: lhci autorun` in package.json scripts).
    '.lighthouserc.js',
    // Standalone CLI harnesses launched manually (documented smoke tests, not
    // wired to npm scripts or CI). Multi-pod presence smoke test for issue #301
    // — invoked manually per docs/releases/v0.4-presence-multipod-smoke.md.
    'scripts/smoke-presence-multipod.mjs',
    // scripts/vitest.config.ts is invoked dynamically via
    // `npx vitest run --config scripts/vitest.config.ts` (see perf/README.md)
    // to exercise the pure helpers in scripts/perf-graph-bench.ts (#380).
    // Knip cannot see this CLI flag so we ignore the config file explicitly.
    'scripts/vitest.config.ts',
    // Standalone tsx-invoked CLI harness; documented as an entry point in
    // `perf/README.md` (5 references) and `CHANGELOG.md`. Knip can't trace
    // markdown-documented CLI scripts, so ignore it explicitly.
    'perf/seed-test-data.ts',
  ],
  workspaces: {
    'backend': {
      entry: ['src/index.ts', 'src/app.ts'],
      project: ['src/**/*.ts'],
      ignore: ['src/**/*.test.ts', 'src/**/__fixtures__/**'],
      ignoreDependencies: [
        'pino-pretty',
        // Dynamically imported in core/enterprise/loader.ts; intentionally absent
        // from package.json (CE doesn't ship the EE package — falls back to noop.ts)
        '@compendiq/enterprise',
      ],
    },
    'frontend': {
      entry: ['src/main.tsx'],
      project: ['src/**/*.{ts,tsx}'],
      ignore: ['src/**/*.test.{ts,tsx}'],
      ignoreDependencies: [
        // Consumed via CSS @import in src/index.css (knip cannot trace CSS @imports)
        '@fontsource-variable/hanken-grotesk',
        '@fontsource-variable/jetbrains-mono',
      ],
    },
    'packages/contracts': {
      entry: ['src/index.ts'],
      project: ['src/**/*.ts'],
    },
    'mcp-docs': {
      project: ['src/**/*.ts'],
      ignoreDependencies: ['pino-pretty'],
    },
  },
};

export default config;
