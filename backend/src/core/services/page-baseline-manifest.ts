import { createHash } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import fs, { type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import type { PoolClient } from 'pg';
import type { PageSource } from '@compendiq/contracts';
import { getPool, query } from '../db/postgres.js';
import {
  runPageWriteIntentEffect,
  type PageWriteIntent,
} from './page-write-admission.js';
import { userCanAccessPage } from './rbac-service.js';
import {
  BASELINE_STORE_DIRNAME,
  attachmentsRootNow,
  baselineAttemptDirectory,
  baselineMediaPath,
  baselineStoreRoot,
  cachedAttachmentPath,
  getMimeType,
  isStorableAttachmentFilename,
  localStorePath,
  pageIconAttachmentPaths,
} from './attachment-store.js';

export { BASELINE_STORE_DIRNAME };

export interface BaselineAttachment {
  identity: string;
  store: 'local' | 'confluence' | 'icon';
  pageKey: string;
  filename: string;
  size: number;
  mediaType: string;
  sha256: string;
  retainedPath: string;
}

export interface PreparedBaselineManifest {
  baselineId: string;
  pageId: number;
  version: number;
  contentRevision: string;
  manifest: unknown[];
  manifestBytes: Buffer;
  manifestDigest: string;
  attachments: BaselineAttachment[];
  totalBytes: number;
}

export class PageBaselineManifestError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = 'PageBaselineManifestError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/;
const DECIMAL_REVISION = /^(0|[1-9][0-9]*)$/;
const PAGE_KEY = /^[A-Za-z0-9_-]+$/;
const POSITIVE_PAGE_ID = /^[1-9][0-9]*$/;
const HTML_SPACE = /^[\t\n\f\r ]$/;
const DATA_URL = /^data:/i;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/i;
const COPY_BUFFER_BYTES = 64 * 1024;
const DEFAULT_MAX_ATTACHMENTS = 512;
const DEFAULT_MAX_TOTAL_BYTES = 1024 * 1024 * 1024;
const DEFAULT_MIN_FREE_BYTES = 64 * 1024 * 1024;

interface PageRow {
  id: number;
  confluence_id: string | null;
  source: PageSource;
  version: number;
  content_revision: string;
  title: string;
  body_html: string | null;
  body_storage: string | null;
  body_text: string | null;
  labels: string[];
  parent_id: string | null;
  icon_kind: string | null;
  icon_value: string | null;
  icon_color: string | null;
  icon_filled: boolean | null;
}

interface ParentRow {
  id: number;
  confluence_id: string | null;
  source: PageSource;
}

type StoredMediaStore = 'local' | 'confluence';

interface MediaSource {
  store: BaselineAttachment['store'];
  pageKey: string;
  filename: string;
  sourcePath: string;
  expectedSize?: number;
  expectedSha256?: string;
  frozenOwnerId?: number;
  frozenBaselineId?: string;
  frozenRetainedPath?: string;
}

interface StoredMediaSource extends MediaSource {
  store: StoredMediaStore;
}

interface FileFingerprint {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
}

interface CleanupRow {
  status: string;
  published_at: Date | null;
  attachments: unknown;
  preparation_intent_id: string;
  page_reference: boolean;
  history_reference: boolean;
  intent_status: string;
  intent_runtime_id: string;
  intent_kind: string;
  intent_page_ids: number[];
  intent_revisions: unknown;
  recovery_mode: string;
  effect_class: string | null;
  effect_baseline_id: string | null;
  effect_started_at: Date | null;
  recovery_to_runtime_id: string | null;
  fenced_at: Date | null;
  quiesced_at: Date | null;
  quiescence_ack: string | null;
  current_transaction_write: boolean;
}

interface InspectedAttachmentSource {
  source: MediaSource;
  size: number;
  sha256: string;
  fingerprint: FileFingerprint;
  attachment: BaselineAttachment;
}

interface InspectionState {
  baselineId: string;
  pageId: number;
  manifestDigest: string;
  totalBytes: number;
  sourcePageIds: readonly number[];
  inspected: readonly InspectedAttachmentSource[];
  actorId: string;
}

interface RetainAuthorizationRow {
  page_id: number | null;
  status: string;
  manifest_digest: string;
  total_bytes: string;
  reserved_bytes: string;
  preparation_intent_id: string;
  attachments: unknown;
  intent_status: string;
  intent_runtime_id: string;
  effect_class: string | null;
}

const inspectionStates = new WeakMap<PreparedBaselineManifest, InspectionState>();

const MEDIA_URL_ATTRIBUTES: Record<string, readonly string[]> = {
  audio: ['src'],
  embed: ['src'],
  image: ['href', 'xlink:href'],
  img: ['src', 'srcset'],
  input: ['src'],
  object: ['data'],
  source: ['src', 'srcset'],
  track: ['src'],
  video: ['src', 'poster'],
};

function configuredLimit(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^[1-9][0-9]*$/.test(raw)) {
    throw new PageBaselineManifestError(503, 'baseline_storage_unavailable', `${name} must be a positive integer`);
  }
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed)) {
    throw new PageBaselineManifestError(503, 'baseline_storage_unavailable', `${name} is outside the safe integer range`);
  }
  return parsed;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (i + 1 >= value.length) return true;
      const next = value.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertJsonArrayValue(value: unknown, activeArrays: Set<unknown[]>): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (hasUnpairedSurrogate(value)) {
      throw new PageBaselineManifestError(
        409,
        'baseline_manifest_invalid',
        'Baseline text contains an unpaired UTF-16 surrogate',
      );
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new PageBaselineManifestError(
        409,
        'baseline_manifest_invalid',
        'Baseline manifest numbers must be safe integers',
      );
    }
    return;
  }
  if (!Array.isArray(value)) {
    throw new PageBaselineManifestError(
      409,
      'baseline_manifest_invalid',
      'Baseline manifest values must use fixed arrays, not objects',
    );
  }
  if (activeArrays.has(value)) {
    throw new PageBaselineManifestError(409, 'baseline_manifest_invalid', 'Baseline manifest contains a cycle');
  }
  activeArrays.add(value);
  for (const member of value) assertJsonArrayValue(member, activeArrays);
  activeArrays.delete(value);
}

/**
 * Canonical manifest encoding is one fixed array tree:
 *
 * `['compendiq.article-baseline', 1, baselineId, pageIdentity, version,
 * contentRevision, title, bodyHtml, bodyStorage, bodyText, labels,
 * parentIdentity, icon, attachments]`.
 *
 * Nested v1 arrays are exact:
 * - page identity: `['page', source, decimalInternalId, confluenceId|null]`;
 * - parent identity: `null` or
 *   `['parent', source, decimalInternalId, confluenceId|null, storedParentKey]`;
 * - icon: `null` only when every raw field is null, otherwise
 *   `['icon', rawKind|null, rawValue|null, rawColor|null, rawFilled|null]`;
 * - attachment: `[identity, store, pageKey, filename, safeIntegerSize,
 *   mediaType, sha256]`.
 *
 * Labels and attachment identities are sorted by their UTF-8 bytes. The
 * attachment identity is SHA-256 of this encoder applied to
 * `[store,pageKey,filename]`; retained paths are deliberately outside the
 * signed byte identity. Encoding is JSON.stringify exactly once, then UTF-8
 * with no BOM and no trailing newline. Objects, non-integer numbers and
 * malformed UTF-16 are refused instead of being normalised.
 */
export function encodeBaselineManifest(manifest: unknown[]): Buffer {
  if (!Array.isArray(manifest)) {
    throw new PageBaselineManifestError(409, 'baseline_manifest_invalid', 'Baseline manifest must be an array');
  }
  assertJsonArrayValue(manifest, new Set());
  return Buffer.from(JSON.stringify(manifest), 'utf8');
}

function utf8Compare(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function pageIdentity(row: Pick<PageRow | ParentRow, 'id' | 'source' | 'confluence_id'>): unknown[] {
  return ['page', row.source, String(row.id), row.confluence_id];
}

function parentStoredKey(row: ParentRow): string {
  return row.source === 'confluence' && row.confluence_id ? row.confluence_id : String(row.id);
}

function decodeUrlSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new PageBaselineManifestError(
      409,
      'baseline_media_unreadable',
      'An attachment URL contains malformed percent encoding',
    );
  }
}

function mediaIdentity(store: BaselineAttachment['store'], pageKey: string, filename: string): string {
  const framed = encodeBaselineManifest([store, pageKey, filename]);
  return createHash('sha256').update(framed).digest('hex');
}

function mediaSource(store: StoredMediaStore, pageKey: string, filename: string): StoredMediaSource {
  if (hasUnpairedSurrogate(pageKey) || hasUnpairedSurrogate(filename)) {
    throw new PageBaselineManifestError(
      409,
      'baseline_manifest_invalid',
      'An attachment identity contains malformed Unicode',
    );
  }
  try {
    if (!isStorableAttachmentFilename(filename) || path.basename(filename) !== filename) {
      throw new Error('Invalid attachment filename');
    }
    if (store === 'local') {
      if (!POSITIVE_PAGE_ID.test(pageKey)) throw new Error('Invalid local page key');
      const pageId = Number(pageKey);
      if (!Number.isSafeInteger(pageId)) throw new Error('Invalid local page key');
      return { store, pageKey, filename, sourcePath: localStorePath(pageId, filename) };
    }
    if (!PAGE_KEY.test(pageKey)) throw new Error('Invalid Confluence attachment key');
    return { store, pageKey, filename, sourcePath: cachedAttachmentPath(pageKey, filename) };
  } catch {
    throw new PageBaselineManifestError(
      409,
      'baseline_media_unreadable',
      `Attachment reference ${store}/${pageKey}/${filename} is not a safe stored path`,
    );
  }
}

function parseInternalAttachmentUrl(value: string): StoredMediaSource | null {
  const prefixes = [
    { marker: '/api/local-attachments/', store: 'local' as const },
    { marker: '/api/attachments/', store: 'confluence' as const },
  ];
  for (const { marker, store } of prefixes) {
    if (!value.startsWith(marker)) continue;
    const tail = value.slice(marker.length).split(/[?#]/, 1)[0]!;
    const segments = tail.split('/');
    if (segments.length !== 2 || !segments[0] || !segments[1]) {
      throw new PageBaselineManifestError(
        409,
        'baseline_media_unreadable',
        `Attachment URL is not a direct stored file: ${value}`,
      );
    }
    return mediaSource(store, decodeUrlSegment(segments[0]), decodeUrlSegment(segments[1]));
  }
  return null;
}

function isPinnedInlineMedia(value: string): boolean {
  return DATA_URL.test(value) || value === '';
}

interface SrcsetUrl {
  start: number;
  end: number;
  value: string;
}

/**
 * Extracts only URL tokens using the HTML srcset candidate algorithm's
 * delimiter rules. In particular, commas inside a non-whitespace URL token
 * belong to that URL (as in data URLs); only trailing URL commas or commas
 * after descriptors delimit candidates.
 */
function parseSrcsetUrls(value: string): SrcsetUrl[] {
  const urls: SrcsetUrl[] = [];
  let position = 0;
  while (position < value.length) {
    while (position < value.length && (HTML_SPACE.test(value[position]!) || value[position] === ',')) {
      position += 1;
    }
    if (position >= value.length) break;

    const start = position;
    while (position < value.length && !HTML_SPACE.test(value[position]!)) position += 1;
    let end = position;
    while (end > start && value[end - 1] === ',') end -= 1;
    if (end > start) urls.push({ start, end, value: value.slice(start, end) });

    // A trailing comma ended a descriptor-less candidate. Otherwise consume
    // descriptors until a comma outside parentheses ends this candidate.
    if (end !== position) continue;
    let parentheses = 0;
    while (position < value.length) {
      const character = value[position]!;
      if (character === '(') parentheses += 1;
      else if (character === ')' && parentheses > 0) parentheses -= 1;
      position += 1;
      if (character === ',' && parentheses === 0) break;
    }
  }
  return urls;
}

function mediaAttributeValues(tagName: string, attribute: string, value: string): string[] {
  if (attribute === 'srcset' && (tagName === 'img' || tagName === 'source')) {
    return parseSrcsetUrls(value).map((candidate) => candidate.value);
  }
  return [value];
}

function addMediaSource(into: Map<string, MediaSource>, source: MediaSource): void {
  const identity = mediaIdentity(source.store, source.pageKey, source.filename);
  if (!into.has(identity)) into.set(identity, source);
}

function collectMediaSources(page: PageRow): MediaSource[] {
  const document = new JSDOM(page.body_html ?? '').window.document;
  const sources = new Map<string, MediaSource>();

  for (const element of document.querySelectorAll('*')) {
    const tagName = element.tagName.toLowerCase();
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name === 'srcset' && (tagName === 'img' || tagName === 'source')) {
        for (const candidate of mediaAttributeValues(tagName, attribute.name, attribute.value)) {
          if (isPinnedInlineMedia(candidate)) continue;
          const internal = parseInternalAttachmentUrl(candidate);
          if (internal) addMediaSource(sources, internal);
        }
        continue;
      }
      if (!isPinnedInlineMedia(attribute.value)) {
        const internal = parseInternalAttachmentUrl(attribute.value);
        if (internal) addMediaSource(sources, internal);
      }
    }
    if (tagName === 'a') {
      const href = element.getAttribute('href');
      if (href?.startsWith('#confluence-attachment:')) {
        const filename = decodeUrlSegment(href.slice('#confluence-attachment:'.length));
        const pageKey = page.source === 'confluence' && page.confluence_id
          ? page.confluence_id
          : String(page.id);
        addMediaSource(sources, mediaSource('confluence', pageKey, filename));
      }
    }

    const mediaAttributes = MEDIA_URL_ATTRIBUTES[tagName] ?? [];
    if (tagName === 'input' && element.getAttribute('type')?.toLowerCase() !== 'image') continue;
    for (const attribute of mediaAttributes) {
      const raw = element.getAttribute(attribute);
      if (raw === null) continue;
      for (const candidate of mediaAttributeValues(tagName, attribute, raw)) {
        if (isPinnedInlineMedia(candidate) || parseInternalAttachmentUrl(candidate)) continue;
        if (candidate.startsWith('#confluence-attachment:')) {
          const filename = decodeUrlSegment(candidate.slice('#confluence-attachment:'.length));
          const pageKey = page.source === 'confluence' && page.confluence_id
            ? page.confluence_id
            : String(page.id);
          addMediaSource(sources, mediaSource('confluence', pageKey, filename));
          continue;
        }
        if (candidate.startsWith('#')) continue;
        throw new PageBaselineManifestError(
          409,
          'baseline_media_external_unpinned',
          `Media reference is not pinned to the attachment store: ${candidate}`,
        );
      }
    }
  }

  // Storage-format references are dependencies too. A corrupt or partially
  // converted body_html must not make a freeze appear complete by hiding a
  // binary that body_storage still needs for round-trip rendering.
  const storage = new JSDOM(page.body_storage ?? '').window.document;
  const pageKey = page.source === 'confluence' && page.confluence_id
    ? page.confluence_id
    : String(page.id);
  for (const element of storage.querySelectorAll('*')) {
    const attachmentFilename = element.getAttribute('ri:filename');
    if (attachmentFilename !== null) {
      addMediaSource(sources, mediaSource('confluence', pageKey, attachmentFilename));
    }
    if (
      element.tagName.toLowerCase() !== 'ac:structured-macro'
      || element.getAttribute('ac:name') !== 'drawio'
    ) {
      continue;
    }
    const diagramName = Array.from(element.getElementsByTagName('ac:parameter'))
      .find((parameter) => parameter.getAttribute('ac:name') === 'diagramName')
      ?.textContent?.trim();
    if (!diagramName) {
      throw new PageBaselineManifestError(
        409,
        'baseline_media_missing',
        'A Draw.io diagram has no stored diagram name',
      );
    }
    addMediaSource(sources, mediaSource('confluence', pageKey, `${diagramName}.png`));
    addMediaSource(sources, mediaSource('confluence', pageKey, `${diagramName}.drawio`));
  }

  for (const diagram of document.querySelectorAll('.confluence-drawio')) {
    const image = diagram.querySelector('img');

    const rendered = image ? parseInternalAttachmentUrl(image.getAttribute('src') ?? '') : null;
    if (!rendered) {
      throw new PageBaselineManifestError(
        409,
        'baseline_media_missing',
        'A Draw.io diagram has no stored rendered attachment',
      );
    }
    const xmlFilename = rendered.filename.toLowerCase().endsWith('.png')
      ? `${rendered.filename.slice(0, -4)}.drawio`
      : `${rendered.filename}.drawio`;
    addMediaSource(sources, mediaSource(rendered.store, rendered.pageKey, xmlFilename));
  }

  return [...sources.values()];
}

/**
 * Produces the rendering-only frozen HTML variant. The authored body and its
 * signed manifest bytes remain untouched. Every URL is selected by the same
 * parser and framed identity used by capture, then scoped to the page whose
 * frozen snapshot the caller has authorized. Legacy hash references are
 * resolved only in the exact Confluence-store namespace persisted in the
 * baseline page identity.
 */
export function renderBaselineBodyHtml(
  html: string,
  pageId: number,
  baselineId: string,
  attachments: readonly BaselineAttachment[],
  legacyAttachmentPageKey: string,
): string {
  if (
    !Number.isSafeInteger(pageId)
    || pageId <= 0
    || !UUID.test(baselineId)
    || !PAGE_KEY.test(legacyAttachmentPageKey)
    || hasUnpairedSurrogate(legacyAttachmentPageKey)
  ) {
    throw new PageBaselineManifestError(409, 'baseline_manifest_invalid', 'Frozen media route identity is invalid');
  }
  const inventory = new Map<string, BaselineAttachment>();
  for (const attachment of attachments) {
    const expectedIdentity = mediaIdentity(attachment.store, attachment.pageKey, attachment.filename);
    if (attachment.identity !== expectedIdentity || inventory.has(attachment.identity)) {
      throw new PageBaselineManifestError(
        503,
        'baseline_storage_unavailable',
        'Frozen media inventory identity is invalid',
      );
    }
    inventory.set(attachment.identity, attachment);
  }
  const document = new JSDOM(html).window.document;
  const routeFor = (source: MediaSource): string => {
    const identity = mediaIdentity(source.store, source.pageKey, source.filename);
    if (!inventory.has(identity)) {
      throw new PageBaselineManifestError(
        503,
        'baseline_storage_unavailable',
        'Frozen body references media outside its retained inventory',
      );
    }
    return `/api/pages/${pageId}/baselines/${baselineId}/media/${identity}`;
  };
  const hashSource = (value: string): StoredMediaSource | null => {
    if (!value.startsWith('#confluence-attachment:')) return null;
    const filename = decodeUrlSegment(value.slice('#confluence-attachment:'.length));
    const source = mediaSource('confluence', legacyAttachmentPageKey, filename);
    const identity = mediaIdentity(source.store, source.pageKey, source.filename);
    if (!inventory.has(identity)) {
      throw new PageBaselineManifestError(
        503,
        'baseline_storage_unavailable',
        'Frozen Confluence attachment reference is not retained for its original page',
      );
    }
    return source;
  };

  for (const element of document.querySelectorAll('*')) {
    const tagName = element.tagName.toLowerCase();
    const mediaAttributes = MEDIA_URL_ATTRIBUTES[tagName] ?? [];
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name === 'srcset' && (tagName === 'img' || tagName === 'source')) {
        const candidates = parseSrcsetUrls(attribute.value);
        let cursor = 0;
        let rewritten = '';
        let changed = false;
        for (const candidate of candidates) {
          const source = isPinnedInlineMedia(candidate.value)
            ? null
            : parseInternalAttachmentUrl(candidate.value)
              ?? (mediaAttributes.includes(attribute.name) ? hashSource(candidate.value) : null);
          if (!source) continue;
          rewritten += attribute.value.slice(cursor, candidate.start);
          rewritten += routeFor(source);
          cursor = candidate.end;
          changed = true;
        }
        if (changed) {
          rewritten += attribute.value.slice(cursor);
          element.setAttribute(attribute.name, rewritten);
        }
        continue;
      }
      const source = isPinnedInlineMedia(attribute.value)
        ? null
        : parseInternalAttachmentUrl(attribute.value)
          ?? (
            (tagName === 'a' && attribute.name === 'href')
            || mediaAttributes.includes(attribute.name)
              ? hashSource(attribute.value)
              : null
          );
      if (source) element.setAttribute(attribute.name, routeFor(source));
    }
  }
  return document.body.innerHTML;
}

async function bindFrozenMediaSource(
  client: PoolClient,
  source: MediaSource,
  ownerId: number,
  baselineId: string,
): Promise<void> {
  const baseline = await client.query<{ attachments: unknown }>(
    `SELECT attachments
       FROM page_baselines
      WHERE id = $1
        AND status = 'published'`,
    [baselineId],
  );
  if (baseline.rows.length !== 1) {
    throw new PageBaselineManifestError(
      503,
      'baseline_storage_unavailable',
      'Referenced frozen media evidence is unavailable',
    );
  }
  const matches = parseCleanupAttachments(baselineId, baseline.rows[0]!.attachments)
    .filter((attachment) =>
      attachment.store === source.store
      && attachment.pageKey === source.pageKey
      && attachment.filename === source.filename);
  if (matches.length !== 1) {
    throw new PageBaselineManifestError(
      409,
      'baseline_media_missing',
      'Referenced media is not present in the foreign page baseline',
    );
  }
  const retained = matches[0]!;
  source.sourcePath = retainedAbsolutePath(baselineId, retained);
  source.expectedSize = retained.size;
  source.frozenOwnerId = ownerId;
  source.frozenBaselineId = baselineId;
  source.frozenRetainedPath = retained.retainedPath;
  source.expectedSha256 = retained.sha256;
}

async function assertMediaSourcesAccessible(
  client: PoolClient,
  page: PageRow,
  actorId: string,
  sources: readonly MediaSource[],
): Promise<number[]> {
  const owners = new Map<string, { id: number; baselineId: string | null }>();
  const ownerPageIds = new Set<number>([page.id]);
  for (const source of sources) {
    if (source.store === 'icon') continue;
    const scopeKey = `${source.store}\0${source.pageKey}`;
    let owner = owners.get(scopeKey);
    if (owner === undefined) {
      if (source.store === 'local') {
        if (!POSITIVE_PAGE_ID.test(source.pageKey)) {
          throw new PageBaselineManifestError(
            403,
            'baseline_media_scope_denied',
            'Referenced media owner could not be authorized',
          );
        }
        const result = await client.query<{ id: number; baseline_id: string | null }>(
          `SELECT id, baseline_id
             FROM pages
            WHERE id::text = $1
              AND source = 'standalone'`,
          [source.pageKey],
        );
        if (result.rows.length !== 1) {
          throw new PageBaselineManifestError(
            403,
            'baseline_media_scope_denied',
            'Referenced media owner could not be authorized',
          );
        }
        owner = { id: result.rows[0]!.id, baselineId: result.rows[0]!.baseline_id };
      } else {
        const primary = await client.query<{ id: number; baseline_id: string | null }>(
          `SELECT id, baseline_id
             FROM pages
            WHERE confluence_id = $1
            ORDER BY id`,
          [source.pageKey],
        );
        let selected: { id: number; baseline_id: string | null } | undefined;
        if (primary.rows.length > 0) {
          if (primary.rows.length === 1) selected = primary.rows[0];
        } else if (POSITIVE_PAGE_ID.test(source.pageKey)) {
          const fallback = await client.query<{ id: number; baseline_id: string | null }>(
            `SELECT id, baseline_id
               FROM pages
              WHERE id::text = $1
                AND source = 'standalone'`,
            [source.pageKey],
          );
          if (fallback.rows.length === 1) selected = fallback.rows[0];
        }
        if (!selected) {
          throw new PageBaselineManifestError(
            403,
            'baseline_media_scope_denied',
            'Referenced media owner could not be authorized',
          );
        }
        owner = { id: selected.id, baselineId: selected.baseline_id };
      }
      owners.set(scopeKey, owner);
    }
    if (owner.id !== page.id && !(await userCanAccessPage(actorId, owner.id, client))) {
      throw new PageBaselineManifestError(
        403,
        'baseline_media_scope_denied',
        'Referenced media owner could not be authorized',
      );
    }
    if (owner.id !== page.id && owner.baselineId !== null) {
      await bindFrozenMediaSource(client, source, owner.id, owner.baselineId);
    } else {
      ownerPageIds.add(owner.id);
    }
  }
  return [...ownerPageIds].sort((left, right) => left - right);
}

async function resolveIconSource(page: PageRow): Promise<MediaSource | null> {
  if (page.icon_kind !== 'image') return null;
  if (!page.icon_value || !SHA256.test(page.icon_value)) {
    throw new PageBaselineManifestError(409, 'baseline_media_missing', 'Page image icon has no valid byte identity');
  }
  let candidates: string[];
  try {
    candidates = pageIconAttachmentPaths(page.id, page.icon_value);
  } catch {
    throw new PageBaselineManifestError(409, 'baseline_media_unreadable', 'Page image icon path is invalid');
  }
  for (const candidate of candidates) {
    try {
      const stat = await fs.lstat(candidate);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new PageBaselineManifestError(409, 'baseline_media_unreadable', 'Page image icon is not a plain file');
      }
      return {
        store: 'icon',
        pageKey: String(page.id),
        filename: path.basename(candidate),
        sourcePath: candidate,
      };
    } catch (error) {
      if (error instanceof PageBaselineManifestError) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new PageBaselineManifestError(409, 'baseline_media_unreadable', 'Page image icon could not be read');
      }
    }
  }
  throw new PageBaselineManifestError(409, 'baseline_media_missing', 'Page image icon bytes are missing');
}

function fingerprint(stat: BigIntStats): FileFingerprint {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
  };
}

function sameFingerprint(left: FileFingerprint, right: FileFingerprint): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeNs === right.mtimeNs;
}

async function assertRealPathContained(filePath: string, rootPath: string): Promise<void> {
  const [realFile, realRoot] = await Promise.all([fs.realpath(filePath), fs.realpath(rootPath)]);
  if (!realFile.startsWith(realRoot + path.sep)) {
    throw new PageBaselineManifestError(
      409,
      'baseline_media_unreadable',
      'Attachment path escapes the configured attachment store',
    );
  }
}

async function inspectSource(
  source: MediaSource,
): Promise<{ size: number; sha256: string; fingerprint: FileFingerprint }> {
  let handle: FileHandle | undefined;
  try {
    await assertRealPathContained(source.sourcePath, attachmentsRootNow());
    const pathBefore = await fs.lstat(source.sourcePath, { bigint: true });
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
      throw new PageBaselineManifestError(
        409,
        'baseline_media_unreadable',
        `Attachment ${source.filename} is not a plain file`,
      );
    }
    const before = fingerprint(pathBefore);
    handle = await fs.open(source.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fingerprint(await handle.stat({ bigint: true }));
    if (!sameFingerprint(before, opened)) {
      throw new PageBaselineManifestError(
        409,
        'baseline_media_unreadable',
        `Attachment ${source.filename} changed during inspection`,
      );
    }
    const hashed = await hashOpenFile(handle);
    const after = fingerprint(await handle.stat({ bigint: true }));
    const pathAfter = fingerprint(await fs.lstat(source.sourcePath, { bigint: true }));
    if (
      hashed.size !== Number(before.size)
      || !Number.isSafeInteger(hashed.size)
      || !sameFingerprint(before, after)
      || !sameFingerprint(after, pathAfter)
    ) {
      throw new PageBaselineManifestError(
        409,
        'baseline_media_unreadable',
        `Attachment ${source.filename} changed during inspection`,
      );
    }
    if (
      source.expectedSize !== undefined
      && (hashed.size !== source.expectedSize || hashed.sha256 !== source.expectedSha256)
    ) {
      throw new PageBaselineManifestError(
        503,
        'baseline_storage_unavailable',
        'Referenced frozen media evidence failed integrity verification',
      );
    }
    return { ...hashed, fingerprint: before };
  } catch (error) {
    if (error instanceof PageBaselineManifestError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new PageBaselineManifestError(409, 'baseline_media_missing', `Attachment ${source.filename} is missing`);
    }
    throw new PageBaselineManifestError(409, 'baseline_media_unreadable', `Attachment ${source.filename} is unreadable`);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

async function assertDiskCapacity(requiredBytes: number): Promise<void> {
  try {
    const stats = await fs.statfs(baselineStoreRoot(), { bigint: true });
    const free = stats.bavail * stats.bsize;
    const reserve = BigInt(configuredLimit('PAGE_BASELINE_MIN_FREE_BYTES', DEFAULT_MIN_FREE_BYTES));
    if (free < BigInt(requiredBytes) + reserve) {
      throw new PageBaselineManifestError(
        507,
        'baseline_capacity_exceeded',
        'Insufficient free space to retain this baseline without consuming the safety reserve',
      );
    }
  } catch (error) {
    if (error instanceof PageBaselineManifestError) throw error;
    throw new PageBaselineManifestError(503, 'baseline_storage_unavailable', 'Baseline storage capacity could not be read');
  }
}


/**
 * Physical-capacity admission check. The caller MUST hold
 * `page_baseline_capacity`'s singleton row lock and invoke this before adding
 * the new logical reservation. Existing `preparing` bytes are subtracted from
 * current filesystem free space because they may not have been copied yet.
 * Preparations already partly copied are counted both by statfs and their
 * reservation; that deliberate double count is conservative and never
 * under-reserves.
 */
export async function assertBaselineRetentionCapacity(
  client: PoolClient,
  additionalBytes: number,
): Promise<void> {
  if (!Number.isSafeInteger(additionalBytes) || additionalBytes < 0) {
    throw new PageBaselineManifestError(400, 'baseline_media_limit_exceeded', 'Baseline byte reservation is invalid');
  }
  try {
    const root = attachmentsRootNow();
    const rootStat = await fs.lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new PageBaselineManifestError(503, 'baseline_storage_unavailable', 'Attachment storage root is invalid');
    }
    const retainedRoot = baselineStoreRoot();
    if (!retainedRoot.startsWith(root + path.sep)) {
      throw new PageBaselineManifestError(503, 'baseline_storage_unavailable', 'Baseline storage root is invalid');
    }
    try {
      const retainedStat = await fs.lstat(retainedRoot);
      if (retainedStat.isSymbolicLink() || !retainedStat.isDirectory()) {
        throw new PageBaselineManifestError(503, 'baseline_storage_unavailable', 'Baseline storage root is invalid');
      }
      await assertRealPathContained(retainedRoot, root);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }

    const [stats, reserved] = await Promise.all([
      fs.statfs(root, { bigint: true }),
      client.query<{ reserved_bytes: string }>(
        `SELECT COALESCE(SUM(reserved_bytes), 0)::text AS reserved_bytes
           FROM page_baselines
          WHERE status = 'preparing'`,
      ),
    ]);
    const free = stats.bavail * stats.bsize;
    const outstanding = BigInt(reserved.rows[0]?.reserved_bytes ?? '0');
    const reserve = BigInt(configuredLimit('PAGE_BASELINE_MIN_FREE_BYTES', DEFAULT_MIN_FREE_BYTES));
    if (free - outstanding < BigInt(additionalBytes) + reserve) {
      throw new PageBaselineManifestError(
        507,
        'baseline_capacity_exceeded',
        'Insufficient unreserved free space to retain this baseline without consuming the safety reserve',
      );
    }
  } catch (error) {
    if (error instanceof PageBaselineManifestError) throw error;
    throw new PageBaselineManifestError(
      503,
      'baseline_storage_unavailable',
      'Baseline storage capacity could not be read',
    );
  }
}
async function hashOpenFile(handle: FileHandle): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
  let position = 0;
  for (;;) {
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) break;
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
    if (!Number.isSafeInteger(position)) {
      throw new PageBaselineManifestError(413, 'baseline_media_limit_exceeded', 'Attachment is too large');
    }
  }
  return { sha256: hash.digest('hex'), size: position };
}

async function copyAndVerify(
  source: MediaSource,
  expected: { size: number; fingerprint: FileFingerprint },
  baselineId: string,
  attemptId: string,
): Promise<BaselineAttachment> {
  const identity = mediaIdentity(source.store, source.pageKey, source.filename);
  const mediaId = createHash('sha256').update(identity).update('\0').update(source.filename).digest('hex');
  const destination = baselineMediaPath(baselineId, attemptId, mediaId);
  let sourceHandle: FileHandle | undefined;
  let destinationHandle: FileHandle | undefined;
  try {
    let opened: FileFingerprint;
    try {
      sourceHandle = await fs.open(source.sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW);
      opened = fingerprint(await sourceHandle.stat({ bigint: true }));
    } catch (error) {
      const reason = (error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'baseline_media_missing'
        : 'baseline_media_unreadable';
      throw new PageBaselineManifestError(
        409,
        reason,
        `Attachment ${source.filename} could not be opened`,
      );
    }
    if (!sameFingerprint(opened, expected.fingerprint)) {
      throw new PageBaselineManifestError(
        409,
        'baseline_media_unreadable',
        `Attachment ${source.filename} changed during preparation`,
      );
    }

    destinationHandle = await fs.open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let position = 0;
    for (;;) {
      let bytesRead: number;
      try {
        ({ bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position));
      } catch {
        throw new PageBaselineManifestError(
          409,
          'baseline_media_unreadable',
          `Attachment ${source.filename} could not be read`,
        );
      }
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(buffer, written, bytesRead - written, position + written);
        if (result.bytesWritten === 0) {
          throw new PageBaselineManifestError(
            503,
            'baseline_storage_unavailable',
            'Retained attachment write made no progress',
          );
        }
        written += result.bytesWritten;
      }
      position += bytesRead;
      if (position > expected.size) {
        throw new PageBaselineManifestError(
          409,
          'baseline_media_unreadable',
          `Attachment ${source.filename} changed during preparation`,
        );
      }
    }
    await destinationHandle.sync();

    let after: FileFingerprint;
    let pathAfter: FileFingerprint;
    try {
      after = fingerprint(await sourceHandle.stat({ bigint: true }));
      pathAfter = fingerprint(await fs.lstat(source.sourcePath, { bigint: true }));
    } catch {
      throw new PageBaselineManifestError(
        409,
        'baseline_media_unreadable',
        `Attachment ${source.filename} changed during preparation`,
      );
    }
    if (position !== expected.size || !sameFingerprint(opened, after) || !sameFingerprint(after, pathAfter)) {
      throw new PageBaselineManifestError(
        409,
        'baseline_media_unreadable',
        `Attachment ${source.filename} changed during preparation`,
      );
    }
    const sha256 = hash.digest('hex');
    await destinationHandle.close();
    destinationHandle = undefined;
    await sourceHandle.close();
    sourceHandle = undefined;

    const verifyHandle = await fs.open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const retainedStat = await verifyHandle.stat({ bigint: true });
      const verified = await hashOpenFile(verifyHandle);
      if (!retainedStat.isFile() || retainedStat.nlink !== 1n || verified.size !== position || verified.sha256 !== sha256) {
        throw new PageBaselineManifestError(503, 'baseline_storage_unavailable', 'Retained attachment verification failed');
      }
      if (retainedStat.dev === expected.fingerprint.dev && retainedStat.ino === expected.fingerprint.ino) {
        throw new PageBaselineManifestError(503, 'baseline_storage_unavailable', 'Retained attachment must not be a hardlink');
      }
    } finally {
      await verifyHandle.close();
    }

    const relative = path.relative(attachmentsRootNow(), destination).split(path.sep).join('/');
    return {
      identity,
      store: source.store,
      pageKey: source.pageKey,
      filename: source.filename,
      size: position,
      mediaType: getMimeType(source.filename),
      sha256,
      retainedPath: relative,
    };
  } catch (error) {
    if (error instanceof PageBaselineManifestError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOSPC' || code === 'EDQUOT') {
      throw new PageBaselineManifestError(507, 'baseline_capacity_exceeded', 'Baseline storage has insufficient capacity');
    }
    throw new PageBaselineManifestError(
      503,
      'baseline_storage_unavailable',
      `Attachment ${source.filename} could not be retained`,
    );
  } finally {
    const closes: Promise<void>[] = [];
    if (sourceHandle) closes.push(sourceHandle.close());
    if (destinationHandle) closes.push(destinationHandle.close());
    await Promise.allSettled(closes);
  }
}

async function fsyncDirectory(directory: string): Promise<void> {
  let handle: FileHandle | undefined;
  try {
    handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Some supported filesystems do not implement directory fsync. Every
    // retained file has already been fsynced and re-opened for digest
    // verification, which is the publication prerequisite.
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EBADF') {
      throw new PageBaselineManifestError(
        503,
        'baseline_storage_unavailable',
        'Baseline storage metadata could not be synchronized',
      );
    }
  } finally {
    if (handle) await handle.close();
  }
}

async function createExclusiveAttempt(baselineId: string, attemptId: string): Promise<void> {
  const root = attachmentsRootNow();
  try {
    await fs.mkdir(root, { recursive: true, mode: 0o700 });
    const rootStat = await fs.lstat(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error('Invalid attachment root');

    const retainedRoot = baselineStoreRoot();
    await fs.mkdir(retainedRoot, { recursive: true, mode: 0o700 });
    await assertRealPathContained(retainedRoot, root);
    const retainedStat = await fs.lstat(retainedRoot);
    if (retainedStat.isSymbolicLink() || !retainedStat.isDirectory()) throw new Error('Invalid retained root');

    const baselineDirectory = path.dirname(baselineAttemptDirectory(baselineId, attemptId));
    await fs.mkdir(baselineDirectory, { recursive: true, mode: 0o700 });
    const baselineStat = await fs.lstat(baselineDirectory);
    if (baselineStat.isSymbolicLink() || !baselineStat.isDirectory()) throw new Error('Invalid baseline directory');
    await assertRealPathContained(baselineDirectory, retainedRoot);

    const attemptDirectory = baselineAttemptDirectory(baselineId, attemptId);
    await fs.mkdir(attemptDirectory, { recursive: false, mode: 0o700 });
    await fs.mkdir(path.join(attemptDirectory, 'media'), { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOSPC' || (error as NodeJS.ErrnoException).code === 'EDQUOT') {
      throw new PageBaselineManifestError(507, 'baseline_capacity_exceeded', 'Baseline storage has insufficient capacity');
    }
    throw new PageBaselineManifestError(503, 'baseline_storage_unavailable', 'Could not create exclusive baseline storage');
  }
}

function retainedAbsolutePath(baselineId: string, attachment: BaselineAttachment): string {
  const segments = attachment.retainedPath.split('/');
  if (
    segments.length !== 5
    || segments[0] !== BASELINE_STORE_DIRNAME
    || segments[1] !== baselineId
    || !UUID.test(segments[1])
    || !UUID.test(segments[2] ?? '')
    || segments[3] !== 'media'
    || !SHA256.test(segments[4] ?? '')
  ) {
    throw new PageBaselineManifestError(503, 'baseline_storage_unavailable', 'Retained attachment path is invalid');
  }
  const resolved = path.resolve(attachmentsRootNow(), ...segments);
  const expectedPrefix = path.resolve(baselineStoreRoot(), baselineId) + path.sep;
  if (!resolved.startsWith(expectedPrefix)) {
    throw new PageBaselineManifestError(503, 'baseline_storage_unavailable', 'Retained attachment path escaped its baseline');
  }
  return resolved;
}

async function openVerifiedAttachment(
  baselineId: string,
  attachment: BaselineAttachment,
): Promise<FileHandle> {
  const prefix = `${attachment.identity}: `;
  let handle: FileHandle | undefined;
  try {
    if (
      !UUID.test(baselineId)
      || attachment.identity !== mediaIdentity(attachment.store, attachment.pageKey, attachment.filename)
    ) {
      throw new PageBaselineManifestError(503, 'baseline_storage_unavailable', `${prefix}metadata identity mismatch`);
    }
    if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || !SHA256.test(attachment.sha256)) {
      throw new PageBaselineManifestError(503, 'baseline_storage_unavailable', `${prefix}invalid retained metadata`);
    }

    const filePath = retainedAbsolutePath(baselineId, attachment);
    await assertRealPathContained(filePath, baselineStoreRoot());
    const pathBefore = await fs.lstat(filePath, { bigint: true });
    if (pathBefore.isSymbolicLink() || !pathBefore.isFile() || pathBefore.nlink !== 1n) {
      throw new PageBaselineManifestError(
        503,
        'baseline_storage_unavailable',
        `${prefix}retained object is not an exclusive plain file`,
      );
    }

    handle = await fs.open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openedStat = await handle.stat({ bigint: true });
    if (
      !openedStat.isFile()
      || openedStat.nlink !== 1n
      || !sameFingerprint(fingerprint(pathBefore), fingerprint(openedStat))
    ) {
      throw new PageBaselineManifestError(
        503,
        'baseline_storage_unavailable',
        `${prefix}retained object changed while it was opened`,
      );
    }

    const verified = await hashOpenFile(handle);
    const [handleAfter, pathAfter] = await Promise.all([
      handle.stat({ bigint: true }),
      fs.lstat(filePath, { bigint: true }),
    ]);
    if (
      !handleAfter.isFile()
      || handleAfter.nlink !== 1n
      || pathAfter.isSymbolicLink()
      || !pathAfter.isFile()
      || pathAfter.nlink !== 1n
      || !sameFingerprint(fingerprint(openedStat), fingerprint(handleAfter))
      || !sameFingerprint(fingerprint(handleAfter), fingerprint(pathAfter))
    ) {
      throw new PageBaselineManifestError(
        503,
        'baseline_storage_unavailable',
        `${prefix}retained object changed during verification`,
      );
    }
    if (verified.size !== attachment.size) {
      throw new PageBaselineManifestError(503, 'baseline_storage_unavailable', `${prefix}byte length mismatch`);
    }
    if (verified.sha256 !== attachment.sha256) {
      throw new PageBaselineManifestError(503, 'baseline_storage_unavailable', `${prefix}SHA-256 mismatch`);
    }

    const verifiedHandle = handle;
    handle = undefined;
    return verifiedHandle;
  } catch (error) {
    if (error instanceof PageBaselineManifestError) throw error;
    const unavailable = (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'retained object missing'
      : 'retained object unreadable';
    throw new PageBaselineManifestError(503, 'baseline_storage_unavailable', `${prefix}${unavailable}`);
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

async function verifyOneAttachment(baselineId: string, attachment: BaselineAttachment): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await openVerifiedAttachment(baselineId, attachment);
    return null;
  } catch (error) {
    return error instanceof PageBaselineManifestError
      ? error.message
      : `${attachment.identity}: retained object unreadable`;
  } finally {
    if (handle) await handle.close().catch(() => undefined);
  }
}

export async function verifyBaselineAttachments(
  baselineId: string,
  attachments: readonly BaselineAttachment[],
): Promise<{ valid: boolean; failures: string[] }> {
  const failures: string[] = [];
  for (const attachment of attachments) {
    const failure = await verifyOneAttachment(baselineId, attachment);
    if (failure) failures.push(failure);
  }
  return { valid: failures.length === 0, failures };
}

export async function readBaselineAttachment(
  baselineId: string,
  attachment: BaselineAttachment,
): Promise<NodeJS.ReadableStream> {
  const handle = await openVerifiedAttachment(baselineId, attachment);
  try {
    return handle.createReadStream({ autoClose: true, start: 0 });
  } catch (error) {
    await handle.close().catch(() => undefined);
    if (error instanceof PageBaselineManifestError) throw error;
    throw new PageBaselineManifestError(
      503,
      'baseline_storage_unavailable',
      `${attachment.identity}: retained object unreadable`,
    );
  }
}

function parseCleanupAttachments(baselineId: string, value: unknown): BaselineAttachment[] {
  if (!Array.isArray(value)) {
    throw new PageBaselineManifestError(
      503,
      'baseline_storage_unavailable',
      'Abandoned baseline attachment metadata is invalid',
    );
  }
  return value.map((candidate) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new PageBaselineManifestError(
        503,
        'baseline_storage_unavailable',
        'Abandoned baseline attachment metadata is invalid',
      );
    }
    const attachment = candidate as Partial<BaselineAttachment>;
    if (
      !SHA256.test(attachment.identity ?? '')
      || (attachment.store !== 'local' && attachment.store !== 'confluence' && attachment.store !== 'icon')
      || typeof attachment.pageKey !== 'string'
      || typeof attachment.filename !== 'string'
      || attachment.filename.length === 0
      || /[\r\n]/.test(attachment.filename)
      || typeof attachment.size !== 'number'
      || !Number.isSafeInteger(attachment.size)
      || attachment.size < 0
      || typeof attachment.mediaType !== 'string'
      || !MEDIA_TYPE.test(attachment.mediaType)
      || !SHA256.test(attachment.sha256 ?? '')
      || typeof attachment.retainedPath !== 'string'
    ) {
      throw new PageBaselineManifestError(
        503,
        'baseline_storage_unavailable',
        'Abandoned baseline attachment metadata is invalid',
      );
    }
    const validated = attachment as BaselineAttachment;
    if (validated.identity !== mediaIdentity(validated.store, validated.pageKey, validated.filename)) {
      throw new PageBaselineManifestError(
        503,
        'baseline_storage_unavailable',
        'Abandoned baseline attachment identity is invalid',
      );
    }
    retainedAbsolutePath(baselineId, validated);
    return validated;
  });
}

/**
 * Resolves a route identity only from validated persisted inventory. Callers
 * must authorize the owning snapshot before invoking this helper.
 */
export function baselineAttachmentByIdentity(
  baselineId: string,
  value: unknown,
  identity: string,
): BaselineAttachment | null {
  if (!SHA256.test(identity)) return null;
  const matches = parseCleanupAttachments(baselineId, value)
    .filter((attachment) => attachment.identity === identity);
  if (matches.length > 1) {
    throw new PageBaselineManifestError(
      503,
      'baseline_storage_unavailable',
      'Baseline media inventory contains a duplicate identity',
    );
  }
  return matches[0] ?? null;
}

function repairIntentMatches(row: CleanupRow, intent: PageWriteIntent): boolean {
  const pageIds = [...intent.pageIds].sort((left, right) => left - right);
  const storedPageIds = [...row.intent_page_ids].sort((left, right) => left - right);
  if (
    pageIds.length !== storedPageIds.length
    || pageIds.some((pageId, index) => pageId !== storedPageIds[index])
    || typeof row.intent_revisions !== 'object'
    || row.intent_revisions === null
    || Array.isArray(row.intent_revisions)
  ) {
    return false;
  }
  const revisions = row.intent_revisions as Record<string, unknown>;
  if (Object.keys(revisions).length !== pageIds.length) return false;
  return pageIds.every((pageId) => {
    const stored = revisions[String(pageId)];
    const expected = intent.revisions[pageId];
    return typeof stored === 'object'
      && stored !== null
      && !Array.isArray(stored)
      && expected !== undefined
      && String((stored as Record<string, unknown>).contentRevision) === expected.contentRevision
      && String((stored as Record<string, unknown>).lifecycleRevision) === expected.lifecycleRevision;
  });
}

/**
 * True only when the exact deterministic preparation namespace is absent.
 * ENOENT is the sole absence verdict; unreadable or malformed storage fails.
 */
export async function isBaselinePreparationAbsent(baselineId: string): Promise<boolean> {
  if (!UUID.test(baselineId)) {
    throw new PageBaselineManifestError(400, 'invalid_baseline_id', 'Baseline id must be a UUID');
  }
  const directory = path.resolve(baselineStoreRoot(), baselineId);
  try {
    await fs.lstat(directory);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
    throw new PageBaselineManifestError(
      503,
      'baseline_storage_unavailable',
      'Baseline preparation presence could not be verified',
    );
  }
}

/**
 * Removes one committed abandoned preparation's private namespace. A repair
 * in the current active epoch must present the exact transferred intent token;
 * terminal or safely fenced/quiescent intents may be maintained without it.
 * Publication and references always veto filesystem deletion.
 */
export async function removeBaselinePreparation(
  client: PoolClient,
  baselineId: string,
  repairIntent?: PageWriteIntent,
): Promise<void> {
  if (!UUID.test(baselineId)) {
    throw new PageBaselineManifestError(400, 'invalid_baseline_id', 'Baseline id must be a UUID');
  }
  const result = await client.query<CleanupRow>(
    `SELECT b.status,
            b.published_at,
            b.attachments,
            b.preparation_intent_id,
            i.status AS intent_status,
            i.runtime_id AS intent_runtime_id,
            i.kind AS intent_kind,
            i.page_ids AS intent_page_ids,
            i.revisions AS intent_revisions,
            i.recovery_mode,
            i.effect->>'effectClass' AS effect_class,
            i.effect->>'baselineId' AS effect_baseline_id,
            i.effect_started_at,
            i.recovery_history->-1->>'toRuntimeId' AS recovery_to_runtime_id,
            r.fenced_at,
            r.quiesced_at,
            r.quiescence_ack,
            (b.xmin = pg_current_xact_id()::xid) AS current_transaction_write,
            EXISTS (SELECT 1 FROM pages p WHERE p.baseline_id = b.id) AS page_reference,
            EXISTS (SELECT 1 FROM page_baseline_history h WHERE h.baseline_id = b.id) AS history_reference
       FROM page_baselines b
       JOIN page_write_intents i ON i.id = b.preparation_intent_id
       JOIN page_writer_runtimes r ON r.runtime_id = i.runtime_id
      WHERE b.id = $1
      FOR UPDATE OF b`,
    [baselineId],
  );
  const row = result.rows[0];
  if (!row) {
    if (await isBaselinePreparationAbsent(baselineId)) return;
    throw new PageBaselineManifestError(
      409,
      'baseline_cleanup_forbidden',
      'Baseline storage exists without an abandoned database preparation',
    );
  }
  const terminalIntent = ['completed', 'cancelled', 'reconciled_applied', 'reconciled_not_applied']
    .includes(row.intent_status);
  const fencedLocalRecovery = repairIntent === undefined
    && row.intent_status === 'pending'
    && row.recovery_mode === 'local_verified'
    && row.fenced_at !== null
    && row.quiescence_ack !== null;
  const activeRepair = repairIntent !== undefined
    && repairIntent.id === row.preparation_intent_id
    && repairIntent.runtimeId === row.intent_runtime_id
    && row.intent_status === 'pending'
    && row.intent_kind === 'baseline.prepare'
    && row.recovery_mode === 'local_verified'
    && row.effect_class === 'local'
    && row.effect_baseline_id === baselineId
    && row.effect_started_at !== null
    && row.recovery_to_runtime_id === repairIntent.runtimeId
    && row.fenced_at === null
    && row.quiesced_at === null
    && repairIntentMatches(row, repairIntent);
  if (
    row.current_transaction_write
    || row.status !== 'abandoned'
    || row.published_at !== null
    || row.page_reference
    || row.history_reference
    || (repairIntent !== undefined ? !activeRepair : (!terminalIntent && !fencedLocalRecovery))
  ) {
    throw new PageBaselineManifestError(
      409,
      'baseline_cleanup_forbidden',
      'Only a committed, never-published, unreferenced abandoned preparation with exact intent authority may be removed',
    );
  }
  parseCleanupAttachments(baselineId, row.attachments);

  const retainedRoot = baselineStoreRoot();
  const baselineDirectory = path.resolve(retainedRoot, baselineId);
  if (!baselineDirectory.startsWith(retainedRoot + path.sep)) {
    throw new PageBaselineManifestError(503, 'baseline_storage_unavailable', 'Baseline storage path is invalid');
  }
  try {
    const rootStat = await fs.lstat(retainedRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new PageBaselineManifestError(503, 'baseline_storage_unavailable', 'Baseline storage root is invalid');
    }
    const baselineStat = await fs.lstat(baselineDirectory);
    if (baselineStat.isSymbolicLink() || !baselineStat.isDirectory()) {
      throw new PageBaselineManifestError(503, 'baseline_storage_unavailable', 'Baseline storage directory is invalid');
    }
    await assertRealPathContained(baselineDirectory, retainedRoot);
    await fs.rm(baselineDirectory, { recursive: true, force: false });
    await fsyncDirectory(retainedRoot);
  } catch (error) {
    if (error instanceof PageBaselineManifestError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (await isBaselinePreparationAbsent(baselineId)) return;
    }
    throw new PageBaselineManifestError(
      503,
      'baseline_storage_unavailable',
      'Abandoned baseline storage could not be removed',
    );
  }
  if (!(await isBaselinePreparationAbsent(baselineId))) {
    throw new PageBaselineManifestError(
      503,
      'baseline_storage_unavailable',
      'Abandoned baseline storage removal could not be verified',
    );
  }
}

export async function inspectBaselineManifest(
  client: PoolClient,
  pageId: number,
  baselineId: string,
  actorId: string,
): Promise<PreparedBaselineManifest> {
  if (!Number.isInteger(pageId) || pageId <= 0) {
    throw new PageBaselineManifestError(404, 'page_not_found', 'Page not found');
  }
  if (!UUID.test(baselineId)) {
    throw new PageBaselineManifestError(400, 'invalid_baseline_id', 'Baseline id must be a UUID');
  }
  if (!actorId) {
    throw new PageBaselineManifestError(403, 'baseline_media_scope_denied', 'Media authorization actor is required');
  }

  const pageResult = await client.query<PageRow>(
    `SELECT id, confluence_id, source, version, content_revision::text, title,
            body_html, body_storage, body_text, labels, parent_id,
            icon_kind, icon_value, icon_color, icon_filled
       FROM pages
      WHERE id = $1 AND deleted_at IS NULL`,
    [pageId],
  );
  const page = pageResult.rows[0];
  if (!page) throw new PageBaselineManifestError(404, 'page_not_found', 'Page not found');
  if (!Number.isSafeInteger(page.version) || page.version <= 0 || !DECIMAL_REVISION.test(page.content_revision)) {
    throw new PageBaselineManifestError(409, 'baseline_manifest_invalid', 'Page revision metadata is invalid');
  }
  if (!Array.isArray(page.labels) || page.labels.some((label) => typeof label !== 'string')) {
    throw new PageBaselineManifestError(409, 'baseline_manifest_invalid', 'Page labels are invalid');
  }
  if (page.source !== 'confluence' && page.source !== 'standalone') {
    throw new PageBaselineManifestError(409, 'baseline_manifest_invalid', 'Page source is invalid');
  }
  // Raw icon nullability is part of the signed payload. In particular,
  // icon_filled=false is distinct from null even when no icon kind is set.
  // Validate every persisted string before any retained-file side effect.
  // This preserves the database's exact UTF-16 strings while refusing values
  // that UTF-8 would otherwise encode with a replacement character.
  encodeBaselineManifest([
    pageIdentity(page),
    page.title,
    page.body_html,
    page.body_storage,
    page.body_text,
    page.labels,
    page.parent_id,
    page.icon_kind,
    page.icon_value,
    page.icon_color,
  ]);
  const labels = [...page.labels].sort(utf8Compare);

  let parentIdentity: unknown[] | null = null;
  if (page.parent_id !== null) {
    const parentResult = await client.query<ParentRow>(
      `SELECT id, confluence_id, source
         FROM pages
        WHERE confluence_id = $1 OR id::text = $1
        ORDER BY id`,
      [page.parent_id],
    );
    if (parentResult.rows.length === 0) {
      throw new PageBaselineManifestError(409, 'baseline_parent_missing', 'Page parent identity no longer resolves');
    }
    if (parentResult.rows.length !== 1) {
      throw new PageBaselineManifestError(409, 'baseline_parent_ambiguous', 'Page parent identity is ambiguous');
    }
    const parent = parentResult.rows[0]!;
    if (parent.source !== 'confluence' && parent.source !== 'standalone') {
      throw new PageBaselineManifestError(409, 'baseline_manifest_invalid', 'Page parent source is invalid');
    }
    if (parentStoredKey(parent) !== page.parent_id) {
      throw new PageBaselineManifestError(409, 'baseline_parent_ambiguous', 'Page parent key is not canonical');
    }
    parentIdentity = ['parent', parent.source, String(parent.id), parent.confluence_id, page.parent_id];
  }

  const sources = collectMediaSources(page);
  const sourcePageIds = await assertMediaSourcesAccessible(client, page, actorId, sources);
  const iconSource = await resolveIconSource(page);
  if (iconSource) sources.push(iconSource);

  const maxAttachments = configuredLimit('PAGE_BASELINE_MAX_ATTACHMENTS', DEFAULT_MAX_ATTACHMENTS);
  if (sources.length > maxAttachments) {
    throw new PageBaselineManifestError(
      413,
      'baseline_media_limit_exceeded',
      `Baseline references ${sources.length} media objects; the limit is ${maxAttachments}`,
    );
  }

  const inspected: InspectedAttachmentSource[] = [];
  let totalBytes = 0;
  for (const source of sources) {
    const found = await inspectSource(source);
    totalBytes += found.size;
    if (!Number.isSafeInteger(totalBytes)) {
      throw new PageBaselineManifestError(413, 'baseline_media_limit_exceeded', 'Baseline media size is too large');
    }
    const identity = mediaIdentity(source.store, source.pageKey, source.filename);
    const mediaId = createHash('sha256').update(identity).update('\0').update(source.filename).digest('hex');
    const retainedPath = path
      .relative(attachmentsRootNow(), baselineMediaPath(baselineId, baselineId, mediaId))
      .split(path.sep)
      .join('/');
    const attachment: BaselineAttachment = {
      identity,
      store: source.store,
      pageKey: source.pageKey,
      filename: source.filename,
      size: found.size,
      mediaType: getMimeType(source.filename),
      sha256: found.sha256,
      retainedPath,
    };
    retainedAbsolutePath(baselineId, attachment);
    inspected.push({ source, ...found, attachment });
  }
  const maxBytes = configuredLimit('PAGE_BASELINE_MAX_BYTES', DEFAULT_MAX_TOTAL_BYTES);
  if (totalBytes > maxBytes) {
    throw new PageBaselineManifestError(
      413,
      'baseline_media_limit_exceeded',
      `Baseline media is ${totalBytes} bytes; the limit is ${maxBytes}`,
    );
  }
  const attachments = inspected
    .map((item) => ({ ...item.attachment }))
    .sort((left, right) => utf8Compare(left.identity, right.identity));

  const rawIcon = [page.icon_kind, page.icon_value, page.icon_color, page.icon_filled];
  const icon = rawIcon.every((value) => value === null)
    ? null
    : ['icon', ...rawIcon];
  const attachmentManifest = attachments.map((attachment) => [
    attachment.identity,
    attachment.store,
    attachment.pageKey,
    attachment.filename,
    attachment.size,
    attachment.mediaType,
    attachment.sha256,
  ]);
  const manifest: unknown[] = [
    'compendiq.article-baseline',
    1,
    baselineId,
    pageIdentity(page),
    page.version,
    page.content_revision,
    page.title,
    page.body_html,
    page.body_storage,
    page.body_text,
    labels,
    parentIdentity,
    icon,
    attachmentManifest,
  ];
  const manifestBytes = encodeBaselineManifest(manifest);
  const manifestDigest = createHash('sha256').update(manifestBytes).digest('hex');

  const prepared: PreparedBaselineManifest = {
    baselineId,
    pageId,
    version: page.version,
    contentRevision: page.content_revision,
    manifest,
    manifestBytes,
    manifestDigest,
    attachments,
    totalBytes,
  };
  inspectionStates.set(prepared, {
    baselineId,
    pageId,
    manifestDigest,
    totalBytes,
    sourcePageIds,
    actorId,
    inspected,
  });
  return prepared;
}

/**
 * Page ids whose lifecycle locks and durable write intent must cover a retain.
 * Only the original in-process inspection object can reveal this private
 * source inventory.
 */
export function baselineManifestSourcePageIds(
  preflight: PreparedBaselineManifest,
): readonly number[] {
  const state = inspectionStates.get(preflight);
  if (!state) {
    throw new PageBaselineManifestError(
      409,
      'baseline_preflight_invalid',
      'Baseline source inventory is unavailable; inspect the page again',
    );
  }
  return [...state.sourcePageIds];
}

function sameBaselineAttachment(left: BaselineAttachment, right: BaselineAttachment): boolean {
  return left.identity === right.identity
    && left.store === right.store
    && left.pageKey === right.pageKey
    && left.filename === right.filename
    && left.size === right.size
    && left.mediaType === right.mediaType
    && left.sha256 === right.sha256
    && left.retainedPath === right.retainedPath;
}

async function assertFrozenSourcesStillAuthorized(state: InspectionState): Promise<void> {
  const frozen = state.inspected.filter((item) => item.source.frozenOwnerId !== undefined);
  if (frozen.length === 0) return;
  const client = await getPool().connect();
  try {
    for (const item of frozen) {
      const source = item.source;
      const ownerId = source.frozenOwnerId!;
      const baselineId = source.frozenBaselineId!;
      const owner = await client.query<{ baseline_id: string | null }>(
        'SELECT baseline_id FROM pages WHERE id = $1',
        [ownerId],
      );
      if (
        owner.rows.length !== 1
        || !(await userCanAccessPage(state.actorId, ownerId, client))
      ) {
        throw new PageBaselineManifestError(
          403,
          'baseline_media_scope_denied',
          'Referenced media owner could not be authorized',
        );
      }
      if (owner.rows[0]!.baseline_id !== baselineId) {
        throw new PageBaselineManifestError(
          409,
          'baseline_preflight_invalid',
          'Referenced frozen media identity changed after inspection',
        );
      }
      const current: MediaSource = {
        store: source.store,
        pageKey: source.pageKey,
        filename: source.filename,
        sourcePath: '',
      };
      await bindFrozenMediaSource(client, current, ownerId, baselineId);
      if (
        current.frozenRetainedPath !== source.frozenRetainedPath
        || current.sourcePath !== source.sourcePath
        || current.expectedSize !== source.expectedSize
        || current.expectedSha256 !== source.expectedSha256
      ) {
        throw new PageBaselineManifestError(
          409,
          'baseline_preflight_invalid',
          'Referenced frozen media evidence changed after inspection',
        );
      }
    }
  } finally {
    client.release();
  }
}

/**
 * Copies a previously inspected manifest only after its durable preparing row,
 * logical capacity reservation and local write intent all agree.
 */
export async function retainBaselineManifest(
  preflight: PreparedBaselineManifest,
  intent: PageWriteIntent,
): Promise<void> {
  const state = inspectionStates.get(preflight);
  let preflightUnchanged = false;
  if (state) {
    try {
      const encoded = encodeBaselineManifest(preflight.manifest);
      const digest = createHash('sha256').update(encoded).digest('hex');
      const expectedAttachments = state.inspected
        .map((item) => item.attachment)
        .sort((left, right) => utf8Compare(left.identity, right.identity));
      preflightUnchanged = encoded.equals(preflight.manifestBytes)
        && digest === state.manifestDigest
        && preflight.attachments.length === expectedAttachments.length
        && preflight.attachments.every((attachment, index) =>
          sameBaselineAttachment(attachment, expectedAttachments[index]!));
    } catch {
      preflightUnchanged = false;
    }
  }
  const intentPageIds = [...intent.pageIds].sort((left, right) => left - right);
  const intentPagesMatch = state !== undefined
    && intentPageIds.length === state.sourcePageIds.length
    && intentPageIds.every((pageId, index) => pageId === state.sourcePageIds[index]);
  if (
    !state
    || !preflightUnchanged
    || state.baselineId !== preflight.baselineId
    || state.pageId !== preflight.pageId
    || state.manifestDigest !== preflight.manifestDigest
    || state.totalBytes !== preflight.totalBytes
    || !intentPagesMatch
  ) {
    throw new PageBaselineManifestError(
      409,
      'baseline_preflight_invalid',
      'Baseline retention requires the original unchanged inspection result and matching page intent',
    );
  }
  const authorization = await query<RetainAuthorizationRow>(
    `SELECT b.page_id,
            b.status,
            b.manifest_digest,
            b.total_bytes::text,
            b.reserved_bytes::text,
            b.preparation_intent_id,
            b.attachments,
            i.status AS intent_status,
            i.runtime_id AS intent_runtime_id,
            i.effect->>'effectClass' AS effect_class
       FROM page_baselines b
       JOIN page_write_intents i ON i.id = b.preparation_intent_id
      WHERE b.id = $1`,
    [state.baselineId],
  );
  const row = authorization.rows[0];
  let bytesMatch = false;
  let attachmentsMatch = false;
  try {
    bytesMatch = row !== undefined
      && BigInt(row.total_bytes) === BigInt(state.totalBytes)
      && BigInt(row.reserved_bytes) === BigInt(state.totalBytes);
    const storedAttachments = row
      ? parseCleanupAttachments(state.baselineId, row.attachments)
      : [];
    const expectedAttachments = state.inspected
      .map((item) => item.attachment)
      .sort((left, right) => utf8Compare(left.identity, right.identity));
    attachmentsMatch = storedAttachments.length === expectedAttachments.length
      && storedAttachments.every((attachment, index) =>
        sameBaselineAttachment(attachment, expectedAttachments[index]!));
  } catch {
    bytesMatch = false;
    attachmentsMatch = false;
  }
  if (
    !row
    || row.page_id !== state.pageId
    || row.status !== 'preparing'
    || row.manifest_digest !== state.manifestDigest
    || row.preparation_intent_id !== intent.id
    || row.intent_status !== 'pending'
    || row.intent_runtime_id !== intent.runtimeId
    || row.effect_class !== 'local'
    || !bytesMatch
    || !attachmentsMatch
  ) {
    throw new PageBaselineManifestError(
      409,
      'baseline_reservation_mismatch',
      'Durable baseline reservation does not authorize this retained-byte write',
    );
  }

  await runPageWriteIntentEffect(intent, { kind: 'local' }, async () => {
    await assertFrozenSourcesStillAuthorized(state);
    await createExclusiveAttempt(state.baselineId, state.baselineId);
    await assertDiskCapacity(state.totalBytes);
    for (const item of state.inspected) {
      const retained = await copyAndVerify(
        item.source,
        item,
        state.baselineId,
        state.baselineId,
      );
      if (!sameBaselineAttachment(retained, item.attachment)) {
        throw new PageBaselineManifestError(
          409,
          'baseline_media_unreadable',
          `Attachment ${item.source.filename} no longer matches the inspected manifest`,
        );
      }
    }
    const attemptDirectory = baselineAttemptDirectory(state.baselineId, state.baselineId);
    await fsyncDirectory(path.join(attemptDirectory, 'media'));
    await fsyncDirectory(attemptDirectory);
    await fsyncDirectory(path.dirname(attemptDirectory));
  });
}
