/**
 * Standalone mode (#1623) — the ONE rule every page/AI write path applies when
 * a user's Confluence integration is switched off.
 *
 * Off means standalone, not degraded. An already-synced article stays
 * editable, deletable and AI-usable; the write simply takes the path a
 * `standalone` article takes — local row, local version bookkeeping, no remote
 * version check, no image upload, no `updatePage` / `deletePage`. Nothing
 * leaves the box, and credentials are never solicited.
 *
 * Callers ask this instead of inferring the mode from a null client:
 * `getClientForUser` returns null BOTH for "switched off" and for "on but
 * unconfigured", and only the second one may answer `Confluence not
 * configured` — that string is a credential prompt, which is exactly what a
 * standalone user must never see.
 *
 * The divergence a local write creates is not a new reconciliation model: the
 * local path stamps `local_modified_at` / `local_modified_by` (#305), which is
 * the same marker a sync-side conflict already reads, so re-enabling the
 * integration hands the page to the existing conflict handling unchanged.
 *
 * Operations that ARE Confluence work — creating a page upstream, re-syncing
 * from upstream, walking the remote tree, relocating across the boundary —
 * have no local equivalent. They refuse with `CONFLUENCE_DISABLED_MESSAGE`,
 * naming the integration being off rather than asking for a PAT.
 */
import { isConfluenceEnabled } from '../../../core/services/confluence-integration.js';

/**
 * Refusal for a Confluence-only operation while the integration is off.
 * Same wording the sync/spaces routes use, so one server string covers the
 * whole "you switched this off" family.
 */
export const CONFLUENCE_DISABLED_MESSAGE = 'Confluence integration is disabled';

/**
 * True when a write to this page must stay local: it either has no upstream at
 * all, or the user's integration is off.
 *
 * `pageSource` is `pages.source` — only `'confluence'` has an upstream.
 */
export async function pageWriteStaysLocal(userId: string, pageSource: string): Promise<boolean> {
  if (pageSource !== 'confluence') return true;
  return !(await isConfluenceEnabled(userId));
}
