import { marked } from 'marked';
import DOMPurify from 'dompurify';

/**
 * #708 — KEY DECISION: `/llm/improve` streams **Markdown**, but inline
 * replacement in the TipTap editor needs **HTML**. We convert on the client
 * with `marked` (already a frontend dependency, used the same way in
 * `GenerateMode`) and sanitize with DOMPurify before handing the fragment to
 * `insertContentAt`. This keeps the backend route untouched (no new
 * "return HTML" mode) and reuses the project's single sanitization library.
 *
 * Two output shapes are produced from the same parse:
 *  - `html`   — block-level HTML, suitable for "Insert below" where a fresh
 *               paragraph/list is welcome.
 *  - `inline` — the same content with a single wrapping `<p>` unwrapped, so a
 *               selection inside a sentence is replaced in place without
 *               injecting a block break. When the improved text is genuinely
 *               multi-block (e.g. the model returns a list), `inline` falls
 *               back to the block HTML.
 */

const FORBID_TAGS = ['script', 'style', 'iframe', 'object', 'embed', 'form'];
const FORBID_ATTR = ['onerror', 'onload', 'onclick', 'onmouseover', 'onfocus'];

/** Parse Markdown to a sanitized HTML string (synchronous). */
export function improveMarkdownToHtml(markdown: string): string {
  const parsed = marked.parse(markdown, { async: false });
  const raw = typeof parsed === 'string' ? parsed : '';
  return DOMPurify.sanitize(raw, { FORBID_TAGS, FORBID_ATTR }) as string;
}

/**
 * Strip a single outer `<p>…</p>` wrapper when the HTML contains exactly one
 * paragraph and no other block-level siblings. Used for in-place selection
 * replacement so the editor keeps the surrounding block intact.
 */
export function unwrapSingleParagraph(html: string): string {
  const trimmed = html.trim();
  const match = /^<p>([\s\S]*)<\/p>$/.exec(trimmed);
  if (!match) return trimmed;
  // Bail out if there is a nested block break — only unwrap a lone paragraph.
  if (/<p[\s>]/i.test(match[1]!)) return trimmed;
  return match[1]!.trim();
}

/** Convenience: sanitized HTML in both block and inline shapes. */
export function buildImproveHtml(markdown: string): { html: string; inline: string } {
  const html = improveMarkdownToHtml(markdown);
  return { html, inline: unwrapSingleParagraph(html) };
}
