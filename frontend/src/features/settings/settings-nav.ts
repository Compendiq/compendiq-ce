/**
 * Settings IA — single source of truth for the left-rail navigation.
 *
 * Used by:
 *   - SettingsLayout (rendering the <nav> landmark with grouped links)
 *   - App.tsx route config (generating child routes with per-panel lazy imports)
 *   - SettingsLayout loader (resolving the legacy `?tab=<id>` redirect via legacyTabMap)
 *
 * Category/item IDs are the URL segments: `/settings/<category>/<item>`.
 * Adding a new settings panel = one entry here + one panel file; nothing else.
 *
 * See docs/plans/215-settings-ia-reorg.md for the design rationale.
 */

export type SettingsCategoryId =
  | 'personal'
  | 'content'
  | 'ai'
  | 'integrations'
  | 'security'
  | 'system';

export interface SettingsNavItem {
  /** URL segment + legacy back-compat key. */
  id: string;
  /** Human label shown in the rail. */
  label: string;
  /** Legacy `?tab=<value>` identifier. `null` if the item is new and has no legacy id. */
  legacyTabId: string | null;
  adminOnly?: boolean;
  enterpriseOnly?: boolean;
  /** Enterprise feature-flag name required to render. Paired with `enterpriseOnly: true`. */
  requiresFeature?: string;
}

export interface SettingsNavGroup {
  id: SettingsCategoryId;
  label: string;
  items: SettingsNavItem[];
}

/**
 * Builds a SettingsNavItem with the common case (`legacyTabId === id`) defaulted.
 * Pass `legacyTabId` in options only when it diverges from the URL segment
 * (e.g. the LLM panel whose legacy `?tab=ollama` predates the rename).
 */
function navItem(
  id: string,
  label: string,
  options: Omit<SettingsNavItem, 'id' | 'label' | 'legacyTabId'> & { legacyTabId?: string | null } = {},
): SettingsNavItem {
  const { legacyTabId = id, ...rest } = options;
  return { id, label, legacyTabId, ...rest };
}

/**
 * Grouped nav config. The order within each group controls rail rendering order;
 * the order of groups controls top-to-bottom rail order.
 */
export const SETTINGS_NAV: readonly SettingsNavGroup[] = [
  {
    id: 'personal',
    label: 'Personal',
    items: [
      navItem('confluence', 'Confluence'),
      navItem('ai-prompts', 'AI Prompts'),
      navItem('theme', 'Theme'),
    ],
  },
  {
    id: 'content',
    label: 'Content',
    items: [
      navItem('spaces', 'Spaces'),
      navItem('sync', 'Sync'),
      // Sync conflict resolution (Compendiq/compendiq-ee#118). Two
      // adjacent panels: the policy radio (always visible to EE admins
      // with the feature licensed) and the conflicts queue (same gating
      // — the queue is empty unless the policy is `manual-review`, and
      // the empty state is harmless to render).
      navItem('sync-conflict-policy', 'Sync conflict policy', {
        adminOnly: true,
        enterpriseOnly: true,
        requiresFeature: 'sync_conflict_resolution',
        legacyTabId: null,
      }),
      navItem('sync-conflicts', 'Sync conflicts', {
        adminOnly: true,
        enterpriseOnly: true,
        requiresFeature: 'sync_conflict_resolution',
        legacyTabId: null,
      }),
      navItem('labels', 'Labels', { adminOnly: true }),
    ],
  },
  {
    id: 'ai',
    label: 'AI',
    items: [
      // NOTE: the legacy `?tab=ollama` URL maps here. The URL segment is now
      // `llm` because the panel is provider-agnostic (Ollama + OpenAI).
      navItem('llm', 'LLM', { legacyTabId: 'ollama', adminOnly: true }),
      navItem('embedding', 'Embedding', { adminOnly: true }),
      navItem('ai-safety', 'AI Safety', { adminOnly: true }),
      navItem('workers', 'Workers', { adminOnly: true }),
      navItem('llm-policy', 'LLM Policy', {
        adminOnly: true,
        enterpriseOnly: true,
        requiresFeature: 'org_llm_policy',
      }),
      navItem('llm-audit', 'LLM Audit', {
        adminOnly: true,
        enterpriseOnly: true,
        requiresFeature: 'llm_audit_trail',
      }),
      // AI output review (Compendiq/compendiq-ee#120). Two adjacent
      // settings panels: the reviewer queue (a list) and the policy
      // configuration (per-action modes + expiry). The detail diff
      // view is a full-page route at `/settings/ai-reviews/:id`,
      // outside the SettingsLayout — see App.tsx.
      navItem('ai-reviews', 'AI review queue', {
        adminOnly: true,
        enterpriseOnly: true,
        requiresFeature: 'ai_output_review',
        legacyTabId: null,
      }),
      navItem('ai-review-policy', 'AI review policy', {
        adminOnly: true,
        enterpriseOnly: true,
        requiresFeature: 'ai_output_review',
        legacyTabId: null,
      }),
    ],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    items: [
      navItem('email', 'Email / SMTP', { adminOnly: true }),
      navItem('searxng', 'SearXNG', { adminOnly: true }),
      navItem('mcp-docs', 'MCP Docs', { adminOnly: true }),
    ],
  },
  {
    id: 'security',
    label: 'Security & Access',
    items: [
      // Per-user admin CRUD (#304). Lives under Security & Access because it
      // governs who can authenticate, not what settings they see.
      navItem('users', 'Users', { adminOnly: true, legacyTabId: null }),
      navItem('rate-limits', 'Rate Limits', { adminOnly: true }),
      navItem('sso', 'SSO / OIDC', {
        adminOnly: true,
        enterpriseOnly: true,
      }),
      navItem('ip-allowlist', 'IP allowlist', {
        adminOnly: true,
        enterpriseOnly: true,
        requiresFeature: 'ip_allowlisting',
        legacyTabId: null,
      }),
      navItem('webhooks', 'Webhooks', {
        adminOnly: true,
        enterpriseOnly: true,
        requiresFeature: 'webhook_push',
        legacyTabId: null,
      }),
      navItem('scim', 'SCIM', {
        adminOnly: true,
        enterpriseOnly: true,
        requiresFeature: 'scim_provisioning',
      }),
      navItem('retention', 'Data Retention', {
        adminOnly: true,
        enterpriseOnly: true,
        requiresFeature: 'data_retention_policies',
      }),
    ],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      navItem('license', 'License', { adminOnly: true }),
      navItem('errors', 'Errors', { adminOnly: true }),
      navItem('system', 'System', { adminOnly: true }),
    ],
  },
] as const;

/**
 * Flat map of `?tab=<legacyId>` → canonical `/settings/<category>/<item>` path.
 * Generated from SETTINGS_NAV so there is no duplication.
 */
export const legacyTabMap: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(
    SETTINGS_NAV.flatMap((group) =>
      group.items
        .filter((item) => item.legacyTabId !== null)
        .map((item) => [item.legacyTabId!, `/settings/${group.id}/${item.id}`] as const),
    ),
  ),
);

export interface AccessContext {
  isAdmin: boolean;
  isEnterprise: boolean;
  hasFeature: (featureName: string) => boolean;
}

/**
 * Shared visibility predicate — same rules used today in SettingsPage, centralised
 * so the layout and any future consumer (e.g. a search / command palette) agree.
 *
 * Checks are ordered for short-circuiting from cheapest/synchronous to potentially
 * more expensive lookups: admin flag (sync auth-store read), enterprise flag
 * (cached license context), then feature-flag resolution (may be a remote/cached
 * lookup). Reorder only with measurement.
 */
export function canSeeItem(item: SettingsNavItem, ctx: AccessContext): boolean {
  if (item.adminOnly && !ctx.isAdmin) return false;
  if (item.enterpriseOnly && !ctx.isEnterprise) return false;
  if (item.requiresFeature && !ctx.hasFeature(item.requiresFeature)) return false;
  return true;
}

/**
 * First visible `/settings/<category>/<item>` path for a given user. Used by the
 * index-route redirect so `/settings` always lands on something the user can see.
 */
export function firstVisiblePath(ctx: AccessContext): string {
  for (const group of SETTINGS_NAV) {
    for (const item of group.items) {
      if (canSeeItem(item, ctx)) {
        return `/settings/${group.id}/${item.id}`;
      }
    }
  }
  // Fallback — should be unreachable because `confluence` is always visible.
  return '/settings/personal/confluence';
}
