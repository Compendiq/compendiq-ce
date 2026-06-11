import { lazy, type ComponentType, type ReactElement } from 'react';
import { Link, Navigate, useOutletContext, useParams } from 'react-router-dom';
import { SETTINGS_NAV, canSeeItem, firstVisiblePath } from './settings-nav';
import type { AccessContextWithLoading } from './SettingsLayout';
import { useSettings, useUpdateSettings } from '../../shared/hooks/use-settings';
import { useAuthStore } from '../../stores/auth-store';
import { SkeletonFormFields } from '../../shared/components/feedback/Skeleton';
import type { SettingsResponse } from '@compendiq/contracts';

// ---------------------------------------------------------------------------
// Panel registry — maps `<category>/<item>` → a React.lazy component.
// Each entry produces its own chunk at `npm run build`. Keep this aligned
// with `settings-nav.ts`: if a nav entry exists there, it must have a
// matching key here (enforced at runtime — mismatch renders "unknown panel").
//
// The consolidation pass collapsed several adjacent panels into wrapper
// components that render sub-tabs inside one rail entry.
// ---------------------------------------------------------------------------

const ConfluenceTab = lazy(() => import('./panels/ConfluenceTab').then((m) => ({ default: m.ConfluenceTab })));
const AiPromptsTab = lazy(() => import('./panels/AiPromptsTab').then((m) => ({ default: m.AiPromptsTab })));
const ThemeTab = lazy(() => import('./ThemeTab').then((m) => ({ default: m.ThemeTab })));
const LabelManager = lazy(() => import('./LabelManager').then((m) => ({ default: m.LabelManager })));
const LicenseStatusCard = lazy(() => import('../admin/LicenseStatusCard').then((m) => ({ default: m.LicenseStatusCard })));

const SpacesSyncWrapper = lazy(() => import('./wrappers/SpacesSyncWrapper').then((m) => ({ default: m.SpacesSyncWrapper })));
const AiModelsWrapper = lazy(() => import('./wrappers/AiModelsWrapper').then((m) => ({ default: m.AiModelsWrapper })));
const AiSafetyWrapper = lazy(() => import('./wrappers/AiSafetyWrapper').then((m) => ({ default: m.AiSafetyWrapper })));
const AccessControlWrapper = lazy(() => import('./wrappers/AccessControlWrapper').then((m) => ({ default: m.AccessControlWrapper })));
const ComplianceWrapper = lazy(() => import('./wrappers/ComplianceWrapper').then((m) => ({ default: m.ComplianceWrapper })));
const IntegrationsWrapper = lazy(() => import('./wrappers/IntegrationsWrapper').then((m) => ({ default: m.IntegrationsWrapper })));
const DiagnosticsWrapper = lazy(() => import('./wrappers/DiagnosticsWrapper').then((m) => ({ default: m.DiagnosticsWrapper })));

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
  // Personal
  'personal/confluence': renderWithSettings(ConfluenceTab),
  'personal/ai-prompts': ({ settings, isLoading, onSaveSettings, isAdmin }) => {
    if (isLoading || !settings) return <SkeletonFormFields />;
    return <AiPromptsTab settings={settings} onSave={onSaveSettings} isAdmin={isAdmin} />;
  },
  'personal/theme': ({ onSaveSettings }) => <ThemeTab onSave={onSaveSettings} />,

  // Knowledge
  'knowledge/spaces': ({ settings, isLoading, onSaveSettingsAsync }) => (
    <SpacesSyncWrapper
      settings={settings}
      isLoading={isLoading}
      onSaveSettingsAsync={onSaveSettingsAsync}
    />
  ),
  'knowledge/labels': () => <LabelManager />,

  // AI
  'ai/models': () => <AiModelsWrapper />,
  'ai/ai-safety': () => <AiSafetyWrapper />,

  // Governance
  'governance/access': () => <AccessControlWrapper />,
  'governance/compliance': () => <ComplianceWrapper />,

  // System
  'system/integrations': () => <IntegrationsWrapper />,
  'system/license': () => <LicenseStatusCard />,
  'system/diagnostics': () => <DiagnosticsWrapper />,
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
  const { data: settings, isLoading } = useSettings();
  const updateSettings = useUpdateSettings();

  // Gating check against the live nav config.
  const groupId = category;
  const itemId = item;
  const navItem =
    groupId && itemId
      ? SETTINGS_NAV.find((g) => g.id === groupId)?.items.find((i) => i.id === itemId)
      : undefined;

  // Unknown path — no registered nav item matches (regardless of role).
  // Render a small not-found panel instead of silently redirecting, so a
  // typoed or stale bookmark is visible rather than confusing. Registered
  // items the user merely cannot see (adminOnly / EE-gated) keep the
  // redirect below.
  if (!navItem || !PANELS[key]) {
    return (
      <section className="space-y-3" data-testid="settings-panel-not-found">
        <h2 className="text-xl font-semibold tracking-[-0.01em]">
          {"This settings page doesn't exist."}
        </h2>
        <p className="text-sm text-muted-foreground">
          The address may be mistyped, or the panel may have moved.
        </p>
        <Link to={firstVisiblePath(ctx)} className="inline-block text-sm font-medium text-action underline">
          Go to Settings
        </Link>
      </section>
    );
  }

  // Defer the EE-gated redirect until the /admin/license fetch resolves.
  // Without this, a cold deep-link like `/settings/governance/compliance` by
  // an EE admin races the license fetch — `useEnterprise()` returns
  // `{ isEnterprise: false, hasFeature: () => false }` for ~50–200ms, and the
  // gate fires before the real license lands, redirecting the user away
  // from their bookmarked URL.
  const needsEnterpriseResolution = !!(navItem.enterpriseOnly || navItem.requiresFeature);
  if (needsEnterpriseResolution && ctx.isEnterpriseLoading) {
    return <SkeletonFormFields />;
  }

  if (!canSeeItem(navItem, ctx)) {
    return <Navigate to={firstVisiblePath(ctx)} replace />;
  }

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
