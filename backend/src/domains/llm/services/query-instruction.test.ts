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

    /**
     * #1115 — the Qwen3-**VL**-Embedding family matches both needles above and
     * wants a completely different format: a chat template with the
     * instruction as a system message, not `Instruct:/Query:`. That formatting
     * lives in `vl-embedding-client.ts`.
     *
     * This matters because an operator can point the *text* `embedding`
     * assignment at a VL model by hand — the model picker lists whatever the
     * provider serves — and the failure would be silent: a garbled preamble
     * on every query vector, which reads as poor retrieval rather than as a
     * misconfiguration.
     */
    it('excludes the VL family, whatever the naming convention', () => {
      for (const m of [
        'qwen3-vl-embedding-2b',
        'Qwen/Qwen3-VL-Embedding-8B',
        'qwen3-vl-embedding:2b',
        'QWEN3-VL-EMBEDDING-8B',
        'text-embedding-qwen3-vl-embedding-2b',
      ]) {
        expect(wantsInstructionPrefix(m), m).toBe(false);
      }
    });

    it('carries the exclusion through formatQueryForEmbedding', () => {
      expect(formatQueryForEmbedding('Qwen/Qwen3-VL-Embedding-2B', 'wie viele Kammern?')).toBe(
        'wie viele Kammern?',
      );
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
      const re = new RegExp(`(?:^|[^.\\w])${needle.replace(/\./g, '\\.')}\\s*\\(`, 'g');
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

    /**
     * The individual arguments of one call's argument text, split on the
     * commas that are not nested inside a bracket of any kind.
     *
     * Same "good enough for this file's job" caveat as `callArgumentLists`,
     * and it errs in the safe direction: a comma inside a string argument
     * over-counts, so a call carrying one fails loudly rather than passing
     * quietly. There is none at any of these call sites. `''` (a zero-argument
     * call) is length 0, not 1.
     */
    function topLevelArgs(argText: string): string[] {
      const args: string[] = [];
      let depth = 0;
      let start = 0;
      for (let i = 0; i < argText.length; i++) {
        const c = argText[i]!;
        if (c === '(' || c === '[' || c === '{') depth++;
        else if (c === ')' || c === ']' || c === '}') depth--;
        else if (c === ',' && depth === 0) {
          args.push(argText.slice(start, i));
          start = i + 1;
        }
      }
      const last = argText.slice(start);
      if (args.length > 0 || last.trim() !== '') args.push(last);
      return args;
    }

    /** The first capture group of every match of `re` in `src`. */
    function captures(src: string, re: RegExp): string[] {
      return [...src.matchAll(re)].map((m) => m[1]);
    }

    /**
     * Every local name `needle` is reachable under in `src`.
     *
     * The exported name is NOT the local name, and assuming it is was this
     * walk's own blind spot — see the fixture block below for the mutations
     * that proved it. Four binding forms are recognised, which is all four the
     * backend writes:
     *
     *   import { generateEmbedding }               → `generateEmbedding`
     *   import { generateEmbedding as embedText }  → `embedText`
     *   import * as client from '…'                → `client.generateEmbedding`
     *   const { generateEmbedding } = await import(…)  → `generateEmbedding`
     *
     * A namespace binding is added for EVERY namespace in the file rather than
     * only for the client module, because the walk has no module graph and a
     * path can be spelled a dozen ways. It costs nothing: `import * as jose`
     * contributes the binding `jose.generateEmbedding`, which matches no call.
     *
     * Returning `[]` is what keeps the many prose mentions out: a doc comment
     * binds nothing. `generateEmbedding()` written in a comment used to be
     * indistinguishable from a call (verified — one such line added to
     * `core/utils/version.ts`, a file with no embedding code at all, failed this
     * guard), and the tempting fix for that failure is to add the innocent file
     * to `NON_QUERY_CALL_SITES`, where it passes and the allow-list quietly
     * stops meaning what it says. Stripping comments instead needs a real
     * tokenizer — a regex literal or a URL containing `//` makes a naive
     * stripper blank a whole line, and over-stripping fails in the DANGEROUS
     * direction, hiding a real call. Binding is exact, and eslint's
     * unused-import rule already forbids importing without calling.
     */
    function localBindings(src: string, needle: string): string[] {
      const names = new Set<string>();

      /** `generateEmbedding` / `… as local` / `…: local` inside a brace list. */
      const fromClause = (clause: string, renameOp: string) => {
        const m = new RegExp(`\\b${needle}\\b(?:${renameOp}(\\w+))?`).exec(clause);
        if (m) names.add(m[1] ?? needle);
      };

      // `import { a, generateEmbedding as b } from '…'` — a static named
      // import, where the rename operator is `as`.
      for (const clause of captures(src, /import\s*(?:type\s+)?\{([^}]*)\}\s*from/g)) {
        fromClause(clause, '\\s+as\\s+');
      }
      // `const { generateEmbedding: b } = await import('…')` — a destructuring
      // pattern, where the rename operator is `:` instead. Every `scripts/*.mts`
      // reaches `src` this way, because scripts run against `dist`.
      for (const clause of captures(src, /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*(?:await\s+)?import\s*\(/g)) {
        fromClause(clause, '\\s*:\\s*');
      }
      // `import * as ns from '…'` and `const ns = await import('…')` — the
      // symbol is reached as a member, so the binding carries the namespace.
      for (const ns of captures(src, /import\s*\*\s*as\s+(\w+)\s*from/g)) {
        names.add(`${ns}.${needle}`);
      }
      for (const ns of captures(src, /(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?import\s*\(/g)) {
        names.add(`${ns}.${needle}`);
      }
      return [...names];
    }

    /**
     * The argument text of every call to `needle` in `src`, under whatever
     * local name the file bound it to.
     */
    function embeddingCalls(src: string, needle: string): string[] {
      return localBindings(src, needle).flatMap((binding) => callArgumentLists(src, binding));
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
          if (embeddingCalls(src, needle).length > 0) hits.push(relPath);
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
      // #1260 — the shadow comparison embeds each sampled QUERY twice, once
      // per model, and the prefix must ride per model: Qwen3 prefixed,
      // bge-m3 bare, whichever side each is on. Prefixing both, or neither,
      // silently handicaps one arm of the very comparison being run.
      'src/domains/llm/services/shadow-compare-service.ts',
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
      // measures the string that ships rather than a copy of it — asserted by
      // path in the last test of this block, because a comment is not a guard.
    };

    // ── the walk's own reach, pinned on fixtures ────────────────────────────
    //
    // Everything above is only as good as `embeddingCalls`, and the version
    // that shipped the per-call check assumed the LOCAL name is the EXPORTED
    // name — `import { generateEmbedding }` followed by `generateEmbedding(`.
    // Three other spellings are live style in this repo and every one of them
    // was invisible to it. Verified by mutation at the PR head: a probe file
    // added under `routes/knowledge/` with a plain named import turned the
    // accounted-for test RED, and the same file rewritten with an alias, with a
    // namespace import, or as a `scripts/*.mts` dynamic import left all 13
    // tests GREEN. The repo already writes all three — `app.ts:82` has
    // `close as closeCacheBus`, `core/plugins/auth.ts:3` has `import * as
    // jose`, and every `scripts/*.mts` reaches `src` through `await import()`
    // because scripts run against `dist` — so this was not a hypothetical: it
    // is exactly how a new query-side embed inherits the wrong policy in
    // silence, which is the one thing this whole block exists to prevent.
    //
    // Fixtures rather than probe files, because a temporary file under `src`
    // that a crashed run leaves behind fails the suite for the next reader with
    // an error about a path they never wrote.
    describe('the walk resolves the local binding, not the exported name', () => {
      const FORMS: Record<string, string> = {
        'plain named import': `
          import { generateEmbedding } from './openai-compatible-client.js';
          export const run = (c: C, m: string, q: string) => generateEmbedding(c, m, q);
        `,
        'aliased named import': `
          import { generateEmbedding as embedText } from './openai-compatible-client.js';
          export const run = (c: C, m: string, q: string) => embedText(c, m, q);
        `,
        'namespace import': `
          import * as client from './openai-compatible-client.js';
          export const run = (c: C, m: string, q: string) => client.generateEmbedding(c, m, q);
        `,
        'dynamic import, destructured': `
          const { generateEmbedding } = await import(\`\${REPO}/services/openai-compatible-client.js\`);
          export const run = (c: C, m: string, q: string) => generateEmbedding(c, m, q);
        `,
        'dynamic import, destructured and renamed': `
          const { generateEmbedding: embedText } = await import('./openai-compatible-client.js');
          export const run = (c: C, m: string, q: string) => embedText(c, m, q);
        `,
        'dynamic import, namespace binding': `
          const client = await import('./openai-compatible-client.js');
          export const run = (c: C, m: string, q: string) => client.generateEmbedding(c, m, q);
        `,
      };

      it.each(Object.entries(FORMS))('sees the call through a %s', (_form, src) => {
        const calls = embeddingCalls(src, 'generateEmbedding');
        expect(calls).toHaveLength(1);
        expect(calls[0]).toBe('c, m, q');
      });

      it('still ignores a mention that binds nothing', () => {
        // The rule that keeps prose out. A doc comment naming the function, in
        // a file that imports something else entirely, is not a call site — and
        // the tempting fix for a false positive here is to add the innocent
        // file to `NON_QUERY_CALL_SITES`, where it passes and the allow-list
        // quietly stops meaning what it says.
        const src = `
          import { readFileSync } from 'node:fs';
          /** Mirrors what generateEmbedding(config, model, text) returns. */
          export const read = (p: string) => readFileSync(p, 'utf8');
        `;
        expect(embeddingCalls(src, 'generateEmbedding')).toEqual([]);
      });

      it('does not credit an unrelated namespace with the symbol', () => {
        // `import * as jose` is real in `core/plugins/auth.ts`. The namespace
        // binding is `jose.generateEmbedding`, which matches no call — so a
        // namespace-importing file is not swept in for having one.
        const src = `
          import * as jose from 'jose';
          export const verify = (t: string) => jose.jwtVerify(t, key);
        `;
        expect(embeddingCalls(src, 'generateEmbedding')).toEqual([]);
      });
    });

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
        const calls = embeddingCalls(src, 'generateEmbedding');
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

    it('the offline comparison harness builds its prefix from the shipping module', () => {
      // The one query-side embed the walk cannot see: `compare-embedding-
      // variants.mts` embeds the 144 fixture queries over its own `fetch`, so
      // it never calls `generateEmbedding` and never enters `filesCalling`.
      // Naming it in a comment is what the rest of this PR argues is not a
      // guard, so it gets a real one — read by its known path, not discovered.
      //
      // It previously hardcoded `'Instruct: Given a web search query, retrieve
      // relevant passages that answer the query\nQuery:'` — Qwen's stock task,
      // not `RETRIEVAL_TASK` — so its prefix-on/off delta measured a preamble
      // the app never sends, and those numbers are quoted on #1108 and in
      // `06-data-model.md`. Re-hardcoding it is a one-line silent revert.
      const src = readFileSync(join(BACKEND_ROOT, 'scripts/compare-embedding-variants.mts'), 'utf8');
      expect(src).toContain('formatQueryForEmbedding(');
      // The half that actually catches a revert: no literal preamble anywhere.
      expect(src).not.toMatch(/['"`]Instruct: /);
    });

    it('no caller overrides the retrieval task', () => {
      // The two assertions above ask only that the WRAPPER is called, and
      // `formatQueryForEmbedding(model, query, task)` takes an optional THIRD
      // argument. So the exact divergence this block exists to prevent comes
      // straight back through that parameter with everything still green:
      // passing Qwen's stock `'Given a web search query, retrieve relevant
      // passages that answer the query'` satisfies `toContain(
      // 'formatQueryForEmbedding(')`, and the no-literal check never fires
      // because a task string carries no `Instruct: ` of its own — the module
      // supplies that. Verified by mutation at the previous head: adding that
      // third argument to the harness left all 22 tests passing.
      //
      // The docs make the stronger claim (`09-flow-rag-chat.md`: "it builds its
      // prefix from the exported `RETRIEVAL_TASK` rather than from a copy";
      // `06-data-model.md` says the same of the Qwen arms) — a symbol the
      // harness reaches only through the DEFAULT parameter. Pinning the
      // argument count is what makes the default the only path to it, and it is
      // asserted for the shipping query sites too: a per-site task is a
      // divergence in the app just as much as in the harness. The override
      // parameter stays on the API for tests and for a deliberate future
      // change — which then updates this list rather than slipping past it.
      for (const file of [...QUERY_CALL_SITES, 'scripts/compare-embedding-variants.mts']) {
        const src = readFileSync(join(BACKEND_ROOT, file), 'utf8');
        const calls = embeddingCalls(src, 'formatQueryForEmbedding');
        expect(calls.length, `${file} never calls formatQueryForEmbedding`).toBeGreaterThan(0);
        for (const args of calls) {
          expect(
            topLevelArgs(args),
            `${file}: formatQueryForEmbedding(${args.trim()}) — pass (model, query) only`,
          ).toHaveLength(2);
        }
      }
    });
  });
});
