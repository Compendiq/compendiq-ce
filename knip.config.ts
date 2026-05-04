import type { KnipConfig } from 'knip';

const config: KnipConfig = {
  // Root-level ignore: knip can't trace lhci autorun's convention-based
  // resolution of .lighthouserc.js (consumed via `lighthouse: lhci autorun`
  // in package.json scripts).
  ignore: ['.lighthouserc.js'],
  workspaces: {
    'backend': {
      entry: ['src/index.ts', 'src/app.ts'],
      project: ['src/**/*.ts'],
      ignore: ['src/**/*.test.ts', 'src/**/__fixtures__/**'],
      ignoreDependencies: ['pino-pretty'],
    },
    'frontend': {
      entry: ['src/main.tsx'],
      project: ['src/**/*.{ts,tsx}'],
      ignore: ['src/**/*.test.{ts,tsx}'],
      ignoreDependencies: [
        // Consumed via CSS @import in src/index.css (knip cannot trace CSS @imports)
        '@fontsource-variable/hanken-grotesk',
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
