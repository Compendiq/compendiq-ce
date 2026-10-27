/**
 * Sub-page context assembly service.
 *
 * Fetches a parent page and all its recursive sub-pages from pages,
 * then concatenates them with clear page boundary markers for LLM consumption.
 *
 * Content length limits prevent exceeding LLM context windows.
 *
 * Article AI policy (SPEC-WORK-001, #281): a caller that will send the
 * assembled text to a provider passes a `policyContext` naming the provider
 * it was admitted for, at the configuration revision it was admitted at.
 * Every descendant is then decided against its own `pages.ai_policy` — read
 * from the same row as its body — BEFORE its title or body is formatted, and
 * the result names exactly which page ids (with policy and policy revision)
 * were included so the caller can record provenance it can trust. A
 * descendant's exclusion is never visible in the prompt text. Without a
 * `policyContext` the walk is unfiltered: display-only routes keep their
 * behaviour, and no provider-bound caller may omit it.
 */

import { query } from '../../../core/db/postgres.js';
import { sanitizeLlmInput } from '../../../core/utils/sanitize-llm-input.js';
import { htmlToMarkdown } from '../../../core/services/content-converter.js';
import { logger } from '../../../core/utils/logger.js';
import { getUserAccessibleSpacesMemoized } from '../../../core/services/rbac-service.js';
import { visiblePagesPredicate } from '../../../core/services/page-visibility.js';
import { isAiPolicy, type AiPolicy } from '../../../core/services/ai-policy-service.js';
import {
  asRevision,
  decideAiPolicyAdmission,
  loadProviderMetadata,
  type ProviderMetadata,
} from '../../llm/services/ai-policy-admission.js';

/** Maximum combined context size in characters (approx 60K tokens for most LLMs). */
const MAX_COMBINED_CONTEXT_CHARS = 200_000;

/** Maximum depth for recursive sub-page fetching (prevent runaway recursion). */
const MAX_DEPTH = 5;

/**
 * Maximum number of sub-pages the walk CONSIDERS. A considered page counts
 * whether it was included or excluded by policy, so a tree padded with
 * `none` pages cannot force the walk past the bound (SPEC-WORK-001 review).
 */
const MAX_SUB_PAGES = 50;

export interface PageContent {
  /** Local page id — the trustworthy identity for provenance. */
  id: number;
  confluenceId: string | null;
  title: string;
  bodyHtml: string;
  depth: number;
  /** Policy and revision read from the SAME row as the body. */
  policy: AiPolicy;
  policyRevision: number;
  contentRevision: number;
}

/** A descendant the policy context refused; nothing of it was formatted. */
export interface ExcludedPage {
  id: number;
  policy: AiPolicy;
  policyRevision: number;
  reason: 'policy_none' | 'provider_not_local';
}

/**
 * The caller's dispatch binding. The provider is read once per walk and
 * must still be at `expectedConfigRevision` AND at the EFFECTIVE locality
 * the caller was admitted with. A locality declaration
 * (`declareProviderLocality`) does not move `config_revision`, so the
 * revision alone cannot see an `external → local` (or back) flip between the
 * caller's admission and the walk; the walk fails closed on either
 * mismatch rather than deciding descendants against a binding nobody
 * admitted.
 */
export interface SubPagePolicyContext {
  providerId: string;
  /** Use case the caller is assembling for (logged with exclusions). */
  usecase: string;
  /** `configRevision` the caller's own admission bound it to. */
  expectedConfigRevision: number;
  /**
   * The effective locality the caller's admission decided against
   * (`AiPolicyAdmission.locality`): `local` only when declared against the
   * current configuration revision, otherwise `external`.
   */
  expectedLocality: 'local' | 'external';
}

/**
 * Why a policy-bound walk refused before reading any descendant.
 *
 * - `ai_policy_provider_revision_mismatch` / `ai_policy_provider_locality_mismatch`:
 *   the binding the caller was admitted with no longer describes the
 *   provider — a conflict (#282 maps these to 409, before any stream opens).
 * - `ai_policy_unavailable`: the provider's metadata could not be read or
 *   does not decode (row deleted, DB failure, invalid columns). RETRYABLE —
 *   a fact about the deployment, not the binding (#282 maps it to 503).
 */
export type SubPagePolicyErrorReason =
  | 'ai_policy_provider_revision_mismatch'
  | 'ai_policy_provider_locality_mismatch'
  | 'ai_policy_unavailable';

export class SubPagePolicyError extends Error {
  constructor(
    public readonly reason: SubPagePolicyErrorReason,
    message: string,
    /** Server-read identity only; never carry the refused title or body. */
    public readonly pageId?: number,
  ) {
    super(message);
    this.name = 'SubPagePolicyError';
  }

  /** True for refusals a caller may retry unchanged (`ai_policy_unavailable`). */
  get retryable(): boolean {
    return this.reason === 'ai_policy_unavailable';
  }
}

export interface SubPageFetchResult {
  pages: PageContent[];
  excluded: ExcludedPage[];
}

export interface IncludedPageRef {
  id: number;
  confluenceId: string | null;
  title: string;
  policy: AiPolicy;
  policyRevision: number;
  contentRevision: number;
  truncated: boolean;
}

interface AssembledContext {
  /** The combined markdown text with page boundary markers. */
  markdown: string;
  /** Total number of pages included (parent + sub-pages). */
  pageCount: number;
  /** Whether content was truncated due to length limits. */
  wasTruncated: boolean;
  /** List of page titles included, for reference. */
  includedPages: string[];
  /**
   * Provenance: every SUB-page whose text is in `markdown`, by local id with
   * the policy/revision its body was read under. The parent is the caller's
   * (it already holds its own admission) and is not listed here.
   */
  includedPageRefs: IncludedPageRef[];
  /** Descendants refused by the policy context; none of their text is present. */
  excludedByPolicy: ExcludedPage[];
  /** Injection-pattern detections from the per-page-body sanitization
   * (#1270 review F1) — the caller folds these into its attestation trail,
   * mirroring fetchWebSources. */
  injectionWarnings: string[];
}

/**
 * Read the provider's metadata once, through the SAME decoder admission
 * uses (`decodeProviderMetadata`). A provider that cannot be read — no row
 * (deleted since the caller's admission), a query failure, or metadata that
 * does not decode — is `ai_policy_unavailable`: the walk fails closed and
 * nothing is inferred (no default locality, no sentinel revision).
 */
async function loadProviderMetadataOrThrow(policyContext: SubPagePolicyContext): Promise<ProviderMetadata> {
  let provider: ProviderMetadata | null;
  try {
    provider = await loadProviderMetadata({ query }, policyContext.providerId);
  } catch (err) {
    logger.warn(
      { err, providerId: policyContext.providerId, usecase: policyContext.usecase },
      'Sub-page policy walk could not read provider metadata; refusing',
    );
    throw new SubPagePolicyError(
      'ai_policy_unavailable',
      `Provider ${policyContext.providerId} metadata could not be read`,
    );
  }
  if (!provider) {
    throw new SubPagePolicyError(
      'ai_policy_unavailable',
      `Provider ${policyContext.providerId} has no readable metadata (deleted or invalid)`,
    );
  }
  return provider;
}

async function bindProvider(policyContext: SubPagePolicyContext): Promise<ProviderMetadata> {
  const provider = await loadProviderMetadataOrThrow(policyContext);
  if (provider.configRevision !== policyContext.expectedConfigRevision) {
    throw new SubPagePolicyError(
      'ai_policy_provider_revision_mismatch',
      `Provider ${policyContext.providerId} is at configuration revision ${provider.configRevision}, `
        + `the caller was admitted at ${policyContext.expectedConfigRevision}`,
    );
  }
  if (provider.effectiveLocality !== policyContext.expectedLocality) {
    throw new SubPagePolicyError(
      'ai_policy_provider_locality_mismatch',
      `Provider ${policyContext.providerId} is now ${provider.effectiveLocality}, `
        + `the caller was admitted against a ${policyContext.expectedLocality} provider`,
    );
  }
  return provider;
}

/** An unknown stored policy is never read as `all`. */
function storedPolicy(value: string): AiPolicy {
  return isAiPolicy(value) ? value : 'none';
}

/**
 * Fetch all sub-pages recursively for a given parent page.
 * Returns pages in breadth-first order.
 *
 * With a `policyContext`, each descendant is decided BEFORE it is pushed to
 * the result; an excluded page's title and body are dropped, but its
 * children are still walked (a `none` folder does not hide an `all` child)
 * and it still counts toward `MAX_SUB_PAGES`.
 */
export async function fetchSubPages(
  userId: string,
  parentId: string,
  policyContext?: SubPagePolicyContext,
): Promise<PageContent[]> {
  return (await fetchAdmittedSubPages(userId, parentId, policyContext)).pages;
}

export async function fetchAdmittedSubPages(
  userId: string,
  parentId: string,
  policyContext?: SubPagePolicyContext,
): Promise<SubPageFetchResult> {
  const subPages: PageContent[] = [];
  const excluded: ExcludedPage[] = [];
  const queue: Array<{ id: string; depth: number }> = [{ id: parentId, depth: 1 }];
  const visited = new Set<string>();
  let considered = 0;

  // The provider binding is resolved once, before any row is read, so every
  // descendant is decided against the same (verified) binding.
  const provider = policyContext ? await bindProvider(policyContext) : null;

  // #814: gate every descendant through the non-RAG list predicate, so a
  // caller can never pull a sub-page from a space they lack RBAC access to,
  // another user's private standalone page, or a restricted page they hold no
  // ACE for into the LLM prompt. Soft-deleted children are excluded via `deleted_at IS NULL`.
  const spaces = await getUserAccessibleSpacesMemoized(userId);

  while (queue.length > 0 && considered < MAX_SUB_PAGES) {
    const current = queue.shift()!;
    if (current.depth > MAX_DEPTH || visited.has(current.id)) continue;
    visited.add(current.id);

    const result = await query<{
      id: number;
      confluence_id: string | null;
      title: string;
      body_html: string | null;
      ai_policy: string;
      ai_policy_revision: string;
      content_revision: string;
    }>(
      `SELECT id, confluence_id, title, body_html, ai_policy, ai_policy_revision::text, content_revision::text
       FROM pages
       WHERE parent_id = $1
         AND deleted_at IS NULL
         AND ${visiblePagesPredicate(2, 3, 'pages')}
       ORDER BY id`,
      [current.id, spaces, userId],
    );

    for (const row of result.rows) {
      if (considered >= MAX_SUB_PAGES) break;
      considered += 1;
      const policy = storedPolicy(row.ai_policy);
      const policyRevision = asRevision(row.ai_policy_revision);
      const contentRevision = asRevision(row.content_revision);
      if (!isAiPolicy(row.ai_policy) || policyRevision === null || contentRevision === null) {
        throw new SubPagePolicyError('ai_policy_unavailable', 'Unreadable descendant metadata', row.id);
      }

      // Queue children for next depth level. Standalone (local-space) pages have
      // a NULL confluence_id and are keyed on `parent_id = <parent DB id as text>`,
      // so fall back to the DB id — mirroring COALESCE(confluence_id, id::text)
      // in pages-crud.ts (#886). Without this, standalone descendants below depth
      // 1 are dropped (WHERE parent_id = NULL matches nothing).
      queue.push({ id: row.confluence_id ?? String(row.id), depth: current.depth + 1 });

      if (provider) {
        const decision = decideAiPolicyAdmission(policy, provider);
        if (decision !== 'admit') {
          excluded.push({ id: row.id, policy, policyRevision, reason: decision });
          logger.debug(
            { pageId: row.id, policy, reason: decision, providerId: policyContext!.providerId, usecase: policyContext!.usecase },
            'Sub-page excluded by article AI policy',
          );
          continue;
        }
      }

      subPages.push({
        id: row.id,
        confluenceId: row.confluence_id,
        title: row.title,
        bodyHtml: row.body_html || '',
        depth: current.depth,
        policy,
        policyRevision,
        contentRevision,
      });
    }
  }

  return { pages: subPages, excluded };
}

/**
 * Check if a page has any sub-pages.
 */
export async function hasSubPages(
  userId: string,
  pageId: string,
): Promise<boolean> {
  // #814: only count children the caller may actually see (same visibility
  // predicate + soft-delete filter as fetchSubPages).
  const spaces = await getUserAccessibleSpacesMemoized(userId);
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM pages
     WHERE parent_id = $1
       AND deleted_at IS NULL
       AND ${visiblePagesPredicate(2, 3, 'pages')}`,
    [pageId, spaces, userId],
  );
  const row = result.rows[0];
  if (!row) throw new Error('Expected a row from COUNT query');
  return parseInt(row.count, 10) > 0;
}

/**
 * Assemble combined context from a parent page and its sub-pages.
 *
 * Returns markdown content with clear page boundary markers:
 *
 *   --- Page: "Parent Title" (Main Page) ---
 *   [parent content]
 *
 *   --- Page: "Sub-page Title" ---
 *   [sub-page content]
 *
 * Content is truncated if it exceeds MAX_COMBINED_CONTEXT_CHARS.
 */
export async function assembleSubPageContext(
  userId: string,
  parentPageId: string,
  parentHtml: string,
  parentTitle: string,
  maxChars: number = MAX_COMBINED_CONTEXT_CHARS,
  opts?: {
    /**
     * Emit #765 layout boundary tokens for the PARENT page conversion. The
     * Improve route needs them: apply-time skeleton alignment runs against
     * the parent page, so a token-free parent makes any Improve of a
     * multi-cell layout page unrecoverable (guaranteed 422). Sub-page
     * conversions NEVER opt in (#765 review: truncated sub-page token
     * sequences could be echoed by the model into the parent's output —
     * truncation only ever affects sub-pages, the parent always goes first).
     */
    parentLayoutTokens?: boolean;
    /** Provider binding for the descendant walk (see `SubPagePolicyContext`). */
    policyContext?: SubPagePolicyContext;
  },
): Promise<AssembledContext> {
  // Convert parent page to markdown
  const parentMarkdown = opts?.parentLayoutTokens
    ? htmlToMarkdown(parentHtml, { layoutTokens: true })
    : htmlToMarkdown(parentHtml);
  const includedPages: string[] = [parentTitle];
  const includedPageRefs: IncludedPageRef[] = [];
  let wasTruncated = false;
  // #1270 review F1: per-page-BODY sanitization, before the attribution
  // markers wrap the text. Sanitizing the assembled string at the route ate
  // the route's own `--- Page: ... ---` markers (the delimiter-injection
  // pattern matches marker + blank line + a body starting "System ..."),
  // breaking the attribution mechanism getMultiPagePromptSuffix instructs
  // the model to use. Warnings surface to the caller — the route folds them
  // into the same attestation trail as fetchWebSources' (the precedent this
  // mirrors).
  const injectionWarnings: string[] = [];
  const sanitizeBody = (markdown: string): string => {
    const { sanitized, warnings } = sanitizeLlmInput(markdown);
    injectionWarnings.push(...warnings);
    return sanitized;
  };

  // Titles are sanitized too (#1270 round-4 residual): they are
  // attacker-controlled metadata interpolated into the prompt's marker
  // lines — the one channel the per-body layering re-opened (the
  // whole-string pass used to cover them). Same precedent as the route's
  // external-doc title sanitization (#820).
  const sanitizeTitle = (title: string): string => {
    const { sanitized, warnings } = sanitizeLlmInput(title);
    injectionWarnings.push(...warnings);
    return sanitized;
  };

  // Start with the parent page
  let combined = `--- Page: "${sanitizeTitle(parentTitle)}" (Main Page) ---\n\n${sanitizeBody(parentMarkdown)}`;

  // Fetch sub-pages — already policy-filtered when a context is given, so no
  // excluded page's title or body reaches the sanitizer or the markdown.
  const { pages: subPages, excluded: excludedByPolicy } =
    await fetchAdmittedSubPages(userId, parentPageId, opts?.policyContext);

  if (subPages.length === 0) {
    return {
      markdown: combined,
      pageCount: 1,
      wasTruncated: false,
      includedPages,
      includedPageRefs,
      excludedByPolicy,
      injectionWarnings,
    };
  }

  logger.debug(
    { parentPageId, subPageCount: subPages.length, excludedByPolicy: excludedByPolicy.length },
    'Assembling sub-page context',
  );

  for (const subPage of subPages) {
    const subMarkdown = sanitizeBody(htmlToMarkdown(subPage.bodyHtml));
    const separator = `\n\n--- Page: "${sanitizeTitle(subPage.title)}" (Sub-page, depth ${subPage.depth}) ---\n\n`;
    const section = separator + subMarkdown;
    const ref = {
      id: subPage.id,
      confluenceId: subPage.confluenceId,
      title: subPage.title,
      policy: subPage.policy,
      policyRevision: subPage.policyRevision,
      contentRevision: subPage.contentRevision,
    };

    // Check if adding this page would exceed the limit
    if (combined.length + section.length > maxChars) {
      // Try to add a truncated version
      const remaining = maxChars - combined.length - separator.length - 100; // 100 chars for truncation notice
      if (remaining > 200) {
        combined += separator + subMarkdown.slice(0, remaining) + '\n\n[Content truncated due to length limits]';
        includedPages.push(subPage.title + ' (truncated)');
        includedPageRefs.push({ ...ref, truncated: true });
      }
      wasTruncated = true;
      logger.debug(
        { parentPageId, includedCount: includedPages.length, totalSubPages: subPages.length },
        'Sub-page context truncated due to length limits',
      );
      break;
    }

    combined += section;
    includedPages.push(subPage.title);
    includedPageRefs.push({ ...ref, truncated: false });
  }

  return {
    markdown: combined,
    pageCount: includedPages.length,
    wasTruncated,
    includedPages,
    includedPageRefs,
    excludedByPolicy,
    injectionWarnings,
  };
}

/**
 * Get a multi-page system prompt suffix that instructs the LLM
 * to reference specific sub-pages in its response.
 */
export function getMultiPagePromptSuffix(pageCount: number): string {
  if (pageCount <= 1) return '';
  return `\n\nIMPORTANT: This content spans multiple pages (${pageCount} total). When making suggestions or references, always specify which page you are referring to by using the page title shown in the "--- Page: ... ---" markers. For example, say "In the page 'Getting Started'..." rather than generic references.`;
}
