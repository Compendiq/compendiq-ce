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
 * Grouped nav config. The order within each group controls rail rendering order;
 * the order of groups controls top-to-bottom rail order.
 */
export const SETTINGS_NAV: readonly SettingsNavGroup[] = [
  {
    id: 'personal',
    label: 'Personal',
    items: [
      { id: 'confluence', label: 'Confluence', legacyTabId: 'confluence' },
      { id: 'ai-prompts', label: 'AI Prompts', legacyTabId: 'ai-prompts' },
      { id: 'theme', label: 'Theme', legacyTabId: 'theme' },
    ],
  },
  {
    id: 'content',
    label: 'Content',
    items: [
      { id: 'spaces', label: 'Spaces', legacyTabId: 'spaces' },
      { id: 'sync', label: 'Sync', legacyTabId: 'sync' },
      { id: 'labels', label: 'Labels', legacyTabId: 'labels', adminOnly: true },
    ],
  },
  {
    id: 'ai',
    label: 'AI',
    items: [
      // NOTE: the legacy `?tab=ollama` URL maps here. The URL segment is now
      // `llm` because the panel is provider-agnostic (Ollama + OpenAI).
      { id: 'llm', label: 'LLM', legacyTabId: 'ollama', adminOnly: true },
      { id: 'embedding', label: 'Embedding', legacyTabId: 'embedding', adminOnly: true },
      { id: 'ai-safety', label: 'AI Safety', legacyTabId: 'ai-safety', adminOnly: true },
      { id: 'workers', label: 'Workers', legacyTabId: 'workers', adminOnly: true },
      {
        id: 'llm-policy',
        label: 'LLM Policy',
        legacyTabId: 'llm-policy',
        adminOnly: true,
        enterpriseOnly: true,
        requiresFeature: 'org_llm_policy',
      },
      {
        id: 'llm-audit',
        label: 'LLM Audit',
        legacyTabId: 'llm-audit',
        adminOnly: true,
        enterpriseOnly: true,
        requiresFeature: 'llm_audit_trail',
      },
    ],
  },
  {
    id: 'integrations',
    label: 'Integrations',
    items: [
      { id: 'email', label: 'Email / SMTP', legacyTabId: 'email', adminOnly: true },
      { id: 'searxng', label: 'SearXNG', legacyTabId: 'searxng', adminOnly: true },
      { id: 'mcp-docs', label: 'MCP Docs', legacyTabId: 'mcp-docs', adminOnly: true },
    ],
  },
  {
    id: 'security',
    label: 'Security & Access',
    items: [
      { id: 'rate-limits', label: 'Rate Limits', legacyTabId: 'rate-limits', adminOnly: true },
      {
        id: 'sso',
        label: 'SSO / OIDC',
        legacyTabId: 'sso',
        adminOnly: true,
        enterpriseOnly: true,
      },
      {
        id: 'scim',
        label: 'SCIM',
        legacyTabId: 'scim',
        adminOnly: true,
        enterpriseOnly: true,
        requiresFeature: 'scim_provisioning',
      },
      {
        id: 'retention',
        label: 'Data Retention',
        legacyTabId: 'retention',
        adminOnly: true,
        enterpriseOnly: true,
        requiresFeature: 'data_retention_policies',
      },
    ],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      { id: 'license', label: 'License', legacyTabId: 'license', adminOnly: true },
      { id: 'errors', label: 'Errors', legacyTabId: 'errors', adminOnly: true },
      { id: 'system', label: 'System', legacyTabId: 'system', adminOnly: true },
    ],
  },
] as const;

/**
 * Flat map of `?tab=<legacyId>` → canonical `/settings/<category>/<item>` path.
 * Generated from SETTINGS_NAV so there is no duplication.
 */
export const legacyTabMap: Readonly<Record<string, string>> = Object.freeze(
  SETTINGS_NAV.flatMap((group) =>
    group.items
      .filter((item) => item.legacyTabId !== null)
      .map((item) => [item.legacyTabId!, `/settings/${group.id}/${item.id}`] as const),
  ).reduce<Record<string, string>>((acc, [legacyId, path]) => {
    acc[legacyId] = path;
    return acc;
  }, {}),
);

export interface AccessContext {
  isAdmin: boolean;
  isEnterprise: boolean;
  hasFeature: (featureName: string) => boolean;
}

/**
 * Shared visibility predicate — same rules used today in SettingsPage, centralised
 * so the layout and any future consumer (e.g. a search / command palette) agree.
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
