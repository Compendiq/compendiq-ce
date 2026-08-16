import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
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
    const DOC_SIDE = [
      'embedding-service.ts',       // live embed + shadow dual-write
      'shadow-migration-service.ts', // backfill + dimension probe
    ];

    it.each(DOC_SIDE)('%s does not use the query formatter', (file) => {
      const src = readFileSync(join(__dirname, file), 'utf8');
      expect(src).not.toContain('formatQueryForEmbedding');
      expect(src).not.toContain('query-instruction');
    });

    it('rag-service is the only importer', () => {
      // If a second query-side embedding call ever appears, this fails and the
      // author has to decide deliberately whether it is a query or a document.
      const rag = readFileSync(join(__dirname, 'rag-service.ts'), 'utf8');
      expect(rag).toContain('formatQueryForEmbedding');
    });
  });
});
