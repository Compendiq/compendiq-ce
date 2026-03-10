import { query } from '../db/postgres.js';
import { providerGenerateEmbedding } from './llm-provider.js';
import { htmlToText } from './content-converter.js';
import { logger } from '../utils/logger.js';
import pgvector from 'pgvector';

const CHUNK_SIZE = 500;     // ~500 tokens target
const CHUNK_OVERLAP = 50;   // ~50 token overlap
const CHARS_PER_TOKEN = 4;  // rough estimate

interface ChunkMetadata {
  page_title: string;
  section_title: string;
  space_key: string;
  confluence_id: string;
}

interface EmbeddingStatus {
  totalPages: number;
  embeddedPages: number;
  dirtyPages: number;
  totalEmbeddings: number;
  isProcessing: boolean;
}

const processingUsers = new Set<string>();

/**
 * Split text into chunks, preferring heading/paragraph boundaries.
 */
export function chunkText(text: string, pageTitle: string, spaceKey: string, confluenceId: string): Array<{ text: string; metadata: ChunkMetadata }> {
  const maxChars = CHUNK_SIZE * CHARS_PER_TOKEN;
  const overlapChars = CHUNK_OVERLAP * CHARS_PER_TOKEN;

  // Split on headings first (lines starting with # or lines with === or ---)
  const sections = text.split(/(?=^#{1,6}\s)/m);
  const chunks: Array<{ text: string; metadata: ChunkMetadata }> = [];

  let currentSection = pageTitle;

  for (const section of sections) {
    const trimmed = section.trim();
    if (!trimmed) continue;

    // Extract section title
    const headingMatch = trimmed.match(/^#{1,6}\s+(.+?)$/m);
    if (headingMatch) {
      currentSection = headingMatch[1];
    }

    if (trimmed.length <= maxChars) {
      chunks.push({
        text: trimmed,
        metadata: {
          page_title: pageTitle,
          section_title: currentSection,
          space_key: spaceKey,
          confluence_id: confluenceId,
        },
      });
    } else {
      // Split large sections on paragraph boundaries
      const paragraphs = trimmed.split(/\n\n+/);
      let currentChunk = '';

      for (const para of paragraphs) {
        if ((currentChunk + '\n\n' + para).length > maxChars && currentChunk) {
          chunks.push({
            text: currentChunk.trim(),
            metadata: {
              page_title: pageTitle,
              section_title: currentSection,
              space_key: spaceKey,
              confluence_id: confluenceId,
            },
          });
          // Keep overlap from end of previous chunk
          const words = currentChunk.split(/\s+/);
          const overlapWords = Math.ceil(overlapChars / 5);
          currentChunk = words.slice(-overlapWords).join(' ') + '\n\n' + para;
        } else {
          currentChunk = currentChunk ? currentChunk + '\n\n' + para : para;
        }
      }

      if (currentChunk.trim()) {
        chunks.push({
          text: currentChunk.trim(),
          metadata: {
            page_title: pageTitle,
            section_title: currentSection,
            space_key: spaceKey,
            confluence_id: confluenceId,
          },
        });
      }
    }
  }

  return chunks;
}

/**
 * Embed a single page's content.
 */
export async function embedPage(
  userId: string,
  confluenceId: string,
  pageTitle: string,
  spaceKey: string,
  bodyHtml: string,
): Promise<number> {
  const plainText = htmlToText(bodyHtml);
  if (!plainText || plainText.length < 20) {
    logger.debug({ confluenceId, pageTitle }, 'Skipping empty/short page for embedding');
    return 0;
  }

  const chunks = chunkText(plainText, pageTitle, spaceKey, confluenceId);
  if (chunks.length === 0) return 0;

  // Delete old embeddings for this page
  await query('DELETE FROM page_embeddings WHERE user_id = $1 AND confluence_id = $2', [userId, confluenceId]);

  // Generate embeddings in batches of 10
  const batchSize = 10;
  let embeddedCount = 0;

  for (let i = 0; i < chunks.length; i += batchSize) {
    const batch = chunks.slice(i, i + batchSize);
    const texts = batch.map((c) => c.text);

    try {
      const embeddings = await providerGenerateEmbedding(userId, texts);

      for (let j = 0; j < batch.length; j++) {
        await query(
          `INSERT INTO page_embeddings (user_id, confluence_id, chunk_index, chunk_text, embedding, metadata)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            userId,
            confluenceId,
            i + j,
            batch[j].text,
            pgvector.toSql(embeddings[j]),
            JSON.stringify(batch[j].metadata),
          ],
        );
        embeddedCount++;
      }
    } catch (err) {
      logger.error({ err, confluenceId, batch: i }, 'Failed to embed batch');
      throw err;
    }
  }

  // Mark page as no longer dirty + update embedding status
  await query(
    `UPDATE cached_pages SET embedding_dirty = FALSE, embedding_status = 'embedded', embedded_at = NOW()
     WHERE user_id = $1 AND confluence_id = $2`,
    [userId, confluenceId],
  );

  logger.info({ confluenceId, pageTitle, chunks: embeddedCount }, 'Page embedded');
  return embeddedCount;
}

/**
 * Check if embedding processing is already running for a user.
 */
export function isProcessingUser(userId: string): boolean {
  return processingUsers.has(userId);
}

/**
 * Process all dirty pages for a user.
 * Returns `alreadyProcessing: true` if skipped because processing was in progress.
 */
export async function processDirtyPages(userId: string): Promise<{ processed: number; errors: number; alreadyProcessing?: boolean }> {
  if (processingUsers.has(userId)) {
    logger.warn({ userId }, 'Embedding processing already in progress for user');
    return { processed: 0, errors: 0, alreadyProcessing: true };
  }

  processingUsers.add(userId);
  let processed = 0;
  let errors = 0;

  try {
    const result = await query<{
      confluence_id: string;
      title: string;
      space_key: string;
      body_html: string;
    }>(
      `SELECT confluence_id, title, space_key, body_html
       FROM cached_pages
       WHERE user_id = $1 AND embedding_dirty = TRUE AND body_html IS NOT NULL
       ORDER BY last_modified_at DESC`,
      [userId],
    );

    logger.info({ userId, dirtyPages: result.rows.length }, 'Processing dirty pages for embedding');

    for (const page of result.rows) {
      try {
        // Mark page as currently embedding
        await query(
          `UPDATE cached_pages SET embedding_status = 'embedding' WHERE user_id = $1 AND confluence_id = $2`,
          [userId, page.confluence_id],
        );

        await embedPage(userId, page.confluence_id, page.title, page.space_key, page.body_html);
        processed++;
      } catch (err) {
        logger.error({ err, confluenceId: page.confluence_id }, 'Failed to embed page');
        // Mark page as failed
        await query(
          `UPDATE cached_pages SET embedding_status = 'failed' WHERE user_id = $1 AND confluence_id = $2`,
          [userId, page.confluence_id],
        ).catch((updateErr) => logger.error({ err: updateErr }, 'Failed to update embedding_status to failed'));
        errors++;
      }
    }
  } finally {
    processingUsers.delete(userId);
  }

  return { processed, errors };
}

/**
 * Get embedding status for a user.
 */
export async function getEmbeddingStatus(userId: string): Promise<EmbeddingStatus> {
  const [totalResult, dirtyResult, embeddingResult, embeddedPagesResult] = await Promise.all([
    query<{ count: string }>('SELECT COUNT(*) as count FROM cached_pages WHERE user_id = $1', [userId]),
    query<{ count: string }>('SELECT COUNT(*) as count FROM cached_pages WHERE user_id = $1 AND embedding_dirty = TRUE', [userId]),
    query<{ count: string }>('SELECT COUNT(*) as count FROM page_embeddings WHERE user_id = $1', [userId]),
    query<{ count: string }>('SELECT COUNT(DISTINCT confluence_id) as count FROM page_embeddings WHERE user_id = $1', [userId]),
  ]);

  return {
    totalPages: parseInt(totalResult.rows[0].count, 10),
    embeddedPages: parseInt(embeddedPagesResult.rows[0].count, 10),
    dirtyPages: parseInt(dirtyResult.rows[0].count, 10),
    totalEmbeddings: parseInt(embeddingResult.rows[0].count, 10),
    isProcessing: processingUsers.has(userId),
  };
}

/**
 * Re-embed all pages for all users (admin action).
 */
export async function reEmbedAll(): Promise<void> {
  await query('DELETE FROM page_embeddings');
  await query(`UPDATE cached_pages SET embedding_dirty = TRUE, embedding_status = 'not_embedded', embedded_at = NULL`);
  logger.info('All embeddings cleared, pages marked dirty for re-embedding');

  // Get all users with pages
  const users = await query<{ user_id: string }>(
    'SELECT DISTINCT user_id FROM cached_pages',
  );

  for (const { user_id } of users.rows) {
    await processDirtyPages(user_id);
  }
}
