/**
 * Compare embedding models and chunking variants on #1102's corpus and
 * fixture, VECTOR LEG ONLY — no FTS, no RRF.
 *
 * Committed because a measurement nobody can re-run is not evidence (#1261
 * review). The numbers quoted on #1108 and in 06-data-model.md come from this
 * script; re-run it to audit them.
 *
 *   EMBED_URL=http://localhost:1234/v1/embeddings \
 *   ONLY_MODEL=lms ONLY_VARIANTS=V1,V2 npx tsx scripts/compare-embedding-variants.mts
 *
 * It isolates the vector leg deliberately: a keyword leg identical in every
 * arm can only mask the effect being measured. That also means its numbers are
 * NOT comparable to the hybrid figures run-retrieval-eval.ts reports.
 *
 * Chunking changes the DOCUMENTS, so every variant needs its own document
 * pass; the 144 queries are identical across variants, so they are embedded
 * once per (model, dimensions).
 *
 * Run on both models on purpose: bge-m3 is what is live when #1108 merges,
 * qwen3-4b@2000 is the end state once #1114 bundles into the same re-embed.
 * A change that helps one and hurts the other is worth knowing before we
 * commit to a single pass.
 */
import { readFileSync } from 'node:fs';

const REPO = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const OLLAMA = process.env.EMBED_URL ?? 'http://localhost:11435/v1/embeddings';

const { loadCorpus } = await import(`${REPO}/src/domains/llm/eval/fixture.js`) as typeof import('../src/domains/llm/eval/fixture.js');
const { markdownToHtml, htmlToText } = await import(`${REPO}/src/core/services/content-converter.js`) as typeof import('../src/core/services/content-converter.js');
const { chunkText } = await import(`${REPO}/src/domains/llm/services/embedding-service.js`) as typeof import('../src/domains/llm/services/embedding-service.js');
const { recallAtK, meanReciprocalRank, pairedSignificance } = await import(`${REPO}/src/domains/llm/eval/metrics.js`) as typeof import('../src/domains/llm/eval/metrics.js');
const { formatQueryForEmbedding, wantsInstructionPrefix } = await import(`${REPO}/src/domains/llm/services/query-instruction.js`) as typeof import('../src/domains/llm/services/query-instruction.js');

interface Variant { id: string; label: string; titlePrefix: boolean; chunkTokens: number }
const VARIANTS: Variant[] = [
  { id: 'V1', label: 'today: 500 tok, no title prefix', titlePrefix: false, chunkTokens: 500 },
  { id: 'V2', label: '500 tok + title prefix', titlePrefix: true, chunkTokens: 500 },
  { id: 'V3', label: '667 tok, no title prefix', titlePrefix: false, chunkTokens: 667 },
  { id: 'V4', label: '667 tok + title prefix', titlePrefix: true, chunkTokens: 667 },
].filter((v) => !process.env.ONLY_VARIANTS || process.env.ONLY_VARIANTS.split(',').includes(v.id));

interface ModelCfg { id: string; label: string; model: string; dimensions?: number; prefix: boolean }
const ALL_MODELS: ModelCfg[] = [
  { id: 'bge', label: 'bge-m3 1024 (live today)', model: 'bge-m3', prefix: false },
  { id: 'qwen', label: 'qwen3-4b 2000 (end state)', model: 'qwen3-embedding:4b', dimensions: 2000, prefix: true },
  // LM Studio serves the same weights ~7x faster than the memory-capped
  // container. No `dimensions`: truncation is irrelevant to the prefix
  // question, and the model bake-off already showed 2000 costs nothing.
  { id: 'lms', label: 'qwen3-4b 2560 via LM Studio', model: 'text-embedding-qwen3-embedding-4b', prefix: true },
];
// One model per process: running both in sequence killed Ollama's runner with
// an EOF partway through the second (two embedders resident at once).
const MODELS = process.env.ONLY_MODEL ? ALL_MODELS.filter((m) => m.id === process.env.ONLY_MODEL) : ALL_MODELS;

async function embed(model: string, input: string[], dimensions?: number): Promise<number[][]> {
  const body: Record<string, unknown> = { model, input };
  if (dimensions) body.dimensions = dimensions;
  const res = await fetch(OLLAMA, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${model}: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { data: Array<{ embedding: number[]; index: number }> };
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}

async function embedAll(model: string, texts: string[], dimensions: number | undefined, label: string): Promise<number[][]> {
  const out: number[][] = [];
  const t0 = Date.now();
  for (let i = 0; i < texts.length; i += 8) out.push(...(await embed(model, texts.slice(i, i + 8), dimensions)));
  console.log(`    ${label}: ${out.length} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  return out;
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; na += a[i]! * a[i]!; nb += b[i]! * b[i]!; }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

const corpus = loadCorpus();
const pageText = new Map<string, { title: string; text: string }>();
for (const page of corpus) {
  pageText.set(page.file, { title: page.title, text: htmlToText(await markdownToHtml(page.markdown)) });
}
const fixture = JSON.parse(readFileSync(`${REPO}/src/domains/llm/eval/fixture.json`, 'utf8')) as {
  labels: Array<{ id: string; query: string; expectedFiles: string[] }>;
};
const fileId = new Map<string, number>();
corpus.forEach((p, i) => fileId.set(p.file, i));

function buildChunks(v: Variant): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  for (const [file, { title, text }] of pageText) {
    for (const c of chunkText(text, title, 'EVAL', file, v.chunkTokens, Math.round(v.chunkTokens / 10))) {
      // The issue's format: "{title} — {section}\n\n" prepended to the chunk.
      const prefixed = v.titlePrefix ? `${title} — ${c.metadata.section_title}\n\n${c.text}` : c.text;
      out.push({ file, text: prefixed });
    }
  }
  return out;
}

const results: Record<string, { runs: Array<{ queryId: string; retrieved: number[]; expected: number[] }>; recall: Record<string, number>; mrr: number }> = {};

for (const m of MODELS) {
  console.log(`\n═══ ${m.label}`);
  // The prefixed arm goes through the SHIPPING formatter (#1114), not a copy of
  // its template. This script used to hardcode Qwen's stock web-search task,
  // which is not the wording `query-instruction.ts` sends — so its prefix-on/off
  // delta measured a preamble the app never uses. (The figures already quoted on
  // #1108 and in 06-data-model.md were produced with that older string; re-runs
  // measure what ships and may differ slightly.)
  //
  // `m.prefix` stays the on/off axis rather than being inferred, and the check
  // below is what stops the "on" arm silently collapsing into the "off" one if a
  // model is added whose name the matcher does not recognise.
  if (m.prefix && !wantsInstructionPrefix(m.model)) {
    throw new Error(`${m.id}: prefix:true but query-instruction.ts would not prefix "${m.model}"`);
  }
  const queries = fixture.labels.map((l) => (m.prefix ? formatQueryForEmbedding(m.model, l.query) : l.query));
  const queryVecs = await embedAll(m.model, queries, m.dimensions, 'queries (shared)');

  for (const v of VARIANTS) {
    const chunks = buildChunks(v);
    console.log(`  ── ${v.id} ${v.label} → ${chunks.length} chunks`);
    const docVecs = await embedAll(m.model, chunks.map((c) => c.text), m.dimensions, 'documents');

    const runs = fixture.labels.map((label, qi) => {
      const scored = docVecs.map((dv, ci) => ({ file: chunks[ci]!.file, score: cosine(queryVecs[qi]!, dv) }));
      scored.sort((a, b) => b.score - a.score);
      const seen = new Set<string>();
      const retrieved: number[] = [];
      for (const s of scored) {
        if (seen.has(s.file)) continue;
        seen.add(s.file);
        retrieved.push(fileId.get(s.file)!);
        if (retrieved.length >= 20) break;
      }
      return { queryId: label.id, retrieved, expected: label.expectedFiles.map((f) => fileId.get(f)!) };
    });

    const key = `${m.id}/${v.id}`;
    results[key] = {
      runs,
      recall: Object.fromEntries([1, 3, 5, 10].map((k) => [`@${k}`, recallAtK(runs, k)])),
      mrr: meanReciprocalRank(runs),
    };
    console.log(`     R@1 ${results[key]!.recall['@1']!.toFixed(4)} · R@5 ${results[key]!.recall['@5']!.toFixed(4)} · MRR ${results[key]!.mrr.toFixed(4)}`);
  }
}

console.log('\n\n=== #1108 RESULTS (vector leg only) ===');
console.log('model  variant  Recall@1  Recall@3  Recall@5  Recall@10   MRR');
for (const m of MODELS) {
  for (const v of VARIANTS) {
    const r = results[`${m.id}/${v.id}`]!;
    console.log(`${m.id.padEnd(5)}  ${v.id}      ${r.recall['@1']!.toFixed(4)}    ${r.recall['@3']!.toFixed(4)}    ${r.recall['@5']!.toFixed(4)}    ${r.recall['@10']!.toFixed(4)}   ${r.mrr.toFixed(4)}   ${v.label}`);
  }
}

console.log('\n=== PAIRED SIGNIFICANCE (McNemar exact, Recall@5) ===');
const score = (r: { queryId: string; retrieved: number[]; expected: number[] }) => recallAtK([r], 5);
for (const m of MODELS) {
  for (const [from, to, what] of [['V1', 'V2', 'title prefix @500'], ['V1', 'V3', 'bigger chunk, no prefix'], ['V1', 'V4', 'both'], ['V3', 'V4', 'title prefix @667']] as const) {
    const v = pairedSignificance(results[`${m.id}/${from}`]!.runs, results[`${m.id}/${to}`]!.runs, score);
    console.log(`${m.id.padEnd(5)} ${from}→${to} (${what}): ${v.wins}W/${v.losses}L · p=${v.pValue?.toFixed(4)} · ${v.significant ? v.direction.toUpperCase() : 'no credible change'}`);
  }
}
