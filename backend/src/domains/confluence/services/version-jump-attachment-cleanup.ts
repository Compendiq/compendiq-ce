/**
 * The attachment-cache cleanup `syncPage` runs when an existing Confluence
 * page arrives with a newer upstream version (#1773).
 *
 * The rule is still the one `syncPage` has always applied: the page's whole
 * cache directory goes (`cleanPageAttachments`), so every file is fetched
 * again. {@link selectVersionJumpCacheDeletions} states that rule as a
 * selection over the cached files — every one of them — so the rule has one
 * place to change.
 */
import { cleanPageAttachments } from './attachment-handler.js';

/** One page's local content, as read before any delete. */
export interface VersionJumpLocalSources {
  bodyHtml: string | null;
  draftBodyHtml: string | null;
  bodyStorage: string | null;
  draftBodyStorage: string | null;
  /** `pages.space_key`: resolves cross-page refs in the stored storage the way their download named them. */
  spaceKey: string | null;
  /** The page's `page_versions.body_html` rows that can name a cached file. */
  versionBodiesHtml: readonly string[];
}

export interface VersionJumpSelectionInput {
  /** Regular files with storable names in the page's cache directory. */
  cached: readonly string[];
  /** The new upstream `body_storage`. */
  incomingStorage: string;
  /** The space being synced: the `currentSpaceKey` the downloads name files with. */
  spaceKey: string;
  local: VersionJumpLocalSources;
}

/** The cached files a version jump removes, in `cached` order: every one of them. */
export function selectVersionJumpCacheDeletions(input: VersionJumpSelectionInput): string[] {
  return [...input.cached];
}

export interface PruneVersionJumpAttachmentCacheInput {
  /** `pages.id` of the existing row. */
  pageId: number;
  /** The cache directory key: the page's `confluence_id`. */
  attachmentKey: string;
  /** The new upstream `body_storage`. */
  incomingStorage: string;
  /** The space being synced. */
  spaceKey: string;
}

/** Clean the page's attachment cache before a newer upstream version is applied. */
export async function pruneVersionJumpAttachmentCache(
  input: PruneVersionJumpAttachmentCacheInput,
): Promise<void> {
  await cleanPageAttachments(input.attachmentKey);
}
