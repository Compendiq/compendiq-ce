import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  wantsInstructionPrefix,
  formatQueryForEmbedding,
  RETRIEVAL_TASK,
} from './query-instruction.js';

describe('query-instruction (#1114)', () => {
  describe('wantsInstructionPrefix', () => {
    it('recognises Qwen3 embedding models across the naming conventions in use', () => {
      // HuggingFace, Ollama and LM Studio all spell the same model differently,
      // and the resolved `model` string is whatever the provider was configured
      // with — so the matcher has to survive all three.
      for (const m of [
        'qwen3-embedding-4b',
        'Qwen/Qwen3-Embedding-4B',
        'qwen3-embedding:4b',
        'QWEN3-EMBEDDING-8B',
        'text-embedding-qwen3-embedding-4b',
      ]) {
        expect(wantsInstructionPrefix(m), m).toBe(true);
      }
    });

    it('does not claim models it was not trained for', () => {
      for (const m of ['bge-m3', 'nomic-embed-text', 'all-minilm', 'text-embedding-3-large']) {
        expect(wantsInstructionPrefix(m), m).toBe(false);
      }
    });

    it('does not fire on the Qwen3 CHAT models', () => {
      // The `embedding` use case is repointable by hand. A chat model in that
      // slot is already wrong; it must not additionally get a preamble.
      for (const m of ['qwen3', 'qwen3-8b', 'qwen3:32b', 'qwen3-coder']) {
        expect(wantsInstructionPrefix(m), m).toBe(false);
      }
    });

    it('does not guess at a future Qwen generation', () => {
      // A false positive corrupts every query vector; a false negative costs a
      // little accuracy. Unknown models must land on the safe side.
      expect(wantsInstructionPrefix('qwen4-embedding-4b')).toBe(false);
      expect(wantsInstructionPrefix('qwen2-embedding')).toBe(false);
    });

    it('handles an absent model without throwing', () => {
      expect(wantsInstructionPrefix(null)).toBe(false);
      expect(wantsInstructionPrefix(undefined)).toBe(false);
      expect(wantsInstructionPrefix('')).toBe(false);
    });
  });

  describe('formatQueryForEmbedding', () => {
    it('leaves a non-instruction model’s query byte-identical', () => {
      // This is what makes the call site safe to run unconditionally.
      const q = 'how do I rotate the PAT?';
      expect(formatQueryForEmbedding('bge-m3', q)).toBe(q);
    });

    it('emits Qwen3’s exact template, with NO space after "Query:"', () => {
      const out = formatQueryForEmbedding('qwen3-embedding-4b', 'how do I rotate the PAT?');
      expect(out).toBe(`Instruct: ${RETRIEVAL_TASK}\nQuery:how do I rotate the PAT?`);
      // Pinned separately from the equality above, because this is the single
      // detail the epic body got wrong and a stray space is invisible in a diff.
      expect(out).toContain('\nQuery:how');
      expect(out).not.toContain('Query: how');
    });

    it('separates the task and the query with a newline, not a space', () => {
      const out = formatQueryForEmbedding('qwen3-embedding-4b', 'x');
      expect(out.split('\n')).toHaveLength(2);
      expect(out.startsWith('Instruct: ')).toBe(true);
    });

    it('preserves a query that itself contains newlines (pasted error text)', () => {
      // A pasted stack trace is a real query shape here — #1107 and the
      // deep-search rules both single it out — so it must survive intact.
      const q = 'Error: boom\n  at thing.ts:1';
      const out = formatQueryForEmbedding('qwen3-embedding-4b', q);
      expect(out).toBe(`Instruct: ${RETRIEVAL_TASK}\nQuery:${q}`);
      expect(out.endsWith(q)).toBe(true);
    });

    it('accepts an explicit task override', () => {
      const out = formatQueryForEmbedding('qwen3-embedding-4b', 'q', 'Custom task');
      expect(out).toBe('Instruct: Custom task\nQuery:q');
    });
  });

  // ── the asymmetry, pinned structurally ──────────────────────────────────────
  //
  // Property 1 in the module header — query-only — cannot be asserted by
  // calling anything: a document path that wrongly prefixed would still return
  // a plausible vector, and every behavioural test would stay green while
  // retrieval quietly degraded. What actually guards it is that the DOCUMENT
  // embedding call sites never reach this module, so that is what is checked.
  describe('documents are never prefixed', () => {
    // Discovered, not enumerated. A hardcoded list of document-side files
    // cannot fail for a path that does not exist yet, which is precisely the
    // regression worth catching — `eval/seed.ts` was already a third document
    // embedder missing from the first version of this list.
    function filesCalling(needle: string): string[] {
      const roots = [join(__dirname), join(__dirname, '..', 'eval')];
      const hits: string[] = [];
      for (const root of roots) {
        for (const f of readdirSync(root)) {
          if (!f.endsWith('.ts') || f.endsWith('.test.ts')) continue;
          const src = readFileSync(join(root, f), 'utf8');
          // `await generateEmbedding(` etc — a CALL, not the declaration.
          if (new RegExp(`[^.\\w]${needle}\\s*\\(`).test(src.replace(/export async function generateEmbedding/g, ''))) {
            hits.push(join(root, f));
          }
        }
      }
      return hits;
    }

    it('exactly one embedding call site applies the query prefix', () => {
      const callers = filesCalling('generateEmbedding');
      // Sanity: the discovery found the paths we know about, so a passing
      // assertion below cannot be an artifact of matching nothing.
      expect(callers.length).toBeGreaterThanOrEqual(4);

      const prefixing = callers.filter((f) =>
        readFileSync(f, 'utf8').includes('formatQueryForEmbedding'));

      expect(prefixing.map((f) => f.split('/').pop())).toEqual(['rag-service.ts']);
    });

    it('the eval seeder embeds documents bare', () => {
      // Called out by name because a prefixed corpus would not fail anything —
      // it would just quietly make every eval number wrong, which is worse
      // than a crash and is how a model comparison gets silently invalidated.
      const seed = readFileSync(join(__dirname, '..', 'eval', 'seed.ts'), 'utf8');
      expect(seed).toContain('generateEmbedding');
      expect(seed).not.toContain('formatQueryForEmbedding');
    });
  });
});
