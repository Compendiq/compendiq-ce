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
import { markdownToHtml } from '../../../core/services/content-converter.js';
import { embedPage } from '../services/embedding-service.js';
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

export const EVAL_SPACE_KEY = 'EVAL';

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
    const inserted = await query<{ id: number }>(
      `INSERT INTO pages (confluence_id, source, space_key, title, body_text, body_storage, body_html, page_type, visibility, embedding_dirty, embedding_status)
       VALUES (gen_random_uuid()::text, 'standalone', $1, $2, $3, '', $4, 'page', 'shared', TRUE, 'not_embedded')
       RETURNING id`,
      [EVAL_SPACE_KEY, page.title, page.markdown, html],
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
