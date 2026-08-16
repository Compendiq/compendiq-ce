import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

/**
 * Regression guard for #1114: no `docs/architecture/*.md` **diagram** may name
 * one embedding model, or one vector width, as if it were the schema.
 *
 * The embedding pair is DB-configured — `resolveUsecase('embedding')` for the
 * model (ADR-021), a server-probed `admin_settings.embedding_dimensions` for
 * the width — and the column type follows that width through `columnTypeFor`
 * (`vector(n)` + HNSW ≤2000, `halfvec(n)` + `halfvec_cosine_ops` 2001–4000,
 * unindexed `vector(n)` above). `bge-m3`@1024 is the *bootstrap default*, not
 * the definition, and the measured production recommendation is now
 * Qwen3-Embedding-4B@2560 on the `halfvec` tier.
 *
 * Four diagram labels disagreed before this guard existed — 06's ER attribute
 * said `"1024 dims (bge-m3)"`, 01 said Ollama serves `bge-m3, 1024 dims`, 02
 * called Postgres `HNSW, 1024-dim embeddings`, and 08's sync sequence sent
 * `POST /api/embeddings (bge-m3)` and got back `vector[1024]` — so a reader
 * arriving at the source-of-truth diagrams learned a fixed schema that the
 * code has not had since the tiering landed.
 *
 * Deliberately scoped to fenced ```mermaid blocks only. Prose *must* keep
 * naming models: the notes under each diagram say which pair is the default
 * and which is recommended, and that is the wording this guard exists to move
 * the facts into. A test that banned the strings file-wide would forbid the
 * fix.
 *
 * This is a guard, not a mirror: it pins the *property* (no pinned model, no
 * pinned width, and a comment that still explains the tiering) rather than the
 * sentences, so the docs can be reworded without a test edit — but a future
 * "let me just put the real number back" edit fails by file and line.
 */

const architectureDir = resolve(__dirname, '../../docs/architecture');

interface MermaidLine {
  file: string;
  /** 1-based line number in the original .md file. */
  number: number;
  text: string;
}

/** Every line inside a fenced ```mermaid block, across docs/architecture/*.md. */
function mermaidLines(): MermaidLine[] {
  const files = readdirSync(architectureDir).filter((f) => f.endsWith('.md'));
  const out: MermaidLine[] = [];

  for (const file of files) {
    const lines = readFileSync(resolve(architectureDir, file), 'utf-8').split('\n');
    let inBlock = false;
    lines.forEach((text, idx) => {
      if (!inBlock && text.trim() === '```mermaid') {
        inBlock = true;
        return;
      }
      if (inBlock && text.trim() === '```') {
        inBlock = false;
        return;
      }
      if (inBlock) out.push({ file, number: idx + 1, text });
    });
  }

  return out;
}

// Named embedding models. Any of these inside a diagram label is the failure:
// the diagram cannot know which one is assigned.
const MODEL_NAME_RE =
  /\b(?:bge-m3|bge-large[\w.:-]*|nomic-embed[\w.:-]*|snowflake-arctic-embed[\w.:-]*|qwen3-embedding[\w.:-]*|all-minilm[\w.:-]*|text-embedding-[\w.:-]+)\b/i;

// A pinned vector width: `1024 dims`, `1024-dim`, `vector[1024]`, `vector(1024)`,
// `halfvec(2560)`. The dimension-driven wording uses `vector(n)` / `halfvec(n)`,
// which has no digits and so cannot trip this.
const PINNED_WIDTH_RE = /\b\d{3,5}\s*-?\s*dims?\b|\b(?:half)?vec(?:tor)?\s*[[(]\s*\d+\s*[\])]/i;

describe('docs/architecture diagrams do not hardcode the embedding model (#1114)', () => {
  const lines = mermaidLines();

  it('found mermaid lines to check (extractor sanity check)', () => {
    // Without this, a fence-convention change would make every assertion below
    // pass over an empty list.
    expect(lines.length).toBeGreaterThan(100);
  });

  it('names no specific embedding model inside a diagram', () => {
    const offenders = lines.filter((l) => MODEL_NAME_RE.test(l.text));
    expect(
      offenders.map((l) => `${l.file}:${l.number}: ${l.text.trim()}`),
      'A diagram label names one embedding model. The pair is resolved from ' +
        "`llm_usecase_assignments` ('embedding' use case, ADR-021) — say so in the " +
        'label and put the current default/recommendation in the prose notes below it.',
    ).toEqual([]);
  });

  it('pins no vector width inside a diagram', () => {
    const offenders = lines.filter((l) => PINNED_WIDTH_RE.test(l.text));
    expect(
      offenders.map((l) => `${l.file}:${l.number}: ${l.text.trim()}`),
      'A diagram label pins a vector width. The width is probed from the resolved ' +
        'model and drives the column type (`vector(n)` ≤2000, `halfvec(n)` 2001–4000) — ' +
        'write `vector(n)` / `halfvec(n)`, not a number.',
    ).toEqual([]);
  });
});

describe('06-data-model.md page_embeddings.embedding attribute (#1114)', () => {
  const dataModel = readFileSync(resolve(architectureDir, '06-data-model.md'), 'utf-8');

  /** The `... embedding "..."` attribute line inside the page_embeddings ER block. */
  function embeddingAttribute(): string {
    const block = /\n\s*page_embeddings\s*\{([\s\S]*?)\n\s*\}/.exec(dataModel);
    expect(block, 'no `page_embeddings { ... }` block found in 06-data-model.md').not.toBeNull();
    const attr = /^\s*\S+\s+embedding\s+"([^"]*)"\s*$/m.exec(block![1]!);
    expect(
      attr,
      'no `<type> embedding "<comment>"` attribute inside page_embeddings — the comment ' +
        'is where the dimension-driven typing is explained, so an attribute with no ' +
        'comment at all is also a failure here',
    ).not.toBeNull();
    return attr![1]!;
  }

  it('carries a comment describing the dimension-driven column type', () => {
    // Non-vacuity: without this, deleting the comment would satisfy the two
    // bans above, and the ER diagram would say less than it did before #1114.
    expect(embeddingAttribute()).toMatch(/halfvec/i);
  });

  it('does not describe the column as one model at one width', () => {
    const comment = embeddingAttribute();
    expect(comment).not.toMatch(MODEL_NAME_RE);
    expect(comment).not.toMatch(PINNED_WIDTH_RE);
  });
});

/**
 * Docs↔code drift guards for the two claims the #1114 prose makes ABOUT
 * BACKEND CODE. Both were review findings on the first cut of this PR: the
 * docs stated something the code does not do, and nothing would have gone red.
 * Reading backend source from a frontend test is the `nginx-api-body-limit`
 * precedent — the assertion belongs wherever the claim is written down, and
 * these claims are written down in `docs/`.
 *
 * Neither is a mirror of the prose: they pin the code facts the prose depends
 * on, so the failure message says which sentence has gone stale.
 */
const backendSrc = resolve(__dirname, '../../backend/src');

describe('backend facts the #1114 docs assert (#1114 review)', () => {
  /** Every .ts under backend/src, tests included. */
  function backendSources(dir = backendSrc): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) out.push(...backendSources(full));
      else if (entry.name.endsWith('.ts')) out.push(full);
    }
    return out;
  }

  it('EMBEDDING_MODEL is inert — nothing reads its value', () => {
    // ADR-012's `#1114` amendment and 06-data-model.md both say `bge-m3` is
    // NOT injected by an env var: `EMBEDDING_MODEL` has had no effect since
    // migration 054 and survives only in `llm-provider-bootstrap.ts`'s
    // `DEPRECATED_VARS` list, where the deprecation loop tests it for
    // truthiness through `process.env[v]` and logs. That dynamic read is why
    // this looks for an explicit one instead of the bare name.
    const readers = backendSources()
      .filter((f) => /process\.env\.EMBEDDING_MODEL|process\.env\[\s*['"]EMBEDDING_MODEL/.test(
        readFileSync(f, 'utf-8'),
      ))
      .map((f) => f.slice(backendSrc.length + 1));

    expect(
      readers,
      'Something reads `process.env.EMBEDDING_MODEL` again. The docs say it has no ' +
        'effect since migration 054 (ADR-012 `#1114` amendment, 06-data-model.md ' +
        '→ "Which model, in practice", and CLAUDE.md\'s legacy-env paragraph) — ' +
        'update them, or drop the read.',
    ).toEqual([]);
  });

  it('CLAUDE.md does not offer EMBEDDING_MODEL as a tunable default', () => {
    // Same fact, stated where an agent actually reads it. CLAUDE.md listed
    // `EMBEDDING_MODEL=bge-m3` under "Tunable defaults (override only with
    // reason)" — i.e. it told every reader to set a variable nothing reads,
    // three sections below its own tech-stack line saying the model is
    // DB-resolved. It now sits in the legacy-env paragraph instead.
    const claudeMd = readFileSync(resolve(__dirname, '../../CLAUDE.md'), 'utf-8');
    const tunable = /^Tunable defaults[^\n]*$/m.exec(claudeMd);

    // Non-vacuity: without this, renaming the heading would make the assertion
    // below pass over `null`, and the width var proves the list is the real one.
    expect(tunable, 'no "Tunable defaults" line in CLAUDE.md — retarget this guard').not.toBeNull();
    expect(tunable![0]).toContain('EMBEDDING_DIMENSIONS');

    expect(
      tunable![0],
      'CLAUDE.md lists EMBEDDING_MODEL as a tunable default. Nothing reads it (see the ' +
        'assertion above); it belongs in the legacy-env paragraph, not in a list that ' +
        'tells a reader overriding it does something.',
    ).not.toContain('EMBEDDING_MODEL');
  });

  it('EMBEDDING_DIMENSIONS is still the width fallback (non-vacuity)', () => {
    // The same paragraphs draw a line between the two env vars: the width DOES
    // fall back to env when `admin_settings.embedding_dimensions` is missing.
    // Without this, a typo in the regex above would make that test pass over
    // nothing and the distinction the docs draw would be unguarded.
    const readers = backendSources()
      .filter((f) => /process\.env\.EMBEDDING_DIMENSIONS/.test(readFileSync(f, 'utf-8')))
      .map((f) => f.slice(backendSrc.length + 1));

    expect(readers).toContain('core/services/admin-settings-service.ts');
  });

  it('/api/search mode=semantic still embeds the query bare (#1339 open)', () => {
    // 08-flow-sync.md and 09-flow-rag-chat.md both now say the #1329 query
    // prefix is applied on the RAG leg ONLY, and name `/api/search`'s semantic
    // mode as the query-side call that misses it. `query-instruction.test.ts`
    // cannot see this: its discovery roots are `domains/llm/services` and
    // `domains/llm/eval`, so a route file is outside them entirely.
    //
    // This failing is GOOD NEWS — it means #1339 was fixed. Delete the "open
    // gap" paragraphs in both docs, the comments in `routes/knowledge/search.ts`,
    // `rag-service.ts` and `query-instruction.ts`, and then this assertion.
    const search = readFileSync(resolve(backendSrc, 'routes/knowledge/search.ts'), 'utf-8');
    // Comments stripped: the file *names* `formatQueryForEmbedding` in the
    // comment that records this gap, and a naive substring match would read
    // its own documentation as the fix.
    const code = search.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code, 'the query-side embedding call this guard tracks has moved').toMatch(
      /generateEmbedding\(/,
    );
    expect(
      /formatQueryForEmbedding/.test(code),
      'routes/knowledge/search.ts now applies the query prefix — #1339 is closed. ' +
        'Remove the open-gap notes from 08-flow-sync.md, 09-flow-rag-chat.md, ' +
        'rag-service.ts, search.ts and query-instruction.ts, then delete this assertion.',
    ).toBe(false);

    // Non-vacuity in the other direction: every place that states the
    // query-prefix asymmetry must carry the caveat while the gap is open, or
    // the corrected copies drift apart again — which is exactly what happened
    // once. `query-instruction.ts`'s module header is in the list because it is
    // the canonical statement of the doctrine: it is where "this is query-only"
    // is argued, and it justified the narrow scan in `query-instruction.test.ts`
    // with a call-site count that was already wrong.
    const claimSites: Array<[string, string]> = [
      ['08-flow-sync.md', resolve(architectureDir, '08-flow-sync.md')],
      ['09-flow-rag-chat.md', resolve(architectureDir, '09-flow-rag-chat.md')],
      [
        'domains/llm/services/query-instruction.ts',
        resolve(backendSrc, 'domains/llm/services/query-instruction.ts'),
      ],
    ];
    for (const [label, path] of claimSites) {
      expect(
        readFileSync(path, 'utf-8'),
        `${label} states the query-prefix asymmetry but no longer names the /api/search gap`,
      ).toContain('#1339');
    }
  });
});
