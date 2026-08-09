/**
 * #1102 — seed the vendored corpus into a database and embed it for real.
 *
 * "For real" is the whole point: the pages go through `markdownToHtml` and
 * then `embedPage`, so the eval measures the same chunking, the same
 * `resolveUsecase('embedding')` resolution and the same pgvector writes the
 * product uses. A seeder that inserted pre-computed vectors would be
 * measuring its own fixture rather than the retrieval stack.
 */
import { query } from '../../../core/db/postgres.js';
import { markdownToHtml, htmlToText } from '../../../core/services/content-converter.js';
import { embedPage, CHUNK_HARD_LIMIT } from '../services/embedding-service.js';
import { generateEmbedding } from '../services/openai-compatible-client.js';
import type { ProviderConfig } from '../services/openai-compatible-client.js';
import { logger } from '../../../core/utils/logger.js';
import { loadCorpus, type CorpusPage } from './fixture.js';

export interface SeedResult {
  pageIdByFile: Map<string, number>;
  embeddedPages: number;
  skipped: string[];
}

/**
 * pgvector's index tiers, mirroring the destructive re-embed path: HNSW on
 * `vector` up to 2000 dims, on `halfvec` to 4000, unindexed above. The eval
 * corpus is small enough that an unindexed tier would still work, but the
 * gate should exercise the same index type production does.
 */
function columnTypeFor(dims: number): { columnType: string; opclass: string | null } {
  if (dims <= 2000) return { columnType: `vector(${dims})`, opclass: 'vector_cosine_ops' };
  if (dims <= 4000) return { columnType: `halfvec(${dims})`, opclass: 'halfvec_cosine_ops' };
  return { columnType: `vector(${dims})`, opclass: null };
}

async function currentVectorDimensions(): Promise<number | null> {
  const r = await query<{ atttypmod: number }>(
    `SELECT atttypmod FROM pg_attribute
     WHERE attrelid = 'page_embeddings'::regclass AND attname = 'embedding'`,
  );
  const mod = r.rows[0]?.atttypmod;
  return mod === undefined || mod < 0 ? null : mod;
}

/**
 * Retype the vector columns to the model's MEASURED dimension.
 *
 * The schema ships 1024-dimensional (bge-m3), and the small model the CI gate
 * runs is not. Nothing here is a migration: the eval owns a throwaway database
 * and this runs before anything is inserted, so there are no vectors to
 * preserve — which is exactly why the shadow-migration machinery (#1116) is
 * not involved and must not be reached for.
 */
export async function ensureVectorDimensions(dims: number): Promise<void> {
  if (!Number.isInteger(dims) || dims < 1 || dims > 16000) {
    throw new Error(`Refusing to retype vector columns to an implausible dimension: ${dims}`);
  }
  if ((await currentVectorDimensions()) === dims) return;

  const { columnType, opclass } = columnTypeFor(dims);
  logger.info({ dims, columnType }, 'Eval seed: retyping vector columns to the probed dimension');

  await query(`DROP INDEX IF EXISTS idx_page_embeddings_hnsw`);
  await query(`DROP INDEX IF EXISTS idx_pages_page_avg_embedding_hnsw`);
  // TRUNCATE, not ALTER … USING: any rows already present carry the old
  // dimension and cannot be cast into the new one.
  await query(`TRUNCATE page_embeddings`);
  await query(`ALTER TABLE page_embeddings ALTER COLUMN embedding TYPE ${columnType}`);
  await query(`ALTER TABLE pages ALTER COLUMN page_avg_embedding TYPE ${columnType} USING NULL`);
  if (opclass) {
    await query(
      `CREATE INDEX idx_page_embeddings_hnsw ON page_embeddings USING hnsw (embedding ${opclass}) WITH (m = 16, ef_construction = 200)`,
    );
    await query(
      `CREATE INDEX idx_pages_page_avg_embedding_hnsw ON pages USING hnsw (page_avg_embedding ${opclass}) WITH (m = 16, ef_construction = 200)`,
    );
  }
  await query(
    `INSERT INTO admin_settings (setting_key, setting_value, updated_at)
     VALUES ('embedding_dimensions', $1, NOW())
     ON CONFLICT (setting_key) DO UPDATE SET setting_value = $1, updated_at = NOW()`,
    [String(dims)],
  );
}

export class TruncatingModelError extends Error {}

/**
 * Refuse to measure with a model that cannot read a whole chunk.
 *
 * The corpus chunks out at up to `CHUNK_HARD_LIMIT` characters — headings are
 * gone by the time `chunkText` sees the converted text, so most pages become
 * one section that the paragraph splitter cannot break, and `pushChunk` emits
 * right up to the ceiling. A model with a small context window silently embeds
 * only the prefix: the run still reports "100% embedded" and produces a
 * confident Recall@K describing text the model never saw.
 *
 * Detected empirically rather than by consulting a model card, because
 * neither the OpenAI-compatible API nor Ollama's `/v1` exposes a context
 * length: embed two chunk-sized texts that differ ONLY in their last word. A
 * model reading the whole input must produce different vectors. `all-minilm`
 * returns byte-identical ones here — which is how this was found.
 */
export async function assertModelReadsFullChunk(
  cfg: ProviderConfig,
  model: string,
  chunkSample: string,
): Promise<void> {
  // The filler must be REAL corpus text (review r2). The first version repeated
  // 'alpha ', which is one token per six characters in every BPE vocabulary —
  // so a 6000-character probe carried ~1000 tokens while a 6000-character
  // corpus chunk carries ~1500-2000 (embedding-service.ts pins that estimate,
  // and all-minilm's 256-token window measured out at ~1000 characters on this
  // corpus, i.e. ~3.9 chars/token). The probe therefore certified models with
  // a ~1000-token window that still truncate two thirds of every real chunk —
  // exactly the failure it exists to catch.
  const filler = chunkSample.slice(0, CHUNK_HARD_LIMIT);
  if (filler.length < CHUNK_HARD_LIMIT) {
    throw new TruncatingModelError(
      `Truncation probe needs ${CHUNK_HARD_LIMIT} characters of real corpus text, got ${filler.length}`,
    );
  }
  const [head] = await generateEmbedding(cfg, model, `${filler} ZEBRAQUIRK`);
  const [tail] = await generateEmbedding(cfg, model, `${filler} OMEGADIFFER`);
  if (!head || !tail) {
    throw new TruncatingModelError(`Model ${model} returned no embedding for the truncation probe`);
  }

  const dot = head.reduce((sum, v, i) => sum + v * (tail[i] ?? 0), 0);
  const norm = Math.sqrt(head.reduce((s, v) => s + v * v, 0)) * Math.sqrt(tail.reduce((s, v) => s + v * v, 0));
  const cosine = norm === 0 ? 1 : dot / norm;

  if (cosine > 1 - 1e-9) {
    throw new TruncatingModelError(
      `Model ${model} produced the same vector for two ${CHUNK_HARD_LIMIT}-character corpus-text samples differing only in their final word ` +
        `(cosine ${cosine.toFixed(9)}) — it is truncating the input. Every metric would then describe the prefix the model ` +
        'happened to read, not the corpus. Use a model whose context covers a whole chunk.',
    );
  }
}

export const EVAL_SPACE_KEY = 'EVAL';

/**
 * Clear any previous corpus before seeding.
 *
 * Without this, a second run against the same database inserts a SECOND copy
 * of every page. Retrieval then splits between the identical twins, the
 * fixture's expected id competes with a page whose text is character-for-
 * character the same, and recall roughly halves — which the comparison mode
 * dutifully reports as a credible regression caused by the change under test.
 * Found by running the eval against its own baseline and getting a regression
 * out of identical code.
 *
 * CASCADE reaches page_embeddings and page_relationships; search_analytics is
 * cleared separately because it references users rather than pages and would
 * otherwise accumulate a run's worth of rows each time.
 */
export async function resetEvalCorpus(): Promise<void> {
  await query(`TRUNCATE pages CASCADE`);
  await query(`TRUNCATE search_analytics`);
}

/**
 * Insert every corpus page and embed it. Returns the filename → page id map
 * the fixture is resolved through; page ids are assigned here and differ
 * between runs, which is why the fixture never stores them.
 */
export async function seedCorpus(
  userId: string,
  opts: { corpus?: CorpusPage[]; onProgress?: (done: number, total: number) => void } = {},
): Promise<SeedResult> {
  const corpus = opts.corpus ?? loadCorpus();
  const pageIdByFile = new Map<string, number>();
  const skipped: string[] = [];
  let embeddedPages = 0;

  for (const [index, page] of corpus.entries()) {
    const html = await markdownToHtml(page.markdown);
    // body_text must be what the PRODUCT stores — htmlToText(html), not the
    // markdown source (review r1). The migration-049 trigger builds pages.tsv
    // from title || body_text, so storing raw markdown would index heading
    // markers, code-fence syntax and every link URL: the keyword leg would be
    // scored against a corpus the product never produces, while the vector leg
    // embedded the converted text. Half of hybrid search, measured wrong.
    const text = htmlToText(html);
    const inserted = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html, page_type, visibility, embedding_dirty, embedding_status)
       VALUES (gen_random_uuid()::text, 'standalone', $1, $2, $3, '', $4, 'page', 'shared', TRUE, 'not_embedded')
       RETURNING id`,
      [EVAL_SPACE_KEY, page.title, text, html],
    );
    const pageId = inserted.rows[0]!.id;
    pageIdByFile.set(page.file, pageId);

    const chunks = await embedPage(userId, pageId, page.title, EVAL_SPACE_KEY, html);
    if (chunks > 0) embeddedPages++;
    else skipped.push(page.file);

    opts.onProgress?.(index + 1, corpus.length);
  }

  return { pageIdByFile, embeddedPages, skipped };
}

/**
 * Point the `embedding` use case at a reachable server.
 *
 * Without this row `resolveUsecase('embedding')` throws, `hybridSearch`
 * swallows it into keyword-only, and the run reports a confident FTS-derived
 * score — the silent failure `runner.ts` guards against. Creating the row here
 * is what makes that guard a backstop rather than the primary mechanism.
 */
export async function configureEmbeddingProvider(opts: {
  baseUrl: string;
  model: string;
  name?: string;
}): Promise<string> {
  const provider = await query<{ id: string }>(
    `INSERT INTO llm_providers (name, base_url, auth_type, verify_ssl, is_default, default_model)
     VALUES ($1, $2, 'none', true, true, $3)
     RETURNING id`,
    [opts.name ?? 'eval-embedding', opts.baseUrl, opts.model],
  );
  const providerId = provider.rows[0]!.id;
  await query(
    `INSERT INTO llm_usecase_assignments (usecase, provider_id, model, updated_at)
     VALUES ('embedding', $1, $2, NOW())
     ON CONFLICT (usecase) DO UPDATE SET provider_id = $1, model = $2, updated_at = NOW()`,
    [providerId, opts.model],
  );
  return providerId;
}
