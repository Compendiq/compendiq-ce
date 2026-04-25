import { useState } from 'react';
import { m } from 'framer-motion';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { apiFetch } from '../../shared/lib/api';
import { useAuthStore } from '../../stores/auth-store';
import { useSettings } from '../../shared/hooks/use-settings';
import { SpacesTab } from './SpacesTab';
import { LabelManager } from './LabelManager';
import { ErrorDashboard } from './ErrorDashboard';
import { ThemeTab } from './ThemeTab';
import { WorkersTab } from './WorkersTab';
import { McpDocsTab } from './McpDocsTab';
import { AiSafetyTab } from './AiSafetyTab';
import { RateLimitsTab } from './RateLimitsTab';
import { SearxngTab } from './SearxngTab';
import { SmtpSettingsTab } from './SmtpSettingsTab';
import { SkeletonFormFields } from '../../shared/components/feedback/Skeleton';
import { LicenseStatusCard } from '../admin/LicenseStatusCard';
import { OidcSettingsPage } from '../admin/OidcSettingsPage';
import { IpAllowlistTab } from '../admin/IpAllowlistTab';
import { WebhooksTab } from '../admin/WebhooksTab';
import { LlmPolicyTab } from '../admin/LlmPolicyTab';
import { DataRetentionTab } from '../admin/DataRetentionTab';
import { LlmAuditPage } from '../admin/LlmAuditPage';
import { ScimSettingsPage } from '../admin/ScimSettingsPage';
import { SyncConflictPolicyTab } from '../admin/SyncConflictPolicyTab';
import { SyncConflictsPage } from '../admin/SyncConflictsPage';
import { AiReviewPolicyTab } from '../admin/AiReviewPolicyTab';
import { ReviewerQueuePage } from '../ai/ReviewerQueuePage';
import { useEnterprise } from '../../shared/enterprise/use-enterprise';
import {
  ConfluenceTab,
  SyncTab,
  LlmTab,
  EmbeddingTab,
  AiPromptsTab,
  SystemTab,
} from './panels';

// Re-export the backward-compatible alias for tests/consumers that import
// `OllamaTab` from the SettingsPage module.
export { OllamaTab } from './panels';

type TabId = 'confluence' | 'sync' | 'sync-conflict-policy' | 'sync-conflicts' | 'ollama' | 'ai-prompts' | 'ai-safety' | 'rate-limits' | 'spaces' | 'theme' | 'labels' | 'errors' | 'embedding' | 'workers' | 'mcp-docs' | 'searxng' | 'email' | 'license' | 'sso' | 'ip-allowlist' | 'webhooks' | 'llm-policy' | 'retention' | 'llm-audit' | 'ai-reviews' | 'ai-review-policy' | 'scim' | 'system';

export function SettingsPage() {
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const isAdmin = user?.role === 'admin';
  const { isEnterprise, hasFeature } = useEnterprise();
  const [activeTab, setActiveTab] = useState<TabId>('confluence');

  const { data: settings, isLoading } = useSettings();

  const updateSettings = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/settings', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['settings'] });
      toast.success('Settings saved');
    },
    onError: (err) => toast.error(err.message),
  });

  const tabs: { id: TabId; label: string; adminOnly?: boolean; enterpriseOnly?: boolean; requiresFeature?: string }[] = [
    { id: 'confluence', label: 'Confluence' },
    { id: 'sync', label: 'Sync' },
    { id: 'sync-conflict-policy', label: 'Sync conflict policy', adminOnly: true, enterpriseOnly: true, requiresFeature: 'sync_conflict_resolution' },
    { id: 'sync-conflicts', label: 'Sync conflicts', adminOnly: true, enterpriseOnly: true, requiresFeature: 'sync_conflict_resolution' },
    { id: 'spaces', label: 'Spaces' },
    { id: 'ollama', label: 'LLM', adminOnly: true },
    { id: 'ai-prompts', label: 'AI Prompts' },
    { id: 'ai-safety', label: 'AI Safety', adminOnly: true },
    { id: 'rate-limits', label: 'Rate Limits', adminOnly: true },
    { id: 'theme', label: 'Theme' },
    { id: 'labels', label: 'Labels', adminOnly: true },
    { id: 'errors', label: 'Errors', adminOnly: true },
    { id: 'embedding', label: 'Embedding', adminOnly: true },
    { id: 'workers', label: 'Workers', adminOnly: true },
    { id: 'mcp-docs', label: 'MCP Docs', adminOnly: true },
    { id: 'searxng', label: 'SearXNG', adminOnly: true },
    { id: 'email', label: 'Email / SMTP', adminOnly: true },
    // License tab is always visible to admins so community users can see their
    // edition status and learn how to upgrade. The SSO tab is gated on a valid
    // enterprise license AND the EE backend (which returns features:['oidc']).
    { id: 'license', label: 'License', adminOnly: true },
    { id: 'sso', label: 'SSO / OIDC', adminOnly: true, enterpriseOnly: true },
    { id: 'ip-allowlist', label: 'IP allowlist', adminOnly: true, enterpriseOnly: true, requiresFeature: 'ip_allowlisting' },
    { id: 'webhooks', label: 'Webhooks', adminOnly: true, enterpriseOnly: true, requiresFeature: 'webhook_push' },
    { id: 'llm-policy', label: 'LLM Policy', adminOnly: true, enterpriseOnly: true, requiresFeature: 'org_llm_policy' },
    { id: 'retention', label: 'Data Retention', adminOnly: true, enterpriseOnly: true, requiresFeature: 'data_retention_policies' },
    { id: 'llm-audit', label: 'LLM Audit', adminOnly: true, enterpriseOnly: true, requiresFeature: 'llm_audit_trail' },
    { id: 'ai-reviews', label: 'AI review queue', adminOnly: true, enterpriseOnly: true, requiresFeature: 'ai_output_review' },
    { id: 'ai-review-policy', label: 'AI review policy', adminOnly: true, enterpriseOnly: true, requiresFeature: 'ai_output_review' },
    { id: 'scim', label: 'SCIM', adminOnly: true, enterpriseOnly: true, requiresFeature: 'scim_provisioning' },
    { id: 'system', label: 'System', adminOnly: true },
  ];

  const visibleTabs = tabs.filter((t) => {
    if (t.adminOnly && !isAdmin) return false;
    if (t.enterpriseOnly && !isEnterprise) return false;
    if (t.requiresFeature && !hasFeature(t.requiresFeature)) return false;
    return true;
  });

  return (
    <m.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
    >
      <h1 className="mb-6 text-2xl font-bold tracking-[-0.01em]">Settings</h1>

      <div className="glass-card">
        {/* Tab bar — Obsidian style: no fill on inactive, inset bottom-border on active */}
        <div className="flex overflow-x-auto border-b border-border/40">
          {visibleTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`whitespace-nowrap px-5 py-2.5 text-sm transition-all duration-150 ${
                activeTab === tab.id
                  ? 'text-foreground shadow-[inset_0_-2px_0_0_var(--color-primary)]'
                  : 'text-muted-foreground hover:bg-foreground/5 hover:text-foreground/80'
              }`}
              data-testid={`tab-${tab.id}`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="p-6">
          {(isLoading || !settings) && activeTab !== 'labels' && activeTab !== 'errors' && activeTab !== 'theme' && activeTab !== 'embedding' && activeTab !== 'sync' && activeTab !== 'sync-conflict-policy' && activeTab !== 'sync-conflicts' && activeTab !== 'workers' && activeTab !== 'mcp-docs' && activeTab !== 'ai-safety' && activeTab !== 'rate-limits' && activeTab !== 'searxng' && activeTab !== 'email' && activeTab !== 'license' && activeTab !== 'sso' && activeTab !== 'ip-allowlist' && activeTab !== 'webhooks' && activeTab !== 'llm-policy' && activeTab !== 'retention' && activeTab !== 'llm-audit' && activeTab !== 'ai-reviews' && activeTab !== 'ai-review-policy' && activeTab !== 'scim' ? (
            <SkeletonFormFields />
          ) : activeTab === 'confluence' ? (
            <ConfluenceTab settings={settings!} onSave={(v) => updateSettings.mutate(v)} />
          ) : activeTab === 'sync' ? (
            <SyncTab />
          ) : activeTab === 'sync-conflict-policy' && isAdmin && isEnterprise ? (
            <SyncConflictPolicyTab />
          ) : activeTab === 'sync-conflicts' && isAdmin && isEnterprise ? (
            <SyncConflictsPage />
          ) : activeTab === 'spaces' ? (
            <SpacesTab
              selectedSpaces={settings?.selectedSpaces ?? []}
              showSpaceHomeContent={settings?.showSpaceHomeContent ?? true}
              onSave={(v) => updateSettings.mutateAsync(v)}
            />
          ) : activeTab === 'ollama' ? (
            <LlmTab />
          ) : activeTab === 'ai-prompts' ? (
            <AiPromptsTab settings={settings!} onSave={(v) => updateSettings.mutate(v)} isAdmin={isAdmin} />
          ) : activeTab === 'ai-safety' && isAdmin ? (
            <AiSafetyTab />
          ) : activeTab === 'rate-limits' && isAdmin ? (
            <RateLimitsTab />
          ) : activeTab === 'theme' ? (
            <ThemeTab onSave={(v) => updateSettings.mutate(v)} />
          ) : activeTab === 'labels' && isAdmin ? (
            <LabelManager />
          ) : activeTab === 'errors' && isAdmin ? (
            <ErrorDashboard />
          ) : activeTab === 'embedding' && isAdmin ? (
            <EmbeddingTab />
          ) : activeTab === 'workers' && isAdmin ? (
            <WorkersTab />
          ) : activeTab === 'mcp-docs' && isAdmin ? (
            <McpDocsTab />
          ) : activeTab === 'searxng' && isAdmin ? (
            <SearxngTab />
          ) : activeTab === 'email' && isAdmin ? (
            <SmtpSettingsTab />
          ) : activeTab === 'license' && isAdmin ? (
            <LicenseStatusCard />
          ) : activeTab === 'sso' && isAdmin && isEnterprise ? (
            <OidcSettingsPage />
          ) : activeTab === 'ip-allowlist' && isAdmin && isEnterprise ? (
            <IpAllowlistTab />
          ) : activeTab === 'webhooks' && isAdmin && isEnterprise ? (
            <WebhooksTab />
          ) : activeTab === 'llm-policy' && isAdmin ? (
            <LlmPolicyTab />
          ) : activeTab === 'retention' && isAdmin ? (
            <DataRetentionTab />
          ) : activeTab === 'llm-audit' && isAdmin ? (
            <LlmAuditPage />
          ) : activeTab === 'ai-reviews' && isAdmin && isEnterprise ? (
            <ReviewerQueuePage />
          ) : activeTab === 'ai-review-policy' && isAdmin && isEnterprise ? (
            <AiReviewPolicyTab />
          ) : activeTab === 'scim' && isAdmin ? (
            <ScimSettingsPage />
          ) : activeTab === 'system' && isAdmin ? (
            <SystemTab />
          ) : (
            null
          )}
        </div>
      </div>
    </m.div>
  );
}
