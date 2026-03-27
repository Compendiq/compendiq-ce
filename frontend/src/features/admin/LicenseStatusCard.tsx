import { useQuery } from '@tanstack/react-query';
import { m } from 'framer-motion';
import { Shield, Crown, Users, Calendar, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { apiFetch } from '../../shared/lib/api';
import { cn } from '../../shared/lib/cn';

interface LicenseStatus {
  tier: 'community' | 'team' | 'business' | 'enterprise';
  seats: number;
  expiry: string | null;
  features: string[];
  isValid: boolean;
}

function useLicenseStatus() {
  return useQuery<LicenseStatus>({
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
  const config = tierConfig[tier] ?? tierConfig.community;
  const isCommunity = tier === 'community';

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
                  {data?.isValid ? 'Active' : isCommunity ? 'Free' : 'Inactive'}
                </span>
              </div>
              {isCommunity && (
                <p className="text-sm text-muted-foreground">
                  Set <code className="rounded bg-foreground/10 px-1.5 py-0.5 text-xs">ATLASMIND_LICENSE_KEY</code> to activate enterprise features
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
                {data?.expiry ? new Date(data.expiry).toLocaleDateString() : 'N/A'}
              </div>
            </div>
          </div>
        )}
      </m.div>

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

      {/* Upgrade notice for community */}
      {isCommunity && (
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
              Enterprise features like SSO/OIDC, audit log export, and custom branding require a valid license key.
              Contact your administrator or visit the Compendiq website for licensing options.
            </div>
          </div>
        </m.div>
      )}
    </div>
  );
}
