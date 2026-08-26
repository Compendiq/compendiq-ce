import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SpellcheckExtension } from './SpellcheckExtension';

const here = dirname(fileURLToPath(import.meta.url));

describe('SpellcheckExtension (#1418 SPEC-030)', () => {
  it('is a distinct TipTap extension, not folded into inline completion', () => {
    expect(SpellcheckExtension.name).toBe('spellcheck');
    expect(SpellcheckExtension.name).not.toBe('inlineCompletion');
  });

  it('uses a 200ms debounce and a wavy interactive-border class', () => {
    const source = readFileSync(resolve(here, 'SpellcheckExtension.ts'), 'utf8');
    expect(source).toMatch(/200/);
    expect(source).toMatch(/spellcheck-miss/);
    expect(source).toMatch(/codeBlock/);
  });
});
