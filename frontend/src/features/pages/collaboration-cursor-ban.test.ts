import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve } from 'path';

/**
 * TipTap v3 renamed the caret extension. The v2 package name
 * `@tiptap/extension-collaboration-cursor` must not land in application
 * code or package manifests. Design docs may mention it as the rejected name.
 */

const REPO = resolve(__dirname, '../../../..');

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'coverage' || entry === '.git') {
      continue;
    }
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (
      /(?:package\.json|package-lock\.json)$/.test(entry)
      || /\.(?:ts|tsx|js|mjs|css)$/.test(entry)
    ) {
      out.push(full);
    }
  }
  return out;
}

describe('no collaboration-cursor package', () => {
  it('does not appear in frontend/backend/contracts source or package manifests', () => {
    const roots = [
      join(REPO, 'frontend/src'),
      join(REPO, 'frontend/package.json'),
      join(REPO, 'backend/src'),
      join(REPO, 'backend/package.json'),
      join(REPO, 'packages/contracts'),
      join(REPO, 'package.json'),
    ];
    const files: string[] = [];
    for (const root of roots) {
      if (statSync(root).isDirectory()) walk(root, files);
      else files.push(root);
    }

    const hits: string[] = [];
    for (const file of files) {
      if (file.endsWith('collaboration-cursor-ban.test.ts')) continue;
      const text = readFileSync(file, 'utf-8');
      if (text.includes('collaboration-cursor')) {
        hits.push(file.slice(REPO.length + 1));
      }
    }
    expect(hits, `collaboration-cursor leaked into:\n${hits.join('\n')}`).toEqual([]);
  });
});
