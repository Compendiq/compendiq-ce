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
      // #1347: patterns are BARE folder paths (e.g. `src/core`, not
      // `src/core/*`). `mode: 'folder'` classifies both a direct file inside
      // the named folder AND a file in a subfolder of it. Every route file
      // lives DIRECTLY in `src/routes/<domain>/` (there are zero nested
      // route files today) — the previous `src/routes/<x>/*` patterns only
      // matched a SUBFOLDER of that directory, so no route file ever got an
      // element type, `boundaries/dependencies` silently never applied to
      // any of them, and a `routes/foundation` file importing from
      // `domains/llm` passed lint clean. Domain folders (`src/core`,
      // `src/domains/*`) have no direct files today, which is why their
      // rules were already firing correctly before this fix.
      'boundaries/elements': [
        { type: 'core', pattern: 'src/core', mode: 'folder' },
        { type: 'confluence', pattern: 'src/domains/confluence', mode: 'folder' },
        { type: 'llm', pattern: 'src/domains/llm', mode: 'folder' },
        { type: 'knowledge', pattern: 'src/domains/knowledge', mode: 'folder' },
        { type: 'routes-foundation', pattern: 'src/routes/foundation', mode: 'folder' },
        { type: 'routes-confluence', pattern: 'src/routes/confluence', mode: 'folder' },
        { type: 'routes-llm', pattern: 'src/routes/llm', mode: 'folder' },
        { type: 'routes-knowledge', pattern: 'src/routes/knowledge', mode: 'folder' },
        {
          type: 'app',
          pattern: ['src/app.ts', 'src/index.ts', 'src/telemetry.ts', 'src/telemetry-register.ts'],
          mode: 'full',
        },
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
      // #1347: every src/ file must map to a declared element, or the
      // dependency rules above can silently stop applying to it the way
      // routes/* did before this fix. `boundaries/no-unknown` stays off —
      // it flags dependency TARGETS, and `@compendiq/contracts` resolves
      // outside `src/`, which would be pure noise.
      'boundaries/no-unknown-files': 'error',
      'boundaries/dependencies': [
        'error',
        {
          default: 'allow',
          rules: [
            // Core cannot import from any domain or route
            {
              from: { type: 'core' },
              disallow: { to: { type: ['confluence', 'llm', 'knowledge', 'routes-foundation', 'routes-confluence', 'routes-llm', 'routes-knowledge'] } },
            },
            // Confluence domain: core + llm (for sync-embedding cross-domain)
            {
              from: { type: 'confluence' },
              disallow: { to: { type: ['knowledge', 'routes-foundation', 'routes-confluence', 'routes-llm', 'routes-knowledge'] } },
            },
            // LLM domain: only core
            {
              from: { type: 'llm' },
              disallow: { to: { type: ['confluence', 'knowledge', 'routes-foundation', 'routes-confluence', 'routes-llm', 'routes-knowledge'] } },
            },
            // Knowledge domain: core + llm + confluence
            {
              from: { type: 'knowledge' },
              disallow: { to: { type: ['routes-foundation', 'routes-confluence', 'routes-llm', 'routes-knowledge'] } },
            },
            // Foundation routes: core + llm + confluence (#1347 ruling — see
            // https://github.com/Compendiq/compendiq-ce/issues/1347). Once
            // the rule actually fired, whole-tree lint reported 7 real
            // violations, all `routes-foundation`: admin.ts needs the shadow
            // migration guard, the confidence-basis resolver and the
            // cluster-wide LLM concurrency/queue-depth setters (all in
            // domains/llm); health.ts and setup.ts need the
            // openai-compatible provider health/list-models check
            // (domains/llm); settings.ts needs the Confluence sync overview
            // and client-for-user helpers (domains/confluence) for its
            // connection test. Re-homing those into routes/llm and
            // routes/confluence was considered and rejected as out of scope
            // for this fix (it changes route registration) — the allow-list
            // is widened to match what these routes genuinely need instead.
            // `knowledge` stays disallowed: nothing in routes/foundation
            // reaches it.
            {
              from: { type: 'routes-foundation' },
              disallow: { to: { type: ['knowledge', 'routes-confluence', 'routes-llm', 'routes-knowledge'] } },
            },
            // Confluence routes: core + confluence domain
            {
              from: { type: 'routes-confluence' },
              disallow: { to: { type: ['llm', 'knowledge', 'routes-foundation', 'routes-llm', 'routes-knowledge'] } },
            },
            // LLM routes: core + llm domain + confluence (for subpage-context, sync-service)
            {
              from: { type: 'routes-llm' },
              disallow: { to: { type: ['knowledge', 'routes-foundation', 'routes-confluence', 'routes-knowledge'] } },
            },
            // Knowledge routes: core + all domains (highest level)
            {
              from: { type: 'routes-knowledge' },
              disallow: { to: { type: ['routes-foundation', 'routes-confluence', 'routes-llm'] } },
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
