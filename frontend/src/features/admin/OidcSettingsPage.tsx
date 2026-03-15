import { useState, useCallback } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { m } from 'framer-motion';
import { toast } from 'sonner';
import {
  Shield, Globe, Key, Link2, Plus, Trash2,
  Loader2, CheckCircle2, XCircle, TestTube2,
} from 'lucide-react';
import { apiFetch } from '../../shared/lib/api';
import { cn } from '../../shared/lib/cn';

// ── Types ──────────────────────────────────────────────────────────────────────

interface OidcProvider {
  id: number;
  name: string;
  issuerUrl: string;
  clientId: string;
  redirectUri: string;
  groupsClaim: string;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface OidcConfigResponse {
  configured: boolean;
  provider: OidcProvider | null;
}

interface OidcMapping {
  id: number;
  oidcGroup: string;
  roleId: number;
  roleName: string | null;
  spaceKey: string | null;
}

interface Role {
  id: number;
  name: string;
  displayName: string;
}

interface TestResult {
  success: boolean;
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  endSessionEndpoint?: string | null;
  error?: string;
}

type OidcTab = 'provider' | 'mappings';

// ── Hooks ──────────────────────────────────────────────────────────────────────

function useOidcConfig() {
  return useQuery<OidcConfigResponse>({
    queryKey: ['admin', 'oidc'],
    queryFn: () => apiFetch('/admin/oidc'),
    staleTime: 30_000,
  });
}

function useOidcMappings() {
  return useQuery<OidcMapping[]>({
    queryKey: ['admin', 'oidc', 'mappings'],
    queryFn: () => apiFetch('/admin/oidc/mappings'),
    staleTime: 30_000,
  });
}

function useRoles() {
  return useQuery<Role[]>({
    queryKey: ['admin', 'roles'],
    queryFn: () => apiFetch('/roles'),
    staleTime: 60_000,
  });
}

// ── Provider Configuration Tab ─────────────────────────────────────────────────

function ProviderTab() {
  const queryClient = useQueryClient();
  const { data, isLoading } = useOidcConfig();

  const [issuerUrl, setIssuerUrl] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState('');
  const [groupsClaim, setGroupsClaim] = useState('groups');
  const [enabled, setEnabled] = useState(false);
  const [initialized, setInitialized] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  // Populate form when data loads
  if (data?.provider && !initialized) {
    setIssuerUrl(data.provider.issuerUrl);
    setClientId(data.provider.clientId);
    setRedirectUri(data.provider.redirectUri);
    setGroupsClaim(data.provider.groupsClaim);
    setEnabled(data.provider.enabled);
    setInitialized(true);
  }

  const saveMutation = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      apiFetch('/admin/oidc', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'oidc'] });
      toast.success('OIDC configuration saved');
      setClientSecret(''); // Clear secret after save
    },
    onError: (err) => toast.error(err.message),
  });

  const testMutation = useMutation({
    mutationFn: (body: { issuerUrl: string }) =>
      apiFetch<TestResult>('/admin/oidc/test', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onSuccess: (result) => {
      setTestResult(result);
      if (result.success) {
        toast.success('Connection successful');
      } else {
        toast.error(result.error ?? 'Connection failed');
      }
    },
    onError: (err) => toast.error(err.message),
  });

  const handleSave = useCallback(() => {
    if (!issuerUrl || !clientId || !redirectUri) {
      toast.error('Issuer URL, Client ID, and Redirect URI are required');
      return;
    }
    if (!data?.configured && !clientSecret) {
      toast.error('Client Secret is required for initial setup');
      return;
    }

    saveMutation.mutate({
      issuerUrl,
      clientId,
      clientSecret: clientSecret || 'UNCHANGED',
      redirectUri,
      groupsClaim,
      enabled,
    });
  }, [issuerUrl, clientId, clientSecret, redirectUri, groupsClaim, enabled, data, saveMutation]);

  const handleTest = useCallback(() => {
    if (!issuerUrl) {
      toast.error('Enter an Issuer URL to test');
      return;
    }
    setTestResult(null);
    testMutation.mutate({ issuerUrl });
  }, [issuerUrl, testMutation]);

  if (isLoading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-16 animate-pulse rounded-lg bg-foreground/5" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="oidc-provider-form">
      {/* Status indicator */}
      <div className="glass-card p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className={cn(
              'h-2.5 w-2.5 rounded-full',
              data?.configured && data.provider?.enabled
                ? 'bg-emerald-500'
                : data?.configured
                  ? 'bg-amber-500'
                  : 'bg-zinc-500',
            )} />
            <span className="text-sm font-medium">
              {data?.configured && data.provider?.enabled
                ? 'SSO Active'
                : data?.configured
                  ? 'Configured (disabled)'
                  : 'Not configured'}
            </span>
          </div>
          {data?.configured && (
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
                className="h-4 w-4 rounded border-border accent-primary"
              />
              Enabled
            </label>
          )}
        </div>
      </div>

      {/* Provider form */}
      <div className="space-y-4">
        <div>
          <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
            <Globe size={14} className="text-muted-foreground" />
            Issuer URL
          </label>
          <div className="flex gap-2">
            <input
              type="url"
              value={issuerUrl}
              onChange={(e) => setIssuerUrl(e.target.value)}
              placeholder="https://idp.example.com/realms/main"
              className="flex-1 rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
              data-testid="oidc-issuer-url"
            />
            <button
              onClick={handleTest}
              disabled={!issuerUrl || testMutation.isPending}
              className="flex items-center gap-1.5 rounded-md bg-foreground/5 px-3 py-2 text-sm hover:bg-foreground/10 disabled:opacity-50"
              data-testid="oidc-test-btn"
            >
              {testMutation.isPending ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <TestTube2 size={14} />
              )}
              Test
            </button>
          </div>
          {testResult && (
            <m.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              className={cn(
                'mt-2 rounded-md p-3 text-xs',
                testResult.success
                  ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-400'
                  : 'bg-destructive/10 text-destructive',
              )}
            >
              <div className="flex items-center gap-1.5">
                {testResult.success ? (
                  <CheckCircle2 size={14} />
                ) : (
                  <XCircle size={14} />
                )}
                <span className="font-medium">
                  {testResult.success ? 'Connection successful' : 'Connection failed'}
                </span>
              </div>
              {testResult.success && testResult.issuer && (
                <div className="mt-1.5 space-y-0.5 text-muted-foreground">
                  <div>Issuer: {testResult.issuer}</div>
                  {testResult.endSessionEndpoint && (
                    <div>Logout endpoint: available</div>
                  )}
                </div>
              )}
              {!testResult.success && testResult.error && (
                <div className="mt-1 text-muted-foreground">{testResult.error}</div>
              )}
            </m.div>
          )}
        </div>

        <div>
          <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
            <Key size={14} className="text-muted-foreground" />
            Client ID
          </label>
          <input
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            placeholder="my-app-client-id"
            className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            data-testid="oidc-client-id"
          />
        </div>

        <div>
          <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
            <Key size={14} className="text-muted-foreground" />
            Client Secret
          </label>
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            placeholder={data?.configured ? '(unchanged — enter new value to rotate)' : 'Enter client secret'}
            className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            data-testid="oidc-client-secret"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Encrypted at rest with AES-256-GCM. Never exposed in API responses.
          </p>
        </div>

        <div>
          <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
            <Link2 size={14} className="text-muted-foreground" />
            Redirect URI
          </label>
          <input
            type="url"
            value={redirectUri}
            onChange={(e) => setRedirectUri(e.target.value)}
            placeholder="http://localhost:3000/api/auth/oidc/callback"
            className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            data-testid="oidc-redirect-uri"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            Must match the redirect URI registered with your identity provider.
          </p>
        </div>

        <div>
          <label className="mb-1.5 flex items-center gap-1.5 text-sm font-medium">
            <Shield size={14} className="text-muted-foreground" />
            Groups Claim Name
          </label>
          <input
            type="text"
            value={groupsClaim}
            onChange={(e) => setGroupsClaim(e.target.value)}
            placeholder="groups"
            className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
            data-testid="oidc-groups-claim"
          />
          <p className="mt-1 text-xs text-muted-foreground">
            The claim name in the ID token that contains the user's group memberships.
          </p>
        </div>
      </div>

      <div className="flex items-center justify-between border-t border-border/50 pt-4">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="h-4 w-4 rounded border-border accent-primary"
            data-testid="oidc-enabled"
          />
          Enable SSO
        </label>
        <button
          onClick={handleSave}
          disabled={saveMutation.isPending}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          data-testid="oidc-save-btn"
        >
          {saveMutation.isPending && <Loader2 size={14} className="animate-spin" />}
          Save Configuration
        </button>
      </div>
    </div>
  );
}

// ── Group Mappings Tab ─────────────────────────────────────────────────────────

function MappingsTab() {
  const queryClient = useQueryClient();
  const { data: mappings, isLoading } = useOidcMappings();
  const { data: roles } = useRoles();

  const [showForm, setShowForm] = useState(false);
  const [oidcGroup, setOidcGroup] = useState('');
  const [roleId, setRoleId] = useState<number>(0);
  const [spaceKey, setSpaceKey] = useState('');

  const createMutation = useMutation({
    mutationFn: (body: { oidcGroup: string; roleId: number; spaceKey: string | null }) =>
      apiFetch('/admin/oidc/mappings', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'oidc', 'mappings'] });
      setShowForm(false);
      setOidcGroup('');
      setRoleId(0);
      setSpaceKey('');
      toast.success('Mapping created');
    },
    onError: (err) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) =>
      apiFetch(`/admin/oidc/mappings/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['admin', 'oidc', 'mappings'] });
      toast.success('Mapping deleted');
    },
    onError: (err) => toast.error(err.message),
  });

  const handleCreate = useCallback(() => {
    if (!oidcGroup.trim() || !roleId) {
      toast.error('OIDC Group and Role are required');
      return;
    }
    createMutation.mutate({
      oidcGroup: oidcGroup.trim(),
      roleId,
      spaceKey: spaceKey.trim() || null,
    });
  }, [oidcGroup, roleId, spaceKey, createMutation]);

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="glass-card h-16 animate-pulse" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="oidc-mappings">
      <p className="text-sm text-muted-foreground">
        Map OIDC group claims to roles. When a user logs in with SSO, their group
        memberships are synced and role assignments are applied automatically.
      </p>

      {/* Create mapping */}
      {!showForm ? (
        <button
          onClick={() => setShowForm(true)}
          className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          data-testid="create-mapping-btn"
        >
          <Plus size={16} />
          New Mapping
        </button>
      ) : (
        <m.div
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          className="glass-card space-y-3 p-4"
          data-testid="create-mapping-form"
        >
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                OIDC Group
              </label>
              <input
                type="text"
                value={oidcGroup}
                onChange={(e) => setOidcGroup(e.target.value)}
                placeholder="engineering"
                className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                data-testid="mapping-oidc-group"
                autoFocus
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Role
              </label>
              <select
                value={roleId}
                onChange={(e) => setRoleId(Number(e.target.value))}
                className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                data-testid="mapping-role"
              >
                <option value={0}>Select role...</option>
                {roles?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.displayName || r.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">
                Space Key (optional)
              </label>
              <input
                type="text"
                value={spaceKey}
                onChange={(e) => setSpaceKey(e.target.value)}
                placeholder="DEV"
                className="w-full rounded-md bg-foreground/5 px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-primary"
                data-testid="mapping-space-key"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={handleCreate}
              disabled={!oidcGroup.trim() || !roleId || createMutation.isPending}
              className="flex items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              data-testid="submit-mapping"
            >
              {createMutation.isPending && <Loader2 size={14} className="animate-spin" />}
              Create
            </button>
            <button
              onClick={() => setShowForm(false)}
              className="rounded-md bg-foreground/5 px-3 py-1.5 text-sm hover:bg-foreground/10"
            >
              Cancel
            </button>
          </div>
        </m.div>
      )}

      {/* Mappings list */}
      {!mappings?.length ? (
        <div className="glass-card py-12 text-center text-sm text-muted-foreground">
          No group mappings configured yet
        </div>
      ) : (
        <div className="glass-card overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 text-left text-xs text-muted-foreground">
                <th className="px-4 py-3 font-medium">OIDC Group</th>
                <th className="px-4 py-3 font-medium">Role</th>
                <th className="px-4 py-3 font-medium">Space</th>
                <th className="w-16 px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {mappings.map((mapping, i) => (
                <m.tr
                  key={mapping.id}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ delay: i * 0.03 }}
                  className="hover:bg-foreground/5"
                  data-testid={`mapping-${mapping.id}`}
                >
                  <td className="px-4 py-2.5 font-mono text-xs">{mapping.oidcGroup}</td>
                  <td className="px-4 py-2.5">
                    <span className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">
                      {mapping.roleName ?? `Role #${mapping.roleId}`}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">
                    {mapping.spaceKey ?? '(global)'}
                  </td>
                  <td className="px-4 py-2.5">
                    <button
                      onClick={() => deleteMutation.mutate(mapping.id)}
                      disabled={deleteMutation.isPending}
                      className="rounded p-1 text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                      aria-label={`Delete mapping for ${mapping.oidcGroup}`}
                      data-testid={`delete-mapping-${mapping.id}`}
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </m.tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

const TAB_CONFIG: Array<{ key: OidcTab; label: string; icon: typeof Shield }> = [
  { key: 'provider', label: 'Provider', icon: Globe },
  { key: 'mappings', label: 'Group Mappings', icon: Shield },
];

export function OidcSettingsPage() {
  const [activeTab, setActiveTab] = useState<OidcTab>('provider');

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold">SSO / OIDC</h1>
        <p className="text-sm text-muted-foreground">
          Configure single sign-on with your identity provider
        </p>
      </div>

      {/* Tabs */}
      <div className="glass-card p-1.5">
        <div className="flex gap-1">
          {TAB_CONFIG.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-4 py-2 text-sm transition-colors',
                activeTab === key
                  ? 'bg-primary/15 text-primary font-medium'
                  : 'text-muted-foreground hover:bg-foreground/5',
              )}
              data-testid={`oidc-tab-${key}`}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content */}
      {activeTab === 'provider' && <ProviderTab />}
      {activeTab === 'mappings' && <MappingsTab />}
    </div>
  );
}
