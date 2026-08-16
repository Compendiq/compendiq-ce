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
  // Property 1 in the module header — query-side prefixed, document-side bare —
  // cannot be asserted by calling anything: either half getting it wrong still
  // returns a plausible vector, and every behavioural test stays green while
  // retrieval quietly degrades. What actually guards it is WHICH embedding calls
  // reach this module, so that is what is checked.
  //
  // The first version of this scan looked only at `domains/llm/services` and
  // `domains/llm/eval`, and concluded there was exactly one query-side call in
  // the app. There were two: `routes/knowledge/search.ts` embeds the query
  // itself for `GET /api/search?mode=semantic` — a mode a user picks from the
  // Pages search bar — and the scan could not see it because it never looked in
  // `routes/`. A guard whose blind spot is a whole directory certifies the
  // directory it read, so this one walks every directory the backend lints and
  // typechecks: `backend/src` AND `backend/scripts`.
  //
  // The second version was file-granular — it asked whether the FILE mentioned
  // `formatQueryForEmbedding` anywhere — which the bare `import` line satisfies
  // on its own. Verified by mutation: dropping the prefix from `search.ts`'s
  // call while leaving the import in place kept the file in the "prefixing" set
  // and the guard stayed green. It also could not see a SECOND, unprefixed
  // embed added to a file already on the list, which is precisely how a new
  // query path would inherit the wrong policy again. So the query side is now
  // asserted per CALL: every `generateEmbedding(...)` argument list in a
  // query-side file must carry `formatQueryForEmbedding(`.
  describe('the query/document asymmetry holds at every call site', () => {
    /** `backend/` — the walk covers both directories `npm run lint -w backend` does. */
    const BACKEND_ROOT = join(__dirname, '..', '..', '..', '..');
    const SCAN_ROOTS = ['src', 'scripts'];

    /**
     * The argument text of every `needle(...)` call in `src`, by counting
     * parens from each call's opening bracket. Good enough for this file's job
     * — a paren inside a string argument would skew it, and there is none at
     * any of these call sites — and it is what lets the query-side assertion
     * below talk about a CALL rather than about a file.
     */
    function callArgumentLists(src: string, needle: string): string[] {
      const out: string[] = [];
      // `await generateEmbedding(` etc — a CALL, not `foo.generateEmbedding(`
      // and not the `export async function` declaration.
      const re = new RegExp(`[^.\\w]${needle}\\s*\\(`, 'g');
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        let depth = 1;
        let i = m.index + m[0].length;
        const from = i;
        while (i < src.length && depth > 0) {
          if (src[i] === '(') depth++;
          else if (src[i] === ')') depth--;
          i++;
        }
        out.push(src.slice(from, i - 1));
      }
      return out;
    }

    /** Whether `src` imports `needle` by name (the declaring module does not). */
    function importsSymbol(src: string, needle: string): boolean {
      return new RegExp(`import\\s*\\{[^}]*\\b${needle}\\b[^}]*\\}\\s*from`, 's').test(src);
    }

    /**
     * Every file under `backend/{src,scripts}` that CALLS `needle`, as paths
     * relative to `backend/`.
     *
     * Discovered, not enumerated. A hardcoded list cannot fail for a path that
     * does not exist yet, which is the regression worth catching — `eval/seed.ts`
     * was missing from the first hand-written list, `routes/knowledge/search.ts`
     * from the first automated one, and `scripts/run-retrieval-eval.ts` from the
     * second.
     *
     * A file counts only if it also IMPORTS the symbol. That is what keeps the
     * many prose mentions out: `generateEmbedding()` written in a doc comment
     * used to be indistinguishable from a call (verified — one such line added
     * to `core/utils/version.ts`, a file with no embedding code at all, failed
     * this guard), and the tempting fix for that failure is to add the innocent
     * file to `NON_QUERY_CALL_SITES`, where it passes and the allow-list quietly
     * stops meaning what it says. Stripping comments instead needs a real
     * tokenizer — a regex literal or a URL containing `//` makes a naive
     * stripper blank a whole line, and over-stripping fails in the DANGEROUS
     * direction, hiding a real call. The import is exact, and eslint's
     * unused-import rule already forbids importing without calling.
     */
    function filesCalling(needle: string): string[] {
      const hits: string[] = [];
      const walk = (dir: string, rel: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const full = join(dir, entry.name);
          const relPath = `${rel}/${entry.name}`;
          if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === 'dist') continue;
            walk(full, relPath);
            continue;
          }
          // `.mts` too: `scripts/` holds one, and an extension the walk does
          // not know is the same blind spot as a directory it does not enter.
          if (!/\.m?ts$/.test(entry.name) || entry.name.endsWith('.test.ts')) continue;
          const src = readFileSync(full, 'utf8');
          if (!importsSymbol(src, needle)) continue;
          if (callArgumentLists(src, needle).length > 0) hits.push(relPath);
        }
      };
      for (const root of SCAN_ROOTS) walk(join(BACKEND_ROOT, root), root);
      return hits.sort();
    }

    /**
     * The QUERY-side embedding calls: the two places a user's question becomes
     * a vector. Both must apply the prefix, and they are the only two that may.
     */
    const QUERY_CALL_SITES = [
      // The RAG vector leg — `/llm/ask` and `hybridSearch`, so `mode=hybrid` on
      // `/api/search` arrives here too.
      'src/domains/llm/services/rag-service.ts',
      // `GET /api/search?mode=semantic` embeds the query itself instead of
      // delegating to `hybridSearch`, so it is a second, independent query path.
      'src/routes/knowledge/search.ts',
    ].sort();

    /**
     * Every NON-query embedding call site, with the reason it must stay bare.
     * Enumerated on purpose: `filesCalling` discovers the set, and this list is
     * the record that someone read each one and decided. A call site that is
     * neither here nor in `QUERY_CALL_SITES` fails the first test below, so a
     * new embedding path cannot inherit a policy by omission — which is exactly
     * how `search.ts` went unprefixed for two PRs.
     */
    const NON_QUERY_CALL_SITES: Record<string, string> = {
      // Index-time. `embedPage` embeds page CHUNKS, and the shadow dual-write
      // beside it embeds those same texts under the shadow model. Documents are
      // bare under every model — that is the whole asymmetry, and it is what
      // makes the stored corpus identical whether or not the prefix is live.
      'src/domains/llm/services/embedding-service.ts':
        'index-time: page chunks, live + shadow dual-write',
      // Index-time again (the shadow backfill re-embeds stored `chunk_text`),
      // plus a literal `'probe'` whose returned length types the shadow column.
      'src/domains/llm/services/shadow-migration-service.ts':
        'index-time: shadow backfill; plus the dimension probe',
      // The eval corpus seeder, and `assertModelReadsFullChunk`'s two
      // chunk-sized probe texts. A prefixed corpus would fail nothing and
      // quietly make every retrieval number wrong — worse than a crash, and
      // how a model comparison gets silently invalidated.
      'src/domains/llm/eval/seed.ts':
        'eval: corpus seed + the full-chunk truncation probe',
      // `POST /admin/embedding/probe` embeds the literal string `'probe'` to
      // read back the VECTOR WIDTH a (provider, model) pair produces. There is
      // no user question here to instruct the model about, and it runs against
      // candidate pairs that are not assigned to anything yet. It stays bare —
      // stated here rather than left to the scan's old blind spot, so the next
      // reader can tell "deliberately excluded" from "never looked at".
      'src/routes/llm/llm-embedding-probe.ts':
        'admin: vector-width probe, not a query',
      // The retrieval-eval harness embeds `'dimension probe'` to read a model's
      // vector width before it seeds. Its QUERIES never reach this call — they
      // go through `hybridSearch`, so they inherit the prefix from
      // `rag-service.ts`. It sits outside `backend/src`, which is why the walk
      // covers `backend/scripts` too: `npm run lint -w backend` (`eslint src/
      // scripts/`) and `tsconfig.scripts.json` already treat that directory as
      // part of the backend, and it is exactly where an "embed the eval queries
      // directly" change would land and silently measure the bare query.
      'scripts/run-retrieval-eval.ts':
        'eval harness: vector-width probe, not a query',
      // Deliberately not in this list because it is not a `generateEmbedding`
      // caller and so the walk cannot see it: `scripts/compare-embedding-
      // variants.mts` embeds the 144 fixture queries over its own `fetch`. Its
      // prefix is built from the exported `RETRIEVAL_TASK`, so the harness
      // measures the string that ships rather than a copy of it.
    };

    it('every embedding call site is accounted for, query-side or not', () => {
      const callers = filesCalling('generateEmbedding');
      // Sanity: the walk found the paths we know about, so the assertions
      // below cannot pass by matching nothing.
      expect(callers.length).toBeGreaterThanOrEqual(7);
      expect(callers).toEqual(
        [...QUERY_CALL_SITES, ...Object.keys(NON_QUERY_CALL_SITES)].sort(),
      );
    });

    it('every query-side embedding CALL applies the prefix — not merely the file', () => {
      for (const file of QUERY_CALL_SITES) {
        const src = readFileSync(join(BACKEND_ROOT, file), 'utf8');
        const calls = callArgumentLists(src, 'generateEmbedding');
        // A query site that stops embedding altogether fails the accounted-for
        // test above; here it must not silently match zero calls.
        expect(calls.length, `${file} embeds nothing`).toBeGreaterThan(0);
        for (const args of calls) {
          expect(args, `${file}: generateEmbedding(${args.trim()})`)
            .toContain('formatQueryForEmbedding(');
        }
      }
    });

    it('no non-query call site reaches this module', () => {
      for (const [file, why] of Object.entries(NON_QUERY_CALL_SITES)) {
        const src = readFileSync(join(BACKEND_ROOT, file), 'utf8');
        expect(src, `${file} — ${why}`).toContain('generateEmbedding');
        // Whole-file, deliberately stricter than the per-call check above: a
        // document-side path has no business importing this module at all.
        expect(src, `${file} — ${why}`).not.toContain('formatQueryForEmbedding');
      }
    });
  });
});
