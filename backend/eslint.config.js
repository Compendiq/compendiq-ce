import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import boundaries from 'eslint-plugin-boundaries';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'core', pattern: 'src/core/*', mode: 'folder' },
        { type: 'confluence', pattern: 'src/domains/confluence/*', mode: 'folder' },
        { type: 'llm', pattern: 'src/domains/llm/*', mode: 'folder' },
        { type: 'knowledge', pattern: 'src/domains/knowledge/*', mode: 'folder' },
        { type: 'routes-foundation', pattern: 'src/routes/foundation/*', mode: 'folder' },
        { type: 'routes-confluence', pattern: 'src/routes/confluence/*', mode: 'folder' },
        { type: 'routes-llm', pattern: 'src/routes/llm/*', mode: 'folder' },
        { type: 'routes-knowledge', pattern: 'src/routes/knowledge/*', mode: 'folder' },
        { type: 'app', pattern: ['src/app.ts', 'src/index.ts', 'src/telemetry.ts'], mode: 'full' },
      ],
      'boundaries/ignore': ['**/*.test.ts', '**/test-*.ts'],
      'import/resolver': {
        typescript: {
          alwaysTryTypes: true,
        },
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'boundaries/dependencies': [
        'error',
        {
          default: 'allow',
          rules: [
            // Core cannot import from any domain or route
            {
              from: ['core'],
              disallow: ['confluence', 'llm', 'knowledge', 'routes-foundation', 'routes-confluence', 'routes-llm', 'routes-knowledge'],
            },
            // Confluence domain: core + llm (for sync-embedding cross-domain)
            {
              from: ['confluence'],
              disallow: ['knowledge', 'routes-foundation', 'routes-confluence', 'routes-llm', 'routes-knowledge'],
            },
            // LLM domain: only core
            {
              from: ['llm'],
              disallow: ['confluence', 'knowledge', 'routes-foundation', 'routes-confluence', 'routes-llm', 'routes-knowledge'],
            },
            // Knowledge domain: core + llm + confluence
            {
              from: ['knowledge'],
              disallow: ['routes-foundation', 'routes-confluence', 'routes-llm', 'routes-knowledge'],
            },
            // Foundation routes: core only
            {
              from: ['routes-foundation'],
              disallow: ['confluence', 'llm', 'knowledge', 'routes-confluence', 'routes-llm', 'routes-knowledge'],
            },
            // Confluence routes: core + confluence domain
            {
              from: ['routes-confluence'],
              disallow: ['llm', 'knowledge', 'routes-foundation', 'routes-llm', 'routes-knowledge'],
            },
            // LLM routes: core + llm domain + confluence (for subpage-context, sync-service)
            {
              from: ['routes-llm'],
              disallow: ['knowledge', 'routes-foundation', 'routes-confluence', 'routes-knowledge'],
            },
            // Knowledge routes: core + all domains (highest level)
            {
              from: ['routes-knowledge'],
              disallow: ['routes-foundation', 'routes-confluence', 'routes-llm'],
            },
          ],
        },
      ],
    },
  },
  {
    ignores: ['dist/', 'node_modules/', '*.config.*'],
  },
);
