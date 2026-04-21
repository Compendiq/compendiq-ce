import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { m } from 'framer-motion';
import { toast } from 'sonner';
import {
  Database, Loader2, Save, AlertTriangle, Trash2, Eye, ShieldAlert,
} from 'lucide-react';
import type { AdminSettings } from '@compendiq/contracts';
import { apiFetch } from '../../shared/lib/api';
import { cn } from '../../shared/lib/cn';
import { useEnterprise } from '../../shared/enterprise/use-enterprise';

// ── Types (match backend data-retention-service.ts) ───────────────────────────

interface RetentionPolicy {
  tableName: string;
  displayName: string;
  retentionDays: number; // 0 means "keep forever"
  enabled: boolean;
}

interface RetentionConfig {
  policies: RetentionPolicy[];
  extendedRetentionEnabled: boolean;
  extendedRetentionDays: number;
}

interface RetentionPreview {
  tableName: string;
  displayName: string;
  retentionDays: number;
  estimatedRows: number;
}

interface PurgeResponse {
  results: Array<{ tableName: string; displayName: string; deletedRows: number }>;
}

// ── Hooks ──────────────────────────────────────────────────────────────────────

function useRetentionConfig() {
  return useQuery<RetentionConfig>({
    queryKey: ['admin', 'data-retention'],
    queryFn: () => apiFetch('/admin/data-retention'),
    staleTime: 30_000,
  });
}

// ── CE-native: ADMIN_ACCESS_DENIED retention (#264) ────────────────────────
//
// This section is rendered in BOTH CE and EE — the Enterprise-gated
// policy-matrix sits below the feature-gate, but the targeted retention
// window for denial-audit rows is a CE-level safety control (a single admin
// setting under `admin_settings.admin_access_denied_retention_days` +
// `data-retention-service` sweep). Lives here because semantically it is a
// data-retention knob; matches the plan's file pointer.

function AdminAccessDeniedRetentionSection() {
  const queryClient = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => apiFetch<AdminSettings>('/admin/settings'),
  });

  const [draft, setDraft] = useState<number | undefined>(undefined);

  const serverValue = settings?.adminAccessDeniedRetentionDays ?? 90;
  const effective = draft ?? serverValue;
  const hasChange = draft !== undefined && draft !== serverValue;

  const save = useMutation({
    mutationFn: (value: number) =>
      apiFetch('/admin/settings', {
        method: 'PUT',
        body: JSON.stringify({ adminAccessDeniedRetentionDays: value }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin-settings'] });
      setDraft(undefined);
      toast.success('Denied-admin retention updated');
    },
    onError: (err) => toast.error(err.message),
  });

  if (isLoading) {
    return (
      <div className="glass-card p-4" data-testid="denied-admin-retention-loading">
        <div className="h-10 animate-pulse rounded bg-foreground/5" />
      </div>
    );
  }

  return (
    <div className="glass-card p-4" data-testid="denied-admin-retention-section">
      <div className="flex items-start gap-3">
        <ShieldAlert size={18} className="mt-0.5 shrink-0 text-muted-foreground" />
        <div className="flex-1">
          <label
            htmlFor="admin-denied-retention-input"
            className="block text-sm font-medium"
          >
            Admin access-denied audit retention (days)
          </label>
          <p className="mt-1 text-xs text-muted-foreground">
            Automated purge of <code className="rounded bg-foreground/10 px-1">audit_log</code>{' '}
            rows recorded when non-admins attempted admin endpoints
            (action = <code className="rounded bg-foreground/10 px-1">ADMIN_ACCESS_DENIED</code>).
            Default 90 days. Applies only to these rows; other audit events
            retain their own retention.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <input
              id="admin-denied-retention-input"
              type="number"
              min={7}
              max={3650}
              step={1}
              value={effective}
              onChange={(e) => setDraft(Number(e.target.value))}
              className="w-28 rounded-md bg-foreground/5 px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-primary"
              data-testid="admin-denied-retention-input"
            />
            <button
              type="button"
              onClick={() => draft !== undefined && save.mutate(draft)}
              disabled={!hasChange || save.isPending}
              className="flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              data-testid="admin-denied-retention-save-btn"
            >
              {save.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────────────────

export function DataRetentionTab() {
  const queryClient = useQueryClient();
  const { hasFeature } = useEnterprise();
  const { data: config, isLoading } = useRetentionConfig();

  const [policies, setPolicies] = useState<RetentionPolicy[]>([]);
  const [extendedRetentionEnabled, setExtendedRetentionEnabled] = useState(false);
  const [extendedRetentionDays, setExtendedRetentionDays] = useState(365);
  const [initialized, setInitialized] = useState(false);
  const [preview, setPreview] = useState<RetentionPreview[] | null>(null);
  const [purgeConfirm, setPurgeConfirm] = useState('');
  const [showPurgeDialog, setShowPurgeDialog] = useState(false);

  const featureEnabled = hasFeature('data_retention_policies');

  // Populate form when data loads
  if (config && !initialized) {
    setPolicies(config.policies ?? []);
    setExtendedRetentionEnabled(Boolean(config.extendedRetentionEnabled));
    setExtendedRetentionDays(config.extendedRetentionDays ?? 365);
    setInitialized(true);
  }

  const saveMutation = useMutation({
    mutationFn: () =>
      apiFetch('/admin/data-retention', {
        method: 'PUT',
        body: JSON.stringify({
          policies: policies.map((p) => ({
            tableName: p.tableName,
            retentionDays: p.retentionDays,
          })),
          extendedRetentionEnabled,
          extendedRetentionDays,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'data-retention'] });
      toast.success('Retention policy saved');
    },
    onError: (err) => toast.error(err.message),
  });

  const previewMutation = useMutation({
    mutationFn: () => apiFetch<RetentionPreview[]>('/admin/data-retention/preview'),
    onSuccess: (data) => setPreview(data),
    onError: (err) => toast.error(err.message),
  });

  const purgeMutation = useMutation({
    mutationFn: () =>
      apiFetch<PurgeResponse>('/admin/data-retention/purge', { method: 'POST' }),
    onSuccess: (data) => {
      const totalDeleted = data.results?.reduce((s, r) => s + Math.max(0, r.deletedRows), 0) ?? 0;
      toast.success(`Data purge completed — ${totalDeleted.toLocaleString()} rows deleted`);
      setShowPurgeDialog(false);
      setPurgeConfirm('');
      setPreview(null);
      queryClient.invalidateQueries({ queryKey: ['admin', 'data-retention'] });
    },
    onError: (err) => toast.error(err.message),
  });

  const handlePolicyChange = useCallback(
    (index: number, field: 'retentionDays' | 'enabled', value: unknown) => {
      setPolicies((prev) =>
        prev.map((p, i) => {
          if (i !== index) return p;
          if (field === 'retentionDays') {
            const days = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
            return { ...p, retentionDays: days, enabled: days > 0 };
          }
          if (field === 'enabled') {
            return { ...p, enabled: Boolean(value) };
          }
          return p;
        }),
      );
    },
    [],
  );

  const handleSave = useCallback(() => {
    saveMutation.mutate();
  }, [saveMutation]);

  if (!featureEnabled) {
    return (
      <div className="space-y-6">
        {/* #264 — denied-admin retention is a CE-level control and renders
            irrespective of the Enterprise feature gate below. */}
        <AdminAccessDeniedRetentionSection />
        <div data-testid="data-retention-gated">
          <m.div
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            className="flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-4"
          >
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-500" />
            <div>
              <div className="text-sm font-medium text-amber-200">Enterprise Feature</div>
              <div className="mt-1 text-xs text-muted-foreground">
                Extended multi-table retention policies, preview, and on-demand purge
                require an enterprise license with the Data Retention feature enabled.
              </div>
            </div>
          </m.div>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="space-y-4" data-testid="data-retention-loading">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg bg-foreground/5" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="data-retention-form">
      {/* #264 — CE-native denied-admin retention control. Rendered first so
          the setting is consistent across CE and EE — the EE matrix below
          covers different tables + policy-matrix features. */}
      <AdminAccessDeniedRetentionSection />

      {/* Header */}
      <div>
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <Database size={18} className="text-muted-foreground" />
          Data Retention Policies
        </h2>
        <p className="text-sm text-muted-foreground">
          Configure how long data is kept in each table before automatic cleanup. Set retention to 0 to keep rows forever.
        </p>
      </div>

      {/* Extended retention */}
      <div className="glass-card space-y-3 p-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={extendedRetentionEnabled}
            onChange={(e) => setExtendedRetentionEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-border accent-primary"
            data-testid="extended-retention-toggle"
          />
          <span className="font-medium">Extended retention mode</span>
        </label>
        <p className="ml-6 text-xs text-muted-foreground">
          When enabled, retention for the LLM audit log is extended (up to 7 years) for compliance-heavy environments.
        </p>
        <div className={cn('ml-6 flex items-center gap-2', !extendedRetentionEnabled && 'opacity-50')}>
          <label htmlFor="extended-retention-days" className="text-xs font-medium text-muted-foreground">
            Extended retention (days)
          </label>
          <input
            id="extended-retention-days"
            type="number"
            min={1}
            max={2555}
            value={extendedRetentionDays}
            onChange={(e) => setExtendedRetentionDays(parseInt(e.target.value, 10) || 1)}
            disabled={!extendedRetentionEnabled}
            className="w-28 rounded-md bg-foreground/5 px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-primary disabled:cursor-not-allowed"
            data-testid="extended-retention-days-input"
          />
        </div>
      </div>

      {/* Per-table rules */}
      {policies.length > 0 ? (
        <div className="glass-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                <th className="px-4 py-3 font-medium">Table</th>
                <th className="px-4 py-3 font-medium">Retention (days)</th>
                <th className="px-4 py-3 font-medium">Enabled</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30" data-testid="retention-rules-table">
              {policies.map((policy, i) => (
                <tr key={policy.tableName} className="hover:bg-foreground/5">
                  <td className="px-4 py-2.5">
                    <div className="text-sm">{policy.displayName}</div>
                    <div className="font-mono text-xs text-muted-foreground">{policy.tableName}</div>
                  </td>
                  <td className="px-4 py-2.5">
                    <input
                      type="number"
                      value={policy.retentionDays}
                      onChange={(e) =>
                        handlePolicyChange(i, 'retentionDays', parseInt(e.target.value, 10) || 0)
                      }
                      placeholder="0 = keep forever"
                      min={0}
                      max={3650}
                      className="w-28 rounded-md bg-foreground/5 px-2 py-1 text-sm outline-none focus:ring-1 focus:ring-primary"
                      data-testid={`retention-days-${policy.tableName}`}
                    />
                  </td>
                  <td className="px-4 py-2.5">
                    <span
                      className={cn(
                        'rounded px-2 py-0.5 text-xs font-medium',
                        policy.enabled
                          ? 'bg-emerald-500/10 text-emerald-400'
                          : 'bg-foreground/10 text-muted-foreground',
                      )}
                      data-testid={`retention-enabled-${policy.tableName}`}
                    >
                      {policy.enabled ? 'On' : 'Keep forever'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="glass-card py-12 text-center text-sm text-muted-foreground">
          No retention rules configured.
        </div>
      )}

      {/* Preview section */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => previewMutation.mutate()}
          disabled={previewMutation.isPending}
          className="flex items-center gap-2 rounded-lg bg-foreground/5 px-4 py-2 text-sm hover:bg-foreground/10 disabled:opacity-50"
          data-testid="preview-purge-btn"
        >
          {previewMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Eye size={14} />}
          Preview Affected Rows
        </button>
        <button
          type="button"
          onClick={() => setShowPurgeDialog(true)}
          className="flex items-center gap-2 rounded-lg bg-destructive/10 px-4 py-2 text-sm text-destructive hover:bg-destructive/20 disabled:opacity-50"
          data-testid="purge-btn"
        >
          <Trash2 size={14} />
          Purge Now
        </button>
      </div>

      {/* Preview results */}
      {preview && (
        <m.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          className="glass-card overflow-hidden"
          data-testid="preview-results"
        >
          <div className="border-b border-border/50 px-4 py-2.5 text-xs font-medium text-muted-foreground">
            Dry Run — rows that would be deleted
          </div>
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                <th className="px-4 py-2 font-medium">Table</th>
                <th className="px-4 py-2 font-medium">Retention (days)</th>
                <th className="px-4 py-2 font-medium">Rows</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {preview.map((row) => (
                <tr key={row.tableName}>
                  <td className="px-4 py-2">
                    <div className="text-sm">{row.displayName}</div>
                    <div className="font-mono text-xs text-muted-foreground">{row.tableName}</div>
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {row.retentionDays === 0 ? 'forever' : row.retentionDays}
                  </td>
                  <td className="px-4 py-2">
                    <span className={cn(
                      'rounded px-2 py-0.5 text-xs font-medium',
                      row.estimatedRows < 0
                        ? 'bg-destructive/10 text-destructive'
                        : row.estimatedRows > 0
                          ? 'bg-amber-500/10 text-amber-400'
                          : 'bg-emerald-500/10 text-emerald-400',
                    )}>
                      {row.estimatedRows < 0 ? 'error' : row.estimatedRows.toLocaleString()}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </m.div>
      )}

      {/* Purge confirmation dialog (inline) */}
      {showPurgeDialog && (
        <m.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 space-y-3"
          data-testid="purge-confirm-dialog"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle size={18} className="mt-0.5 shrink-0 text-destructive" />
            <div>
              <div className="text-sm font-medium text-destructive">Destructive Action</div>
              <div className="mt-1 text-xs text-muted-foreground">
                This will permanently delete data matching the current retention policy. This action cannot be undone.
              </div>
            </div>
          </div>
          <div>
            <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
              Type <strong>PURGE</strong> to confirm
            </label>
            <input
              type="text"
              value={purgeConfirm}
              onChange={(e) => setPurgeConfirm(e.target.value)}
              placeholder="PURGE"
              className="w-48 rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-destructive"
              data-testid="purge-confirm-input"
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => purgeMutation.mutate()}
              disabled={purgeConfirm !== 'PURGE' || purgeMutation.isPending}
              className="flex items-center gap-2 rounded-md bg-destructive px-3 py-1.5 text-sm text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
              data-testid="purge-confirm-btn"
            >
              {purgeMutation.isPending && <Loader2 size={14} className="animate-spin" />}
              Confirm Purge
            </button>
            <button
              type="button"
              onClick={() => { setShowPurgeDialog(false); setPurgeConfirm(''); }}
              className="rounded-md bg-foreground/5 px-3 py-1.5 text-sm hover:bg-foreground/10"
            >
              Cancel
            </button>
          </div>
        </m.div>
      )}

      {/* Save button */}
      <div className="flex items-center justify-end border-t border-border/50 pt-4">
        <button
          onClick={handleSave}
          disabled={saveMutation.isPending}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          data-testid="data-retention-save-btn"
        >
          {saveMutation.isPending ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
          Save Policy
        </button>
      </div>
    </div>
  );
}
