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

/** Longest Markdown document the route will convert, in UTF-16 code units. */
const MAX_MARKDOWN_LENGTH = 1_000_000;

/**
 * Transport ceiling for the JSON request body (#1178).
 *
 * Fastify's default is 1 MiB, which is *below* what a document at
 * `MAX_MARKDOWN_LENGTH` can serialise to — the two limits are not in the same
 * unit. `JSON.stringify` emits a UTF-16 code unit as up to 3 bytes of UTF-8
 * (any BMP character from U+0800 up, so all CJK) or as up to 6 bytes when it
 * has to escape it (a control character becomes a six-byte `\uXXXX`), so the
 * worst case for a document the schema accepts is ~6 MB. Without this option a
 * perfectly valid file gets a bare `FST_ERR_CTP_BODY_TOO_LARGE` 413 that names
 * no limit the user can act on, and the schema's own message is unreachable.
 *
 * The edge in front of this (`frontend/nginx.conf`, `client_max_body_size`)
 * is set higher again, so the rejection a user sees always comes from here or
 * from the schema — never from nginx as an HTML error page.
 */
const MAX_IMPORT_BODY_BYTES = 8 * 1024 * 1024;

const ImportMarkdownSchema = z.object({
  markdown: z.string()
    .min(1, 'markdown field required')
    .max(MAX_MARKDOWN_LENGTH, 'Markdown too large (max ~1MB)')
    // `.min(1)` accepts "   \n\n \t \n", which converts to an empty body — a
    // "successful" import that loads nothing into the editor and gives the
    // user nothing to react to (#1178).
    .refine((md) => md.trim().length > 0, 'This Markdown file is blank — it contains only whitespace'),
  title: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
  labels: z.array(z.string().min(1).max(MAX_LABEL_LENGTH)).max(MAX_LABELS).optional(),
});

export async function pagesImportRoutes(fastify: FastifyInstance) {
  fastify.addHook('onRequest', fastify.authenticate);

  // POST /api/pages/import/preview — convert Markdown (with optional YAML
  // front-matter) into editor-ready HTML. Persists nothing.
  fastify.post('/pages/import/preview', { bodyLimit: MAX_IMPORT_BODY_BYTES }, async (request) => {
    const parsed = ImportMarkdownSchema.safeParse(request.body);
    if (!parsed.success) {
      throw fastify.httpErrors.badRequest(
        parsed.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join('; '),
      );
    }
    const body = parsed.data;

    // The conversion pipeline is deep (marked → JSDOM → turndown rules →
    // DOMPurify) and its inputs are whatever file the user picked. An
    // unexpected throw anywhere in there is a 500 with 'Internal Server Error'
    // — true, and useless: the user cannot tell a server outage from a file
    // they could fix by deleting one broken table (#1178).
    let converted;
    try {
      converted = await convertMarkdown(body.markdown, body.title, body.labels);
    } catch (err) {
      request.log.error({ err }, 'Markdown import conversion failed');
      throw fastify.httpErrors.unprocessableEntity(
        'Could not convert this Markdown file. It may contain a malformed table, an unclosed code '
        + 'fence or some other construct the converter cannot read — try removing the last section '
        + 'you added, or paste the text straight into the editor instead.',
      );
    }

    // Conversion can also succeed into nothing — a file that is only
    // front-matter, or whose entire body the sanitizer stripped. Silently
    // handing the form an empty article is the same no-op import the
    // whitespace check above exists to prevent.
    if (!converted.bodyHtml.trim()) {
      throw fastify.httpErrors.unprocessableEntity(
        'This Markdown file has no content to import — everything below its front-matter is empty.',
      );
    }

    return converted;
  });
}

/**
 * Parse YAML front-matter from Markdown.
 * Supports simple key: value lines and bracket arrays [a, b, c].
 *
 * Tolerant of what real editors write, because failing to match here is
 * *silent* — the `---` block falls through to the body, renders as an `<hr>`
 * followed by an `<h2>` of the raw YAML, and the import still reports success
 * while the title and labels are gone (#1178):
 *
 * - **CRLF.** The original `\n`-only pattern meant no Windows-authored file
 *   ever matched. Line endings are normalised for the metadata scan, and the
 *   body is handed back with its own endings untouched — Markdown conversion
 *   handles either, and rewriting the user's file is not this function's job.
 * - **A leading UTF-8 BOM.** U+FEFF sits in front of the first `---` and
 *   defeats `^` identically. It is stripped up front, so it also stops riding
 *   into the editor on files that have no front-matter at all.
 */
export function parseFrontMatter(markdown: string): { metadata: Record<string, string | string[]>; content: string } {
  const source = markdown.replace(/^\uFEFF/, '');
  // The closing `---` may be the last line of the file, so the newline after
  // it is optional: a file that is nothing but front-matter parses to an empty
  // body, which the route rejects with a message, rather than parsing to
  // nothing and rendering the YAML as a heading.
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/);
  if (!match) return { metadata: {}, content: source };

  const yaml = match[1]!;
  const content = match[2] ?? '';
  const metadata: Record<string, string | string[]> = {};

  for (const line of yaml.split(/\r?\n/)) {
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
