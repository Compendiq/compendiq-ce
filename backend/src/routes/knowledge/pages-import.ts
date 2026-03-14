import { FastifyInstance } from 'fastify';
import { query } from '../../core/db/postgres.js';
import { markdownToHtml, htmlToText } from '../../core/services/content-converter.js';
import { logAuditEvent } from '../../core/services/audit-service.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import DOMPurify from 'isomorphic-dompurify';

const ImportMarkdownSchema = z.object({
  markdown: z.string().min(1, 'markdown field required').max(1_000_000, 'Markdown too large (max ~1MB)'),
  title: z.string().min(1).max(500).optional(),
  labels: z.array(z.string().min(1).max(100)).max(50).optional(),
});

export async function pagesImportRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // POST /api/pages/import — import article from Markdown text (with optional YAML front-matter)
  fastify.post('/pages/import', async (request) => {
    const userId = request.userId;
    const parsed = ImportMarkdownSchema.safeParse(request.body);
    if (!parsed.success) {
      throw fastify.httpErrors.badRequest(
        parsed.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join('; '),
      );
    }
    const body = parsed.data;

    const article = await importMarkdown(body.markdown, body.title, body.labels, userId);

    await logAuditEvent(userId, 'PAGE_CREATED', 'page', article.confluenceId, {
      title: article.title,
      source: 'standalone',
      method: 'markdown_import',
    }, request);

    return {
      imported: 1,
      total: 1,
      articles: [{ id: article.confluenceId, title: article.title, success: true }],
    };
  });
}

/**
 * Parse YAML front-matter from Markdown.
 * Supports simple key: value lines and bracket arrays [a, b, c].
 */
export function parseFrontMatter(markdown: string): { metadata: Record<string, string | string[]>; content: string } {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { metadata: {}, content: markdown };

  const yaml = match[1];
  const content = match[2];
  const metadata: Record<string, string | string[]> = {};

  for (const line of yaml.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim();
      const rawValue = line.slice(colonIdx + 1).trim();
      // Handle bracket arrays: [tag1, tag2]
      if (rawValue.startsWith('[') && rawValue.endsWith(']')) {
        const inner = rawValue.slice(1, -1);
        metadata[key] = inner.split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
      } else {
        metadata[key] = rawValue.replace(/^['"]|['"]$/g, '');
      }
    }
  }

  return { metadata, content };
}

/**
 * Sanitize HTML to prevent XSS using DOMPurify with a strict allowlist.
 * Strips all tags/attributes not explicitly permitted.
 */
function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
      'p', 'br', 'hr',
      'ul', 'ol', 'li',
      'a', 'img',
      'code', 'pre', 'blockquote',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'strong', 'em', 'del', 'sup', 'sub', 'mark',
      'span', 'div',
    ],
    ALLOWED_ATTR: ['href', 'src', 'alt', 'title', 'class', 'id', 'target', 'rel'],
    ALLOW_DATA_ATTR: false,
  });
}

async function importMarkdown(
  markdown: string,
  defaultTitle: string | undefined,
  bodyLabels: string[] | undefined,
  userId: string,
): Promise<{ confluenceId: string; title: string }> {
  const { metadata, content } = parseFrontMatter(markdown);

  const title = (typeof metadata.title === 'string' && metadata.title)
    || defaultTitle
    || 'Imported Article';

  // Merge labels from front-matter and request body (deduplicated)
  const fmLabels = Array.isArray(metadata.tags) ? metadata.tags
    : Array.isArray(metadata.labels) ? metadata.labels
    : [];
  const labels = [...new Set([...fmLabels, ...(bodyLabels ?? [])])];

  // Convert Markdown to HTML, then sanitize
  const rawHtml = await markdownToHtml(content);
  const bodyHtml = sanitizeHtml(rawHtml);
  const bodyText = htmlToText(bodyHtml);

  // Generate synthetic confluence_id for standalone articles
  const confluenceId = `standalone-${randomUUID()}`;

  const result = await query<{ id: number }>(
    `INSERT INTO pages
       (confluence_id, space_key, title, body_storage, body_html, body_text,
        version, labels, embedding_dirty, embedding_status, last_synced,
        source, created_by_user_id)
     VALUES ($1, '_standalone', $2, NULL, $3, $4,
             1, $5, TRUE, 'not_embedded', NOW(),
             'standalone', $6)
     RETURNING id`,
    [confluenceId, title, bodyHtml, bodyText, labels, userId],
  );

  // Ensure the insert succeeded
  if (result.rows.length === 0) {
    throw new Error('Failed to insert standalone article');
  }

  return { confluenceId, title };
}
