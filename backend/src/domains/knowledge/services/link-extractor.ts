/**
 * Internal-link edge producer for the knowledge graph (#359).
 *
 * Scans `pages.body_html` for anchors that point at *internal* pages and
 * persists each (source → target) edge as a `page_relationships` row with
 * `relationship_type = 'explicit_link'` and `score = 1.0`. These are
 * deterministic edges, not similarity-derived; the score is constant.
 *
 * Two link shapes the rest of the app generates:
 *
 *   1. Direct app-route URLs — what authors paste / what the editor produces:
 *        `<a href="/pages/42">…</a>`
 *      The numeric path segment is `pages.id` (integer FK target).
 *
 *   2. Confluence sync placeholders — what `confluenceToHtml` emits for
 *      `<ac:link><ri:page ri:content-title="…"/></ac:link>` (see
 *      `content-converter.ts:184`):
 *        `<a href="#confluence-page:My Title">…</a>`
 *      We resolve the title back to a `pages.id` (matching by exact title
 *      first; ambiguous titles emit no edge).
 *
 * Idempotent: ON CONFLICT on (page_id_1, page_id_2, relationship_type).
 */
import { JSDOM } from 'jsdom';
import { query, getPool } from '../../../core/db/postgres.js';
import { logger } from '../../../core/utils/logger.js';

const APP_PAGE_PATH_RE = /^\/pages\/(\d+)(?:\/|$|\?|#)/;
const CONFLUENCE_PAGE_HASH_PREFIX = '#confluence-page:';

export interface ExtractedLink {
  /** Internal pages.id of the link target. */
  targetPageId: number;
}

/**
 * Pure parser: pull internal-page targets out of an HTML string.
 * `titleToId` is consulted for the `#confluence-page:<title>` shape.
 */
export function extractInternalLinks(
  html: string | null | undefined,
  titleToId: Map<string, number>,
): ExtractedLink[] {
  if (!html) return [];
  const dom = new JSDOM(`<body>${html}</body>`, { contentType: 'text/html' });
  const anchors = dom.window.document.querySelectorAll('a[href]');
  const seen = new Set<number>();
  const out: ExtractedLink[] = [];

  for (const a of anchors) {
    const href = a.getAttribute('href');
    if (!href) continue;

    // Shape 1: app-route /pages/:id
    const m = APP_PAGE_PATH_RE.exec(href);
    if (m) {
      const id = Number.parseInt(m[1]!, 10);
      if (Number.isFinite(id) && !seen.has(id)) {
        seen.add(id);
        out.push({ targetPageId: id });
      }
      continue;
    }

    // Shape 2: #confluence-page:<title>
    if (href.startsWith(CONFLUENCE_PAGE_HASH_PREFIX)) {
      const title = href.slice(CONFLUENCE_PAGE_HASH_PREFIX.length).trim();
      const id = titleToId.get(title);
      if (id != null && !seen.has(id)) {
        seen.add(id);
        out.push({ targetPageId: id });
      }
      continue;
    }
  }

  return out;
}

/**
 * Walk every page, extract internal links, persist edges. Caller controls
 * scope via `pageIds` — when omitted, all non-deleted pages are processed.
 *
 * Returns the number of *unique* (source,target) edges materialised.
 * Idempotent: re-running the same input produces the same row count.
 */
export async function computeExplicitLinkEdges(
  pageIds?: readonly number[],
): Promise<number> {
  // Title → id table for resolving #confluence-page:<title> hrefs. The map is
  // built once per run, not per page, so this is O(N) in the corpus.
  const titleRows = await query<{ id: number; title: string }>(
    `SELECT id, title FROM pages WHERE deleted_at IS NULL AND title IS NOT NULL`,
  );
  const titleToId = new Map<string, number>();
  // If a title is ambiguous, drop it from the map — emitting an edge to a
  // random page is worse than emitting no edge.
  const seenTitles = new Set<string>();
  for (const r of titleRows.rows) {
    if (seenTitles.has(r.title)) {
      titleToId.delete(r.title);
      continue;
    }
    seenTitles.add(r.title);
    titleToId.set(r.title, r.id);
  }

  // Active page IDs to filter out targets that point at deleted pages.
  const activeIds = new Set(titleRows.rows.map((r) => r.id));

  const pagesResult = pageIds && pageIds.length > 0
    ? await query<{ id: number; body_html: string | null }>(
        `SELECT id, body_html FROM pages
         WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
        [Array.from(pageIds)],
      )
    : await query<{ id: number; body_html: string | null }>(
        `SELECT id, body_html FROM pages WHERE deleted_at IS NULL`,
      );

  const pool = getPool();
  const client = await pool.connect();
  let edgesWritten = 0;
  try {
    await client.query('BEGIN');
    for (const page of pagesResult.rows) {
      const links = extractInternalLinks(page.body_html, titleToId);
      for (const link of links) {
        if (link.targetPageId === page.id) continue; // self-loops are noise
        if (!activeIds.has(link.targetPageId)) continue;
        const [a, b] = page.id < link.targetPageId
          ? [page.id, link.targetPageId]
          : [link.targetPageId, page.id];
        // ON CONFLICT keeps idempotency. score=1.0 since these are
        // deterministic links, not similarity-derived.
        const r = await client.query(
          `INSERT INTO page_relationships (page_id_1, page_id_2, relationship_type, score)
           VALUES ($1, $2, 'explicit_link', 1.0)
           ON CONFLICT (page_id_1, page_id_2, relationship_type) DO NOTHING`,
          [a, b],
        );
        edgesWritten += r.rowCount ?? 0;
      }
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    logger.error({ err }, 'computeExplicitLinkEdges failed; rolled back');
    throw err;
  } finally {
    client.release();
  }
  logger.info({ edgesWritten, pageCount: pagesResult.rows.length }, 'explicit_link edges computed');
  return edgesWritten;
}
