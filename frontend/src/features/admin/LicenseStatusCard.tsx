import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { m } from 'framer-motion';
import { toast } from 'sonner';
import { Shield, Crown, Users, Calendar, CheckCircle2, XCircle, AlertTriangle, KeyRound, Loader2, Save, Trash2 } from 'lucide-react';
import type { LicenseInfoResponse } from '@compendiq/contracts';
import { apiFetch } from '../../shared/lib/api';
import { cn } from '../../shared/lib/cn';

function useLicenseStatus() {
  return useQuery<LicenseInfoResponse>({
    queryKey: ['admin', 'license'],
    queryFn: () => apiFetch('/admin/license'),
    staleTime: 60_000,
  });
}

const tierConfig: Record<string, { label: string; color: string; bgColor: string; borderColor: string }> = {
  community: {
    label: 'Community',
    color: 'text-zinc-400',
    bgColor: 'bg-zinc-500/10',
    borderColor: 'border-zinc-500/30',
  },
  team: {
    label: 'Team',
    color: 'text-blue-400',
    bgColor: 'bg-blue-500/10',
    borderColor: 'border-blue-500/30',
  },
  business: {
    label: 'Business',
    color: 'text-purple-400',
    bgColor: 'bg-purple-500/10',
    borderColor: 'border-purple-500/30',
  },
  enterprise: {
    label: 'Enterprise',
    color: 'text-amber-400',
    bgColor: 'bg-amber-500/10',
    borderColor: 'border-amber-500/30',
  },
};

export function LicenseStatusCard() {
  const { data, isLoading } = useLicenseStatus();
  const queryClient = useQueryClient();
  const [keyInput, setKeyInput] = useState('');

  const saveMutation = useMutation({
    mutationFn: (key: string) =>
      apiFetch<LicenseInfoResponse>('/admin/license', {
        method: 'PUT',
        body: JSON.stringify({ key }),
      }),
    onSuccess: (result) => {
      queryClient.setQueryData(['admin', 'license'], result);
      setKeyInput('');
      if (result.valid && result.tier !== 'community') {
        toast.success(`License activated — ${result.tier} edition`);
      } else if (!result.valid) {
        toast.error('License key saved but is invalid or expired');
      } else {
        toast.warning('License key saved (community tier)');
      }
    },
    onError: (err) => toast.error(err.message),
  });

  const clearMutation = useMutation({
    mutationFn: () =>
      apiFetch<LicenseInfoResponse>('/admin/license', { method: 'DELETE' }),
    onSuccess: (result) => {
      queryClient.setQueryData(['admin', 'license'], result);
      setKeyInput('');
      toast.success('License key cleared');
    },
    onError: (err) => toast.error(err.message),
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg bg-foreground/5" />
        ))}
      </div>
    );
  }

  const tier = data?.tier ?? 'community';
  const config = (tier in tierConfig ? tierConfig[tier] : tierConfig.community)!;
  const isCommunity = tier === 'community';
  const isValid = data?.valid === true;
  const canUpdate = data?.canUpdate === true;
  const hasStoredKey = Boolean(data?.displayKey && data.displayKey.length > 0);

  const handleSave = () => {
    const trimmed = keyInput.trim();
    if (!trimmed) {
      toast.error('Paste a license key first');
      return;
    }
    saveMutation.mutate(trimmed);
  };

  return (
    <div className="space-y-6" data-testid="license-status">
      {/* Header */}
      <div>
        <h2 className="text-lg font-semibold">License</h2>
        <p className="text-sm text-muted-foreground">
          Your current license tier and available features
        </p>
      </div>

      {/* Tier card */}
      <m.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        className="glass-card overflow-hidden"
      >
        <div className="flex items-center justify-between p-5">
          <div className="flex items-center gap-3">
            <div className={cn(
              'flex h-10 w-10 items-center justify-center rounded-lg',
              config.bgColor,
            )}>
              <Crown size={20} className={config.color} />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-lg font-semibold">{config.label} Edition</span>
                <span className={cn(
                  'inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium',
                  config.borderColor,
                  config.bgColor,
                  config.color,
                )}>
                  {isValid ? 'Active' : isCommunity ? 'Free' : 'Inactive'}
                </span>
              </div>
              {isCommunity && !canUpdate && (
                <p className="text-sm text-muted-foreground">
                  Enterprise features require the EE backend and a valid license key.
                </p>
              )}
              {isCommunity && canUpdate && (
                <p className="text-sm text-muted-foreground">
                  Paste an enterprise license key below to activate paid features.
                </p>
              )}
            </div>
          </div>
        </div>

        {/* Stats */}
        {!isCommunity && (
          <div className="grid grid-cols-2 gap-px border-t border-border/40 bg-border/40">
            <div className="bg-card p-4">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Users size={12} />
                Licensed Seats
              </div>
              <div className="mt-1 text-xl font-semibold">{data?.seats ?? 0}</div>
            </div>
            <div className="bg-card p-4">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Calendar size={12} />
                Expires
              </div>
              <div className="mt-1 text-xl font-semibold">
                {data?.expiresAt ? new Date(data.expiresAt).toLocaleDateString() : 'N/A'}
              </div>
            </div>
          </div>
        )}
      </m.div>

      {/* License key management form — only visible when the responding
          backend declares canUpdate (i.e. the EE plugin is loaded). The CE
          noop fallback omits this flag so community deployments stay clean. */}
      {canUpdate && (
        <div className="glass-card p-5" data-testid="license-key-form">
          <div className="mb-3 flex items-center gap-2">
            <KeyRound size={16} className="text-muted-foreground" />
            <h3 className="text-sm font-medium">License Key</h3>
          </div>
          {hasStoredKey && (
            <div className="mb-3 rounded-md border border-border/40 bg-foreground/5 px-3 py-2 font-mono text-xs text-muted-foreground" data-testid="license-key-display">
              Stored: {data?.displayKey}
            </div>
          )}
          <textarea
            value={keyInput}
            onChange={(e) => setKeyInput(e.target.value)}
            placeholder="ATM-enterprise-50-20271231-CPQ1a2b3.abcd..."
            rows={3}
            className="w-full resize-none rounded-md bg-foreground/5 px-3 py-2 font-mono text-xs outline-none focus:ring-1 focus:ring-primary disabled:opacity-60"
            data-testid="license-key-input"
            disabled={saveMutation.isPending || clearMutation.isPending}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Paste the full license key including the signature after the dot. Stored securely in the backend database.
          </p>
          <div className="mt-3 flex items-center gap-2">
            <button
              onClick={handleSave}
              disabled={!keyInput.trim() || saveMutation.isPending || clearMutation.isPending}
              className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              data-testid="license-key-save-btn"
            >
              {saveMutation.isPending ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Save size={14} />
              )}
              Save Key
            </button>
            {hasStoredKey && (
              <button
                onClick={() => clearMutation.mutate()}
                disabled={saveMutation.isPending || clearMutation.isPending}
                className="flex items-center gap-2 rounded-lg border border-border/50 bg-transparent px-4 py-2 text-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                data-testid="license-key-clear-btn"
              >
                {clearMutation.isPending ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Trash2 size={14} />
                )}
                Clear
              </button>
            )}
          </div>
        </div>
      )}

      {/* Features */}
      <div className="glass-card p-5">
        <h3 className="mb-3 text-sm font-medium">Available Features</h3>
        <div className="space-y-2">
          {[
            { key: 'oidc', label: 'SSO / OIDC Authentication', description: 'Single sign-on with your identity provider' },
            { key: 'audit-export', label: 'Audit Log Export', description: 'Export audit logs for compliance' },
            { key: 'custom-branding', label: 'Custom Branding', description: 'White-label with your organization branding' },
            { key: 'multi-instance', label: 'Multi-Instance', description: 'Deploy multiple isolated instances' },
            { key: 'priority-support', label: 'Priority Support', description: 'Dedicated support channel' },
          ].map((feature) => {
            const isAvailable = data?.features?.includes(feature.key) ?? false;
            return (
              <div
                key={feature.key}
                className="flex items-center justify-between rounded-lg border border-border/30 px-4 py-3"
                data-testid={`feature-${feature.key}`}
              >
                <div className="flex items-center gap-3">
                  <Shield size={16} className={isAvailable ? 'text-emerald-500' : 'text-muted-foreground/40'} />
                  <div>
                    <div className={cn('text-sm font-medium', !isAvailable && 'text-muted-foreground')}>
                      {feature.label}
                    </div>
                    <div className="text-xs text-muted-foreground">{feature.description}</div>
                  </div>
                </div>
                {isAvailable ? (
                  <CheckCircle2 size={16} className="text-emerald-500" />
                ) : (
                  <XCircle size={16} className="text-muted-foreground/30" />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Upgrade notice for community deployments that cannot self-activate
          (i.e. the CE backend is noop — no canUpdate). EE community shows
          the form above instead, which lets the admin paste a key directly. */}
      {isCommunity && !canUpdate && (
        <m.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.2 }}
          className="flex items-start gap-3 rounded-lg border border-amber-500/20 bg-amber-500/5 p-4"
        >
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-500" />
          <div>
            <div className="text-sm font-medium text-amber-200">Upgrade to unlock enterprise features</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Enterprise features like SSO/OIDC, audit log export, and custom branding require a Compendiq enterprise license.
              Contact your administrator or visit the Compendiq website for licensing options.
            </div>
          </div>
        </m.div>
      )}
    </div>
  );
}
