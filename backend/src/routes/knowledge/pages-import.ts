/**
 * Markdown import for the New Page form (#1133).
 *
 * This used to be `POST /api/pages/import`, which converted the Markdown *and
 * inserted a row* — always with a hardcoded `space_key = '_standalone'`, with
 * no way to pass a space. Picking a Confluence space in the form and then
 * importing filed the page somewhere else entirely, and did so before the user
 * had seen a word of it.
 *
 * The conversion is the part worth keeping, so the route lost its persistence
 * instead of being deleted: it now returns the converted article and the New
 * Page form loads it into the editor, exactly as "Use Template" does, leaving
 * `POST /api/pages` to do the save with the space, parent and visibility the
 * user actually chose.
 *
 * The path changed rather than the semantics of the old one. A client still
 * POSTing to `/pages/import` and expecting a created page should get a 404, not
 * a 200 that quietly created nothing.
 *
 * Conversion stays server-side per ADR-003: `markdownToHtml` is the canonical
 * pipeline entry point and has no frontend counterpart.
 */

import { FastifyInstance } from 'fastify';
import { markdownToHtml } from '../../core/services/content-converter.js';
import { z } from 'zod';
import DOMPurify from 'isomorphic-dompurify';

/** Shared by the request schema and the front-matter merge below. */
const MAX_TITLE_LENGTH = 500;
const MAX_LABEL_LENGTH = 100;
const MAX_LABELS = 50;

const ImportMarkdownSchema = z.object({
  markdown: z.string().min(1, 'markdown field required').max(1_000_000, 'Markdown too large (max ~1MB)'),
  title: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
  labels: z.array(z.string().min(1).max(MAX_LABEL_LENGTH)).max(MAX_LABELS).optional(),
});

export async function pagesImportRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // POST /api/pages/import/preview — convert Markdown (with optional YAML
  // front-matter) into editor-ready HTML. Persists nothing.
  fastify.post('/pages/import/preview', async (request) => {
    const parsed = ImportMarkdownSchema.safeParse(request.body);
    if (!parsed.success) {
      throw fastify.httpErrors.badRequest(
        parsed.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join('; '),
      );
    }
    const body = parsed.data;

    return convertMarkdown(body.markdown, body.title, body.labels);
  });
}

/**
 * Parse YAML front-matter from Markdown.
 * Supports simple key: value lines and bracket arrays [a, b, c].
 */
export function parseFrontMatter(markdown: string): { metadata: Record<string, string | string[]>; content: string } {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { metadata: {}, content: markdown };

  const yaml = match[1]!;
  const content = match[2] ?? '';
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

/**
 * Convert Markdown into the title, HTML body and labels the New Page form
 * needs. Pure: nothing is written.
 */
async function convertMarkdown(
  markdown: string,
  defaultTitle: string | undefined,
  bodyLabels: string[] | undefined,
): Promise<{ title: string; bodyHtml: string; labels: string[] }> {
  const { metadata, content } = parseFrontMatter(markdown);

  // Front-matter is untrusted input just like the request body, so it gets the
  // same bounds the schema applies there — otherwise a crafted file returns a
  // title or label set the route's own contract would have rejected, and
  // `POST /api/pages` (title ≤500, ≤50 labels of ≤100) then 400s on a payload
  // the user never typed.
  const title = ((typeof metadata.title === 'string' && metadata.title)
    || defaultTitle
    || 'Imported Article').slice(0, MAX_TITLE_LENGTH);

  // Merge labels from front-matter and request body (deduplicated)
  const fmLabels = Array.isArray(metadata.tags) ? metadata.tags
    : Array.isArray(metadata.labels) ? metadata.labels
    : [];
  const labels = [...new Set([...fmLabels, ...(bodyLabels ?? [])])]
    .map((label) => label.slice(0, MAX_LABEL_LENGTH))
    .filter(Boolean)
    .slice(0, MAX_LABELS);

  // Convert Markdown to HTML, then sanitize. The sanitize step still matters
  // even though nothing is stored: this HTML goes straight into the user's
  // editor, and from there into whatever they create.
  const rawHtml = await markdownToHtml(content);
  const bodyHtml = sanitizeHtml(rawHtml);

  return { title, bodyHtml, labels };
}
