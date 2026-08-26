import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

describe('spell worker isolation (#1418 SPEC-027/039)', () => {
  it('does not import transformers.js or onnxruntime', () => {
    const source = readFileSync(resolve(here, 'spellcheck.worker.ts'), 'utf8');
    expect(source).not.toMatch(/@huggingface\/transformers|onnxruntime/i);
    expect(source).toMatch(/nspell/);
  });
});
