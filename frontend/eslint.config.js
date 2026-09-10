import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "TSTypeReference[typeName.name='ReturnType']:has(TSTypeParameterInstantiation > TSTypeQuery > TSQualifiedName[left.name='vi'][right.name='spyOn'])",
          message:
            "ReturnType<typeof vi.spyOn> resolves to 'any' under vitest 4 typings (the last overload with erased type parameters), so mistyped mock values compile clean and no tsconfig in this repo typechecks test files to catch it. Use 'MockInstance<typeof fn>' (import type { MockInstance } from 'vitest') instead.",
        },
      ],
    },
  },
  {
    // Build-time Node scripts (e.g. the CSP hash prebuild guard).
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        console: 'readonly',
        process: 'readonly',
      },
    },
  },
  {
    ignores: ['dist/', 'node_modules/', '*.config.*'],
  },
);
