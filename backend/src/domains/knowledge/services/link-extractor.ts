/**
 * Internal-link edge producer for the knowledge graph (#359).
 *
 * Scans `pages.body_html` for anchors that point at *internal* pages and
 * persists each (source → target) edge as a `page_relationships` row with
 * `relationship_type = 'explicit_link'` and `score = 1.0`. These are
 * deterministic edges, not similarity-derived; the score is constant.
 *
 * Three link shapes the rest of the app generates:
 *
 *   1. Direct app-route URLs — what authors paste / what the editor produces:
 *        `<a href="/pages/42">…</a>`
 *      The numeric path segment is `pages.id` (integer FK target).
 *
 *   2. Absolute deployment-host URLs — what users paste from their browser
 *      address bar / share via copy-link:
 *        `<a href="https://kb.example.com/pages/42">…</a>`
 *      Treated as internal iff the URL host matches a host in `FRONTEND_URL`
 *      (the canonical app-base-URL env, comma-separated, used elsewhere for
 *      CORS origin and email login links). Foreign hosts are dropped.
 *
 *   3. Confluence sync placeholders — what `confluenceToHtml` emits for
 *      `<ac:link><ri:page ri:content-title="…"/></ac:link>` (see
 *      `content-converter.ts:184`):
 *        `<a href="#confluence-page:My Title">…</a>`
 *      We resolve the title back to a `pages.id` (matching by exact title
 *      first; ambiguous titles emit no edge).
 *
 * The producer itself runs as part of `computePageRelationships()` (see
 * embedding-service.ts) so explicit_link edges materialise on every recompute
 * — both the admin /graph/refresh route and the post-embed incremental path.
 *
 * Idempotent: ON CONFLICT on (page_id_1, page_id_2, relationship_type).
 */
import { JSDOM } from 'jsdom';
import type { PoolClient } from 'pg';
import { query } from '../../../core/db/postgres.js';
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
 * `internalHosts` (lower-cased hostnames, no port) gates absolute URLs:
 * `https://<host>/pages/:id` matches only when host ∈ internalHosts.
 */
export function extractInternalLinks(
  html: string | null | undefined,
  titleToId: Map<string, number>,
  internalHosts: ReadonlySet<string> = new Set(),
): ExtractedLink[] {
  if (!html) return [];
  const dom = new JSDOM(`<body>${html}</body>`, { contentType: 'text/html' });
  const anchors = dom.window.document.querySelectorAll('a[href]');
  const seen = new Set<number>();
  const out: ExtractedLink[] = [];

  for (const a of anchors) {
    const href = a.getAttribute('href');
    if (!href) continue;

    // Shape 1: app-route /pages/:id (relative, same-origin)
    const m = APP_PAGE_PATH_RE.exec(href);
    if (m) {
      const id = Number.parseInt(m[1]!, 10);
      if (Number.isFinite(id) && !seen.has(id)) {
        seen.add(id);
        out.push({ targetPageId: id });
      }
      continue;
    }

    // Shape 2: absolute deployment-host URL — only matches when the URL host
    // is in `internalHosts`. Anything else (foreign hosts, opaque schemes) is
    // intentionally ignored: edges only count for *our* knowledge base.
    if (internalHosts.size > 0 && /^https?:\/\//i.test(href)) {
      let parsed: URL | null = null;
      try {
        parsed = new URL(href);
      } catch {
        // Malformed absolute URL — skip silently rather than throw.
      }
      if (parsed && internalHosts.has(parsed.hostname.toLowerCase())) {
        const pm = APP_PAGE_PATH_RE.exec(parsed.pathname);
        if (pm) {
          const id = Number.parseInt(pm[1]!, 10);
          if (Number.isFinite(id) && !seen.has(id)) {
            seen.add(id);
            out.push({ targetPageId: id });
          }
          continue;
        }
      }
      continue;
    }

    // Shape 3: #confluence-page:<title>
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
 * Read FRONTEND_URL (comma-separated, same convention as the CORS origin in
 * app.ts and the invitation email URL in admin-users.ts) and return the set
 * of lower-cased hostnames considered "internal" for absolute-URL link
 * matching. Invalid entries are skipped silently — the env var is allowed to
 * be empty/missing in dev, and we don't want a malformed entry to break
 * graph recomputation.
 */
export function getInternalHosts(): Set<string> {
  const raw = process.env.FRONTEND_URL;
  if (!raw) return new Set();
  const hosts = new Set<string>();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    try {
      const u = new URL(trimmed);
      if (u.hostname) hosts.add(u.hostname.toLowerCase());
    } catch {
      // ignore malformed entry
    }
  }
  return hosts;
}

/**
 * Build the title→id map used by the `#confluence-page:<title>` resolver.
 * Ambiguous titles are dropped so we never emit an edge to a random page.
 * Returns both the map and an `activeIds` set for filtering deleted targets.
 */
async function loadTitleIndex(): Promise<{
  titleToId: Map<string, number>;
  activeIds: Set<number>;
}> {
  const titleRows = await query<{ id: number; title: string }>(
    `SELECT id, title FROM pages WHERE deleted_at IS NULL AND title IS NOT NULL`,
  );
  const titleToId = new Map<string, number>();
  const seenTitles = new Set<string>();
  for (const r of titleRows.rows) {
    if (seenTitles.has(r.title)) {
      titleToId.delete(r.title);
      continue;
    }
    seenTitles.add(r.title);
    titleToId.set(r.title, r.id);
  }
  const activeIds = new Set(titleRows.rows.map((r) => r.id));
  return { titleToId, activeIds };
}

/**
 * Run the explicit_link producer against an existing transactional client.
 *
 * This is the canonical entry point — `computePageRelationships()` calls it
 * inside its own BEGIN/COMMIT so explicit_link edges land atomically with the
 * similarity / label_overlap / parent_child edges. Caller is responsible for
 * the surrounding transaction.
 *
 * `changedPageIds`: when provided and non-empty, only those pages are
 * scanned as link sources (matches the existing producer's incremental
 * scoping). Pass `null`/`undefined` for a full recompute.
 *
 * Returns the number of `(source,target)` edges newly inserted (ON CONFLICT
 * DO NOTHING means re-running yields 0).
 */
export async function runExplicitLinkProducer(
  client: PoolClient,
  changedPageIds?: readonly number[] | null,
): Promise<number> {
  const { titleToId, activeIds } = await loadTitleIndex();
  const internalHosts = getInternalHosts();

  const useIncremental = changedPageIds && changedPageIds.length > 0;
  const pagesResult = useIncremental
    ? await client.query<{ id: number; body_html: string | null }>(
        `SELECT id, body_html FROM pages
         WHERE id = ANY($1::int[]) AND deleted_at IS NULL`,
        [Array.from(changedPageIds!)],
      )
    : await client.query<{ id: number; body_html: string | null }>(
        `SELECT id, body_html FROM pages WHERE deleted_at IS NULL`,
      );

  let edgesWritten = 0;
  for (const page of pagesResult.rows) {
    const links = extractInternalLinks(page.body_html, titleToId, internalHosts);
    for (const link of links) {
      if (link.targetPageId === page.id) continue; // self-loops are noise
      if (!activeIds.has(link.targetPageId)) continue;
      const [a, b] = page.id < link.targetPageId
        ? [page.id, link.targetPageId]
        : [link.targetPageId, page.id];
      // Canonical (lo,hi) ordering matches the unique key. ON CONFLICT keeps
      // idempotency. score=1.0 since these are deterministic, not similarity.
      const r = await client.query(
        `INSERT INTO page_relationships (page_id_1, page_id_2, relationship_type, score)
         VALUES ($1, $2, 'explicit_link', 1.0)
         ON CONFLICT (page_id_1, page_id_2, relationship_type) DO NOTHING`,
        [a, b],
      );
      edgesWritten += r.rowCount ?? 0;
    }
  }
  logger.info(
    { edgesWritten, pageCount: pagesResult.rows.length, mode: useIncremental ? 'incremental' : 'full' },
    'explicit_link edges produced',
  );
  return edgesWritten;
}
