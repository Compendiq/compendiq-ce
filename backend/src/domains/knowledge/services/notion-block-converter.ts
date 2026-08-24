/**
 * Notion block → Compendiq `body_html` / `body_text` conversion (#1464 / #1459).
 *
 * Pure: the caller hands in already-fetched block objects (and any nested
 * `children` they chose to attach). This module never talks to Notion, never
 * fetches image bytes, and never persists a page. Image blocks become
 * `/api/local-attachments/{pageId}/{file}` URLs plus a download intent the
 * later import orchestrator writes through the local attachment store.
 *
 * Unsupported types (databases, buttons, whiteboards, AI meeting notes, …)
 * are omitted — no stub page, no flatten — and listed in `skips`.
 */

import path from 'node:path';
import DOMPurify from 'isomorphic-dompurify';
import { htmlToText } from '../../../core/services/content-converter.js';
import { buildPageImageUrl } from '../../../core/services/image-references.js';
import { canStoreLocalFilename } from '../../../core/services/local-attachment-service.js';

/** Same XSS bar as Markdown import (`pages-import.ts`), plus task-list attrs. */
const SANITIZE_CONFIG = {
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
  ALLOWED_ATTR: [
    'href', 'src', 'alt', 'title', 'class', 'id', 'target', 'rel',
    'data-type', 'data-checked', 'start',
  ],
  ALLOW_DATA_ATTR: false,
};

const SUPPORTED_TYPES = new Set([
  'heading_1',
  'heading_2',
  'heading_3',
  'heading_4',
  'paragraph',
  'quote',
  'code',
  'divider',
  'bulleted_list_item',
  'numbered_list_item',
  'to_do',
  'callout',
  'table',
  'image',
  'child_page',
]);

export interface NotionBlock {
  id?: string;
  type: string;
  has_children?: boolean;
  children?: NotionBlock[];
  [key: string]: unknown;
}

export interface NotionAttachmentIntent {
  blockId: string;
  kind: 'image';
  filename: string;
  sourceUrl: string;
  alt: string;
}

export interface NotionConversionSkip {
  blockId: string;
  type: string;
  reason: 'unsupported';
}

export interface NotionConvertOptions {
  /** Local page PK used in `/api/local-attachments/{id}/…` src attributes. */
  localPageId: number;
  /**
   * Notion page ids this run will persist. Mentions of those ids become
   * `/pages/{localId}`; everything else stays a Notion URL.
   */
  importedPages?: ReadonlyMap<string, number>;
}

export interface NotionConversionResult {
  bodyHtml: string;
  bodyText: string;
  attachments: NotionAttachmentIntent[];
  skips: NotionConversionSkip[];
}

interface ConvertCtx {
  localPageId: number;
  importedPages: Map<string, number>;
  attachments: NotionAttachmentIntent[];
  skips: NotionConversionSkip[];
}

export function convertNotionBlocks(
  blocks: readonly NotionBlock[],
  options: NotionConvertOptions,
): NotionConversionResult {
  const ctx: ConvertCtx = {
    localPageId: options.localPageId,
    importedPages: indexImportedPages(options.importedPages),
    attachments: [],
    skips: [],
  };
  const raw = convertSequence(blocks, ctx);
  const bodyHtml = sanitizeNotionHtml(raw);
  return {
    bodyHtml,
    bodyText: htmlToText(bodyHtml),
    attachments: ctx.attachments,
    skips: ctx.skips,
  };
}

function indexImportedPages(imported?: ReadonlyMap<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  if (!imported) return out;
  for (const [id, pageId] of imported) {
    out.set(normalizeNotionId(id), pageId);
  }
  return out;
}

function normalizeNotionId(id: string): string {
  return id.replace(/-/g, '').toLowerCase();
}

function notionWebUrl(id: string): string {
  return `https://www.notion.so/${normalizeNotionId(id)}`;
}

function sanitizeNotionHtml(html: string): string {
  return DOMPurify.sanitize(html, SANITIZE_CONFIG);
}

function convertSequence(blocks: readonly NotionBlock[], ctx: ConvertCtx): string {
  const parts: string[] = [];
  let i = 0;
  while (i < blocks.length) {
    const type = blocks[i]!.type;
    if (type === 'bulleted_list_item') {
      const group: NotionBlock[] = [];
      while (i < blocks.length && blocks[i]!.type === 'bulleted_list_item') {
        group.push(blocks[i]!);
        i += 1;
      }
      parts.push(renderList('ul', group, ctx));
      continue;
    }
    if (type === 'numbered_list_item') {
      const group: NotionBlock[] = [];
      while (i < blocks.length && blocks[i]!.type === 'numbered_list_item') {
        group.push(blocks[i]!);
        i += 1;
      }
      parts.push(renderList('ol', group, ctx));
      continue;
    }
    if (type === 'to_do') {
      const group: NotionBlock[] = [];
      while (i < blocks.length && blocks[i]!.type === 'to_do') {
        group.push(blocks[i]!);
        i += 1;
      }
      parts.push(renderTaskList(group, ctx));
      continue;
    }
    const html = convertOne(blocks[i]!, ctx);
    if (html) parts.push(html);
    i += 1;
  }
  return parts.join('');
}

function convertOne(block: NotionBlock, ctx: ConvertCtx): string {
  const type = block.type;
  if (!SUPPORTED_TYPES.has(type)) {
    skip(block, ctx);
    return '';
  }
  switch (type) {
    case 'heading_1':
      return wrapRich('h1', payload(block, type), ctx);
    case 'heading_2':
      return wrapRich('h2', payload(block, type), ctx);
    case 'heading_3':
      return wrapRich('h3', payload(block, type), ctx);
    case 'heading_4':
      return wrapRich('h4', payload(block, type), ctx);
    case 'paragraph':
      return wrapRich('p', payload(block, type), ctx);
    case 'quote': {
      const inner = wrapRich('p', payload(block, type), ctx);
      const nested = convertSequence(childrenOf(block), ctx);
      return `<blockquote>${inner}${nested}</blockquote>`;
    }
    case 'code':
      return renderCode(payload(block, type));
    case 'divider':
      return '<hr>';
    case 'callout':
      return renderCallout(block, ctx);
    case 'table':
      return renderTable(block, ctx);
    case 'image':
      return renderImage(block, ctx);
    case 'child_page':
      return renderChildPage(block, ctx);
    default:
      skip(block, ctx);
      return '';
  }
}

function skip(block: NotionBlock, ctx: ConvertCtx): void {
  ctx.skips.push({
    blockId: typeof block.id === 'string' ? block.id : '',
    type: block.type,
    reason: 'unsupported',
  });
}

function payload(block: NotionBlock, type: string): Record<string, unknown> {
  const value = block[type];
  return isRecord(value) ? value : {};
}

function childrenOf(block: NotionBlock, extra?: Record<string, unknown>): NotionBlock[] {
  const fromBlock = Array.isArray(block.children) ? block.children : [];
  const fromPayload = extra && Array.isArray(extra.children) ? extra.children : [];
  const merged = fromPayload.length > 0 ? fromPayload : fromBlock;
  return merged.filter((child): child is NotionBlock => isRecord(child) && typeof child.type === 'string');
}

function wrapRich(tag: string, data: Record<string, unknown>, ctx: ConvertCtx): string {
  const html = renderRichText(asRichArray(data.rich_text), ctx);
  if (!html && tag === 'p') return '';
  return `<${tag}>${html}</${tag}>`;
}

function renderList(tag: 'ul' | 'ol', items: readonly NotionBlock[], ctx: ConvertCtx): string {
  const lis = items.map((item) => {
    const data = payload(item, item.type);
    const text = renderRichText(asRichArray(data.rich_text), ctx);
    const nested = convertSequence(childrenOf(item, data), ctx);
    return `<li>${text}${nested}</li>`;
  }).join('');
  return `<${tag}>${lis}</${tag}>`;
}

function renderTaskList(items: readonly NotionBlock[], ctx: ConvertCtx): string {
  const lis = items.map((item) => {
    const data = payload(item, 'to_do');
    const checked = data.checked === true ? 'true' : 'false';
    const text = renderRichText(asRichArray(data.rich_text), ctx);
    const nested = convertSequence(childrenOf(item, data), ctx);
    return `<li data-type="taskItem" data-checked="${checked}">${text}${nested}</li>`;
  }).join('');
  return `<ul data-type="taskList">${lis}</ul>`;
}

function renderCallout(block: NotionBlock, ctx: ConvertCtx): string {
  const data = payload(block, 'callout');
  const cls = panelClass(typeof data.color === 'string' ? data.color : undefined);
  const text = renderRichText(asRichArray(data.rich_text), ctx);
  const nested = convertSequence(childrenOf(block, data), ctx);
  const inner = text ? `<p>${text}</p>` : '';
  return `<div class="${cls}">${inner}${nested}</div>`;
}

function panelClass(color: string | undefined): string {
  const c = (color ?? 'default').toLowerCase();
  if (c.startsWith('red')) return 'panel-warning';
  if (c.startsWith('green')) return 'panel-tip';
  if (c.startsWith('yellow') || c.startsWith('orange') || c.startsWith('brown')) return 'panel-note';
  return 'panel-info';
}

function renderCode(data: Record<string, unknown>): string {
  const text = asRichArray(data.rich_text).map((rt) => plainOf(rt)).join('');
  const language = typeof data.language === 'string' ? data.language : '';
  const safeLang = /^[A-Za-z0-9+#-]+$/.test(language) && language !== 'plain text'
    ? ` class="language-${escapeHtml(language)}"`
    : '';
  return `<pre><code${safeLang}>${escapeHtml(text)}</code></pre>`;
}

function renderTable(block: NotionBlock, ctx: ConvertCtx): string {
  const data = payload(block, 'table');
  const rows = childrenOf(block, data).filter((row) => row.type === 'table_row');
  const header = data.has_column_header === true;
  const bodyRows = header ? rows.slice(1) : rows;
  const head = header && rows[0] ? `<thead>${renderTableRow(rows[0], ctx, true)}</thead>` : '';
  const body = bodyRows.length > 0
    ? `<tbody>${bodyRows.map((row) => renderTableRow(row, ctx, false)).join('')}</tbody>`
    : '';
  return `<table>${head}${body}</table>`;
}

function renderTableRow(row: NotionBlock, ctx: ConvertCtx, asHeader: boolean): string {
  const data = payload(row, 'table_row');
  const cells = Array.isArray(data.cells) ? data.cells : [];
  const tag = asHeader ? 'th' : 'td';
  const rendered = cells.map((cell) => {
    const html = renderRichText(asRichArray(cell), ctx);
    return `<${tag}>${html}</${tag}>`;
  }).join('');
  return `<tr>${rendered}</tr>`;
}

function renderImage(block: NotionBlock, ctx: ConvertCtx): string {
  const data = payload(block, 'image');
  const sourceUrl = fileUrlOf(data);
  if (!sourceUrl) {
    skip(block, ctx);
    return '';
  }
  const alt = asRichArray(data.caption).map((rt) => plainOf(rt)).join('');
  const filename = filenameFromUrl(sourceUrl, typeof block.id === 'string' ? block.id : 'image');
  ctx.attachments.push({
    blockId: typeof block.id === 'string' ? block.id : '',
    kind: 'image',
    filename,
    sourceUrl,
    alt,
  });
  const src = buildPageImageUrl({
    source: 'local',
    key: filename,
    pageId: ctx.localPageId,
    pageSource: 'standalone',
  });
  return `<img src="${escapeHtml(src)}" alt="${escapeHtml(alt)}">`;
}

function renderChildPage(block: NotionBlock, ctx: ConvertCtx): string {
  const data = payload(block, 'child_page');
  const title = typeof data.title === 'string' ? data.title : 'Untitled';
  const notionId = typeof block.id === 'string' ? block.id : '';
  const href = resolvePageHref(notionId, undefined, ctx) ?? (notionId ? notionWebUrl(notionId) : '');
  if (!href) return `<p>${escapeHtml(title)}</p>`;
  return `<p><a href="${escapeHtml(href)}">${escapeHtml(title)}</a></p>`;
}

function renderRichText(items: readonly Record<string, unknown>[], ctx: ConvertCtx): string {
  return items.map((item) => renderRichItem(item, ctx)).join('');
}

function renderRichItem(item: Record<string, unknown>, ctx: ConvertCtx): string {
  const type = typeof item.type === 'string' ? item.type : 'text';
  let href: string | null = null;
  const text = plainOf(item);

  if (type === 'mention') {
    const mention = isRecord(item.mention) ? item.mention : {};
    const mentionType = typeof mention.type === 'string' ? mention.type : '';
    if (mentionType === 'page' && isRecord(mention.page) && typeof mention.page.id === 'string') {
      href = resolvePageHref(mention.page.id, stringOrNull(item.href), ctx);
    } else if (mentionType === 'database') {
      href = safeHref(stringOrNull(item.href))
        ?? (isRecord(mention.database) && typeof mention.database.id === 'string'
          ? notionWebUrl(mention.database.id)
          : null);
    } else {
      href = safeHref(stringOrNull(item.href));
    }
  } else {
    const textObj = isRecord(item.text) ? item.text : null;
    const link = textObj && isRecord(textObj.link) ? textObj.link : null;
    const linkUrl = link && typeof link.url === 'string' ? link.url : stringOrNull(item.href);
    href = safeHref(linkUrl);
  }

  let html = escapeHtml(text);
  const annotations = isRecord(item.annotations) ? item.annotations : {};
  if (annotations.code === true) html = `<code>${html}</code>`;
  if (annotations.strikethrough === true) html = `<del>${html}</del>`;
  if (annotations.italic === true) html = `<em>${html}</em>`;
  if (annotations.bold === true) html = `<strong>${html}</strong>`;
  if (href) html = `<a href="${escapeHtml(href)}">${html}</a>`;
  return html;
}

function resolvePageHref(notionId: string, fallbackHref: string | null | undefined, ctx: ConvertCtx): string | null {
  const localId = ctx.importedPages.get(normalizeNotionId(notionId));
  if (typeof localId === 'number') return `/pages/${localId}`;
  return safeHref(fallbackHref) ?? (notionId ? notionWebUrl(notionId) : null);
}

function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  const trimmed = url.trim();
  if (trimmed.startsWith('/pages/')) return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
  } catch {
    return null;
  }
  return null;
}

function fileUrlOf(data: Record<string, unknown>): string | null {
  if (data.type === 'external' && isRecord(data.external) && typeof data.external.url === 'string') {
    return data.external.url;
  }
  if (isRecord(data.file) && typeof data.file.url === 'string') {
    return data.file.url;
  }
  if (isRecord(data.external) && typeof data.external.url === 'string') {
    return data.external.url;
  }
  return null;
}

function filenameFromUrl(sourceUrl: string, fallbackId: string): string {
  let candidate = '';
  try {
    const parsed = new URL(sourceUrl);
    candidate = path.basename(parsed.pathname);
  } catch {
    candidate = '';
  }
  if (canStoreLocalFilename(candidate)) return candidate;
  const safe = `notion-${fallbackId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || 'image'}.png`;
  return canStoreLocalFilename(safe) ? safe : 'notion-image.png';
}

function asRichArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => isRecord(item));
}

function plainOf(item: Record<string, unknown>): string {
  if (typeof item.plain_text === 'string') return item.plain_text;
  const text = isRecord(item.text) && typeof item.text.content === 'string' ? item.text.content : '';
  return text;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
