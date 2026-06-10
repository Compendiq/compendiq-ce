/**
 * Settings IA — single source of truth for the left-rail navigation.
 *
 * Used by:
 *   - SettingsSidebar (rendering the <nav> landmark with grouped links)
 *   - App.tsx route config (generating child routes with per-panel lazy imports)
 *
 * Category/item IDs are the URL segments: `/settings/<category>/<item>`.
 * Items that contain multiple sub-panels render them as in-page sub-tabs
 * (see SubTabs.tsx).
 *
 * Consolidation rationale: the previous IA exposed 6 groups × ~32 items,
 * with many adjacent panels (Spaces / Sync, LLM / Embedding / Workers,
 * etc.) that are conceptually one configuration surface. Collapsing them
 * into wrapper-with-sub-tabs panels shrinks the rail to 5 groups × ~12
 * items without touching the underlying panel components.
 */

import { CONFLUENCE_SETTINGS_PATH } from '../../shared/lib/routes';

type SettingsCategoryId =
  | 'personal'
  | 'knowledge'
  | 'ai'
  | 'governance'
  | 'system';

export interface SettingsNavItem {
  /** URL segment. */
  id: string;
  /** Human label shown in the rail. */
  label: string;
  adminOnly?: boolean;
  enterpriseOnly?: boolean;
  /** Enterprise feature-flag name required to render. Paired with `enterpriseOnly: true`. */
  requiresFeature?: string;
}

interface SettingsNavGroup {
  id: SettingsCategoryId;
  label: string;
  items: SettingsNavItem[];
}

function navItem(
  id: string,
  label: string,
  options: Omit<SettingsNavItem, 'id' | 'label'> = {},
): SettingsNavItem {
  return { id, label, ...options };
}

/**
 * Grouped nav config. Order within each group controls rail rendering order;
 * order of groups controls top-to-bottom rail order.
 */
export const SETTINGS_NAV: readonly SettingsNavGroup[] = [
  {
    id: 'personal',
    label: 'Personal',
    items: [
      navItem('confluence', 'Confluence'),
      navItem('ai-prompts', 'AI Prompts'),
      navItem('theme', 'Appearance'),
    ],
  },
  {
    id: 'knowledge',
    label: 'Knowledge',
    items: [
      // Wrapper: Spaces / Sync / Conflict Policy (EE) / Conflicts (EE).
      navItem('spaces', 'Spaces & Sync'),
      navItem('labels', 'Labels', { adminOnly: true }),
    ],
  },
  {
    id: 'ai',
    label: 'AI',
    items: [
      // Wrapper: LLM / Embedding / Workers.
      navItem('models', 'AI Models', { adminOnly: true }),
      // Wrapper: AI Safety / LLM Policy (EE) / PII (EE) / Review Queue (EE) /
      // Review Policy (EE) / LLM Audit (EE). The first sub-tab (AI Safety)
      // is CE so the wrapper is admin-visible in CE; EE tabs reveal as
      // licensing turns on.
      navItem('ai-safety', 'AI Safety', { adminOnly: true }),
    ],
  },
  {
    id: 'governance',
    label: 'Governance',
    items: [
      // Wrapper: Users / RBAC (EE) / SSO (EE) / IP Allowlist (EE) /
      // Rate Limits. Users + Rate Limits are CE; the rest reveal in EE.
      navItem('access', 'Access Control', { adminOnly: true }),
      // Wrapper: Data Retention (EE) / Compliance Reports (EE) /
      // Webhooks (EE) / SCIM (EE). All-EE wrapper — hidden in CE.
      navItem('compliance', 'Data & Compliance', {
        adminOnly: true,
        enterpriseOnly: true,
      }),
    ],
  },
  {
    id: 'system',
    label: 'System',
    items: [
      // Wrapper: Email / SMTP, SearXNG, MCP Docs.
      navItem('integrations', 'Integrations', { adminOnly: true }),
      navItem('license', 'License', { adminOnly: true }),
      // Wrapper: System status / Errors.
      navItem('diagnostics', 'Diagnostics', { adminOnly: true }),
    ],
  },
] as const;

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
  return CONFLUENCE_SETTINGS_PATH;
}
