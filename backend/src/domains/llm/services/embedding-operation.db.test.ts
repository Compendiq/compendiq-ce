import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../../core/db/postgres.js';
import { isDbAvailable, setupTestDb, teardownTestDb, truncateAllTables } from '../../../test-db-helper.js';
import { captureEmbeddingArticle } from './embedding-article-stage.js';
import { embeddingOperation, nextEmbeddingAttempt } from './embedding-operation.js';

const available = await isDbAvailable();
describe.skipIf(!available)('durable embedding operation', () => {
  beforeAll(setupTestDb);
  beforeEach(truncateAllTables);
  afterAll(teardownTestDb);
  it('upgrades idempotently and serializes retry identities without changing source xmin', async () => {
    const sql = await readFile(new URL('../../../core/db/migrations/147_embedding_operation.sql', import.meta.url), 'utf8');
    await query(sql);
    await query(sql);
    const pageId = (await query("INSERT INTO pages (title, space_key, body_html, embedding_dirty) VALUES ('Title', 'DEV', '<p>Original</p>', TRUE) RETURNING id")).rows[0]!.id;
    const article = await captureEmbeddingArticle(pageId, 'Title', 'DEV', '<p>Original</p>');
    const [one, two] = await Promise.all([embeddingOperation(article), embeddingOperation(article)]);
    expect(one).toEqual(two);
    expect((await Promise.all([nextEmbeddingAttempt(article, one), nextEmbeddingAttempt(article, two)])).sort()).toEqual([1, 2]);
    expect(await captureEmbeddingArticle(pageId, 'Title', 'DEV', '<p>Original</p>')).toEqual(article);
    await query("UPDATE pages SET embedding_status = 'failed' WHERE id = $1", [pageId]);
    const retry = await captureEmbeddingArticle(pageId, 'Title', 'DEV', '<p>Original</p>');
    expect(await embeddingOperation(retry)).toEqual(one);
    expect(await nextEmbeddingAttempt(retry, one)).toBe(3);
    await query('UPDATE pages SET image_analysis_revision = image_analysis_revision + 1 WHERE id = $1', [pageId]);
    await expect(nextEmbeddingAttempt(article, one)).rejects.toThrow();
    const next = await captureEmbeddingArticle(pageId, 'Title', 'DEV', '<p>Original</p>');
    const fresh = await embeddingOperation(next);
    expect(fresh.operationId).not.toBe(one.operationId);
    expect(await nextEmbeddingAttempt(next, fresh)).toBe(1);
    await query('UPDATE pages SET embedding_dirty = FALSE WHERE id = $1', [pageId]);
    await query('UPDATE pages SET embedding_dirty = TRUE WHERE id = $1', [pageId]);
    expect((await query('SELECT * FROM embedding_ai_operations WHERE page_id = $1', [pageId])).rows).toEqual([]);
  });
});
