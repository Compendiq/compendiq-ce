import { lazy, type ComponentType, type ReactElement } from 'react';
import { Navigate, useOutletContext, useParams } from 'react-router-dom';
import { SETTINGS_NAV, canSeeItem, firstVisiblePath } from './settings-nav';
import type { AccessContextWithLoading } from './SettingsLayout';
import { useSettings } from '../../shared/hooks/use-settings';
import { useAuthStore } from '../../stores/auth-store';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from '../../shared/lib/api';
import { toast } from 'sonner';
import { SkeletonFormFields } from '../../shared/components/feedback/Skeleton';
import type { SettingsResponse } from '@compendiq/contracts';

// ---------------------------------------------------------------------------
// Panel registry — maps `<category>/<item>` → a React.lazy component.
// Each entry produces its own chunk at `npm run build`. Keep this aligned
// with `settings-nav.ts`: if a nav entry exists there, it must have a
// matching key here (enforced at runtime — mismatch renders "unknown panel").
// ---------------------------------------------------------------------------

const ConfluenceTab = lazy(() => import('./panels/ConfluenceTab').then((m) => ({ default: m.ConfluenceTab })));
const SyncTab = lazy(() => import('./panels/SyncTab').then((m) => ({ default: m.SyncTab })));
const SpacesTab = lazy(() => import('./SpacesTab').then((m) => ({ default: m.SpacesTab })));
const LlmTab = lazy(() => import('./panels/LlmTab').then((m) => ({ default: m.LlmTab })));
const AiPromptsTab = lazy(() => import('./panels/AiPromptsTab').then((m) => ({ default: m.AiPromptsTab })));
const AiSafetyTab = lazy(() => import('./AiSafetyTab').then((m) => ({ default: m.AiSafetyTab })));
const RateLimitsTab = lazy(() => import('./RateLimitsTab').then((m) => ({ default: m.RateLimitsTab })));
const ThemeTab = lazy(() => import('./ThemeTab').then((m) => ({ default: m.ThemeTab })));
const LabelManager = lazy(() => import('./LabelManager').then((m) => ({ default: m.LabelManager })));
const ErrorDashboard = lazy(() => import('./ErrorDashboard').then((m) => ({ default: m.ErrorDashboard })));
const EmbeddingTab = lazy(() => import('./panels/EmbeddingTab').then((m) => ({ default: m.EmbeddingTab })));
const WorkersTab = lazy(() => import('./WorkersTab').then((m) => ({ default: m.WorkersTab })));
const McpDocsTab = lazy(() => import('./McpDocsTab').then((m) => ({ default: m.McpDocsTab })));
const SearxngTab = lazy(() => import('./SearxngTab').then((m) => ({ default: m.SearxngTab })));
const SmtpSettingsTab = lazy(() => import('./SmtpSettingsTab').then((m) => ({ default: m.SmtpSettingsTab })));
const LicenseStatusCard = lazy(() => import('../admin/LicenseStatusCard').then((m) => ({ default: m.LicenseStatusCard })));
const OidcSettingsPage = lazy(() => import('../admin/OidcSettingsPage').then((m) => ({ default: m.OidcSettingsPage })));
const IpAllowlistTab = lazy(() => import('../admin/IpAllowlistTab').then((m) => ({ default: m.IpAllowlistTab })));
const WebhooksTab = lazy(() => import('../admin/WebhooksTab').then((m) => ({ default: m.WebhooksTab })));
const LlmPolicyTab = lazy(() => import('../admin/LlmPolicyTab').then((m) => ({ default: m.LlmPolicyTab })));
const DataRetentionTab = lazy(() => import('../admin/DataRetentionTab').then((m) => ({ default: m.DataRetentionTab })));
const LlmAuditPage = lazy(() => import('../admin/LlmAuditPage').then((m) => ({ default: m.LlmAuditPage })));
const ScimSettingsPage = lazy(() => import('../admin/ScimSettingsPage').then((m) => ({ default: m.ScimSettingsPage })));
const UsersAdminPage = lazy(() => import('../admin/UsersAdminPage').then((m) => ({ default: m.UsersAdminPage })));
const SyncConflictPolicyTab = lazy(() => import('../admin/SyncConflictPolicyTab').then((m) => ({ default: m.SyncConflictPolicyTab })));
const SyncConflictsPage = lazy(() => import('../admin/SyncConflictsPage').then((m) => ({ default: m.SyncConflictsPage })));
const AiReviewPolicyTab = lazy(() => import('../admin/AiReviewPolicyTab').then((m) => ({ default: m.AiReviewPolicyTab })));
const ReviewerQueuePage = lazy(() => import('../ai/ReviewerQueuePage').then((m) => ({ default: m.ReviewerQueuePage })));
const SystemTab = lazy(() => import('./panels/SystemTab').then((m) => ({ default: m.SystemTab })));

type PanelRenderer = (ctx: PanelRenderContext) => ReactElement;

interface PanelRenderContext {
  settings: SettingsResponse | undefined;
  isLoading: boolean;
  onSaveSettings: (body: Record<string, unknown>) => void;
  onSaveSettingsAsync: (body: Record<string, unknown>) => Promise<unknown>;
  isAdmin: boolean;
}

const renderWithSettings = (Component: ComponentType<{ settings: SettingsResponse; onSave: (v: Record<string, unknown>) => void }>): PanelRenderer => ({
  settings,
  isLoading,
  onSaveSettings,
}) => {
  if (isLoading || !settings) return <SkeletonFormFields />;
  return <Component settings={settings} onSave={onSaveSettings} />;
};

// Map of `<category>/<item>` → panel renderer. Keep in sync with settings-nav.ts.
const PANELS: Readonly<Record<string, PanelRenderer>> = {
  'personal/confluence': renderWithSettings(ConfluenceTab),
  'personal/ai-prompts': ({ settings, isLoading, onSaveSettings, isAdmin }) => {
    if (isLoading || !settings) return <SkeletonFormFields />;
    return <AiPromptsTab settings={settings} onSave={onSaveSettings} isAdmin={isAdmin} />;
  },
  'personal/theme': ({ onSaveSettings }) => <ThemeTab onSave={onSaveSettings} />,

  'content/spaces': ({ settings, isLoading, onSaveSettingsAsync }) => {
    if (isLoading || !settings) return <SkeletonFormFields />;
    return (
      <SpacesTab
        selectedSpaces={settings.selectedSpaces ?? []}
        showSpaceHomeContent={settings.showSpaceHomeContent ?? true}
        onSave={onSaveSettingsAsync}
      />
    );
  },
  'content/sync': () => <SyncTab />,
  'content/sync-conflict-policy': () => <SyncConflictPolicyTab />,
  'content/sync-conflicts': () => <SyncConflictsPage />,
  'content/labels': () => <LabelManager />,

  'ai/llm': () => <LlmTab />,
  'ai/embedding': () => <EmbeddingTab />,
  'ai/ai-safety': () => <AiSafetyTab />,
  'ai/workers': () => <WorkersTab />,
  'ai/llm-policy': () => <LlmPolicyTab />,
  'ai/llm-audit': () => <LlmAuditPage />,
  'ai/ai-reviews': () => <ReviewerQueuePage />,
  'ai/ai-review-policy': () => <AiReviewPolicyTab />,

  'integrations/email': () => <SmtpSettingsTab />,
  'integrations/searxng': () => <SearxngTab />,
  'integrations/mcp-docs': () => <McpDocsTab />,

  'security/users': () => <UsersAdminPage />,
  'security/rate-limits': () => <RateLimitsTab />,
  'security/sso': () => <OidcSettingsPage />,
  'security/ip-allowlist': () => <IpAllowlistTab />,
  'security/webhooks': () => <WebhooksTab />,
  'security/scim': () => <ScimSettingsPage />,
  'security/retention': () => <DataRetentionTab />,

  'system/license': () => <LicenseStatusCard />,
  'system/errors': () => <ErrorDashboard />,
  'system/system': () => <SystemTab />,
};

/**
 * Rendered at `/settings/:category/:item`. Resolves the panel from params,
 * enforces gating against the nav config, and bounces unknown or
 * forbidden paths to the first visible panel.
 */
export function SettingsPanelRoute() {
  const { category, item } = useParams();
  const ctx = useOutletContext<AccessContextWithLoading>();
  const key = `${category ?? ''}/${item ?? ''}`;

  const user = useAuthStore((s) => s.user);
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useSettings();

  const updateSettings = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/settings', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success('Settings saved');
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // Gating check: confirm the item in the URL corresponds to a nav entry the
  // user is allowed to see. This covers:
  //   - unknown /settings/foo/bar paths (typos, stale bookmarks)
  //   - an admin-only item accessed by a non-admin via direct URL
  //   - a feature-flagged item accessed without the feature (downgraded plan)
  const groupId = category;
  const itemId = item;
  const navItem =
    groupId && itemId
      ? SETTINGS_NAV.find((g) => g.id === groupId)?.items.find((i) => i.id === itemId)
      : undefined;

  // Unknown path — bounce immediately (nothing to load, nothing to wait for).
  if (!navItem || !PANELS[key]) {
    return <Navigate to={firstVisiblePath(ctx)} replace />;
  }

  // Defer the EE-gated redirect until the /admin/license fetch resolves.
  // Without this, a cold deep-link like `/settings/ai/llm-policy` by an EE
  // admin races the license fetch — `useEnterprise()` returns
  // `{ isEnterprise: false, hasFeature: () => false }` for ~50–200ms, and the
  // gate fires before the real license lands, redirecting the user away
  // from their bookmarked URL. Admin-only (but not EE-only) items don't hit
  // this path — `isAdmin` is synchronous from the auth store.
  const needsEnterpriseResolution = !!(navItem.enterpriseOnly || navItem.requiresFeature);
  if (needsEnterpriseResolution && ctx.isEnterpriseLoading) {
    return <SkeletonFormFields />;
  }

  if (!canSeeItem(navItem, ctx)) {
    return <Navigate to={firstVisiblePath(ctx)} replace />;
  }

  // Also guard on auth store: if user logged out mid-session, bounce.
  if (!user) return <Navigate to="/login" replace />;

  const render = PANELS[key];
  return render({
    settings,
    isLoading,
    onSaveSettings: (body) => updateSettings.mutate(body),
    onSaveSettingsAsync: (body) => updateSettings.mutateAsync(body),
    isAdmin: ctx.isAdmin,
  });
}
