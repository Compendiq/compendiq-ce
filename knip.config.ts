import type { KnipConfig } from 'knip';

const config: KnipConfig = {
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
    },
    'packages/contracts': {
      entry: ['src/index.ts'],
      project: ['src/**/*.ts'],
    },
  },
};

export default config;
