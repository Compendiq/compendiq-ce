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
  'child_database',
  'equation',
  'link_to_page',
]);

/** Layout wrappers whose nested supported blocks must still import. */
const TRANSPARENT_TYPES = new Set([
  'column_list',
  'column',
  'toggle',
  'synced_block',
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

export interface WikiMetadataInput {
  status?: string | null;
  author?: string | null;
  verifiedAt?: Date | null;
  tags?: string[];
  customProperties?: Record<string, string>;
}

export function formatWikiMetadataCallout(meta: WikiMetadataInput): string {
  const items: string[] = [];
  if (meta.status) {
    items.push(`<strong>Status:</strong> ${escapeHtml(meta.status)}`);
  }
  if (meta.author) {
    items.push(`<strong>Owner:</strong> ${escapeHtml(meta.author)}`);
  }
  if (meta.verifiedAt) {
    const d = meta.verifiedAt instanceof Date ? meta.verifiedAt.toISOString().slice(0, 10) : String(meta.verifiedAt);
    items.push(`<strong>Verified:</strong> ${escapeHtml(d)}`);
  }
  if (meta.tags && meta.tags.length > 0) {
    items.push(`<strong>Tags:</strong> ${escapeHtml(meta.tags.join(', '))}`);
  }
  if (meta.customProperties) {
    for (const [k, v] of Object.entries(meta.customProperties)) {
      if (v) {
        items.push(`<strong>${escapeHtml(k)}:</strong> ${escapeHtml(v)}`);
      }
    }
  }
  if (items.length === 0) return '';
  return `<div data-type="callout" class="notion-wiki-metadata"><p>${items.join(' &nbsp;|&nbsp; ')}</p></div>`;
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
  if (TRANSPARENT_TYPES.has(type)) {
    return renderTransparent(block, ctx);
  }
  if (!SUPPORTED_TYPES.has(type)) {
    skip(block, ctx);
    return '';
  }
  switch (type) {
    case 'heading_1':
      return wrapRich('h1', block, ctx);
    case 'heading_2':
      return wrapRich('h2', block, ctx);
    case 'heading_3':
      return wrapRich('h3', block, ctx);
    case 'heading_4':
      return wrapRich('h4', block, ctx);
    case 'paragraph':
      return wrapRich('p', block, ctx);
    case 'quote': {
      const data = payload(block, type);
      const inner = renderRichText(asRichArray(data.rich_text), ctx);
      const nested = convertSequence(childrenOf(block, data), ctx);
      const p = inner ? `<p>${inner}</p>` : '';
      return `<blockquote>${p}${nested}</blockquote>`;
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
    case 'child_database':
      return renderChildDatabase(block, ctx);
    case 'equation':
      return renderEquation(payload(block, type));
    case 'link_to_page':
      return renderLinkToPage(block, ctx);
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

function wrapRich(tag: string, block: NotionBlock, ctx: ConvertCtx): string {
  const data = payload(block, block.type);
  const html = renderRichText(asRichArray(data.rich_text), ctx);
  const nested = convertSequence(childrenOf(block, data), ctx);
  if (!html && tag === 'p') return nested;
  return `<${tag}>${html}</${tag}>${nested}`;
}

function renderTransparent(block: NotionBlock, ctx: ConvertCtx): string {
  const data = payload(block, block.type);
  const kids = childrenOf(block, data);
  if (block.type === 'toggle') {
    const title = renderRichText(asRichArray(data.rich_text), ctx);
    return (title ? `<p>${title}</p>` : '') + convertSequence(kids, ctx);
  }
  if (block.type === 'synced_block' && kids.length === 0) {
    skip(block, ctx);
    return '';
  }
  return convertSequence(kids, ctx);
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
  const icon = extractIcon(data.icon);
  const iconHtml = icon ? `<span class="callout-icon">${escapeHtml(icon)}</span>` : '';
  const text = renderRichText(asRichArray(data.rich_text), ctx);
  const nested = convertSequence(childrenOf(block, data), ctx);
  const inner = text ? `<p>${text}</p>` : '';
  return `<div class="${cls}" data-type="callout">${iconHtml}${inner}${nested}</div>`;
}

function extractIcon(iconObj: unknown): string {
  if (!iconObj || typeof iconObj !== 'object') return '';
  const icon = iconObj as Record<string, unknown>;
  if (icon.type === 'emoji' && typeof icon.emoji === 'string') return icon.emoji;
  return '';
}

function renderEquation(data: Record<string, unknown>): string {
  const expr = typeof data.expression === 'string' ? data.expression : '';
  return `<pre class="math-block"><code class="language-math">${escapeHtml(expr)}</code></pre>`;
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
  const sourceUrl = safeHref(fileUrlOf(data));
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

/**
 * Rows × properties as an HTML table. Shared by the inline `child_database`
 * block renderer and the top-level database import (`table` mode), so a
 * database nested in a page and one flattened on its own produce the same
 * markup.
 */
export function renderDatabaseTable(input: {
  columns: readonly string[];
  rows: readonly Record<string, unknown>[];
  title?: string;
}): string {
  if (input.rows.length === 0) return '';

  const rawTitle = typeof input.title === 'string' ? input.title.trim() : '';
  const title = rawTitle === 'New database' || rawTitle === 'Untitled' ? '' : rawTitle;
  const heading = title ? `<h3>${escapeHtml(title)}</h3>` : '';

  const propKeys: string[] =
    input.columns.length > 0
      ? [...input.columns]
      : Array.from(
          new Set(
            input.rows.flatMap((r) =>
              isRecord(r) && isRecord(r.properties) ? Object.keys(r.properties) : [],
            ),
          ),
        );

  propKeys.sort((a, b) => {
    const aLower = a.toLowerCase();
    const bLower = b.toLowerCase();
    const aIsPrimary = aLower === 'name' || aLower === 'title' || aLower === 'command';
    const bIsPrimary = bLower === 'name' || bLower === 'title' || bLower === 'command';
    if (aIsPrimary && !bIsPrimary) return -1;
    if (!aIsPrimary && bIsPrimary) return 1;
    return a.localeCompare(b);
  });

  const headerRow = propKeys.map((col) => `<th>${escapeHtml(col)}</th>`).join('');
  const thead = headerRow ? `<thead><tr>${headerRow}</tr></thead>` : '';

  const bodyRows = input.rows
    .map((row) => {
      const props = isRecord(row) && isRecord(row.properties) ? row.properties : {};
      const cells = propKeys
        .map((col) => `<td>${escapeHtml(extractPropertyText(props[col]))}</td>`)
        .join('');
      return `<tr>${cells}</tr>`;
    })
    .join('');

  return `${heading}<table>${thead}<tbody>${bodyRows}</tbody></table>`;
}

function renderChildDatabase(block: NotionBlock, ctx: ConvertCtx): string {
  const rows = Array.isArray(block.databaseRows) ? block.databaseRows : [];
  if (rows.length === 0) {
    skip(block, ctx);
    return '';
  }

  const data = payload(block, 'child_database');
  const rawTitle = typeof data.title === 'string' && data.title.trim()
    ? data.title.trim()
    : (typeof block.title === 'string' && block.title.trim() ? block.title.trim() : '');

  return renderDatabaseTable({
    columns: Array.isArray(block.databaseColumns) ? (block.databaseColumns as string[]) : [],
    rows: rows as Record<string, unknown>[],
    title: rawTitle,
  });
}

export function extractPropertyText(prop: unknown): string {
  if (!prop || typeof prop !== 'object') return '';
  const p = prop as Record<string, unknown>;
  const propType = typeof p.type === 'string' ? p.type : '';

  if (propType === 'title' && Array.isArray(p.title)) {
    return plainOfRichArray(p.title);
  }
  if (propType === 'rich_text' && Array.isArray(p.rich_text)) {
    return plainOfRichArray(p.rich_text);
  }
  if (propType === 'number' && typeof p.number === 'number') {
    return String(p.number);
  }
  if (propType === 'select' && isRecord(p.select) && typeof p.select.name === 'string') {
    return p.select.name;
  }
  if (propType === 'multi_select' && Array.isArray(p.multi_select)) {
    return p.multi_select
      .map((item) => (isRecord(item) && typeof item.name === 'string' ? item.name : ''))
      .filter(Boolean)
      .join(', ');
  }
  if (propType === 'status' && isRecord(p.status) && typeof p.status.name === 'string') {
    return p.status.name;
  }
  if (propType === 'checkbox' && typeof p.checkbox === 'boolean') {
    return p.checkbox ? '✓' : '';
  }
  if (propType === 'url' && typeof p.url === 'string') {
    return p.url;
  }
  if (propType === 'email' && typeof p.email === 'string') {
    return p.email;
  }
  if (propType === 'phone_number' && typeof p.phone_number === 'string') {
    return p.phone_number;
  }
  if (propType === 'date' && isRecord(p.date) && typeof p.date.start === 'string') {
    return p.date.start;
  }
  if (propType === 'formula' && isRecord(p.formula)) {
    return formulaOrRollupPlain(p.formula);
  }
  if (propType === 'rollup' && isRecord(p.rollup)) {
    return formulaOrRollupPlain(p.rollup);
  }
  if (propType === 'files' && Array.isArray(p.files)) {
    return p.files
      .map((item) => (isRecord(item) && typeof item.name === 'string' ? item.name : ''))
      .filter(Boolean)
      .join(', ');
  }
  if (propType === 'people' && Array.isArray(p.people)) {
    return p.people
      .map((item) => (isRecord(item) && typeof item.name === 'string' ? item.name : ''))
      .filter(Boolean)
      .join(', ');
  }
  if (propType === 'created_by' && isRecord(p.created_by) && typeof p.created_by.name === 'string') {
    return p.created_by.name;
  }
  if (propType === 'last_edited_by' && isRecord(p.last_edited_by) && typeof p.last_edited_by.name === 'string') {
    return p.last_edited_by.name;
  }
  if (propType === 'created_time' && typeof p.created_time === 'string') {
    return p.created_time.slice(0, 10);
  }
  if (propType === 'last_edited_time' && typeof p.last_edited_time === 'string') {
    return p.last_edited_time.slice(0, 10);
  }
  if (propType === 'relation' && Array.isArray(p.relation)) {
    const n = p.relation.length;
    if (n === 0) return '';
    return n === 1 ? '1 linked page' : `${n} linked pages`;
  }
  if (propType === 'unique_id' && isRecord(p.unique_id)) {
    const prefix = typeof p.unique_id.prefix === 'string' ? p.unique_id.prefix : '';
    const number = typeof p.unique_id.number === 'number' ? String(p.unique_id.number) : '';
    return [prefix, number].filter(Boolean).join('-');
  }

  return '';
}

function formulaOrRollupPlain(value: Record<string, unknown>): string {
  const kind = typeof value.type === 'string' ? value.type : '';
  if (kind === 'string' && typeof value.string === 'string') return value.string;
  if (kind === 'number' && typeof value.number === 'number') return String(value.number);
  if (kind === 'boolean' && typeof value.boolean === 'boolean') return value.boolean ? 'Yes' : 'No';
  if (kind === 'date' && isRecord(value.date) && typeof value.date.start === 'string') {
    return value.date.start.slice(0, 10);
  }
  if (kind === 'array' && Array.isArray(value.array)) {
    return value.array.map((item) => extractPropertyText(item)).filter(Boolean).join(', ');
  }
  return '';
}

function plainOfRichArray(richTexts: unknown[]): string {
  return richTexts
    .map((rt) => {
      if (isRecord(rt) && typeof rt.plain_text === 'string') return rt.plain_text;
      return '';
    })
    .join('');
}

function renderLinkToPage(block: NotionBlock, ctx: ConvertCtx): string {
  const data = payload(block, 'link_to_page');
  const kind = typeof data.type === 'string' ? data.type : '';
  if (kind === 'page_id' && typeof data.page_id === 'string') {
    const href = resolvePageHref(data.page_id, undefined, ctx);
    const label = 'Untitled';
    if (!href) return `<p>${label}</p>`;
    return `<p><a href="${escapeHtml(href)}">${label}</a></p>`;
  }
  if (kind === 'database_id' && typeof data.database_id === 'string') {
    return `<p><a href="${escapeHtml(notionWebUrl(data.database_id))}">Untitled</a></p>`;
  }
  skip(block, ctx);
  return '';
}

function renderRichText(items: readonly Record<string, unknown>[], ctx: ConvertCtx): string {
  return items.map((item) => renderRichItem(item, ctx)).join('');
}

function renderRichItem(item: Record<string, unknown>, ctx: ConvertCtx): string {
  const type = typeof item.type === 'string' ? item.type : 'text';
  if (type === 'equation') {
    const expr = isRecord(item.equation) && typeof item.equation.expression === 'string'
      ? item.equation.expression
      : (typeof item.plain_text === 'string' ? item.plain_text : '');
    return `$${escapeHtml(expr)}$`;
  }
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
  try {
    const parsed = new URL(url.trim());
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
  let base = '';
  try {
    base = path.basename(new URL(sourceUrl).pathname);
  } catch {
    base = '';
  }
  const id = normalizeNotionId(fallbackId) || 'image';
  const ext = path.extname(base);
  const candidate = canStoreLocalFilename(base) ? `${id}-${base}` : `${id}${ext || '.png'}`;
  if (canStoreLocalFilename(candidate)) return candidate;
  const fallback = `${id.slice(0, 32)}.png`;
  return canStoreLocalFilename(fallback) ? fallback : 'notion-image.png';
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

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
